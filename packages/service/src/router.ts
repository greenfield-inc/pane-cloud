import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { CloudApiError, type Route, type RouteResponse } from 'pane-cloud-contract';
import { z } from 'zod';

export interface HandlerInput<T> {
  params: Record<string, string>;
  body: T extends Route<infer B, z.ZodType, z.ZodType> ? z.output<B> : never;
  query: T extends Route<z.ZodType, infer Q, z.ZodType> ? z.output<Q> : never;
  /** The bearer token, or null when the request carried none. */
  token: string | null;
}

type Handler<T> = (input: HandlerInput<T>) => Promise<RouteResponse<T>>;

export interface BoundRoute {
  route: Route;
  handle: Handler<Route>;
}

export function bind<T extends Route>(target: T, handle: Handler<T>): BoundRoute {
  // SAFETY: the server only calls handle with input parsed by target's own schemas.
  return { route: target, handle: handle as Handler<Route> };
}

const MAX_BODY_BYTES = 64 * 1024;

/** The body was not read to its end, so the connection cannot carry another request. */
class BodyTooLarge extends CloudApiError {
  constructor() {
    super('invalid_request', 'The request body is too large.', 'Send a body under 64 KB.');
  }
}

function matchPath(pattern: string, path: string): Record<string, string> | null {
  const want = pattern.split('/');
  const got = path.split('/');
  if (want.length !== got.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < want.length; i += 1) {
    const segment = want[i] ?? '';
    const actual = got[i] ?? '';
    if (segment.startsWith(':')) {
      try {
        params[segment.slice(1)] = decodeURIComponent(actual);
      } catch {
        throw new CloudApiError('invalid_request', 'The path has invalid percent-encoding.', 'Encode path segments with encodeURIComponent.');
      }
    }
    else if (segment !== actual) return null;
  }
  return params;
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    // SAFETY: an IncomingMessage with no encoding set yields Buffer chunks.
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new BodyTooLarge();
    chunks.push(buffer);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (text === '') return undefined;
  try {
    return JSON.parse(text);
  } catch {
    throw new CloudApiError('invalid_request', 'The request body is not JSON.', 'Send a JSON body.');
  }
}

function check<S extends z.ZodType>(what: string, schema: S, value: unknown): z.output<S> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new CloudApiError('invalid_request', `The ${what} does not match the contract: ${z.prettifyError(parsed.error)}`, 'Fix the request to match the contract and send it again.');
  }
  return parsed.data;
}

function send(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  response.end(JSON.stringify(body));
}

/**
 * The HTTP server for the service API. Each request is checked against its route's schemas, and
 * each answer against the route's response schema, so the service cannot drift from the contract.
 * Logs carry the method, path, status and time, never a body or a header.
 */
export function createRouteServer(routes: BoundRoute[], log: (line: string) => void = console.log): Server {
  return createServer((request, response) => {
    const started = Date.now();
    const url = new URL(request.url ?? '/', 'http://service');
    void (async () => {
      let status = 500;
      try {
        if (request.method === 'GET' && url.pathname === '/healthz') {
          status = 200;
          send(response, status, { ok: true });
          return;
        }
        let matched: { bound: BoundRoute; params: Record<string, string> } | null = null;
        for (const bound of routes) {
          if (bound.route.method !== request.method) continue;
          const params = matchPath(bound.route.path, url.pathname);
          if (params) {
            matched = { bound, params };
            break;
          }
        }
        if (!matched) throw new CloudApiError('invalid_request', `No route for ${request.method} ${url.pathname}.`, 'Check the method and path against the contract.');
        const { route: target, handle } = matched.bound;
        const authorization = request.headers.authorization ?? '';
        const token = authorization.startsWith('Bearer ') ? authorization.slice('Bearer '.length) : null;
        if (target.auth && !token) throw new CloudApiError('unauthenticated', 'This call needs a signed-in account.', 'Sign in and send the token as a Bearer token.');
        const rawBody = await readJson(request);
        const body = target.body ? check('body', target.body, rawBody) : undefined;
        const query = target.query ? check('query', target.query, Object.fromEntries(url.searchParams)) : {};
        const result = await handle({ params: matched.params, body, query, token });
        const answer = target.response.safeParse(result);
        if (!answer.success) throw new Error(`answer for ${target.id} is outside the contract: ${z.prettifyError(answer.error)}`);
        status = target.status;
        send(response, status, answer.data);
      } catch (error) {
        if (error instanceof CloudApiError) {
          if (error instanceof BodyTooLarge) response.setHeader('connection', 'close');
          status = error.status;
          send(response, status, error.toBody());
        } else {
          console.error(`${request.method} ${url.pathname} failed:`, error);
          status = 500;
          send(response, status, new CloudApiError('internal', 'The service hit an unexpected error.', 'Try again; if it keeps happening, contact Pane Cloud support.').toBody());
        }
      } finally {
        log(`${request.method} ${url.pathname} ${status} ${Date.now() - started}ms`);
      }
    })();
  });
}
