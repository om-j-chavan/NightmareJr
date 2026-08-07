import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { loadConfig } from '../config.js';
import { createLogger } from '../logger.js';
import { REQUIRED_SCOPES } from '../spotify/client.js';

const log = createLogger('auth');

/**
 * One-shot script that walks the Spotify authorization-code flow and prints a
 * refresh token to paste into .env.
 *
 * Run it once per Spotify account. The refresh token does not expire on its
 * own — you only need to redo this if you revoke access or change scopes.
 */
async function main(): Promise<void> {
  const config = loadConfig('spotify-only');
  const redirect = new URL(config.SPOTIFY_REDIRECT_URI);
  const port = Number(redirect.port || 8888);
  const state = randomBytes(16).toString('hex');

  const authorizeUrl = new URL('https://accounts.spotify.com/authorize');
  authorizeUrl.searchParams.set('response_type', 'code');
  authorizeUrl.searchParams.set('client_id', config.SPOTIFY_CLIENT_ID);
  authorizeUrl.searchParams.set('scope', REQUIRED_SCOPES.join(' '));
  authorizeUrl.searchParams.set('redirect_uri', config.SPOTIFY_REDIRECT_URI);
  authorizeUrl.searchParams.set('state', state);

  const refreshToken = await new Promise<string>((resolve, reject) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
      if (url.pathname !== redirect.pathname) {
        res.writeHead(404).end();
        return;
      }

      const code = url.searchParams.get('code');
      const returnedState = url.searchParams.get('state');
      const error = url.searchParams.get('error');

      const finish = (status: number, body: string, outcome: Error | string): void => {
        res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' }).end(body);
        server.close();
        if (outcome instanceof Error) reject(outcome);
        else resolve(outcome);
      };

      if (error) {
        finish(400, page('Authorization denied.'), new Error(`Spotify returned: ${error}`));
        return;
      }
      if (returnedState !== state) {
        finish(400, page('State mismatch.'), new Error('State mismatch — possible CSRF, aborting.'));
        return;
      }
      if (!code) {
        finish(400, page('No authorization code.'), new Error('No authorization code in callback.'));
        return;
      }

      exchangeCode(code, config)
        .then((token) => finish(200, page('Authorized. You can close this tab.'), token))
        .catch((err: unknown) =>
          finish(500, page('Token exchange failed.'), err instanceof Error ? err : new Error(String(err))),
        );
    });

    server.on('error', reject);
    server.listen(port, '127.0.0.1', () => {
      log.info(`Listening on http://127.0.0.1:${port}`);
      console.log('\nOpen this URL in your browser and approve access:\n');
      console.log(`  ${authorizeUrl.toString()}\n`);
    });
  });

  console.log('\nAdd this line to your .env file:\n');
  console.log(`SPOTIFY_REFRESH_TOKEN=${refreshToken}\n`);
}

async function exchangeCode(
  code: string,
  config: { SPOTIFY_CLIENT_ID: string; SPOTIFY_CLIENT_SECRET: string; SPOTIFY_REDIRECT_URI: string },
): Promise<string> {
  const basic = Buffer.from(
    `${config.SPOTIFY_CLIENT_ID}:${config.SPOTIFY_CLIENT_SECRET}`,
  ).toString('base64');

  const res = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basic}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: config.SPOTIFY_REDIRECT_URI,
    }),
  });

  if (!res.ok) {
    throw new Error(`Token exchange failed (${res.status}): ${await res.text()}`);
  }

  const json = (await res.json()) as { refresh_token?: string };
  if (!json.refresh_token) throw new Error('Spotify did not return a refresh token.');
  return json.refresh_token;
}

function page(message: string): string {
  return `<!doctype html><meta charset="utf-8"><title>NightmareJr</title>
<body style="font:16px system-ui;display:grid;place-items:center;height:100vh;margin:0">
<p>${message}</p></body>`;
}

main().catch((error: unknown) => {
  log.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
