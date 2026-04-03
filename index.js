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
const MAX_PLAYLIST_SONGS = 100;
const STATUS_EMBED_THEMES = {
    success: {
        title: 'Success',
        color: 0x2ECC71,
    },
    loading: {
        title: 'Loading',
        color: 0xF1C40F,
    },
    warn: {
        title: 'Warning',
        color: 0xE74C3C,
    },
};
const LOG_LEVEL = (process.env.BOT_LOG_LEVEL || 'debug').toLowerCase();
const LOG_LEVEL_PRIORITY = {
    error: 0,
    warn: 1,
    info: 2,
    debug: 3,
};

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildVoiceStates,
    ],
});

function shouldLog(level) {
    const configuredPriority = LOG_LEVEL_PRIORITY[LOG_LEVEL] ?? LOG_LEVEL_PRIORITY.debug;
    const levelPriority = LOG_LEVEL_PRIORITY[level] ?? LOG_LEVEL_PRIORITY.debug;
    return levelPriority <= configuredPriority;
}

function formatLogMeta(meta = {}) {
    const entries = Object.entries(meta).filter(([, value]) => value !== undefined);
    if (entries.length === 0) return '';

    const parts = entries.map(([key, value]) => {
        if (value === null) return `${key}=null`;
        if (typeof value === 'object') {
            try {
                return `${key}=${JSON.stringify(value)}`;
            } catch {
                return `${key}=[unserializable]`;
            }
        }
        return `${key}=${value}`;
    });

    return ` | ${parts.join(' ')}`;
}

function log(level, scope, message, meta = {}) {
    if (!shouldLog(level)) return;

    const timestamp = new Date().toISOString();
    const upperLevel = level.toUpperCase();
    const line = `[${timestamp}] [${upperLevel}] [${scope}] ${message}${formatLogMeta(meta)}`;

    if (level === 'error') {
        console.error(line);
        return;
    }

    if (level === 'warn') {
        console.warn(line);
        return;
    }

    console.log(line);
}

function logDebug(scope, message, meta) {
    log('debug', scope, message, meta);
}

function logInfo(scope, message, meta) {
    log('info', scope, message, meta);
}

function logWarn(scope, message, meta) {
    log('warn', scope, message, meta);
}

function logError(scope, message, meta) {
    log('error', scope, message, meta);
}

function createStatusEmbed(message, statusType = 'loading') {
    const theme = STATUS_EMBED_THEMES[statusType] || STATUS_EMBED_THEMES.loading;

    return new EmbedBuilder()
        .setTitle(theme.title)
        .setDescription(message)
        .setColor(theme.color)
        .setTimestamp();
}

async function sendStatus(channel, message, statusType = 'loading') {
    if (!channel) return;

    try {
        await channel.send({ embeds: [createStatusEmbed(message, statusType)] });
    } catch (err) {
        logWarn('STATUS', 'Failed to send status message', {
            error: err.message,
        });
    }
}

async function editStatusReply(interaction, message, statusType = 'loading') {
    await interaction.editReply({ embeds: [createStatusEmbed(message, statusType)] });
}

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

function parseYouTubePlaylistUrl(input) {
    try {
        const parsed = new URL(input);
        const hostname = parsed.hostname.replace(/^www\./i, '').toLowerCase();
        const isYouTubeHost =
            hostname === 'youtube.com' ||
            hostname === 'm.youtube.com' ||
            hostname === 'music.youtube.com' ||
            hostname === 'youtu.be';

        if (!isYouTubeHost) return null;

        const playlistId = parsed.searchParams.get('list');
        if (!playlistId) return null;

        const playlistUrl = `https://www.youtube.com/playlist?list=${playlistId}`;
        logDebug('PLAYLIST_PARSE', 'Detected playlist URL in user input', {
            playlistId,
        });
        return playlistUrl;
    } catch {
        return null;
    }
}

async function getPlaylistInfo(playlistUrl) {
    return new Promise((resolve, reject) => {
        logInfo('PLAYLIST_LOAD', 'Loading playlist metadata with yt-dlp', {
            playlistUrl,
        });

        const ytdlp = spawn('yt-dlp', [
            '--flat-playlist',
            '--dump-single-json',
            '--no-warnings',
            '--skip-download',
            '--quiet',
            playlistUrl,
        ]);

        let stdout = '';
        let stderr = '';

        ytdlp.stdout.on('data', (data) => {
            stdout += data.toString();
        });

        ytdlp.stderr.on('data', (data) => {
            stderr += data.toString();
        });

        ytdlp.on('error', (err) => {
            logError('PLAYLIST_LOAD', 'yt-dlp spawn failure during playlist load', {
                playlistUrl,
                error: err.message,
            });
            reject(new Error(`yt-dlp spawn error: ${err.message}`));
        });

        ytdlp.on('close', (code) => {
            if (code !== 0) {
                const reason = stderr.trim() || `yt-dlp exited with code ${code}`;
                logError('PLAYLIST_LOAD', 'yt-dlp failed while loading playlist metadata', {
                    playlistUrl,
                    exitCode: code,
                    reason,
                });
                return reject(new Error(reason));
            }

            try {
                const payload = JSON.parse(stdout);
                const entries = Array.isArray(payload.entries) ? payload.entries : [];
                const songs = entries
                    .filter((entry) => entry && entry.id)
                    .slice(0, MAX_PLAYLIST_SONGS)
                    .map((entry) => ({
                        title: entry.title || `YouTube Video (${entry.id})`,
                        videoId: entry.id,
                        url: `https://www.youtube.com/watch?v=${entry.id}`,
                        duration: formatDuration(Number(entry.duration)),
                        thumbnail: entry.thumbnail || entry.thumbnails?.[0]?.url || null,
                    }));

                resolve({
                    title: payload.title || 'YouTube Playlist',
                    songs,
                    totalEntries: entries.length,
                });

                logInfo('PLAYLIST_LOAD', 'Playlist metadata loaded', {
                    playlistUrl,
                    playlistTitle: payload.title || 'YouTube Playlist',
                    totalEntries: entries.length,
                    queuedEntries: songs.length,
                    maxAllowed: MAX_PLAYLIST_SONGS,
                });
            } catch (err) {
                logError('PLAYLIST_LOAD', 'Failed to parse playlist metadata JSON', {
                    playlistUrl,
                    error: err.message,
                });
                reject(new Error(`Failed to parse playlist metadata: ${err.message}`));
            }
        });
    });
}

async function resolvePlayableItems(query) {
    const playlistUrl = parseYouTubePlaylistUrl(query);

    if (playlistUrl) {
        const playlist = await getPlaylistInfo(playlistUrl);
        return {
            type: 'playlist',
            title: playlist.title,
            songs: playlist.songs,
            totalEntries: playlist.totalEntries,
        };
    }

    const song = await searchYouTube(query);
    if (!song) return null;

    return {
        type: 'single',
        songs: [song],
        totalEntries: 1,
    };
}

async function searchYouTube(query) {
    logDebug('SEARCH', 'Resolving YouTube query', { query });

    const videoIdMatch = query.match(
        /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/|youtube\.com\/shorts\/)([a-zA-Z0-9_-]{11})/
    );

    if (videoIdMatch) {
        const videoId = videoIdMatch[1];
        const info = await yt.getBasicInfo(videoId);

        logInfo('SEARCH', 'Resolved direct YouTube video URL', {
            query,
            videoId,
            title: info.basic_info.title,
        });

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

    logInfo('SEARCH', 'Resolved query using YouTube search result', {
        query,
        videoId: first.id,
        title: first.title?.text ?? first.title ?? 'Unknown',
    });

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
    logDebug('STREAM', 'Spawning yt-dlp audio stream', { url });

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
        logWarn('STREAM', 'yt-dlp stderr output', {
            detail: data.toString().trim(),
        });
    });

    ytdlp.on('error', (err) => {
        logError('STREAM', 'yt-dlp stream process failed to spawn', {
            error: err.message,
            url,
        });
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
        logInfo('PLAYBACK', 'Queue is empty, starting inactivity disconnect timer', {
            guildId,
            timeoutMs: 180000,
        });

        // Auto-disconnect after 3 minutes of inactivity
        setTimeout(() => {
            const q = queues.get(guildId);
            if (q && q.songs.length === 0) {
                logInfo('PLAYBACK', 'Disconnecting voice due to inactivity', { guildId });
                q.connection.destroy();
                queues.delete(guildId);
            }
        }, 180_000);
        return;
    }

    const song = serverQueue.songs[0];
    serverQueue.playing = true;

    try {
        await sendStatus(serverQueue.textChannel, `Preparing to play **${song.title}**...`, 'loading');
        logInfo('PLAYBACK', 'Preparing song for playback', {
            guildId,
            title: song.title,
            videoId: song.videoId,
            queueLength: serverQueue.songs.length,
        });

        const audioStream = createStream(song.url);

        audioStream.on('error', (err) => {
            logError('PLAYBACK', 'Audio stream error during playback', {
                guildId,
                title: song.title,
                error: err.message,
            });
            serverQueue.player.stop();
        });

        const resource = createAudioResource(audioStream, {
            inputType: StreamType.Arbitrary,
            inlineVolume: true,
        });

        resource.volume.setVolumeLogarithmic(serverQueue.volume / 100);
        serverQueue.resource = resource;
        serverQueue.player.play(resource);

        logInfo('PLAYBACK', 'Playback started', {
            guildId,
            title: song.title,
            volume: serverQueue.volume,
        });

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
        logError('PLAYBACK', 'Failed to play song, skipping to next entry', {
            guildId,
            title: song.title,
            error: error.message,
        });
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
    logInfo('BOOT', 'Registering slash commands', {
        commandCount: commands.length,
        applicationId: client.user?.id,
    });

    try {
        await rest.put(Routes.applicationCommands(client.user.id), {
            body: commands.map((cmd) => cmd.toJSON()),
        });
        logInfo('BOOT', 'Slash commands registered successfully', {
            commandCount: commands.length,
        });
    } catch (error) {
        logError('BOOT', 'Failed to register slash commands', {
            error: error.message,
        });
    }
}

// ---------------------------------------------------------------------------
// Command Handler
// ---------------------------------------------------------------------------

client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isChatInputCommand()) return;

    const { commandName, guild, member } = interaction;
    logInfo('COMMAND', 'Received slash command', {
        commandName,
        guildId: guild?.id,
        userId: interaction.user.id,
    });

    switch (commandName) {
        // ---------------------------------------------------------------
        // /play
        // ---------------------------------------------------------------
        case 'play': {
            await interaction.deferReply();

            const query = interaction.options.getString('query');
            const requesterName = member.displayName ?? interaction.user.username;

            logInfo('CMD_PLAY', 'Processing play command', {
                guildId: guild.id,
                userId: interaction.user.id,
                query,
            });

            const voiceChannel = member.voice?.channel;
            if (!voiceChannel) {
                logWarn('CMD_PLAY', 'User not connected to a voice channel', {
                    guildId: guild.id,
                    userId: interaction.user.id,
                });
                return interaction.editReply(
                    'You need to be in a voice channel to use this command.',
                );
            }

            const permissions = voiceChannel.permissionsFor(interaction.client.user);
            if (!permissions.has('Connect') || !permissions.has('Speak')) {
                logWarn('CMD_PLAY', 'Bot missing required voice channel permissions', {
                    guildId: guild.id,
                    channelId: voiceChannel.id,
                    hasConnect: permissions.has('Connect'),
                    hasSpeak: permissions.has('Speak'),
                });
                return interaction.editReply(
                    'I need **Connect** and **Speak** permissions in your voice channel.',
                );
            }

            const playlistUrl = parseYouTubePlaylistUrl(query);
            if (playlistUrl) {
                await editStatusReply(
                    interaction,
                    `Playlist detected. Loading tracks (up to ${MAX_PLAYLIST_SONGS})...`,
                    'loading',
                );
                logInfo('CMD_PLAY', 'Playlist input detected', {
                    guildId: guild.id,
                    playlistUrl,
                });
            } else {
                await editStatusReply(
                    interaction,
                    'Searching YouTube and preparing your request...',
                    'loading',
                );
                logDebug('CMD_PLAY', 'Single track or search input detected', {
                    guildId: guild.id,
                });
            }

            let resolvedInput;
            try {
                resolvedInput = await resolvePlayableItems(query);
            } catch (err) {
                logError('CMD_PLAY', 'Failed to resolve playable input', {
                    guildId: guild.id,
                    query,
                    error: err.message,
                });
                return interaction.editReply(`Search failed: ${err.message}`);
            }

            if (!resolvedInput || resolvedInput.songs.length === 0) {
                logWarn('CMD_PLAY', 'No playable results found', {
                    guildId: guild.id,
                    query,
                });
                return interaction.editReply(`No results found for: **${query}**`);
            }

            const songsToQueue = resolvedInput.songs.map((song) => ({
                ...song,
                requestedBy: requesterName,
            }));
            const firstSong = songsToQueue[0];

            logInfo('CMD_PLAY', 'Playable items resolved', {
                guildId: guild.id,
                inputType: resolvedInput.type,
                totalEntries: resolvedInput.totalEntries,
                queuedEntries: songsToQueue.length,
                firstTitle: firstSong.title,
            });

            if (resolvedInput.type === 'playlist') {
                await editStatusReply(
                    interaction,
                    `Loaded ${songsToQueue.length} track(s) from **${resolvedInput.title}**. Preparing queue...`,
                    'loading',
                );
            }

            const existingQueue = queues.get(guild.id);

            if (existingQueue) {
                const previousLength = existingQueue.songs.length;
                existingQueue.songs.push(...songsToQueue);

                logInfo('QUEUE', 'Added songs to existing queue', {
                    guildId: guild.id,
                    addedCount: songsToQueue.length,
                    previousLength,
                    newLength: existingQueue.songs.length,
                    wasPlaying: existingQueue.playing,
                });

                // If queue is not currently playing, start playback
                if (!existingQueue.playing) {
                    await editStatusReply(interaction, 'Queue updated. Preparing playback...', 'loading');
                    logInfo('QUEUE', 'Queue was idle and playback is restarting', {
                        guildId: guild.id,
                        queueLength: existingQueue.songs.length,
                    });
                    playSong(guild.id);
                }

                if (resolvedInput.type === 'playlist') {
                    const truncatedNote =
                        resolvedInput.totalEntries > songsToQueue.length
                            ? ` (added first ${songsToQueue.length} tracks)`
                            : '';
                    return interaction.editReply(
                        `Added **${songsToQueue.length}** song(s) from **${resolvedInput.title}**${truncatedNote}.`,
                    );
                }

                return interaction.editReply(
                    `Added to queue: **${firstSong.title}** [${firstSong.duration}]`,
                );
            }

            await editStatusReply(interaction, 'Joining voice channel and preparing playback...', 'loading');
            logInfo('VOICE', 'Creating queue and joining voice channel', {
                guildId: guild.id,
                channelId: voiceChannel.id,
                initialQueueLength: songsToQueue.length,
            });

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
                songs: songsToQueue,
                volume: 50,
                playing: false,
                resource: null,
            };

            queues.set(guild.id, queueObj);
            connection.subscribe(player);

            logInfo('QUEUE', 'New queue created and player subscribed', {
                guildId: guild.id,
                queueLength: queueObj.songs.length,
                channelId: voiceChannel.id,
            });

            // Player events
            player.on(AudioPlayerStatus.Idle, async () => {
                const finishedSong = queueObj.songs[0];
                queueObj.songs.shift();

                const nextSong = queueObj.songs[0];
                if (nextSong) {
                    await sendStatus(
                        queueObj.textChannel,
                        `Switching to next song: **${nextSong.title}**...`,
                        'loading',
                    );
                    logInfo('PLAYBACK', 'Song finished, switching to next track', {
                        guildId: guild.id,
                        finishedTitle: finishedSong?.title,
                        nextTitle: nextSong.title,
                        remainingQueue: queueObj.songs.length,
                    });
                } else {
                    await sendStatus(queueObj.textChannel, 'Current song finished. Queue is now empty.', 'success');
                    logInfo('PLAYBACK', 'Song finished and queue is empty', {
                        guildId: guild.id,
                        finishedTitle: finishedSong?.title,
                    });
                }

                playSong(guild.id);
            });

            player.on('error', async (error) => {
                logError('PLAYBACK', 'Player emitted an error', {
                    guildId: guild.id,
                    currentSong: queueObj.songs[0]?.title,
                    error: error.message,
                });

                await sendStatus(
                    queueObj.textChannel,
                    'Playback issue detected. Attempting to continue with the next song...',
                    'warn',
                );

                queueObj.textChannel
                    .send(`Playback error: ${error.message}`)
                    .catch(console.error);
                queueObj.songs.shift();
                playSong(guild.id);
            });

            // Voice connection disconnection recovery
            connection.on(VoiceConnectionStatus.Disconnected, async () => {
                logWarn('VOICE', 'Voice disconnected; attempting quick recovery', {
                    guildId: guild.id,
                    channelId: voiceChannel.id,
                });

                try {
                    await Promise.race([
                        entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
                        entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
                    ]);

                    logInfo('VOICE', 'Voice connection recovered after disconnect', {
                        guildId: guild.id,
                        channelId: voiceChannel.id,
                    });
                } catch {
                    logWarn('VOICE', 'Voice recovery failed; destroying queue connection', {
                        guildId: guild.id,
                        channelId: voiceChannel.id,
                    });

                    await sendStatus(
                        queueObj.textChannel,
                        'Voice connection was lost and could not be recovered. Disconnecting.',
                        'warn',
                    );

                    connection.destroy();
                    queues.delete(guild.id);
                }
            });

            // Wait for the voice connection to be ready before playing
            try {
                await entersState(connection, VoiceConnectionStatus.Ready, 30_000);
                logInfo('VOICE', 'Voice connection is ready', {
                    guildId: guild.id,
                    channelId: voiceChannel.id,
                });
            } catch {
                logError('VOICE', 'Voice connection failed to become ready in time', {
                    guildId: guild.id,
                    channelId: voiceChannel.id,
                    timeoutMs: 30000,
                });
                connection.destroy();
                queues.delete(guild.id);
                return interaction.editReply('Failed to connect to the voice channel. Please try again.');
            }

            if (resolvedInput.type === 'playlist') {
                const truncatedNote =
                    resolvedInput.totalEntries > songsToQueue.length
                        ? ` Added first ${songsToQueue.length} tracks.`
                        : '';
                await interaction.editReply(
                    `Queued **${songsToQueue.length}** song(s) from **${resolvedInput.title}**.${truncatedNote}`,
                );
            } else {
                await interaction.editReply(`Playing: **${firstSong.title}** [${firstSong.duration}]`);
            }

            playSong(guild.id);
            break;
        }

        // ---------------------------------------------------------------
        // /skip
        // ---------------------------------------------------------------
        case 'skip': {
            const serverQueue = queues.get(guild.id);
            logInfo('CMD_SKIP', 'Processing skip command', {
                guildId: guild.id,
                userId: interaction.user.id,
                queueLength: serverQueue?.songs?.length ?? 0,
            });

            if (!serverQueue || serverQueue.songs.length === 0) {
                logWarn('CMD_SKIP', 'Skip requested with empty queue', {
                    guildId: guild.id,
                });
                return interaction.reply('There is nothing to skip.');
            }

            const skipped = serverQueue.songs[0].title;
            serverQueue.player.stop();
            await sendStatus(
                serverQueue.textChannel,
                'Skipping current song and moving to the next...',
                'loading',
            );
            logInfo('CMD_SKIP', 'Current song skipped', {
                guildId: guild.id,
                skipped,
                remainingAfterSkip: Math.max(serverQueue.songs.length - 1, 0),
            });
            interaction.reply(`Skipped: **${skipped}**`);
            break;
        }

        // ---------------------------------------------------------------
        // /stop
        // ---------------------------------------------------------------
        case 'stop': {
            const serverQueue = queues.get(guild.id);
            logInfo('CMD_STOP', 'Processing stop command', {
                guildId: guild.id,
                userId: interaction.user.id,
                queueLength: serverQueue?.songs?.length ?? 0,
            });

            if (!serverQueue) {
                logWarn('CMD_STOP', 'Stop requested but nothing is playing', {
                    guildId: guild.id,
                });
                return interaction.reply('There is nothing playing.');
            }

            serverQueue.songs = [];
            serverQueue.player.stop();
            serverQueue.connection.destroy();
            queues.delete(guild.id);
            logInfo('CMD_STOP', 'Playback stopped and queue destroyed', {
                guildId: guild.id,
            });
            interaction.reply('Stopped playback and cleared the queue.');
            break;
        }

        // ---------------------------------------------------------------
        // /queue
        // ---------------------------------------------------------------
        case 'queue': {
            const serverQueue = queues.get(guild.id);
            logDebug('CMD_QUEUE', 'Processing queue command', {
                guildId: guild.id,
                userId: interaction.user.id,
                queueLength: serverQueue?.songs?.length ?? 0,
            });

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

            logInfo('CMD_QUEUE', 'Queue snapshot returned to user', {
                guildId: guild.id,
                totalSongs: serverQueue.songs.length,
            });
            interaction.reply({ embeds: [embed] });
            break;
        }

        // ---------------------------------------------------------------
        // /pause
        // ---------------------------------------------------------------
        case 'pause': {
            const serverQueue = queues.get(guild.id);
            logInfo('CMD_PAUSE', 'Processing pause command', {
                guildId: guild.id,
                userId: interaction.user.id,
                playing: serverQueue?.playing ?? false,
            });

            if (!serverQueue || !serverQueue.playing) {
                logWarn('CMD_PAUSE', 'Pause requested while nothing is playing', {
                    guildId: guild.id,
                });
                return interaction.reply('There is nothing to pause.');
            }
            serverQueue.player.pause();
            logInfo('CMD_PAUSE', 'Playback paused', {
                guildId: guild.id,
                currentSong: serverQueue.songs[0]?.title,
            });
            interaction.reply('Paused the current song.');
            break;
        }

        // ---------------------------------------------------------------
        // /resume
        // ---------------------------------------------------------------
        case 'resume': {
            const serverQueue = queues.get(guild.id);
            logInfo('CMD_RESUME', 'Processing resume command', {
                guildId: guild.id,
                userId: interaction.user.id,
                queueLength: serverQueue?.songs?.length ?? 0,
            });

            if (!serverQueue) {
                logWarn('CMD_RESUME', 'Resume requested with no queue', {
                    guildId: guild.id,
                });
                return interaction.reply('There is nothing to resume.');
            }
            serverQueue.player.unpause();
            logInfo('CMD_RESUME', 'Playback resumed', {
                guildId: guild.id,
                currentSong: serverQueue.songs[0]?.title,
            });
            interaction.reply('Resumed playback.');
            break;
        }

        // ---------------------------------------------------------------
        // /nowplaying
        // ---------------------------------------------------------------
        case 'nowplaying': {
            const serverQueue = queues.get(guild.id);
            logDebug('CMD_NOWPLAYING', 'Processing nowplaying command', {
                guildId: guild.id,
                userId: interaction.user.id,
                queueLength: serverQueue?.songs?.length ?? 0,
            });

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

            logInfo('CMD_NOWPLAYING', 'Returned currently playing song details', {
                guildId: guild.id,
                title: song.title,
            });
            interaction.reply({ embeds: [embed] });
            break;
        }

        // ---------------------------------------------------------------
        // /volume
        // ---------------------------------------------------------------
        case 'volume': {
            const serverQueue = queues.get(guild.id);
            logInfo('CMD_VOLUME', 'Processing volume command', {
                guildId: guild.id,
                userId: interaction.user.id,
                currentVolume: serverQueue?.volume,
            });

            if (!serverQueue) {
                logWarn('CMD_VOLUME', 'Volume change requested with no active queue', {
                    guildId: guild.id,
                });
                return interaction.reply('There is nothing playing.');
            }

            const level = interaction.options.getInteger('level');
            serverQueue.volume = level;

            if (serverQueue.resource?.volume) {
                serverQueue.resource.volume.setVolumeLogarithmic(level / 100);
            }

            logInfo('CMD_VOLUME', 'Volume updated', {
                guildId: guild.id,
                level,
                activeSong: serverQueue.songs[0]?.title,
            });
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
