import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface FakeGithubUser {
  id: number;
  login: string;
  name?: string;
  email?: string;
}

/**
 * GitHub's device flow, /user and the releases API, at their real paths, so the service runs its real
 * GitHub code against it. Every access token it issues is kept, so a test can search for it.
 */
export async function startFakeGithub(options: { releases: { version: string; debSha256: string }[] }) {
  const devices = new Map<string, { userCode: string; state: 'pending' | 'denied' | 'approved'; user: FakeGithubUser | null }>();
  const tokens = new Map<string, FakeGithubUser>();
  let counter = 0;
  let base = '';

  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://github');
    let body = '';
    request.on('data', (chunk: Buffer) => (body += chunk.toString()));
    request.on('end', () => {
      const form = new URLSearchParams(body);
      const json = (status: number, value: unknown) => {
        response.writeHead(status, { 'content-type': 'application/json' });
        response.end(JSON.stringify(value));
      };
      if (request.method === 'POST' && url.pathname === '/login/device/code') {
        counter += 1;
        const deviceCode = `dev-${counter}-${randomBytes(4).toString('hex')}`;
        const userCode = `ABCD-${String(counter).padStart(4, '0')}`;
        devices.set(deviceCode, { userCode, state: 'pending', user: null });
        return json(200, { device_code: deviceCode, user_code: userCode, verification_uri: 'https://github.com/login/device', expires_in: 900, interval: 5 });
      }
      if (request.method === 'POST' && url.pathname === '/login/oauth/access_token') {
        const grant = devices.get(form.get('device_code') ?? '');
        if (!grant) return json(200, { error: 'expired_token' });
        if (grant.state === 'pending') return json(200, { error: 'authorization_pending' });
        if (grant.state === 'denied') return json(200, { error: 'access_denied' });
        devices.delete(form.get('device_code') ?? '');
        const token = `gho_${randomBytes(18).toString('hex')}`;
        if (grant.user) tokens.set(token, grant.user);
        return json(200, { access_token: token, token_type: 'bearer', scope: '' });
      }
      if (request.method === 'GET' && url.pathname === '/user') {
        const user = tokens.get((request.headers.authorization ?? '').replace(/^Bearer /, ''));
        if (!user) return json(401, { message: 'Bad credentials' });
        return json(200, { id: user.id, login: user.login, name: user.name ?? null, email: user.email ?? null });
      }
      const releasesMatch = url.pathname.match(/^\/repos\/[^/]+\/[^/]+\/releases$/);
      if (request.method === 'GET' && releasesMatch) {
        return json(
          200,
          options.releases.map((r) => ({
            tag_name: `v${r.version}`,
            draft: false,
            prerelease: false,
            assets: [
              { name: `Pane-${r.version}-linux-arm64.deb`, browser_download_url: `${base}/download/${r.version}/deb` },
              { name: 'SHA256SUMS.txt', browser_download_url: `${base}/download/${r.version}/sums` },
            ],
          })),
        );
      }
      const sums = url.pathname.match(/^\/download\/([\d.]+)\/sums$/);
      if (request.method === 'GET' && sums) {
        const release = options.releases.find((r) => r.version === sums[1]);
        response.writeHead(200, { 'content-type': 'text/plain' });
        const other = createHash('sha256').update('amd64').digest('hex');
        return response.end(`${other}  Pane-${sums[1]}-linux-amd64.deb\n${release?.debSha256}  Pane-${sums[1]}-linux-arm64.deb\n`);
      }
      json(404, { message: 'Not Found' });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  // SAFETY: a server listening on a TCP port reports an AddressInfo.
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    url: base,
    /** The person entering the code on github.com and approving. */
    approve(userCode: string, user: FakeGithubUser) {
      const grant = [...devices.values()].find((d) => d.userCode === userCode);
      if (!grant) throw new Error(`fake GitHub: no device code ${userCode}`);
      grant.state = 'approved';
      grant.user = user;
    },
    deny(userCode: string) {
      const grant = [...devices.values()].find((d) => d.userCode === userCode);
      if (grant) grant.state = 'denied';
    },
    issuedTokens: () => [...tokens.keys()],
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
