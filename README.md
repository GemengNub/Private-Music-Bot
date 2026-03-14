# Private Music Bot

A Discord music bot that plays YouTube audio in voice channels. Built with discord.js v14, youtubei.js for search, and yt-dlp for audio streaming.

## Features

| Command | Description |
|---------|-------------|
| `/play <query or URL>` | Play a song by name or YouTube URL |
| `/skip` | Skip the current song |
| `/stop` | Stop playback and clear the queue |
| `/queue` | Show the current song queue |
| `/pause` | Pause the current song |
| `/resume` | Resume playback |
| `/nowplaying` | Show info about the current song |
| `/volume <1-100>` | Set the playback volume |

## Prerequisites

- **Node.js** v18 or later
- **yt-dlp** installed and available in your system PATH ([install guide](https://github.com/yt-dlp/yt-dlp#installation))
- A **Discord Bot Token** from the [Discord Developer Portal](https://discord.com/developers/applications)

## Dependencies

| Package | Purpose |
|---------|---------|
| `discord.js` | Discord API client |
| `@discordjs/voice` | Voice connection and audio playback |
| `@discordjs/opus` | Opus audio encoding |
| `@snazzah/davey` | Discord DAVE (Audio Video Encryption) protocol support |
| `ffmpeg-static` | Bundled FFmpeg binary for audio processing |
| `libsodium-wrappers` | Encryption library for voice connections |
| `youtubei.js` | YouTube search and video info |
| `dotenv` | Environment variable loading |

**External tool (not an npm package):**

| Tool | Purpose |
|------|---------|
| `yt-dlp` | YouTube audio extraction (must be installed separately) |

## Setup

### 1. Clone the repository

```bash
git clone https://github.com/GemengNub/Private-Music-Bot.git
cd Private-Music-Bot
```

### 2. Install yt-dlp

**Windows** (with winget):
```bash
winget install yt-dlp
```

**Windows** (with pip):
```bash
pip install yt-dlp
```

**macOS** (with Homebrew):
```bash
brew install yt-dlp
```

**Linux**:
```bash
sudo curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp
sudo chmod a+rx /usr/local/bin/yt-dlp
```

Verify it's installed:
```bash
yt-dlp --version
```

### 3. Install Node.js dependencies

```bash
npm install
```

### 4. Create your Discord bot

1. Go to the [Discord Developer Portal](https://discord.com/developers/applications)
2. Click **New Application** and give it a name
3. Go to the **Bot** tab and click **Reset Token** to get your bot token
4. Enable the **Message Content Intent** under **Privileged Gateway Intents** (optional but recommended)
5. Go to **OAuth2 > URL Generator**
6. Select scopes: `bot`, `applications.commands`
7. Select bot permissions: `Connect`, `Speak`, `Send Messages`, `Embed Links`
8. Copy the generated URL and open it in your browser to invite the bot to your server

### 5. Configure environment

```bash
cp .env.example .env
```

Edit `.env` and paste your bot token:
```
DISCORD_TOKEN=your_actual_bot_token_here
```

### 6. Start the bot

```bash
npm start
```

You should see:
```
Logged in as YourBot#1234
Slash commands registered.
Bot is ready!
```

## Usage

1. Join a voice channel in your Discord server
2. Use `/play <song name or YouTube URL>` in any text channel
3. The bot will join your voice channel and start playing

## Troubleshooting

- **Bot joins but no audio plays**: Make sure `@snazzah/davey` is installed. Discord requires DAVE (end-to-end voice encryption) support.
- **"No results found"**: Check that youtubei.js is working. The `[YOUTUBEJS][Player]` warnings at startup about signature/n-decipher are normal and don't affect search.
- **yt-dlp errors**: Update yt-dlp to the latest version (`yt-dlp -U`). YouTube frequently changes their systems.
- **Connection timeout**: Ensure the bot has **Connect** and **Speak** permissions in the voice channel.

## Architecture

- **youtubei.js** handles YouTube search and video metadata
- **yt-dlp** handles audio extraction (spawned as a child process, pipes audio to stdout)
- **@discordjs/voice** handles the Discord voice connection and audio playback pipeline
- **FFmpeg** (via `ffmpeg-static`) transcodes audio to Opus format for Discord

## TODO:
| Feature | Idea |
|------|---------|
| /loop | `From other music bots lol` |


## License

MIT
