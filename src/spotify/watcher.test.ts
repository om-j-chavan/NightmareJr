import { describe, expect, it, vi } from 'vitest';
import { PlaybackWatcher } from './watcher.js';
import type { SpotifyClient } from './client.js';
import type { PlaybackState, SpotifyTrack } from './types.js';

function track(id: string): SpotifyTrack {
  return {
    id,
    name: `Track ${id}`,
    artists: ['Someone'],
    album: 'An Album',
    durationMs: 200_000,
    artworkUrl: undefined,
    externalUrl: undefined,
  };
}

function state(overrides: Partial<PlaybackState> & { track: SpotifyTrack }): PlaybackState {
  return {
    progressMs: 0,
    isPlaying: true,
    deviceName: 'Phone',
    observedAt: 1_000_000,
    ...overrides,
  };
}

/** Drives the private diff logic through one snapshot at a time. */
function feed(watcher: PlaybackWatcher, snapshots: (PlaybackState | null)[]): string[] {
  const events: string[] = [];
  for (const name of ['trackChanged', 'resumed', 'paused', 'seeked', 'tick', 'idle'] as const) {
    watcher.on(name, () => events.push(name));
  }
  const diff = Reflect.get(watcher, 'diff') as (s: PlaybackState | null) => void;
  for (const snapshot of snapshots) diff.call(watcher, snapshot);
  return events;
}

const stubClient = {} as SpotifyClient;

describe('PlaybackWatcher', () => {
  it('emits trackChanged on the first observed track', () => {
    const watcher = new PlaybackWatcher(stubClient, 2000);
    expect(feed(watcher, [state({ track: track('a') })])).toEqual(['trackChanged']);
  });

  it('emits trackChanged when the track id changes', () => {
    const watcher = new PlaybackWatcher(stubClient, 2000);
    const events = feed(watcher, [
      state({ track: track('a') }),
      state({ track: track('b'), observedAt: 1_002_000 }),
    ]);
    expect(events).toEqual(['trackChanged', 'trackChanged']);
  });

  it('emits paused and resumed on play-state flips', () => {
    const watcher = new PlaybackWatcher(stubClient, 2000);
    const events = feed(watcher, [
      state({ track: track('a') }),
      state({ track: track('a'), isPlaying: false, observedAt: 1_002_000, progressMs: 2000 }),
      state({ track: track('a'), isPlaying: true, observedAt: 1_004_000, progressMs: 2000 }),
    ]);
    expect(events).toEqual(['trackChanged', 'paused', 'resumed']);
  });

  it('treats normal progression as a tick, not a seek', () => {
    const watcher = new PlaybackWatcher(stubClient, 2000);
    const events = feed(watcher, [
      state({ track: track('a'), progressMs: 10_000 }),
      // 2s of wall time, 2s of progress — exactly what playing looks like.
      state({ track: track('a'), progressMs: 12_000, observedAt: 1_002_000 }),
    ]);
    expect(events).toEqual(['trackChanged', 'tick']);
  });

  it('emits seeked when progress jumps beyond elapsed wall time', () => {
    const watcher = new PlaybackWatcher(stubClient, 2000);
    const events = feed(watcher, [
      state({ track: track('a'), progressMs: 10_000 }),
      // 2s of wall time but 50s of progress — the user dragged the scrubber.
      state({ track: track('a'), progressMs: 60_000, observedAt: 1_002_000 }),
    ]);
    expect(events).toEqual(['trackChanged', 'seeked']);
  });

  it('emits idle only after something was playing', () => {
    const watcher = new PlaybackWatcher(stubClient, 2000);
    expect(feed(watcher, [null, null])).toEqual([]);

    const second = new PlaybackWatcher(stubClient, 2000);
    expect(feed(second, [state({ track: track('a') }), null])).toEqual(['trackChanged', 'idle']);
  });

  it('re-emits trackChanged for the same track after reset', () => {
    const watcher = new PlaybackWatcher(stubClient, 2000);
    const events: string[] = [];
    watcher.on('trackChanged', () => events.push('trackChanged'));
    const diff = Reflect.get(watcher, 'diff') as (s: PlaybackState | null) => void;

    diff.call(watcher, state({ track: track('a') }));
    watcher.reset();
    diff.call(watcher, state({ track: track('a'), observedAt: 1_002_000 }));

    expect(events).toEqual(['trackChanged', 'trackChanged']);
  });

  it('stops polling when stopped', () => {
    vi.useFakeTimers();
    const client = { getPlaybackState: vi.fn().mockResolvedValue(null) } as unknown as SpotifyClient;
    const watcher = new PlaybackWatcher(client, 2000);

    watcher.start();
    watcher.stop();
    vi.advanceTimersByTime(10_000);

    // Only the immediate first poll from start() should have fired.
    expect((client.getPlaybackState as ReturnType<typeof vi.fn>).mock.calls.length).toBeLessThanOrEqual(1);
    vi.useRealTimers();
  });
});
