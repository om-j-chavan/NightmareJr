import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SyncEngine } from './sync.js';
import type { AudioResolver, ResolvedAudio } from './audio/resolver.js';
import type { PlaybackWatcher } from './spotify/watcher.js';
import type { PlaybackState, SpotifyTrack } from './spotify/types.js';

function track(id: string): SpotifyTrack {
  return {
    id,
    name: `Track ${id}`,
    artists: ['Someone'],
    album: 'An Album',
    durationMs: 300_000,
    artworkUrl: undefined,
    externalUrl: undefined,
  };
}

function state(id: string, progressMs: number): PlaybackState {
  return {
    track: track(id),
    progressMs,
    isPlaying: true,
    deviceName: 'Phone',
    observedAt: Date.now(),
  };
}

const audio: ResolvedAudio = {
  streamUrl: 'https://example.test/audio',
  sourceTitle: 'Some Match',
  durationMs: 300_000,
  isOpus: true,
};

/** A watcher stand-in whose events the test drives by hand. */
function fakeWatcher(): PlaybackWatcher {
  const emitter = new EventEmitter();
  return Object.assign(emitter, {
    start: vi.fn(),
    stop: vi.fn(),
    reset: vi.fn(),
  }) as unknown as PlaybackWatcher;
}

describe('SyncEngine position correction', () => {
  let watcher: PlaybackWatcher;
  let resolveTrack: () => void;
  let resolver: AudioResolver;
  let sync: SyncEngine;
  let play: ReturnType<typeof vi.spyOn>;
  let seek: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    watcher = fakeWatcher();

    // A resolve the test can hold open, mimicking the seconds yt-dlp takes.
    resolver = {
      resolve: vi.fn(
        () =>
          new Promise<ResolvedAudio>((res) => {
            resolveTrack = () => res(audio);
          }),
      ),
      invalidate: vi.fn(),
    } as unknown as AudioResolver;

    sync = new SyncEngine(watcher, resolver, { driftToleranceMs: 2500, seekLatencyMs: 800 });

    play = vi.spyOn(sync.player, 'play').mockImplementation(() => {});
    seek = vi.spyOn(sync.player, 'seek').mockImplementation(() => {});
    vi.spyOn(sync.player, 'pause').mockImplementation(() => {});
  });

  it('does not correct position while a track change is still resolving', async () => {
    watcher.emit('trackChanged', state('a', 1000));

    // Spotify keeps polling during the resolve. Previously these compared the
    // new track's position against the old track's stream and re-seeked on a
    // drift of an entire song length.
    watcher.emit('tick', state('a', 3000));
    watcher.emit('tick', state('a', 5000));

    expect(seek).not.toHaveBeenCalled();
    expect(play).not.toHaveBeenCalled();
  });

  it('starts playback once the resolve completes', async () => {
    watcher.emit('trackChanged', state('a', 1000));
    resolveTrack();
    await vi.waitFor(() => expect(play).toHaveBeenCalledTimes(1));

    expect(play.mock.calls[0]?.[0]).toEqual(audio);
  });

  it('ignores drift within tolerance once playing', async () => {
    watcher.emit('trackChanged', state('a', 1000));
    resolveTrack();
    await vi.waitFor(() => expect(play).toHaveBeenCalled());

    vi.spyOn(sync.player, 'position').mockReturnValue(1800);
    watcher.emit('tick', state('a', 1000));

    expect(seek).not.toHaveBeenCalled();
  });

  it('corrects drift beyond tolerance once playing', async () => {
    watcher.emit('trackChanged', state('a', 1000));
    resolveTrack();
    await vi.waitFor(() => expect(play).toHaveBeenCalled());

    // Stream is a full minute behind where Spotify says we are.
    vi.spyOn(sync.player, 'position').mockReturnValue(1000);
    watcher.emit('tick', state('a', 61_000));

    expect(seek).toHaveBeenCalledTimes(1);
  });

  it('does not re-seek on a seek event whose drift is within tolerance', async () => {
    watcher.emit('trackChanged', state('a', 1000));
    resolveTrack();
    await vi.waitFor(() => expect(play).toHaveBeenCalled());

    // Spotify reports every event with polling jitter. Re-seeking on a few
    // hundred milliseconds of it stutters worse than the drift it fixes.
    vi.spyOn(sync.player, 'position').mockReturnValue(1900);
    watcher.emit('seeked', state('a', 1500));

    expect(seek).not.toHaveBeenCalled();
  });

  it('suppresses correction again when the next track starts resolving', async () => {
    watcher.emit('trackChanged', state('a', 1000));
    resolveTrack();
    await vi.waitFor(() => expect(play).toHaveBeenCalled());

    watcher.emit('trackChanged', state('b', 0));
    vi.spyOn(sync.player, 'position').mockReturnValue(120_000);
    watcher.emit('tick', state('b', 2000));

    expect(seek).not.toHaveBeenCalled();
  });
});
