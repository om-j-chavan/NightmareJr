import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from './config.js';

const KEYS = [
  'DISCORD_TOKEN',
  'DISCORD_CLIENT_ID',
  'DISCORD_GUILD_ID',
  'SPOTIFY_CLIENT_ID',
  'SPOTIFY_CLIENT_SECRET',
  'SPOTIFY_REDIRECT_URI',
  'SPOTIFY_REFRESH_TOKEN',
  'POLL_INTERVAL_MS',
  'DRIFT_TOLERANCE_MS',
  'SEEK_LATENCY_MS',
  'LOG_LEVEL',
] as const;

let saved: Record<string, string | undefined> = {};

beforeEach(() => {
  saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  for (const key of KEYS) delete process.env[key];
});

afterEach(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe('loadConfig', () => {
  it('runs the auth script with a freshly copied .env where only Spotify is filled in', () => {
    // Exactly what `cp .env.example .env` plus the Spotify steps produces:
    // the Discord keys are present but blank.
    process.env.DISCORD_TOKEN = '';
    process.env.DISCORD_CLIENT_ID = '';
    process.env.DISCORD_GUILD_ID = '';
    process.env.SPOTIFY_CLIENT_ID = 'abc123';
    process.env.SPOTIFY_CLIENT_SECRET = 'secret';
    process.env.SPOTIFY_REFRESH_TOKEN = '';

    const config = loadConfig('spotify-only');

    expect(config.SPOTIFY_CLIENT_ID).toBe('abc123');
    expect(config.SPOTIFY_REDIRECT_URI).toBe('http://127.0.0.1:8888/callback');
  });

  it('applies defaults when tuning values are blank rather than absent', () => {
    process.env.DISCORD_TOKEN = 'token';
    process.env.DISCORD_CLIENT_ID = 'id';
    process.env.SPOTIFY_CLIENT_ID = 'abc123';
    process.env.SPOTIFY_CLIENT_SECRET = 'secret';
    process.env.POLL_INTERVAL_MS = '';
    process.env.LOG_LEVEL = '';

    const config = loadConfig();

    expect(config.POLL_INTERVAL_MS).toBe(2000);
    expect(config.DRIFT_TOLERANCE_MS).toBe(2500);
    expect(config.LOG_LEVEL).toBe('info');
  });

  it('still rejects a genuinely incomplete environment', () => {
    process.env.SPOTIFY_CLIENT_ID = 'abc123';
    expect(() => loadConfig()).toThrow(/DISCORD_TOKEN/);
  });

  it('honours real values over placeholders', () => {
    process.env.DISCORD_TOKEN = 'real-token';
    process.env.DISCORD_CLIENT_ID = 'real-id';
    process.env.SPOTIFY_CLIENT_ID = 'abc123';
    process.env.SPOTIFY_CLIENT_SECRET = 'secret';
    process.env.POLL_INTERVAL_MS = '5000';

    const config = loadConfig('spotify-only');

    expect(config.DISCORD_TOKEN).toBe('real-token');
    expect(config.POLL_INTERVAL_MS).toBe(5000);
  });
});
