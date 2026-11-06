/**
 * GitHub, used two ways: device sign-in to prove who someone is (no scopes, and the service keeps no
 * GitHub token), and the Pane repository's releases as the list of published Pane builds.
 */
import { CloudApiError, type PaneRelease } from 'pane-cloud-contract';
import { z } from 'zod';
import type { ServiceConfig } from './config';

export interface GithubIdentity {
  id: number;
  login: string;
  name: string | null;
  email: string | null;
}

export type DeviceTokenOutcome =
  | { status: 'pending' | 'slow_down' | 'expired' | 'denied' }
  | { status: 'complete'; identity: GithubIdentity };

const DeviceCodeResponse = z.object({
  device_code: z.string(),
  user_code: z.string(),
  verification_uri: z.string(),
  expires_in: z.number(),
  interval: z.number(),
});
const TokenResponse = z.union([z.object({ access_token: z.string() }), z.object({ error: z.string() })]);
const UserResponse = z.object({ id: z.number(), login: z.string(), name: z.string().nullable().optional(), email: z.string().nullable().optional() });
const Release = z.object({
  tag_name: z.string(),
  draft: z.boolean(),
  prerelease: z.boolean(),
  assets: z.array(z.object({ name: z.string(), browser_download_url: z.string() })),
});

const unavailable = (what: string) =>
  new CloudApiError('internal', `GitHub did not answer the ${what} request.`, 'Try again in a minute.');

async function postForm(url: string, form: Record<string, string>): Promise<unknown> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(form).toString(),
  });
  if (!response.ok) throw unavailable('sign-in');
  return response.json();
}

const RELEASE_CACHE_MS = 5 * 60_000;

export function createGithub(config: ServiceConfig['github']) {
  let releaseCache: { at: number; releases: { version: string; sumsUrl: string }[] } | null = null;
  const checksums = new Map<string, string>();

  /** Published releases that ship an arm64 .deb and a SHA256SUMS.txt, oldest first, without checksums yet. */
  const listReleases = async () => {
    const response = await fetch(`${config.apiUrl}/repos/${config.releasesRepo}/releases?per_page=30`, { headers: { accept: 'application/vnd.github+json' } });
    if (!response.ok) throw unavailable('releases');
    const found: { version: string; sumsUrl: string }[] = [];
    for (const release of z.array(Release).parse(await response.json())) {
      const version = release.tag_name.replace(/^v/, '');
      if (release.draft || release.prerelease || !/^\d+\.\d+\.\d+$/.test(version)) continue;
      const sums = release.assets.find((a) => a.name === 'SHA256SUMS.txt');
      if (sums && release.assets.some((a) => a.name === `Pane-${version}-linux-arm64.deb`)) found.push({ version, sumsUrl: sums.browser_download_url });
    }
    return found.sort((a, b) => compareVersions(a.version, b.version));
  };

  const checksumOf = async (version: string, sumsUrl: string): Promise<string | null> => {
    const cached = checksums.get(version);
    if (cached) return cached;
    const response = await fetch(sumsUrl);
    if (!response.ok) throw unavailable('release checksum');
    const debName = `Pane-${version}-linux-arm64.deb`;
    const line = (await response.text()).split('\n').find((l) => l.trim().split(/\s+\*?/)[1] === debName);
    const sha = line?.trim().split(/\s+/)[0]?.toLowerCase();
    if (!sha || !/^[0-9a-f]{64}$/.test(sha)) return null;
    checksums.set(version, sha);
    return sha;
  };

  return {
    async startDeviceFlow() {
      const body = DeviceCodeResponse.parse(await postForm(`${config.webUrl}/login/device/code`, { client_id: config.clientId, scope: '' }));
      return { deviceCode: body.device_code, userCode: body.user_code, verificationUri: body.verification_uri, expiresIn: body.expires_in, interval: body.interval };
    },

    /**
     * Polls GitHub for the device code. On approval it reads the person's profile with the token and
     * drops the token: nothing about it is stored or logged.
     */
    async pollDeviceFlow(deviceCode: string): Promise<DeviceTokenOutcome> {
      const body = TokenResponse.parse(
        await postForm(`${config.webUrl}/login/oauth/access_token`, {
          client_id: config.clientId,
          device_code: deviceCode,
          grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        }),
      );
      if ('error' in body) {
        if (body.error === 'authorization_pending') return { status: 'pending' };
        if (body.error === 'slow_down') return { status: 'slow_down' };
        if (body.error === 'access_denied') return { status: 'denied' };
        return { status: 'expired' };
      }
      const response = await fetch(`${config.apiUrl}/user`, { headers: { accept: 'application/vnd.github+json', authorization: `Bearer ${body.access_token}` } });
      if (!response.ok) throw unavailable('profile');
      const user = UserResponse.parse(await response.json());
      return { status: 'complete', identity: { id: user.id, login: user.login, name: user.name ?? null, email: user.email ?? null } };
    },

    /**
     * A published Pane release with the checksum of its arm64 .deb: the named version, or the latest.
     * Returns the published versions instead when there is no such release.
     */
    async release(version?: string): Promise<PaneRelease | { published: string[] }> {
      if (!releaseCache || Date.now() - releaseCache.at >= RELEASE_CACHE_MS) releaseCache = { at: Date.now(), releases: await listReleases() };
      const { releases } = releaseCache;
      const chosen = version ? releases.find((r) => r.version === version) : releases.at(-1);
      const sha = chosen ? await checksumOf(chosen.version, chosen.sumsUrl) : null;
      if (!chosen || !sha) return { published: releases.map((r) => r.version) };
      return { version: chosen.version, arch: 'arm64', debSha256: sha };
    },
  };
}
export type Github = ReturnType<typeof createGithub>;

function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i += 1) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}
