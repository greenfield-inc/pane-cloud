/**
 * Host identity from AWS, with no shared secret. A host proves who it is with a presigned
 * `sts:GetCallerIdentity` request, signed by its instance role and bound to this fleet by a signed
 * `x-pane-fleet-id` header. The fleet sends that request to STS itself; STS answers with the
 * instance role's session ARN, whose session name is the EC2 instance id: the host id.
 */
import { createHash, createHmac } from 'node:crypto';
import { defaultProvider } from '@aws-sdk/credential-provider-node';
import { SignatureV4 } from '@smithy/signature-v4';
import { HostId } from './sync.js';

const TOKEN_PREFIX = 'pane-sts-v1.';
const FLEET_HEADER = 'x-pane-fleet-id';
const EXPIRES_S = 900;
const QUERY_KEYS = new Set(['Action', 'Version', 'X-Amz-Algorithm', 'X-Amz-Credential', 'X-Amz-Date', 'X-Amz-Expires', 'X-Amz-SignedHeaders', 'X-Amz-Signature', 'X-Amz-Security-Token']);

export const stsEndpoint = (region: string) => `https://sts.${region}.amazonaws.com`;

export interface StsIdentityOptions {
  /** The STS endpoint, `https://sts.<region>.amazonaws.com`; tests point it at a fake. */
  endpoint: string;
  /** Names this fleet in every token, so a token made for it is good nowhere else. */
  fleetId: string;
}

export interface HostCredential {
  /** A bearer token for the sync route, renewed before it expires. */
  token(): Promise<string>;
  /** This host's id as the fleet will see it: its instance role session name. */
  hostId(): Promise<string>;
}

/** The host side: presigns GetCallerIdentity with the instance role (or the given credentials). */
export function stsHostCredential(options: StsIdentityOptions & { region: string; credentials?: { accessKeyId: string; secretAccessKey: string; sessionToken?: string } }): HostCredential {
  const endpoint = new URL(options.endpoint);
  const signer = new SignatureV4({ service: 'sts', region: options.region, credentials: options.credentials ?? defaultProvider(), sha256: Sha256 });
  let cached: { url: string; renewAt: number } | null = null;

  async function presignedUrl(): Promise<string> {
    if (cached && Date.now() < cached.renewAt) return cached.url;
    const signed = await signer.presign(
      {
        method: 'GET',
        protocol: endpoint.protocol,
        hostname: endpoint.hostname,
        ...(endpoint.port ? { port: Number(endpoint.port) } : {}),
        path: '/',
        query: { Action: 'GetCallerIdentity', Version: '2011-06-15' },
        headers: { host: endpoint.host, [FLEET_HEADER]: options.fleetId },
      },
      { expiresIn: EXPIRES_S },
    );
    const url = new URL('/', endpoint);
    for (const [key, value] of Object.entries(signed.query ?? {})) if (typeof value === 'string') url.searchParams.set(key, value);
    // Renewed with 5 minutes to spare, so the fleet never sees an expired one.
    cached = { url: url.toString(), renewAt: Date.now() + (EXPIRES_S - 300) * 1000 };
    return cached.url;
  }

  return {
    token: async () => TOKEN_PREFIX + Buffer.from(await presignedUrl()).toString('base64url'),
    async hostId() {
      return sessionOf(await callerArn(await presignedUrl(), options.fleetId));
    },
  };
}

/**
 * The fleet side: checks the token is a presigned GetCallerIdentity for this fleet and STS endpoint,
 * sends it to STS, and returns the host id when the caller is the host role. A verified token is
 * remembered until it expires, so STS sees about one call per host every 10 minutes.
 */
export function stsHostAuth(options: StsIdentityOptions & { hostRoleArn: string; now?: () => Date }): (token: string) => Promise<string | null> {
  const endpoint = new URL(options.endpoint);
  const role = /^arn:aws:iam::(\d{12}):role\/(?:.*\/)?([\w+=,.@-]+)$/.exec(options.hostRoleArn);
  if (!role) throw new Error(`"${options.hostRoleArn}" is not an IAM role ARN.`);
  const [, account, roleName] = role;
  const now = options.now ?? (() => new Date());
  const verified = new Map<string, { hostId: string; expiresAt: number }>();

  return async (token) => {
    const at = now().getTime();
    const key = createHash('sha256').update(token).digest('hex');
    const known = verified.get(key);
    if (known && at < known.expiresAt) return known.hostId;
    if (!token.startsWith(TOKEN_PREFIX)) return null;
    let url: URL;
    try {
      url = new URL(Buffer.from(token.slice(TOKEN_PREFIX.length), 'base64url').toString('utf8'));
    } catch {
      return null;
    }
    // Only STS, only GetCallerIdentity, only signed for this fleet: nothing else is ever fetched.
    const q = url.searchParams;
    const keys = [...q.keys()];
    if (url.origin !== endpoint.origin || url.pathname !== '/' || url.hash || url.username || url.password) return null;
    if (keys.length !== new Set(keys).size || keys.some((k) => !QUERY_KEYS.has(k))) return null;
    if (q.get('Action') !== 'GetCallerIdentity' || q.get('Version') !== '2011-06-15') return null;
    if (!(q.get('X-Amz-SignedHeaders') ?? '').split(';').includes(FLEET_HEADER)) return null;
    const expiresS = Number(q.get('X-Amz-Expires'));
    const signedAt = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(q.get('X-Amz-Date') ?? '');
    if (!signedAt || !Number.isInteger(expiresS) || expiresS < 1 || expiresS > EXPIRES_S) return null;
    const signedAtMs = Date.parse(`${signedAt[1]}-${signedAt[2]}-${signedAt[3]}T${signedAt[4]}:${signedAt[5]}:${signedAt[6]}Z`);
    const expiresAt = signedAtMs + expiresS * 1000;
    if (at >= expiresAt || signedAtMs > at + 5 * 60_000) return null;

    const arn = await callerArn(url.toString(), options.fleetId).catch(() => null);
    const match = arn ? /^arn:aws:sts::(\d{12}):assumed-role\/([\w+=,.@-]+)\/([\w+=,.@-]+)$/.exec(arn) : null;
    if (!match || match[1] !== account || match[2] !== roleName) return null;
    const hostId = HostId.safeParse(match[3]);
    if (!hostId.success) return null;
    for (const [k, entry] of verified) if (at >= entry.expiresAt) verified.delete(k);
    verified.set(key, { hostId: hostId.data, expiresAt });
    return hostId.data;
  };
}

/** Sends a presigned GetCallerIdentity to STS and returns the caller's ARN. */
async function callerArn(url: string, fleetId: string): Promise<string> {
  const response = await fetch(url, { headers: { [FLEET_HEADER]: fleetId, accept: 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(5_000) });
  if (!response.ok) throw new Error(`STS refused the identity request: ${response.status}.`);
  const body = (await response.json()) as { GetCallerIdentityResponse?: { GetCallerIdentityResult?: { Arn?: unknown } } };
  const arn = body.GetCallerIdentityResponse?.GetCallerIdentityResult?.Arn;
  if (typeof arn !== 'string') throw new Error('STS answered without an ARN.');
  return arn;
}

function sessionOf(arn: string): string {
  const session = /^arn:aws:sts::\d{12}:assumed-role\/[^/]+\/([^/]+)$/.exec(arn)?.[1];
  if (!session) throw new Error(`${arn} is not an instance role session; a fleet host runs with its instance role.`);
  return session;
}

/** SHA-256 and HMAC-SHA-256 from node:crypto, in the shape the SigV4 signer takes. */
class Sha256 {
  private readonly hash;
  constructor(secret?: string | ArrayBuffer | ArrayBufferView) {
    const key = secret === undefined ? undefined : typeof secret === 'string' ? secret : ArrayBuffer.isView(secret) ? Buffer.from(secret.buffer, secret.byteOffset, secret.byteLength) : Buffer.from(secret);
    this.hash = key === undefined ? createHash('sha256') : createHmac('sha256', key);
  }
  update(data: string | ArrayBuffer | ArrayBufferView): void {
    this.hash.update(typeof data === 'string' ? data : ArrayBuffer.isView(data) ? Buffer.from(data.buffer, data.byteOffset, data.byteLength) : Buffer.from(data));
  }
  async digest(): Promise<Uint8Array> {
    return new Uint8Array(this.hash.digest());
  }
}
