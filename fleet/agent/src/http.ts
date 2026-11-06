import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { CloudApiError, type Route, type RouteResponse } from 'pane-cloud-contract';
import { z } from 'zod';

type Input<T> = {
  /** Who the bearer token says is calling: `service`, or a host id. */
  caller: string;
  params: Record<string, string>;
  body: T extends Route<infer B, z.ZodType, z.ZodType> ? z.output<B> : never;
  query: T extends Route<z.ZodType, infer Q, z.ZodType> ? z.output<Q> : never;
};

/** Returns who a bearer token belongs to, or null when the route does not accept it. */
export type Authenticate = (token: string) => Promise<string | null>;

export interface Bound {
  route: Route;
  authenticate: Authenticate;
  handle(input: Input<Route>): Promise<unknown>;
}

/** Binds a route to its callers: one fixed token (the caller is `service`), or an authenticator. */
export function bind<T extends Route>(route: T, auth: string | Authenticate, handle: (input: Input<T>) => Promise<RouteResponse<T>>): Bound {
  const authenticate: Authenticate = typeof auth === 'string' ? async (given) => (sameToken(given, auth) ? 'service' : null) : auth;
  // SAFETY: the server calls handle only with input parsed by the route's own schemas.
  return { route, authenticate, handle: handle as (input: Input<Route>) => Promise<unknown> };
}

const MAX_BODY_BYTES = 4 * 1024 * 1024;

const digest = (value: string) => createHash('sha256').update(value).digest();
const sameToken = (given: string, expected: string) => timingSafeEqual(digest(given), digest(expected));

function match(pattern: string, path: string): Record<string, string> | null {
  const want = pattern.split('/');
  const got = path.split('/');
  if (want.length !== got.length) return null;
  const params: Record<string, string> = {};
  for (const [i, segment] of want.entries()) {
    const actual = got[i] ?? '';
    if (segment.startsWith(':')) params[segment.slice(1)] = decodeURIComponent(actual);
    else if (segment !== actual) return null;
  }
  return params;
}

async function readBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    // SAFETY: an IncomingMessage with no encoding set yields Buffers.
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new CloudApiError('invalid_request', 'The request body is too large.', `Send at most ${MAX_BODY_BYTES} bytes.`);
    chunks.push(buffer);
  }
  if (size === 0) return undefined;
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new CloudApiError('invalid_request', 'The request body is not JSON.', 'Send a JSON body.');
  }
}

function parse<S extends z.ZodType>(what: string, schema: S, value: unknown): z.output<S> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new CloudApiError('invalid_request', `The ${what} does not match the contract: ${z.prettifyError(parsed.error)}`, 'Fix the request to match the contract and send it again.');
  return parsed.data;
}

/** Serves bound routes: bearer token, request schemas, then the handler; every error as the contract's error body. */
export function createApiServer(routes: Bound[], log: (entry: Record<string, unknown>) => void): Server {
  return createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? '/', 'http://fleet');
      let status = 500;
      let body: unknown;
      try {
        let found: { bound: Bound; params: Record<string, string> } | null = null;
        for (const bound of routes) {
          const params = bound.route.method === request.method ? match(bound.route.path, url.pathname) : null;
          if (params) {
            found = { bound, params };
            break;
          }
        }
        if (!found) throw new CloudApiError('invalid_request', `No route for ${request.method} ${url.pathname}.`, 'Check the method and path against the fleet API.');
        const { route, authenticate, handle } = found.bound;
        const authorization = request.headers.authorization ?? '';
        const caller = authorization.startsWith('Bearer ') ? await authenticate(authorization.slice('Bearer '.length)) : null;
        if (caller === null) throw new CloudApiError('unauthenticated', 'This call needs a fleet API credential.', 'Send the configured token, or a host identity token, as a Bearer token.');
        const raw = await readBody(request);
        const input = {
          caller,
          params: found.params,
          body: route.body ? parse('body', route.body, raw) : undefined,
          query: route.query ? parse('query', route.query, Object.fromEntries(url.searchParams)) : {},
        };
        // SAFETY: input was parsed by the route's own schemas just above.
        body = route.response.parse(await handle(input as Input<Route>));
        status = route.status;
      } catch (error) {
        const failure = error instanceof CloudApiError ? error : new CloudApiError('internal', 'The fleet hit an unexpected error.', 'Retry the call; if it keeps failing, report it with the time.');
        if (!(error instanceof CloudApiError)) log({ msg: 'request failed', method: request.method, path: url.pathname, error: String(error) });
        status = failure.status;
        body = failure.toBody();
      }
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(JSON.stringify(body));
    })();
  });
}
