import 'dotenv/config';
import { z } from 'zod';

const schema = z.object({
  DISCORD_TOKEN: z.string().min(1),
  DISCORD_CLIENT_ID: z.string().min(1),
  DISCORD_GUILD_ID: z.string().optional(),

  SPOTIFY_CLIENT_ID: z.string().min(1),
  SPOTIFY_CLIENT_SECRET: z.string().min(1),
  SPOTIFY_REDIRECT_URI: z.string().url().default('http://127.0.0.1:8888/callback'),
  SPOTIFY_REFRESH_TOKEN: z.string().optional(),

  POLL_INTERVAL_MS: z.coerce.number().int().min(1000).default(2000),
  DRIFT_TOLERANCE_MS: z.coerce.number().int().min(500).default(2500),
  SEEK_LATENCY_MS: z.coerce.number().int().min(0).default(800),

  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
});

export type Config = z.infer<typeof schema>;

/**
 * Parses and validates the environment.
 *
 * `required` lets a partial entrypoint (the one-shot OAuth script) boot with
 * only the Spotify credentials present, instead of demanding a Discord token
 * it will never use.
 */
export function loadConfig(required: 'all' | 'spotify-only' = 'all'): Config {
  const source =
    required === 'spotify-only'
      ? { DISCORD_TOKEN: 'unused', DISCORD_CLIENT_ID: 'unused', ...process.env }
      : process.env;

  const result = schema.safeParse(source);
  if (!result.success) {
    const missing = result.error.issues
      .map((i) => `  ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${missing}\n\nCopy .env.example to .env and fill it in.`);
  }
  return result.data;
}
