import 'dotenv/config';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { promisify } from 'node:util';
import { FFMPEG_PATH } from './audio/ffmpeg.js';

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);

/**
 * Preflight check that reports setup progress in plain language.
 *
 * Every check is independent and non-fatal: the point is to show the whole
 * picture at once, so a first-time setup can be finished in one pass rather
 * than discovering the next missing piece only after fixing the last.
 */

type Status = 'ok' | 'todo' | 'fail';

interface Check {
  label: string;
  status: Status;
  detail: string;
  fix?: string;
}

const checks: Check[] = [];

function record(label: string, status: Status, detail: string, fix?: string): void {
  checks.push(fix === undefined ? { label, status, detail } : { label, status, detail, fix });
}

/** Reads an env var, treating blank as absent. */
function env(key: string): string | undefined {
  const value = process.env[key];
  return value === undefined || value === '' ? undefined : value;
}

async function checkEnvFile(): Promise<void> {
  if (existsSync('.env')) {
    record('.env file', 'ok', 'found');
  } else {
    record('.env file', 'todo', 'not found', 'Run: cp .env.example .env');
  }
}

async function checkDiscordToken(): Promise<string | undefined> {
  const token = env('DISCORD_TOKEN');
  if (!token) {
    record(
      'Discord bot token',
      'todo',
      'not set',
      'Developer Portal → your app → Bot tab → Reset Token → paste into DISCORD_TOKEN',
    );
    return undefined;
  }

  try {
    const res = await fetch('https://discord.com/api/v10/users/@me', {
      headers: { Authorization: `Bot ${token}` },
    });
    if (!res.ok) {
      record(
        'Discord bot token',
        'fail',
        `Discord rejected it (HTTP ${res.status})`,
        'The token is wrong or was regenerated. Reset it in the Bot tab and paste the new one.',
      );
      return undefined;
    }
    const bot = (await res.json()) as { username?: string; discriminator?: string };
    record('Discord bot token', 'ok', `authenticated as ${bot.username ?? 'unknown'}`);
    return token;
  } catch (error) {
    record('Discord bot token', 'fail', `could not reach Discord: ${message(error)}`);
    return undefined;
  }
}

async function checkGuild(token: string | undefined): Promise<void> {
  const guildId = env('DISCORD_GUILD_ID');
  if (!guildId) {
    // Optional: without it commands register globally, which still works but
    // can take up to an hour to appear. Not worth blocking a first run on.
    record(
      'Discord server ID',
      'ok',
      'not set (optional — slash commands will take up to 1h to appear)',
    );
    return;
  }
  if (!token) {
    record('Bot is in your server', 'todo', 'cannot check without a valid bot token');
    return;
  }

  try {
    const res = await fetch(`https://discord.com/api/v10/guilds/${guildId}`, {
      headers: { Authorization: `Bot ${token}` },
    });
    if (res.ok) {
      const guild = (await res.json()) as { name?: string };
      record('Bot is in your server', 'ok', `joined "${guild.name ?? guildId}"`);
    } else if (res.status === 403 || res.status === 404) {
      record(
        'Bot is in your server',
        'todo',
        'the bot has not been invited yet',
        'Open the invite link printed at the bottom of this report.',
      );
    } else {
      record('Bot is in your server', 'fail', `Discord returned HTTP ${res.status}`);
    }
  } catch (error) {
    record('Bot is in your server', 'fail', `could not reach Discord: ${message(error)}`);
  }
}

async function checkSpotifyApp(): Promise<boolean> {
  const id = env('SPOTIFY_CLIENT_ID');
  const secret = env('SPOTIFY_CLIENT_SECRET');

  if (!id) {
    record('Spotify client ID', 'todo', 'not set', 'Spotify dashboard → Basic Information → Client ID');
    return false;
  }
  if (!secret) {
    record(
      'Spotify client secret',
      'todo',
      'not set',
      'Spotify dashboard → Basic Information → View client secret',
    );
    return false;
  }

  // client_credentials proves the id/secret pair is valid without needing the
  // user to have authorized anything yet.
  try {
    const res = await fetch('https://accounts.spotify.com/api/token', {
      method: 'POST',
      headers: {
        Authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString('base64')}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ grant_type: 'client_credentials' }),
    });
    if (res.ok) {
      record('Spotify app credentials', 'ok', 'client ID and secret accepted');
      return true;
    }
    record(
      'Spotify app credentials',
      'fail',
      `Spotify rejected them (HTTP ${res.status})`,
      'Re-copy both values from the dashboard — the secret is easy to truncate.',
    );
    return false;
  } catch (error) {
    record('Spotify app credentials', 'fail', `could not reach Spotify: ${message(error)}`);
    return false;
  }
}

async function checkSpotifyAccount(appOk: boolean): Promise<void> {
  const refresh = env('SPOTIFY_REFRESH_TOKEN');
  if (!refresh) {
    record(
      'Spotify account authorized',
      'todo',
      'not set',
      appOk
        ? 'Run: npm run auth  — then paste the printed token into SPOTIFY_REFRESH_TOKEN'
        : 'Fill in the client ID and secret first, then run: npm run auth',
    );
    return;
  }

  const id = env('SPOTIFY_CLIENT_ID');
  const secret = env('SPOTIFY_CLIENT_SECRET');
  if (!id || !secret) return;

  try {
    const tokenRes = await fetch('https://accounts.spotify.com/api/token', {
      method: 'POST',
      headers: {
        Authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString('base64')}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refresh }),
    });

    if (!tokenRes.ok) {
      record(
        'Spotify account authorized',
        'fail',
        `refresh token rejected (HTTP ${tokenRes.status})`,
        'It may have hit its lifetime. Run: npm run auth  — and paste the new token.',
      );
      return;
    }

    const { access_token } = (await tokenRes.json()) as { access_token: string };
    record('Spotify account authorized', 'ok', 'refresh token works');

    const playerRes = await fetch('https://api.spotify.com/v1/me/player', {
      headers: { Authorization: `Bearer ${access_token}` },
    });

    if (playerRes.status === 204) {
      record(
        'Spotify is playing something',
        'todo',
        'nothing playing right now',
        'Start a song in your Spotify app — the bot mirrors playback, it cannot start it.',
      );
      return;
    }

    const state = (await playerRes.json()) as {
      is_playing?: boolean;
      device?: { name?: string };
      item?: { name?: string; artists?: { name: string }[] };
    };
    const title = state.item?.name ?? 'unknown';
    const artist = state.item?.artists?.map((a) => a.name).join(', ') ?? 'unknown';
    const where = state.device?.name ? ` on ${state.device.name}` : '';
    record(
      'Spotify is playing something',
      'ok',
      `${state.is_playing ? 'playing' : 'paused'}: ${artist} - ${title}${where}`,
    );
  } catch (error) {
    record('Spotify account authorized', 'fail', `could not reach Spotify: ${message(error)}`);
  }
}

async function checkBinaries(): Promise<void> {
  try {
    const { YOUTUBE_DL_PATH } = require('youtube-dl-exec').constants as { YOUTUBE_DL_PATH: string };
    const { stdout } = await execFileAsync(YOUTUBE_DL_PATH, ['--version'], { timeout: 30_000 });
    record('yt-dlp (audio source)', 'ok', `version ${stdout.trim()}`);
  } catch (error) {
    record('yt-dlp (audio source)', 'fail', message(error), 'Try: npm install');
  }

  try {
    await execFileAsync(FFMPEG_PATH, ['-hide_banner', '-version'], { timeout: 30_000 });
    record('ffmpeg (audio encoding)', 'ok', 'bundled binary works');
  } catch (error) {
    record('ffmpeg (audio encoding)', 'fail', message(error), 'Try: npm install');
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function render(): void {
  const SYMBOL: Record<Status, string> = { ok: '  OK  ', todo: ' TODO ', fail: ' FAIL ' };

  console.log('\nNightmareJr setup check\n');

  const width = Math.max(...checks.map((c) => c.label.length));
  for (const check of checks) {
    console.log(`[${SYMBOL[check.status]}] ${check.label.padEnd(width)}  ${check.detail}`);
  }

  const outstanding = checks.filter((c) => c.status !== 'ok');

  if (outstanding.length === 0) {
    console.log('\nEverything checks out. Start the bot with:\n\n  npm run dev\n');
    console.log('Then join a voice channel in Discord and type /join\n');
    return;
  }

  console.log(`\n${outstanding.length} thing(s) left. Next steps, in order:\n`);
  let step = 1;
  for (const check of outstanding) {
    if (!check.fix) continue;
    console.log(`  ${step}. ${check.label}`);
    console.log(`     ${check.fix}\n`);
    step += 1;
  }

  const clientId = env('DISCORD_CLIENT_ID');
  if (clientId) {
    console.log('Invite link for your bot (Connect + Speak only):\n');
    console.log(
      `  https://discord.com/api/oauth2/authorize?client_id=${clientId}&permissions=3145728&scope=bot%20applications.commands\n`,
    );
  }
}

async function main(): Promise<void> {
  await checkEnvFile();
  const token = await checkDiscordToken();
  await checkGuild(token);
  const appOk = await checkSpotifyApp();
  await checkSpotifyAccount(appOk);
  await checkBinaries();
  render();
}

await main();
