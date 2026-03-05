require('dotenv').config();

const {
    Client,
    GatewayIntentBits,
    Events,
    REST,
    Routes,
    SlashCommandBuilder,
    EmbedBuilder,
} = require('discord.js');

const {
    joinVoiceChannel,
    createAudioPlayer,
    createAudioResource,
    AudioPlayerStatus,
    VoiceConnectionStatus,
    entersState,
    StreamType,
    NoSubscriberBehavior,
} = require('@discordjs/voice');

const { spawn } = require('child_process');

// Ensure ffmpeg-static is found by prism-media
process.env.FFMPEG_PATH = require('ffmpeg-static');

// ---------------------------------------------------------------------------
// Global State
// ---------------------------------------------------------------------------

let yt = null; // Innertube instance (initialized async)
const queues = new Map(); // guild ID -> queue object

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildVoiceStates,
    ],
});

// ---------------------------------------------------------------------------
// YouTube Helpers
// ---------------------------------------------------------------------------

async function initializeInnerTube() {
    const { Innertube } = await import('youtubei.js');
    yt = await Innertube.create();
}

function formatDuration(seconds) {
    if (!seconds || isNaN(seconds)) return 'Unknown';
    const hrs = Math.floor(seconds / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);
    if (hrs > 0) {
        return `${hrs}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
    }
    return `${mins}:${secs.toString().padStart(2, '0')}`;
}

async function searchYouTube(query) {
    const videoIdMatch = query.match(
        /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/|youtube\.com\/shorts\/)([a-zA-Z0-9_-]{11})/
    );

    if (videoIdMatch) {
        const videoId = videoIdMatch[1];
        const info = await yt.getBasicInfo(videoId);
        return {
            title: info.basic_info.title,
            videoId: videoId,
            url: `https://www.youtube.com/watch?v=${videoId}`,
            duration: formatDuration(info.basic_info.duration),
            thumbnail: info.basic_info.thumbnail?.[0]?.url || null,
        };
    }

    const results = await yt.search(query, { type: 'video' });
    const videos = results.results?.filter(r => r.type === 'Video');
    const first = videos?.[0];

    if (!first) return null;

    return {
        title: first.title?.text ?? first.title ?? 'Unknown',
        videoId: first.id,
        url: `https://www.youtube.com/watch?v=${first.id}`,
        duration: first.duration?.text ?? 'Unknown',
        thumbnail: first.thumbnails?.[0]?.url || null,
    };
}

// ---------------------------------------------------------------------------
// Audio Pipeline (yt-dlp)
// ---------------------------------------------------------------------------

function createStream(url) {
    const ytdlp = spawn('yt-dlp', [
        '-f', 'bestaudio',
        '--no-playlist',
        '--no-warnings',
        '--js-runtimes', 'node',
        '-o', '-',
        '--quiet',
        url,
    ]);

    ytdlp.stderr.on('data', (data) => {
        console.error('[yt-dlp]', data.toString().trim());
    });

    ytdlp.on('error', (err) => {
        console.error('[yt-dlp] spawn error:', err.message);
    });

    return ytdlp.stdout;
}

// ---------------------------------------------------------------------------
// Queue Management
// ---------------------------------------------------------------------------

async function playSong(guildId) {
    const serverQueue = queues.get(guildId);
    if (!serverQueue) return;

    if (serverQueue.songs.length === 0) {
        serverQueue.playing = false;
        // Auto-disconnect after 3 minutes of inactivity
        setTimeout(() => {
            const q = queues.get(guildId);
            if (q && q.songs.length === 0) {
                q.connection.destroy();
                queues.delete(guildId);
            }
        }, 180_000);
        return;
    }

    const song = serverQueue.songs[0];
    serverQueue.playing = true;

    try {
        const audioStream = createStream(song.url);

        audioStream.on('error', (err) => {
            console.error('Stream error:', err);
            serverQueue.player.stop();
        });

        const resource = createAudioResource(audioStream, {
            inputType: StreamType.Arbitrary,
            inlineVolume: true,
        });

        resource.volume.setVolumeLogarithmic(serverQueue.volume / 100);
        serverQueue.resource = resource;
        serverQueue.player.play(resource);

        const embed = new EmbedBuilder()
            .setTitle('Now Playing')
            .setDescription(`**${song.title}**`)
            .addFields(
                { name: 'Duration', value: song.duration, inline: true },
                { name: 'Requested by', value: song.requestedBy, inline: true },
            )
            .setColor(0xFF0000);

        if (song.thumbnail) embed.setThumbnail(song.thumbnail);

        serverQueue.textChannel.send({ embeds: [embed] }).catch(console.error);
    } catch (error) {
        console.error('Error playing song:', error);
        serverQueue.textChannel
            .send(`Error playing **${song.title}**: ${error.message}`)
            .catch(console.error);
        serverQueue.songs.shift();
        return playSong(guildId);
    }
}

// ---------------------------------------------------------------------------
// Slash Command Definitions
// ---------------------------------------------------------------------------

const commands = [
    new SlashCommandBuilder()
        .setName('play')
        .setDescription('Play a song from YouTube')
        .addStringOption((opt) =>
            opt.setName('query').setDescription('Song name or YouTube URL').setRequired(true),
        ),

    new SlashCommandBuilder().setName('skip').setDescription('Skip the current song'),

    new SlashCommandBuilder()
        .setName('stop')
        .setDescription('Stop playback and clear the queue'),

    new SlashCommandBuilder().setName('queue').setDescription('Show the current song queue'),

    new SlashCommandBuilder().setName('pause').setDescription('Pause the current song'),

    new SlashCommandBuilder().setName('resume').setDescription('Resume the paused song'),

    new SlashCommandBuilder()
        .setName('nowplaying')
        .setDescription('Show info about the current song'),

    new SlashCommandBuilder()
        .setName('volume')
        .setDescription('Set the playback volume')
        .addIntegerOption((opt) =>
            opt
                .setName('level')
                .setDescription('Volume level (1-100)')
                .setRequired(true)
                .setMinValue(1)
                .setMaxValue(100),
        ),
];

async function registerCommands() {
    const rest = new REST().setToken(process.env.DISCORD_TOKEN);
    try {
        await rest.put(Routes.applicationCommands(client.user.id), {
            body: commands.map((cmd) => cmd.toJSON()),
        });
        console.log('Slash commands registered.');
    } catch (error) {
        console.error('Error registering commands:', error);
    }
}

// ---------------------------------------------------------------------------
// Command Handler
// ---------------------------------------------------------------------------

client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isChatInputCommand()) return;

    const { commandName, guild, member } = interaction;

    switch (commandName) {
        // ---------------------------------------------------------------
        // /play
        // ---------------------------------------------------------------
        case 'play': {
            await interaction.deferReply();

            const voiceChannel = member.voice?.channel;
            if (!voiceChannel) {
                return interaction.editReply(
                    'You need to be in a voice channel to use this command.',
                );
            }

            const permissions = voiceChannel.permissionsFor(interaction.client.user);
            if (!permissions.has('Connect') || !permissions.has('Speak')) {
                return interaction.editReply(
                    'I need **Connect** and **Speak** permissions in your voice channel.',
                );
            }

            const query = interaction.options.getString('query');

            let songInfo;
            try {
                songInfo = await searchYouTube(query);
            } catch (err) {
                console.error('YouTube search error:', err);
                return interaction.editReply(`Search failed: ${err.message}`);
            }

            if (!songInfo) {
                return interaction.editReply(`No results found for: **${query}**`);
            }

            const song = {
                ...songInfo,
                requestedBy: interaction.user.displayName,
            };

            const existingQueue = queues.get(guild.id);

            if (existingQueue) {
                existingQueue.songs.push(song);
                return interaction.editReply(
                    `Added to queue: **${song.title}** [${song.duration}]`,
                );
            }

            // Create new queue
            const player = createAudioPlayer({
                behaviors: { noSubscriber: NoSubscriberBehavior.Pause },
            });

            const connection = joinVoiceChannel({
                channelId: voiceChannel.id,
                guildId: guild.id,
                adapterCreator: guild.voiceAdapterCreator,
            });

            const queueObj = {
                textChannel: interaction.channel,
                voiceChannel: voiceChannel,
                connection: connection,
                player: player,
                songs: [song],
                volume: 50,
                playing: false,
                resource: null,
            };

            queues.set(guild.id, queueObj);
            connection.subscribe(player);

            // Player events
            player.on(AudioPlayerStatus.Idle, () => {
                queueObj.songs.shift();
                playSong(guild.id);
            });

            player.on('error', (error) => {
                console.error('Player error:', error.message);
                queueObj.textChannel
                    .send(`Playback error: ${error.message}`)
                    .catch(console.error);
                queueObj.songs.shift();
                playSong(guild.id);
            });

            // Voice connection disconnection recovery
            connection.on(VoiceConnectionStatus.Disconnected, async () => {
                try {
                    await Promise.race([
                        entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
                        entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
                    ]);
                } catch {
                    connection.destroy();
                    queues.delete(guild.id);
                }
            });

            // Wait for the voice connection to be ready before playing
            try {
                await entersState(connection, VoiceConnectionStatus.Ready, 30_000);
            } catch {
                connection.destroy();
                queues.delete(guild.id);
                return interaction.editReply('Failed to connect to the voice channel. Please try again.');
            }

            await interaction.editReply(`Playing: **${song.title}** [${song.duration}]`);
            playSong(guild.id);
            break;
        }

        // ---------------------------------------------------------------
        // /skip
        // ---------------------------------------------------------------
        case 'skip': {
            const serverQueue = queues.get(guild.id);
            if (!serverQueue || serverQueue.songs.length === 0) {
                return interaction.reply('There is nothing to skip.');
            }
            const skipped = serverQueue.songs[0].title;
            serverQueue.player.stop();
            interaction.reply(`Skipped: **${skipped}**`);
            break;
        }

        // ---------------------------------------------------------------
        // /stop
        // ---------------------------------------------------------------
        case 'stop': {
            const serverQueue = queues.get(guild.id);
            if (!serverQueue) {
                return interaction.reply('There is nothing playing.');
            }
            serverQueue.songs = [];
            serverQueue.player.stop();
            serverQueue.connection.destroy();
            queues.delete(guild.id);
            interaction.reply('Stopped playback and cleared the queue.');
            break;
        }

        // ---------------------------------------------------------------
        // /queue
        // ---------------------------------------------------------------
        case 'queue': {
            const serverQueue = queues.get(guild.id);
            if (!serverQueue || serverQueue.songs.length === 0) {
                return interaction.reply('The queue is empty.');
            }

            const current = serverQueue.songs[0];
            const upcoming = serverQueue.songs.slice(1, 11);

            const description =
                `**Now Playing:**\n${current.title} [${current.duration}]\n\n` +
                (upcoming.length > 0
                    ? '**Up Next:**\n' +
                      upcoming.map((s, i) => `${i + 1}. ${s.title} [${s.duration}]`).join('\n')
                    : 'No more songs in queue.');

            const embed = new EmbedBuilder()
                .setTitle('Song Queue')
                .setColor(0xFF0000)
                .setDescription(description)
                .setFooter({
                    text: `${serverQueue.songs.length} song(s) total | Volume: ${serverQueue.volume}%`,
                });

            interaction.reply({ embeds: [embed] });
            break;
        }

        // ---------------------------------------------------------------
        // /pause
        // ---------------------------------------------------------------
        case 'pause': {
            const serverQueue = queues.get(guild.id);
            if (!serverQueue || !serverQueue.playing) {
                return interaction.reply('There is nothing to pause.');
            }
            serverQueue.player.pause();
            interaction.reply('Paused the current song.');
            break;
        }

        // ---------------------------------------------------------------
        // /resume
        // ---------------------------------------------------------------
        case 'resume': {
            const serverQueue = queues.get(guild.id);
            if (!serverQueue) {
                return interaction.reply('There is nothing to resume.');
            }
            serverQueue.player.unpause();
            interaction.reply('Resumed playback.');
            break;
        }

        // ---------------------------------------------------------------
        // /nowplaying
        // ---------------------------------------------------------------
        case 'nowplaying': {
            const serverQueue = queues.get(guild.id);
            if (!serverQueue || serverQueue.songs.length === 0) {
                return interaction.reply('Nothing is currently playing.');
            }

            const song = serverQueue.songs[0];
            const embed = new EmbedBuilder()
                .setTitle('Now Playing')
                .setDescription(`**${song.title}**`)
                .addFields(
                    { name: 'Duration', value: song.duration, inline: true },
                    { name: 'Requested by', value: song.requestedBy, inline: true },
                    { name: 'Volume', value: `${serverQueue.volume}%`, inline: true },
                )
                .setURL(song.url)
                .setColor(0xFF0000);

            if (song.thumbnail) embed.setThumbnail(song.thumbnail);

            interaction.reply({ embeds: [embed] });
            break;
        }

        // ---------------------------------------------------------------
        // /volume
        // ---------------------------------------------------------------
        case 'volume': {
            const serverQueue = queues.get(guild.id);
            if (!serverQueue) {
                return interaction.reply('There is nothing playing.');
            }

            const level = interaction.options.getInteger('level');
            serverQueue.volume = level;

            if (serverQueue.resource?.volume) {
                serverQueue.resource.volume.setVolumeLogarithmic(level / 100);
            }

            interaction.reply(`Volume set to **${level}%**`);
            break;
        }

        default:
            break;
    }
});

// ---------------------------------------------------------------------------
// Bot Startup
// ---------------------------------------------------------------------------

client.once(Events.ClientReady, async () => {
    console.log(`Logged in as ${client.user.tag}`);
    await registerCommands();
    console.log('Bot is ready!');
});

process.on('unhandledRejection', (error) => {
    console.error('Unhandled promise rejection:', error);
});

async function main() {
    try {
        await initializeInnerTube();
        await client.login(process.env.DISCORD_TOKEN);
    } catch (error) {
        console.error('Fatal startup error:', error);
        process.exit(1);
    }
}

main();
