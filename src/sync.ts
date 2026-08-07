import { EventEmitter } from 'node:events';
import type { VoiceConnection } from '@discordjs/voice';
import type { AudioResolver} from './audio/resolver.js';
import { NoAudioSourceError } from './audio/resolver.js';
import { SeekablePlayer } from './audio/player.js';
import { createLogger } from './logger.js';
import type { PlaybackWatcher } from './spotify/watcher.js';
import { describeTrack } from './spotify/client.js';
import type { PlaybackState, SpotifyTrack } from './spotify/types.js';

const log = createLogger('sync');

export interface SyncEvents {
  nowPlaying: [track: SpotifyTrack, sourceTitle: string];
  stopped: [];
  resolveFailed: [track: SpotifyTrack, error: Error];
  error: [error: Error];
}

export interface SyncOptions {
  driftToleranceMs: number;
  /** Added to every seek target to offset API + ffmpeg startup latency. */
  seekLatencyMs: number;
}

/**
 * Keeps the Discord voice stream aligned with the user's Spotify playback.
 *
 * The watcher reports what Spotify is doing; this class makes the Discord
 * player match it — same track, same position, same play/pause state.
 */
export class SyncEngine extends EventEmitter<SyncEvents> {
  readonly player = new SeekablePlayer();

  private connection: VoiceConnection | null = null;
  private activeTrackId: string | null = null;
  private currentTrack: SpotifyTrack | null = null;
  /** Guards against overlapping resolves when tracks change rapidly. */
  private resolveGeneration = 0;

  constructor(
    private readonly watcher: PlaybackWatcher,
    private readonly resolver: AudioResolver,
    private readonly options: SyncOptions,
  ) {
    super();
    this.wire();
  }

  attach(connection: VoiceConnection): void {
    this.connection = connection;
    this.player.subscribe(connection);
    // Forget prior state so the current track is re-announced and re-synced.
    this.watcher.reset();
    this.activeTrackId = null;
    this.watcher.start();
    log.info('Sync attached to voice connection');
  }

  detach(): void {
    this.watcher.stop();
    this.player.stop();
    this.connection?.destroy();
    this.connection = null;
    this.activeTrackId = null;
    this.currentTrack = null;
    this.resolveGeneration += 1;
    this.emit('stopped');
    log.info('Sync detached');
  }

  get isActive(): boolean {
    return this.connection !== null;
  }

  get nowPlaying(): SpotifyTrack | null {
    return this.currentTrack;
  }

  /**
   * Re-reads Spotify and rebuilds the stream from scratch.
   *
   * The drift correction handles ordinary slippage on its own; this exists for
   * when the stream is wedged badly enough that a clean restart is faster.
   */
  forceResync(): void {
    this.activeTrackId = null;
    this.watcher.reset();
  }

  private wire(): void {
    this.watcher.on('trackChanged', (state) => void this.startTrack(state));
    this.watcher.on('seeked', (state) => this.alignPosition(state, true));
    this.watcher.on('tick', (state) => this.alignPosition(state, false));

    this.watcher.on('paused', () => {
      log.info('Spotify paused → pausing Discord');
      this.player.pause();
    });

    this.watcher.on('resumed', (state) => {
      log.info('Spotify resumed → resuming Discord');
      this.player.resume();
      this.alignPosition(state, true);
    });

    this.watcher.on('idle', () => {
      log.info('Spotify idle → stopping Discord playback');
      this.player.stop();
      this.activeTrackId = null;
      this.currentTrack = null;
    });

    this.watcher.on('error', (error) => this.emit('error', error));
  }

  private async startTrack(state: PlaybackState): Promise<void> {
    const generation = ++this.resolveGeneration;
    this.activeTrackId = state.track.id;
    this.currentTrack = state.track;

    try {
      const audio = await this.resolver.resolve(state.track);

      // The user skipped again while this resolve was in flight — drop it.
      if (generation !== this.resolveGeneration) {
        log.debug(`Discarding stale resolve for ${state.track.name}`);
        return;
      }

      const target = this.targetPosition(state);
      this.player.play(audio.streamUrl, target);

      if (!state.isPlaying) this.player.pause();

      this.emit('nowPlaying', state.track, audio.sourceTitle);
    } catch (error) {
      if (generation !== this.resolveGeneration) return;

      const err = error instanceof Error ? error : new Error(String(error));
      log.error(`Could not play "${describeTrack(state.track)}": ${err.message}`);
      this.resolver.invalidate(state.track.id);
      this.emit(
        'resolveFailed',
        state.track,
        err instanceof NoAudioSourceError ? err : new NoAudioSourceError(err.message),
      );
    }
  }

  /**
   * Nudges the Discord stream back onto Spotify's clock.
   *
   * `force` re-seeks regardless of drift, for events where we know the
   * position jumped. Otherwise a tolerance avoids re-seeking on the constant
   * sub-second jitter of polling a remote API.
   */
  private alignPosition(state: PlaybackState, force: boolean): void {
    if (state.track.id !== this.activeTrackId) return;
    if (!state.isPlaying && !force) return;

    const target = this.targetPosition(state);
    const drift = target - this.player.position();

    if (!force && Math.abs(drift) <= this.options.driftToleranceMs) return;

    log.debug(`Drift ${Math.round(drift)}ms → re-seeking`);
    this.player.seek(Math.max(0, target));
    if (!state.isPlaying) this.player.pause();
  }

  /** Spotify's reported progress, advanced to account for our own latency. */
  private targetPosition(state: PlaybackState): number {
    const sincePoll = state.isPlaying ? Date.now() - state.observedAt : 0;
    return state.progressMs + sincePoll + (state.isPlaying ? this.options.seekLatencyMs : 0);
  }
}
