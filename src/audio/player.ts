import {
  AudioPlayerStatus,
  NoSubscriberBehavior,
  StreamType,
  createAudioPlayer,
  createAudioResource,
  type AudioPlayer,
  type AudioResource,
  type VoiceConnection,
} from '@discordjs/voice';
import { createLogger } from '../logger.js';
import { hasLibopus, spawnStream, type FfmpegProcess } from './ffmpeg.js';
import type { ResolvedAudio } from './resolver.js';

const log = createLogger('player');

/**
 * A Discord audio player that can be repositioned mid-track.
 *
 * `@discordjs/voice` has no seek primitive — a resource is a one-way stream. So
 * seeking means tearing down the ffmpeg process and starting a new one at the
 * target offset. `position()` accounts for that offset so callers can reason in
 * absolute track time.
 */
export class SeekablePlayer {
  readonly player: AudioPlayer;

  private process: FfmpegProcess | null = null;
  private resource: AudioResource | null = null;
  /** Offset the current resource was started at, in ms. */
  private seekOffsetMs = 0;
  private current: ResolvedAudio | null = null;

  constructor(private readonly bitrate = '128k') {
    this.player = createAudioPlayer({
      behaviors: {
        // Keep the stream running when the channel empties, so returning
        // listeners hear playback already in sync rather than from the top.
        noSubscriber: NoSubscriberBehavior.Play,
      },
    });

    this.player.on('error', (error) => {
      log.error(`Audio player error: ${error.message}`);
    });
  }

  subscribe(connection: VoiceConnection): void {
    connection.subscribe(this.player);
  }

  /** Absolute position within the source track, in ms. */
  position(): number {
    if (!this.resource) return this.seekOffsetMs;
    return this.seekOffsetMs + this.resource.playbackDuration;
  }

  get isPlaying(): boolean {
    return this.player.state.status === AudioPlayerStatus.Playing;
  }

  get isPaused(): boolean {
    return this.player.state.status === AudioPlayerStatus.Paused;
  }

  /** Starts (or restarts) `audio` at `seekMs`. */
  play(audio: ResolvedAudio, seekMs: number): void {
    this.teardown();

    this.process = spawnStream({
      url: audio.streamUrl,
      seekMs,
      copyOpus: audio.isOpus,
      bitrate: this.bitrate,
    });
    this.seekOffsetMs = seekMs;
    this.current = audio;

    // A remuxed source is Ogg/Opus by construction; a transcode is only Ogg
    // when ffmpeg had libopus to encode with.
    this.resource = createAudioResource(this.process.stdout, {
      inputType: audio.isOpus || hasLibopus() ? StreamType.OggOpus : StreamType.Raw,
    });

    this.player.play(this.resource);
    log.debug(`Playing from ${Math.round(seekMs / 1000)}s`);
  }

  /** Repositions within the track already loaded. No-op if nothing is loaded. */
  seek(seekMs: number): void {
    if (!this.current) return;
    log.info(`Re-seeking to ${Math.round(seekMs / 1000)}s`);
    this.play(this.current, seekMs);
  }

  pause(): void {
    this.player.pause(true);
  }

  resume(): void {
    this.player.unpause();
  }

  stop(): void {
    this.player.stop(true);
    this.teardown();
    this.current = null;
    this.seekOffsetMs = 0;
  }

  private teardown(): void {
    if (this.process) {
      this.process.stdout.destroy();
      this.process.kill('SIGKILL');
      this.process = null;
    }
    this.resource = null;
  }
}
