/** The subset of Spotify's player payload this bot actually consumes. */
export interface SpotifyTrack {
  id: string;
  name: string;
  artists: string[];
  album: string;
  durationMs: number;
  /** Largest available album-art URL, if any. */
  artworkUrl: string | undefined;
  externalUrl: string | undefined;
}

export interface PlaybackState {
  track: SpotifyTrack;
  progressMs: number;
  isPlaying: boolean;
  /** Name of the Spotify Connect device the user is playing on. */
  deviceName: string | undefined;
  /** Wall-clock time this state was observed, for drift maths. */
  observedAt: number;
}

/** Raw shapes returned by GET /v1/me/player, narrowed to what we read. */
export interface RawPlayerResponse {
  is_playing?: boolean;
  progress_ms?: number | null;
  currently_playing_type?: string;
  device?: { name?: string } | null;
  item?: {
    id?: string | null;
    name?: string;
    duration_ms?: number;
    album?: { name?: string; images?: { url: string; width?: number }[] };
    artists?: { name: string }[];
    external_urls?: { spotify?: string };
  } | null;
}
