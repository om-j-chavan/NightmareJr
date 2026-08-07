import { createLogger } from '../logger.js';
import type { PlaybackState, RawPlayerResponse, SpotifyTrack } from './types.js';

const log = createLogger('spotify');

const TOKEN_URL = 'https://accounts.spotify.com/api/token';
const PLAYER_URL = 'https://api.spotify.com/v1/me/player';

/** Scopes required to read what the user is playing on their own devices. */
export const REQUIRED_SCOPES = ['user-read-playback-state', 'user-read-currently-playing'] as const;

export interface SpotifyClientOptions {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}

export class SpotifyAuthError extends Error {}

export class SpotifyClient {
  private accessToken: string | null = null;
  /** Epoch ms after which `accessToken` must be refreshed. */
  private expiresAt = 0;
  private inFlightRefresh: Promise<string> | null = null;

  constructor(private readonly options: SpotifyClientOptions) {}

  private get basicAuth(): string {
    return Buffer.from(`${this.options.clientId}:${this.options.clientSecret}`).toString('base64');
  }

  private async getAccessToken(): Promise<string> {
    if (this.accessToken && Date.now() < this.expiresAt) return this.accessToken;
    // Collapse concurrent refreshes so a burst of calls mints only one token.
    this.inFlightRefresh ??= this.refresh().finally(() => {
      this.inFlightRefresh = null;
    });
    return this.inFlightRefresh;
  }

  private async refresh(): Promise<string> {
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: this.options.refreshToken,
    });

    const res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${this.basicAuth}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body,
    });

    if (!res.ok) {
      throw new SpotifyAuthError(
        `Token refresh failed (${res.status}). Re-run \`npm run auth\` to mint a new refresh token. ${await res.text()}`,
      );
    }

    const json = (await res.json()) as { access_token: string; expires_in: number };
    this.accessToken = json.access_token;
    // Renew a minute early so a request never races the expiry.
    this.expiresAt = Date.now() + (json.expires_in - 60) * 1000;
    log.debug(`Access token refreshed, valid for ${json.expires_in}s`);
    return this.accessToken;
  }

  /**
   * Reads the user's current playback.
   *
   * Returns `null` when Spotify reports nothing active — either HTTP 204
   * (no device playing) or a non-track item such as a podcast episode.
   */
  async getPlaybackState(): Promise<PlaybackState | null> {
    const token = await this.getAccessToken();
    const res = await fetch(PLAYER_URL, { headers: { Authorization: `Bearer ${token}` } });

    if (res.status === 204) return null;

    if (res.status === 401) {
      // Force a refresh on the next call rather than failing permanently.
      this.expiresAt = 0;
      throw new SpotifyAuthError('Spotify rejected the access token (401).');
    }

    if (res.status === 429) {
      const retryAfter = Number(res.headers.get('retry-after') ?? '5');
      throw new RateLimitError(retryAfter * 1000);
    }

    if (!res.ok) {
      throw new Error(`Spotify /me/player returned ${res.status}: ${await res.text()}`);
    }

    const raw = (await res.json()) as RawPlayerResponse;
    const track = toTrack(raw);
    if (!track) return null;

    return {
      track,
      progressMs: raw.progress_ms ?? 0,
      isPlaying: raw.is_playing ?? false,
      deviceName: raw.device?.name,
      observedAt: Date.now(),
    };
  }
}

export class RateLimitError extends Error {
  constructor(public readonly retryAfterMs: number) {
    super(`Spotify rate limited; retry in ${retryAfterMs}ms`);
  }
}

function toTrack(raw: RawPlayerResponse): SpotifyTrack | null {
  const item = raw.item;
  // Podcasts and local files have no usable id — nothing we can resolve audio for.
  if (!item?.id || raw.currently_playing_type !== 'track') return null;

  const images = item.album?.images ?? [];
  const largest = images.reduce<{ url: string; width?: number } | undefined>(
    (best, img) => ((img.width ?? 0) > (best?.width ?? 0) ? img : best),
    undefined,
  );

  return {
    id: item.id,
    name: item.name ?? 'Unknown title',
    artists: (item.artists ?? []).map((a) => a.name),
    album: item.album?.name ?? '',
    durationMs: item.duration_ms ?? 0,
    artworkUrl: largest?.url,
    externalUrl: item.external_urls?.spotify,
  };
}

/** `Artist – Title`, the form used for the YouTube lookup and for display. */
export function describeTrack(track: SpotifyTrack): string {
  const artists = track.artists.join(', ');
  return artists ? `${artists} - ${track.name}` : track.name;
}
