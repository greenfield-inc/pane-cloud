/**
 * The host side of the F5 guest agent protocol (fleet/README.md): one JSON object per line over
 * Firecracker's vsock socket, guest port 1024. Everything the guest says is untrusted (its user has
 * root), so every answer is size-capped and parsed strictly.
 */
import { randomUUID } from 'node:crypto';
import { connect } from 'node:net';
import { CloudApiError, type PaneRelease, TailnetStatus } from 'pane-cloud-contract';
import { z } from 'zod';

export const GUEST_PORT = 1024;

export const GuestStatus = z.object({
  paneVersion: z.string().max(64).nullable(),
  tailnet: TailnetStatus,
  activity: z.object({
    agentsRunning: z.number().int().nonnegative(),
    clientsConnected: z.number().int().nonnegative(),
    lastActivityAt: z.iso.datetime({ offset: true }).nullable(),
  }),
});
export type GuestStatus = z.infer<typeof GuestStatus>;

/** F5's `collect_diagnostics` answer. The host checks the archive against `bytes` and `sha256`. */
export const GuestDiagnostics = z.object({
  files: z.array(z.object({ path: z.string().max(4096), bytes: z.number().int().nonnegative() }).strict()).max(1000),
  skipped: z.array(z.object({ path: z.string().max(4096), reason: z.string().max(200) }).strict()).max(1000),
  archive: z
    .object({
      format: z.literal('tar+gzip'),
      bytes: z.number().int().nonnegative(),
      sha256: z.string().regex(/^[0-9a-f]{64}$/),
      base64: z.base64(),
    })
    .strict(),
});

/** F5's `bootstrap` answer: whether the guest's first-boot setup is still running, done or failed. */
export const GuestBootstrap = z.object({ firstBoot: z.enum(['running', 'done', 'failed']) });

export type GuestRequest =
  | { operation: 'status' | 'prepare_to_stop' | 'collect_diagnostics'; parameters: Record<string, never> }
  | { operation: 'bootstrap' | 'update_pane'; parameters: { release: PaneRelease } };

const GuestAnswer = z.union([
  z.object({ id: z.string(), ok: z.literal(true), result: z.unknown() }),
  z.object({ id: z.string(), ok: z.literal(false), error: z.object({ code: z.string().max(64), message: z.string().max(2000), next: z.string().max(2000) }) }),
]);

const MAX_LINE_BYTES = 48 * 1024 * 1024;

/** Sends one request to the guest agent and returns its result, or throws with the guest's error. */
export function callGuest(vsockPath: string, request: GuestRequest, timeoutMs: number, id: string = randomUUID()): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const socket = connect(vsockPath);
    let buffer = '';
    let connected = false;
    const fail = (error: Error) => {
      socket.destroy();
      reject(error);
    };
    socket.setTimeout(timeoutMs, () => fail(new Error(`The guest agent did not answer ${request.operation} within ${timeoutMs} ms.`)));
    socket.on('error', (error) => fail(new Error(`The guest agent is unreachable: ${error.message}`)));
    socket.on('close', () => reject(new Error(`The guest agent closed the connection before answering ${request.operation}.`)));
    socket.on('connect', () => socket.write(`CONNECT ${GUEST_PORT}\n`));
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      if (buffer.length > MAX_LINE_BYTES) return fail(new Error('The guest agent sent an answer that is too large.'));
      for (let newline = buffer.indexOf('\n'); newline >= 0; newline = buffer.indexOf('\n')) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (!connected) {
          if (!line.startsWith('OK ')) return fail(new Error(`The guest agent refused the vsock connection: ${line.slice(0, 200)}`));
          connected = true;
          socket.write(`${JSON.stringify({ id, ...request })}\n`);
          continue;
        }
        let answer: z.infer<typeof GuestAnswer>;
        try {
          answer = GuestAnswer.parse(JSON.parse(line));
        } catch {
          return fail(new Error('The guest agent answered outside the protocol.'));
        }
        if (answer.id !== id) return fail(new Error('The guest agent answered a different request.'));
        socket.end();
        if (answer.ok) return resolve(answer.result);
        return reject(new GuestError(answer.error.code, answer.error.message, answer.error.next));
      }
    });
  });
}

/** An error the guest agent reported. Its text came from inside the machine. */
export class GuestError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly next: string,
  ) {
    super(message);
    this.name = 'GuestError';
  }
}

/** The operation's failure as the fleet reports it: the contract's codes only. */
export function operationError(error: unknown): { code: string; message: string; next: string } {
  if (error instanceof CloudApiError) return { code: error.code, message: error.message, next: error.next };
  if (error instanceof GuestError) return { code: 'internal', message: `The machine's guest agent reported ${error.code}: ${error.message}`, next: error.next };
  return { code: 'internal', message: error instanceof Error ? error.message : String(error), next: 'Read the machine state, then retry the operation or collect diagnostics.' };
}
