import { EventEmitter } from 'node:events';
import { createLogger } from '../logger.js';
import type { SpotifyClient } from './client.js';
import { RateLimitError, SpotifyAuthError } from './client.js';
import type { PlaybackState } from './types.js';

const log = createLogger('watcher');

export interface WatcherEvents {
  /** A different track started (or the first track did). */
  trackChanged: [state: PlaybackState];
  /** Playback resumed on the same track. */
  resumed: [state: PlaybackState];
  /** Playback paused on the same track. */
  paused: [state: PlaybackState];
  /** The user seeked within the current track, beyond normal progression. */
  seeked: [state: PlaybackState];
  /** Routine poll with no discrete change; carries fresh progress for drift checks. */
  tick: [state: PlaybackState];
  /** Spotify reports nothing playing on any device. */
  idle: [];
  error: [error: Error];
}

/**
 * Polls Spotify and turns the raw state snapshots into discrete events.
 *
 * Spotify has no push API for playback, so polling is the only option. The
 * interval backs off automatically when rate limited.
 */
export class PlaybackWatcher extends EventEmitter<WatcherEvents> {
  private timer: NodeJS.Timeout | null = null;
  private previous: PlaybackState | null = null;
  private stopped = true;

  constructor(
    private readonly client: SpotifyClient,
    private readonly pollIntervalMs: number,
    /** Progress jump (beyond elapsed wall time) that counts as a user seek. */
    private readonly seekThresholdMs = 4000,
  ) {
    super();
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    void this.poll();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.previous = null;
  }

  /** Forget history so the next poll re-emits `trackChanged`. */
  reset(): void {
    this.previous = null;
  }

  private schedule(delayMs: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => void this.poll(), delayMs);
  }

  private async poll(): Promise<void> {
    let nextDelay = this.pollIntervalMs;

    try {
      const state = await this.client.getPlaybackState();
      this.diff(state);
    } catch (error) {
      if (error instanceof RateLimitError) {
        nextDelay = Math.max(error.retryAfterMs, this.pollIntervalMs);
        log.warn(`Rate limited; backing off ${nextDelay}ms`);
      } else if (error instanceof SpotifyAuthError) {
        this.emit('error', error);
        nextDelay = this.pollIntervalMs * 5;
      } else {
        this.emit('error', error instanceof Error ? error : new Error(String(error)));
        nextDelay = this.pollIntervalMs * 2;
      }
    }

    this.schedule(nextDelay);
  }

  private diff(state: PlaybackState | null): void {
    const previous = this.previous;

    if (!state) {
      if (previous) {
        log.debug('Playback went idle');
        this.emit('idle');
      }
      this.previous = null;
      return;
    }

    this.previous = state;

    if (!previous || previous.track.id !== state.track.id) {
      log.info(`Track changed → ${state.track.name}`);
      this.emit('trackChanged', state);
      return;
    }

    if (previous.isPlaying !== state.isPlaying) {
      this.emit(state.isPlaying ? 'resumed' : 'paused', state);
      return;
    }

    // A seek shows up as progress that does not match elapsed wall time.
    const elapsed = state.observedAt - previous.observedAt;
    const expected = previous.isPlaying ? previous.progressMs + elapsed : previous.progressMs;
    if (Math.abs(state.progressMs - expected) > this.seekThresholdMs) {
      log.info(`Seek detected → ${Math.round(state.progressMs / 1000)}s`);
      this.emit('seeked', state);
      return;
    }

    this.emit('tick', state);
  }
}
