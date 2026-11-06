import { createServer, request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';

/** An HTTP proxy to `target` that can be switched off, standing in for a fleet that stops answering. */
export async function startSwitchableProxy(target: () => string) {
  let up = true;
  const server = createServer((req, res) => {
    if (!up) {
      req.socket.destroy();
      return;
    }
    const url = new URL(req.url ?? '/', target());
    const upstream = httpRequest(url, { method: req.method, headers: req.headers }, (answer) => {
      res.writeHead(answer.statusCode ?? 502, answer.headers);
      answer.pipe(res);
    });
    upstream.on('error', () => req.socket.destroy());
    req.pipe(upstream);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  // SAFETY: a server listening on a TCP port reports an AddressInfo.
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    set up(value: boolean) {
      up = value;
    },
    close: () => {
      server.closeAllConnections();
      return new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
