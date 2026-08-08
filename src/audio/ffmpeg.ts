import { spawn, spawnSync } from 'node:child_process';
import type { ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';
import { createRequire } from 'node:module';
import { createLogger } from '../logger.js';

const log = createLogger('ffmpeg');

// ffmpeg-static is CommonJS whose whole export is the path string, which the
// ESM default-import interop does not model correctly. require() is exact.
const require = createRequire(import.meta.url);

/** Bundled binary, falling back to whatever is on PATH. */
export const FFMPEG_PATH: string = (require('ffmpeg-static') as string | null) ?? 'ffmpeg';

/** ffmpeg is spawned with stdin ignored, so only stdout/stderr are streams. */
export type FfmpegProcess = ChildProcessByStdio<null, Readable, Readable>;

let libopusAvailable: boolean | null = null;

/**
 * Whether this ffmpeg build can encode Opus directly.
 *
 * When it can, ffmpeg emits Ogg/Opus that Discord accepts verbatim. When it
 * cannot, we fall back to raw PCM and let the JS Opus encoder do the work —
 * correct either way, just more CPU.
 */
export function hasLibopus(): boolean {
  if (libopusAvailable !== null) return libopusAvailable;

  try {
    const probe = spawnSync(FFMPEG_PATH, ['-hide_banner', '-encoders'], { encoding: 'utf8' });
    libopusAvailable = (probe.stdout ?? '').includes('libopus');
  } catch {
    libopusAvailable = false;
  }

  log.info(libopusAvailable ? 'Using ffmpeg libopus encoding' : 'libopus unavailable; using raw PCM');
  return libopusAvailable;
}

export interface StreamSpec {
  url: string;
  /** Where to start playback within the source, in milliseconds. */
  seekMs: number;
  /**
   * Set when the source is already Opus, allowing a straight remux.
   *
   * Discord consumes Opus, and YouTube's best audio is usually Opus already,
   * so decoding and re-encoding it only adds a lossy generation and CPU load
   * for no benefit.
   */
  copyOpus?: boolean;
  /** Bitrate for the transcode path. Ignored when remuxing. */
  bitrate?: string;
}

/**
 * Spawns ffmpeg positioned at `seekMs`.
 *
 * `-ss` is placed before `-i` so ffmpeg seeks by demuxing rather than decoding
 * everything up to the offset — the difference between instant and unusable on
 * a long track.
 */
export function spawnStream({
  url,
  seekMs,
  copyOpus = false,
  bitrate = '128k',
}: StreamSpec): FfmpegProcess {
  const seekSeconds = Math.max(0, seekMs / 1000).toFixed(3);

  const args = [
    '-hide_banner',
    '-loglevel', 'error',
    // Keep the network source alive across transient hiccups.
    '-reconnect', '1',
    '-reconnect_streamed', '1',
    '-reconnect_delay_max', '5',
    '-ss', seekSeconds,
    '-i', url,
    '-vn',
  ];

  if (copyOpus) {
    // Straight passthrough: no decode, no re-encode, no quality loss. Sample
    // rate and channel flags are deliberately omitted — they would force a
    // decode and defeat the point.
    args.push('-c:a', 'copy', '-f', 'ogg');
  } else if (hasLibopus()) {
    args.push('-ar', '48000', '-ac', '2', '-c:a', 'libopus', '-b:a', bitrate, '-f', 'ogg');
  } else {
    args.push('-ar', '48000', '-ac', '2', '-f', 's16le');
  }

  args.push('pipe:1');

  const child = spawn(FFMPEG_PATH, args, { stdio: ['ignore', 'pipe', 'pipe'] });

  child.stderr.on('data', (chunk: Buffer) => {
    const text = chunk.toString().trim();
    if (text) log.debug(text);
  });

  return child;
}
