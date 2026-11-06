import { request } from 'node:http';

/** Thrown when Firecracker's API answers a request with an error, or the socket fails. */
export class FirecrackerApiError extends Error {
  constructor(
    readonly method: string,
    readonly path: string,
    readonly status: number | null,
    detail: string,
  ) {
    super(`Firecracker ${method} ${path} failed${status === null ? '' : ` (${status})`}: ${detail}`);
    this.name = 'FirecrackerApiError';
  }
}

type Method = 'GET' | 'PUT' | 'PATCH';

/** A client for one Firecracker process's API socket. */
export interface FirecrackerApi {
  call<T = unknown>(method: Method, path: string, body?: unknown): Promise<T>;
}

export function firecrackerApi(socketPath: string, timeoutMs = 30_000): FirecrackerApi {
  return {
    call<T>(method: Method, path: string, body?: unknown): Promise<T> {
      const payload = body === undefined ? undefined : JSON.stringify(body);
      return new Promise<T>((resolve, reject) => {
        const req = request(
          {
            socketPath,
            path,
            method,
            timeout: timeoutMs,
            headers: payload === undefined ? { accept: 'application/json' } : { accept: 'application/json', 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) },
          },
          (res) => {
            const chunks: Buffer[] = [];
            res.on('data', (chunk: Buffer) => chunks.push(chunk));
            res.on('end', () => {
              const text = Buffer.concat(chunks).toString('utf8');
              const status = res.statusCode ?? 0;
              if (status >= 300) {
                reject(new FirecrackerApiError(method, path, status, text || res.statusMessage || 'no body'));
                return;
              }
              try {
                // SAFETY: Firecracker's API answers with the documented JSON shape for each path.
                resolve((text === '' ? undefined : JSON.parse(text)) as T);
              } catch {
                reject(new FirecrackerApiError(method, path, status, `body is not JSON: ${text.slice(0, 200)}`));
              }
            });
          },
        );
        req.on('timeout', () => req.destroy(new Error(`no answer within ${timeoutMs} ms`)));
        req.on('error', (error) => reject(new FirecrackerApiError(method, path, null, error.message)));
        if (payload !== undefined) req.write(payload);
        req.end();
      });
    },
  };
}
