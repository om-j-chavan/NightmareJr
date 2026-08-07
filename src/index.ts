import { generateDependencyReport } from '@discordjs/voice';
import { AudioResolver } from './audio/resolver.js';
import { createBot } from './bot/client.js';
import { loadConfig } from './config.js';
import { createLogger, setLogLevel } from './logger.js';
import { SpotifyClient } from './spotify/client.js';
import { PlaybackWatcher } from './spotify/watcher.js';
import { SyncEngine } from './sync.js';

const log = createLogger('main');

async function main(): Promise<void> {
  const config = loadConfig();
  setLogLevel(config.LOG_LEVEL);

  if (!config.SPOTIFY_REFRESH_TOKEN) {
    throw new Error('SPOTIFY_REFRESH_TOKEN is not set. Run `npm run auth` first.');
  }

  log.debug(`Voice dependency report:\n${generateDependencyReport()}`);

  const spotify = new SpotifyClient({
    clientId: config.SPOTIFY_CLIENT_ID,
    clientSecret: config.SPOTIFY_CLIENT_SECRET,
    refreshToken: config.SPOTIFY_REFRESH_TOKEN,
  });

  const watcher = new PlaybackWatcher(spotify, config.POLL_INTERVAL_MS);
  const resolver = new AudioResolver();
  const sync = new SyncEngine(watcher, resolver, {
    driftToleranceMs: config.DRIFT_TOLERANCE_MS,
    seekLatencyMs: config.SEEK_LATENCY_MS,
  });

  const client = createBot(sync);

  const shutdown = (signal: string): void => {
    log.info(`Received ${signal}, shutting down`);
    if (sync.isActive) sync.detach();
    void client.destroy().finally(() => process.exit(0));
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  await client.login(config.DISCORD_TOKEN);
}

main().catch((error: unknown) => {
  log.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
