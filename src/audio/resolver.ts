import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { promisify } from 'node:util';
import { createLogger } from '../logger.js';
import { describeTrack } from '../spotify/client.js';
import type { SpotifyTrack } from '../spotify/types.js';

const log = createLogger('resolver');

const execFileAsync = promisify(execFile);

// youtube-dl-exec exists here purely to download and version-manage the yt-dlp
// binary. Its own runner shells out through cmd.exe on Windows, which mangles
// arguments containing shell metacharacters, so the binary is invoked directly.
const require = createRequire(import.meta.url);
const { YOUTUBE_DL_PATH } = require('youtube-dl-exec').constants as { YOUTUBE_DL_PATH: string };

/** Separator unlikely to appear in a video title, and not a shell metacharacter. */
const FIELD_SEP = '@@@';

export interface ResolvedAudio {
  /** Direct media URL that ffmpeg can open. Signed and time-limited. */
  streamUrl: string;
  sourceTitle: string;
  durationMs: number;
}

export class NoAudioSourceError extends Error {}

/**
 * Finds a streamable audio URL for a Spotify track.
 *
 * Spotify's API never exposes audio, so the track metadata becomes a search
 * query and the best audio-only format is extracted from the result.
 *
 * `--print` is used rather than `--dump-single-json` deliberately: the full
 * JSON for one video is megabytes of format and storyboard metadata, and
 * buffering it costs more time than the extraction itself.
 */
export class AudioResolver {
  private readonly cache = new Map<string, { value: ResolvedAudio; expiresAt: number }>();

  constructor(
    /** Signed URLs expire; keep well under that window. */
    private readonly cacheTtlMs = 30 * 60 * 1000,
    private readonly timeoutMs = 30_000,
  ) {}

  async resolve(track: SpotifyTrack): Promise<ResolvedAudio> {
    const cached = this.cache.get(track.id);
    if (cached && Date.now() < cached.expiresAt) {
      log.debug(`Cache hit for ${track.id}`);
      return cached.value;
    }

    const query = describeTrack(track);
    log.debug(`Resolving "${query}"`);

    const raw = await this.runYtDlp(query);
    const firstLine = raw.trim().split('\n')[0] ?? '';
    const [streamUrl, title, duration] = firstLine.split(FIELD_SEP);

    if (!streamUrl?.startsWith('http')) {
      throw new NoAudioSourceError(`No playable source found for "${query}"`);
    }

    const seconds = Number(duration);
    const resolved: ResolvedAudio = {
      streamUrl,
      sourceTitle: title || query,
      durationMs: Number.isFinite(seconds) ? seconds * 1000 : 0,
    };

    this.cache.set(track.id, { value: resolved, expiresAt: Date.now() + this.cacheTtlMs });
    log.info(`Resolved "${query}" → ${resolved.sourceTitle}`);
    return resolved;
  }

  private async runYtDlp(query: string): Promise<string> {
    const args = [
      `ytsearch1:${query} audio`,
      '--no-warnings',
      '--no-playlist',
      '--format',
      'bestaudio[acodec=opus]/bestaudio/best',
      '--print',
      `%(urls)s${FIELD_SEP}%(title)s${FIELD_SEP}%(duration)s`,
    ];

    try {
      const { stdout } = await execFileAsync(YOUTUBE_DL_PATH, args, {
        timeout: this.timeoutMs,
        maxBuffer: 1024 * 1024,
        windowsHide: true,
      });
      return stdout;
    } catch (error) {
      const err = error as NodeJS.ErrnoException & { stderr?: string; killed?: boolean };
      if (err.killed) {
        throw new NoAudioSourceError(`Timed out resolving "${query}" after ${this.timeoutMs}ms`);
      }
      throw new NoAudioSourceError(
        `yt-dlp failed for "${query}": ${err.stderr?.trim() || err.message}`,
      );
    }
  }

  invalidate(trackId: string): void {
    this.cache.delete(trackId);
  }
}
