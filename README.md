# NightmareJr

A Discord bot that mirrors your Spotify playback into a voice channel. Play, pause, skip or
scrub on your phone or desktop Spotify app, and the bot follows along in Discord.

## How it works, and one important caveat

**Spotify's API does not give out audio.** There is no endpoint, on any plan, that returns a
playable stream. What it does give is *state*: which track is playing, where you are in it, and
whether it is paused.

So the bot splits those two concerns:

| Concern | Source |
| --- | --- |
| What's playing, where, and whether it's paused | Spotify Web API (`GET /v1/me/player`, polled) |
| The actual audio | YouTube, located by searching `Artist - Title` and streamed via yt-dlp |

The sync loop looks like this:

```
Your Spotify app                Spotify Web API             NightmareJr
     │                                │                          │
     ├─ play / skip / seek ──────────▶│                          │
     │                                │◀──── poll every 2s ──────┤
     │                                │                          │
     │                                │  { track, progress_ms,   │
     │                                ├─────  is_playing } ─────▶│
     │                                │                          │
     │                                │              track changed?
     │                                │                 └─ yt-dlp search
     │                                │                 └─ ffmpeg -ss <progress>
     │                                │                          │
     │                                │              drifted >2.5s?
     │                                │                 └─ re-seek
     │                                │                          ▼
     │                                │                  Discord voice channel
```

Because the audio comes from a different source than Spotify, expect two things:

- **The match is not always perfect.** The search picks the top YouTube result, which is
  usually the official audio but occasionally a live version or a remix.
- **Sync is approximate.** The bot re-seeks whenever it drifts more than `DRIFT_TOLERANCE_MS`
  from Spotify. You will hear a brief gap when that happens. Tune `SEEK_LATENCY_MS` if audio
  consistently lands early or late.

Worth knowing before you rely on this: streaming YouTube audio this way is against YouTube's
Terms of Service, which is why every large public bot doing it has been shut down. For a private
server this is a practical hobby setup, not something to publish.

If you want *genuine* Spotify audio instead, the alternative is
[librespot](https://github.com/librespot-org/librespot) — the bot registers itself as a Spotify
Connect device and you select it in your Spotify app. That needs Spotify Premium and moves
playback to the bot rather than mirroring your device. See [Swapping the audio source](#swapping-the-audio-source).

## Requirements

- Node.js 20 or newer (developed on 22)
- A Discord application with a bot user
- A Spotify account and a Spotify developer application

ffmpeg and yt-dlp are installed automatically as npm dependencies — you do not need them on your PATH.

## Setup

### 1. Install

```bash
npm install
cp .env.example .env
```

### 2. Create the Discord bot

1. Go to the [Discord Developer Portal](https://discord.com/developers/applications) → **New Application**.
2. **Bot** → **Reset Token** → copy it into `DISCORD_TOKEN`.
3. **General Information** → copy the Application ID into `DISCORD_CLIENT_ID`.
4. **OAuth2 → URL Generator**: tick scopes `bot` and `applications.commands`, and bot
   permissions **Connect** and **Speak**. Open the generated URL to invite the bot to your server.
5. Right-click your server → **Copy Server ID** → `DISCORD_GUILD_ID`. (This makes slash commands
   register instantly instead of taking up to an hour.)

No privileged gateway intents are required.

### 3. Create the Spotify app

1. Go to the [Spotify Developer Dashboard](https://developer.spotify.com/dashboard) → **Create app**.
2. Copy the Client ID and Client Secret into `SPOTIFY_CLIENT_ID` / `SPOTIFY_CLIENT_SECRET`.
3. In the app settings, add this exact **Redirect URI**:

   ```
   http://127.0.0.1:8888/callback
   ```

   Spotify rejects `localhost` — it must be the loopback IP.

### 4. Authorize your Spotify account

```bash
npm run auth
```

This prints a URL. Open it, approve access, and the script prints a `SPOTIFY_REFRESH_TOKEN`.
Paste that into `.env`.

You will need to repeat this occasionally. Spotify enforces a refresh-token lifetime per app —
check **Refresh Token Lifetime** on your app's Basic Information page; development-mode apps show
180 days. When it lapses the bot logs a token-refresh failure telling you to re-run this command.
Revoking access or changing the requested scopes also invalidates the token.

### 5. Check your setup

```bash
npm run doctor
```

This verifies every credential against the live Discord and Spotify APIs, confirms the bot has
been invited to your server, checks the bundled yt-dlp and ffmpeg binaries, and prints the
remaining steps in order. Run it whenever something isn't working — it is faster than reading
logs. It is read-only and safe to run at any time.

### 6. Register the slash commands and run

```bash
npm run commands
npm run dev
```

## Usage

Join a voice channel, then:

| Command | Effect |
| --- | --- |
| `/join` | Bot joins your voice channel and starts mirroring your Spotify |
| `/leave` | Stop mirroring and disconnect |
| `/nowplaying` | Show the current track, position and album art |
| `/resync` | Force a full re-sync if the audio has drifted badly |

Now just play something on Spotify. Skipping, pausing and scrubbing all propagate within about
one poll interval.

## Configuration

Everything below lives in `.env` and is validated at startup.

| Variable | Default | Purpose |
| --- | --- | --- |
| `POLL_INTERVAL_MS` | `2000` | How often to ask Spotify what's playing. Lower is snappier but closer to rate limits. |
| `DRIFT_TOLERANCE_MS` | `2500` | How far out of sync the stream may drift before a corrective re-seek. |
| `SEEK_LATENCY_MS` | `800` | Added to every seek target to compensate for API and ffmpeg startup delay. Raise it if audio lands late. |
| `LOG_LEVEL` | `info` | Set to `debug` to see drift measurements and every resolve. |

## Project layout

```
src/
  index.ts              Entrypoint — wires everything together
  config.ts             Environment loading and validation (zod)
  sync.ts               Keeps Discord playback aligned with Spotify
  auth/server.ts        One-shot OAuth flow for the refresh token
  spotify/
    client.ts           Token refresh + Web API calls
    watcher.ts          Polls playback, emits discrete change events
    types.ts
  audio/
    resolver.ts         Spotify track → streamable URL, via yt-dlp
    ffmpeg.ts           ffmpeg process spawning and capability probing
    player.ts           Seekable wrapper over @discordjs/voice
  bot/
    client.ts           discord.js client and command handlers
    commands.ts         Slash command definitions
    deploy-commands.ts  Registers commands with Discord
```

The interesting design constraint is in `player.ts`: `@discordjs/voice` has no seek primitive,
because an audio resource is a one-way stream. Seeking therefore means killing the ffmpeg process
and respawning it with a new `-ss` offset. `SeekablePlayer.position()` tracks that offset so the
rest of the code can reason in absolute track time.

## Swapping the audio source

`SyncEngine` depends on `AudioResolver` only through its `resolve(track) → { streamUrl }` shape.
To move to librespot or any other backend, provide something with that method and pass it in
`src/index.ts`. Nothing else needs to change.

## Development

```bash
npm run dev        # watch mode
npm run typecheck  # tsc --noEmit
npm run lint       # eslint
npm test           # vitest
npm run build      # compile to dist/
npm start          # run the compiled build
```

## Troubleshooting

**"SPOTIFY_REFRESH_TOKEN is not set"** — run `npm run auth`.

**Token refresh failed (400)** — the refresh token hit its lifetime, was revoked, or the client
secret changed. Run `npm run auth` again and paste the new token into `.env`.

**Slash commands don't appear** — run `npm run commands`. Without `DISCORD_GUILD_ID` set, global
registration can take up to an hour.

**Bot joins but stays silent** — check Spotify is actually playing on some device, and run with
`LOG_LEVEL=debug` to see whether resolution is failing. A track that yt-dlp can't find is logged
and skipped rather than crashing the bot.

**Audio consistently starts slightly late or early** — adjust `SEEK_LATENCY_MS`.

**Frequent gaps in playback** — raise `DRIFT_TOLERANCE_MS` so the bot re-seeks less aggressively.
