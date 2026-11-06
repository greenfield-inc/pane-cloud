/**
 * The fleet API server and scheduler. The service calls it with signed operations; it checks each
 * one, places creates and resumes on the host with the most memory headroom, and hands the same
 * envelope to that host when the host next syncs. Hosts report machines, results and events back.
 */
import type { AddressInfo } from 'node:net';
import {
  canonicalJson,
  CloudApiError,
  type FleetEvent,
  type FleetMachine,
  fleetRoutes,
  MACHINE_LIMITS,
  type MachineMetrics,
  type OperationEnvelope,
  type OperationStatus,
  verifyOperation,
} from 'pane-cloud-contract';
import { bind, createApiServer } from './http.js';
import type { ReleaseList } from './ports.js';
import { createSaver, type StateStore } from './store.js';
import { type HostReport, type Placement, syncRoute, type Work } from './sync.js';

const FINAL: readonly FleetMachine['state'][] = ['stopped', 'deleted'];
const MAX_EVENTS = 100_000;
const OPERATION_RETENTION_MS = 24 * 60 * 60 * 1000;
/** F3's guest subnet, 10.200.0.0/16, holds 16,384 /30 slots: the most machines the fleet can keep. */
const NETWORK_SLOTS = 16_384;

interface MachineRecord {
  machine: FleetMachine;
  /** The machine's network slot, kept until it is deleted (`Placement.slot`). */
  slot: number;
  /** The last metrics a host reported, kept while the machine is on no host. */
  metrics: MachineMetrics | null;
  /** Set while the machine waits to be rebuilt from the disk on this lost host. */
  recoverFrom: string | null;
}

interface OperationRecord {
  status: OperationStatus;
  envelope: OperationEnvelope;
  hostId: string | null;
  /** Whether the host has reported the operation, so it stops being handed out. */
  delivered: boolean;
}

export interface FleetState {
  machines: Record<string, MachineRecord>;
  operations: Record<string, OperationRecord>;
  events: FleetEvent[];
  nextEventId: number;
  /** The last event id stored from each host. */
  hostCursors: Record<string, string>;
}

export interface FleetOptions {
  /** Bearer token the service sends on the fleet API. */
  serviceToken: string;
  /** Bearer token hosts send on the sync route. */
  hostToken: string;
  /** Service signing keys, by key id (PEM public keys). */
  trustedKeys: Record<string, string>;
  releases: ReleaseList;
  store: StateStore<FleetState>;
  now?: () => Date;
  /** A host that has not synced for this long is lost; its machines are rebuilt elsewhere. */
  hostLostAfterMs?: number;
  /** Memory a new machine is expected to use, for placement (the cover sheet's 3 GiB average). */
  newMachineMiB?: number;
  /** How often to look for lost hosts and machines waiting for a host. */
  checkIntervalMs?: number;
  log?: (entry: Record<string, unknown>) => void;
}

export interface Fleet {
  url: string;
  close(): Promise<void>;
}

interface HostView {
  report: HostReport | null;
  seenAt: number;
  lost: boolean;
}

const notFound = (machineId: string) => new CloudApiError('machine_not_found', `The fleet has no machine ${machineId}.`, 'Create the machine first, or check its id.');
const invalidState = (machine: FleetMachine, operation: string) =>
  new CloudApiError('invalid_state', `${operation} cannot run on machine ${machine.machineId} while it is ${machine.state}.`, 'Read the machine state and send the operation that fits it.');
const noCapacity = () => new CloudApiError('no_capacity', 'No fleet host has room for another machine right now.', 'Retry in a few minutes; the fleet adds hosts as it fills.');

export async function startFleet(options: FleetOptions, listen: { host?: string; port?: number } = {}): Promise<Fleet> {
  const o = options;
  const now = o.now ?? (() => new Date());
  const iso = () => now().toISOString();
  const log = o.log ?? ((entry) => console.log(JSON.stringify({ at: iso(), ...entry })));
  const lostAfterMs = o.hostLostAfterMs ?? 120_000;
  const newMachineMiB = o.newMachineMiB ?? 3072;

  const state: FleetState = (await o.store.load()) ?? { machines: {}, operations: {}, events: [], nextEventId: 1, hostCursors: {} };
  const save = createSaver(o.store, () => state);
  const hosts = new Map<string, HostView>();
  // A host that had machines before a restart must sync again, or it is lost.
  for (const { machine } of Object.values(state.machines)) {
    if (machine.hostId && !hosts.has(machine.hostId)) hosts.set(machine.hostId, { report: null, seenAt: now().getTime(), lost: false });
  }

  const record = (event: Omit<FleetEvent, 'id' | 'at'> & { at?: string }) => {
    state.events.push({ at: iso(), ...event, id: String(state.nextEventId++) });
    if (state.events.length > MAX_EVENTS) state.events.splice(0, state.events.length - MAX_EVENTS);
  };

  // ── Scheduler ──────────────────────────────────────────────────────────────────────────────────

  const live = (view: HostView) => !view.lost && view.report !== null && now().getTime() - view.seenAt <= lostAfterMs;
  /** Machines handed to a host that its last report does not include yet. */
  const pendingOn = (hostId: string) =>
    Object.values(state.operations).filter((op) => op.hostId === hostId && !op.delivered && (op.status.operation === 'create' || op.status.operation === 'resume')).length +
    Object.values(state.machines).filter((m) => m.recoverFrom && m.machine.hostId === hostId).length;

  /** The live host with the most memory headroom under its overcommit target and a free slot. */
  function place(): string | null {
    let best: { hostId: string; headroom: number } | null = null;
    for (const [hostId, view] of hosts) {
      const report = view.report;
      if (!report || !live(view) || report.draining) continue;
      const pending = pendingOn(hostId);
      const headroom = report.memoryTargetMiB - report.memoryUsedMiB - pending * newMachineMiB;
      if (report.activeMachines + pending >= report.maxMachines || headroom < newMachineMiB) continue;
      if (!best || headroom > best.headroom) best = { hostId, headroom };
    }
    return best?.hostId ?? null;
  }

  /** The lowest slot no machine holds. A stopped machine keeps its slot, so it resumes with the same address. */
  function freeSlot(): number | null {
    const used = new Set(Object.values(state.machines).filter((m) => m.machine.state !== 'deleted').map((m) => m.slot));
    for (let slot = 0; slot < NETWORK_SLOTS; slot += 1) if (!used.has(slot)) return slot;
    return null;
  }

  const placement = (m: MachineRecord): Placement => {
    const month = iso().slice(0, 7);
    return { slot: m.slot, egressBytesThisMonth: m.metrics?.day.slice(0, 7) === month ? m.metrics.egressBytesThisMonth : 0 };
  };

  /** Any live host, for work that needs no room, such as deleting a stopped machine's snapshot. */
  const anyHost = () => [...hosts].find(([, view]) => live(view))?.[0] ?? null;

  /** Checks the operation fits the machine, picks its host and records its first step. */
  function route(payload: OperationEnvelope['payload']): string {
    const { machineId, operation } = payload;
    const existing = state.machines[machineId];
    if (operation === 'create') {
      if (existing && existing.machine.state !== 'deleted') throw new CloudApiError('machine_exists', `Machine ${machineId} already exists.`, 'Use a new machine id, or resume the existing machine.');
      const hostId = place();
      const slot = freeSlot();
      if (!hostId || slot === null) throw noCapacity();
      state.machines[machineId] = {
        machine: { machineId, state: 'creating', stateReason: null, hostId, paneVersion: null, tailnet: { status: 'awaiting_login', loginUrl: null, hostname: null }, updatedAt: iso() },
        slot,
        metrics: null,
        recoverFrom: null,
      };
      return hostId;
    }
    if (!existing || existing.machine.state === 'deleted') throw notFound(machineId);
    const machine = existing.machine;
    if (operation === 'resume') {
      if (machine.state !== 'stopped') throw invalidState(machine, operation);
      const hostId = place();
      if (!hostId) throw noCapacity();
      existing.machine = { ...machine, state: 'resuming', stateReason: null, hostId, updatedAt: iso() };
      return hostId;
    }
    if (operation === 'delete') {
      const hostId = machine.hostId ?? anyHost();
      if (!hostId) throw noCapacity();
      existing.recoverFrom = null;
      existing.machine = { ...machine, hostId };
      return hostId;
    }
    if (machine.state !== 'running' || !machine.hostId) throw invalidState(machine, operation);
    return machine.hostId;
  }

  async function submit(body: Parameters<typeof verifyOperation>[0]): Promise<OperationStatus> {
    const envelope = verifyOperation(body, o.trustedKeys, now());
    const { payload } = envelope;
    const seen = () => {
      const op = state.operations[payload.requestId];
      if (op && canonicalJson(op.envelope.payload) !== canonicalJson(payload)) {
        throw new CloudApiError('invalid_request', `requestId ${payload.requestId} was already used for a different operation.`, 'Use a new requestId for each operation.');
      }
      return op?.status;
    };
    const first = seen();
    if (first) return first;
    if ((payload.operation === 'bootstrap' || payload.operation === 'update_pane') && !(await o.releases.isPublished(payload.parameters.release))) {
      throw new CloudApiError('release_not_published', `Pane ${payload.parameters.release.version} with that checksum is not a published release.`, 'Name a published release and its exact .deb checksum.');
    }
    const raced = seen();
    if (raced) return raced;
    const hostId = route(payload);
    const status: OperationStatus = { requestId: payload.requestId, machineId: payload.machineId, operation: payload.operation, status: 'accepted', error: null, result: null, acceptedAt: iso(), finishedAt: null };
    state.operations[payload.requestId] = { status, envelope, hostId, delivered: false };
    await save();
    log({ msg: 'operation accepted', requestId: payload.requestId, machineId: payload.machineId, operation: payload.operation, reason: payload.reason, hostId, keyId: envelope.signature.keyId });
    return status;
  }

  // ── Host sync ──────────────────────────────────────────────────────────────────────────────────

  function absorb(hostId: string, machine: FleetMachine, metrics: MachineMetrics | null, waiting: Set<string>) {
    const existing = state.machines[machine.machineId];
    // A report from before the host received its newest work for this machine is stale.
    if (!existing || existing.machine.hostId !== hostId || waiting.has(machine.machineId)) return;
    if (existing.recoverFrom) {
      if (FINAL.includes(machine.state) || machine.state === 'error') return;
      existing.recoverFrom = null;
    }
    existing.machine = { ...machine, hostId: FINAL.includes(machine.state) ? null : hostId };
    if (metrics) existing.metrics = metrics;
  }

  /** A create or resume the host refused before starting leaves the machine as it was. */
  function undoRefused(hostId: string, status: OperationStatus, report: HostReport) {
    const existing = state.machines[status.machineId];
    if (!existing || existing.machine.hostId !== hostId) return;
    const onHost = report.machines.find((m) => m.machine.machineId === status.machineId)?.machine.state;
    if (onHost && !FINAL.includes(onHost)) return;
    if (status.operation === 'create' && existing.machine.state === 'creating') delete state.machines[status.machineId];
    if (status.operation === 'resume' && existing.machine.state === 'resuming') existing.machine = { ...existing.machine, state: 'stopped', hostId: null, updatedAt: iso() };
  }

  async function sync(hostId: string, report: HostReport) {
    if (report.hostId !== hostId) throw new CloudApiError('invalid_request', 'The report names a different host than the path.', 'Send the report for this host.');
    const view = hosts.get(hostId);
    if (view?.lost) {
      throw new CloudApiError('invalid_state', `Host ${hostId} was declared lost and its machines were moved.`, 'Stop this host; it must not run machines again.');
    }
    hosts.set(hostId, { report, seenAt: now().getTime(), lost: false });

    for (const status of report.operations) {
      const op = state.operations[status.requestId];
      if (!op || op.hostId !== hostId || op.status.finishedAt) continue;
      op.status = status;
      op.delivered = true;
      if (status.status === 'failed') undoRefused(hostId, status, report);
    }
    const cursor = Number(state.hostCursors[hostId] ?? 0);
    for (const event of report.events) {
      if (Number(event.id) <= cursor) continue;
      record(event);
      state.hostCursors[hostId] = event.id;
    }
    const waiting = new Set(Object.values(state.operations).filter((op) => op.hostId === hostId && !op.delivered).map((op) => op.status.machineId));
    for (const { machine, metrics } of report.machines) absorb(hostId, machine, metrics, waiting);

    const work: Work[] = [
      ...Object.values(state.operations)
        .filter((op) => op.hostId === hostId && !op.delivered)
        .flatMap((op): Work[] => {
          const m = state.machines[op.status.machineId];
          return m ? [{ kind: 'operation', envelope: op.envelope, placement: placement(m) }] : [];
        }),
      ...Object.values(state.machines)
        .filter((m) => m.recoverFrom && m.machine.hostId === hostId)
        .map((m): Work => ({ kind: 'recover', machineId: m.machine.machineId, fromHostId: m.recoverFrom ?? '', placement: placement(m) })),
    ];
    await save();
    return { work, eventsAck: state.hostCursors[hostId] ?? null };
  }

  // ── Host loss ──────────────────────────────────────────────────────────────────────────────────

  function hostLost(hostId: string) {
    log({ msg: 'host lost', hostId });
    for (const op of Object.values(state.operations)) {
      if (op.hostId !== hostId || op.status.finishedAt) continue;
      op.status = {
        ...op.status,
        status: 'failed',
        error: { code: 'internal', message: `Host ${hostId} stopped answering while the operation ran.`, next: 'Read the machine state; the fleet brings running machines back on another host.' },
        finishedAt: iso(),
      };
      record({ machineId: op.status.machineId, kind: 'operation_finished', state: null, reason: null, requestId: op.status.requestId });
    }
    for (const m of Object.values(state.machines)) {
      if (m.machine.hostId !== hostId || FINAL.includes(m.machine.state)) continue;
      // A machine still being created there has no disk to bring back; one still recovering keeps its source.
      if (m.machine.state !== 'creating' || m.recoverFrom) m.recoverFrom ??= hostId;
      m.machine = { ...m.machine, state: 'error', stateReason: 'host_lost', hostId: null, updatedAt: iso() };
      record({ machineId: m.machine.machineId, kind: 'state_changed', state: 'error', reason: 'host_lost', requestId: null });
    }
  }

  async function check() {
    const at = now().getTime();
    for (const [hostId, view] of hosts) {
      if (!view.lost && at - view.seenAt > lostAfterMs) {
        view.lost = true;
        hostLost(hostId);
      }
    }
    for (const m of Object.values(state.machines)) {
      if (!m.recoverFrom || m.machine.hostId) continue;
      const hostId = place();
      if (!hostId) break;
      m.machine = { ...m.machine, hostId, updatedAt: iso() };
      log({ msg: 'recovery placed', machineId: m.machine.machineId, fromHostId: m.recoverFrom, hostId });
    }
    for (const [id, op] of Object.entries(state.operations)) {
      if (op.status.finishedAt && at - Date.parse(op.status.finishedAt) > OPERATION_RETENTION_MS) delete state.operations[id];
    }
    await save();
  }

  // ── Routes ─────────────────────────────────────────────────────────────────────────────────────

  const server = createApiServer(
    [
      bind(fleetRoutes.submitOperation, o.serviceToken, async ({ body }) => {
        try {
          return await submit(body);
        } catch (error) {
          if (error instanceof CloudApiError) log({ msg: 'operation refused', code: error.code, requestId: body.payload.requestId, machineId: body.payload.machineId, operation: body.payload.operation });
          throw error;
        }
      }),
      bind(fleetRoutes.getOperation, o.serviceToken, async ({ params }) => {
        const op = state.operations[params.requestId ?? ''];
        if (!op) throw new CloudApiError('operation_not_found', `No operation ${params.requestId}.`, 'Check the requestId the operation was sent with.');
        return op.status;
      }),
      bind(fleetRoutes.getMachine, o.serviceToken, async ({ params }) => {
        const m = state.machines[params.machineId ?? ''];
        if (!m) throw notFound(params.machineId ?? '');
        return m.machine;
      }),
      bind(fleetRoutes.getMetrics, o.serviceToken, async ({ params, query }) => {
        const m = state.machines[params.machineId ?? ''];
        if (!m || m.machine.state === 'deleted') throw notFound(params.machineId ?? '');
        const day = query.day ?? iso().slice(0, 10);
        const last = m.metrics;
        const today = last?.day === day;
        return {
          machineId: m.machine.machineId,
          day,
          cpuSecondsUsed: today ? last.cpuSecondsUsed : 0,
          cpuBudgetSeconds: MACHINE_LIMITS.dailyCpuSeconds,
          throttled: today ? last.throttled : false,
          memoryResidentMiB: m.machine.state === 'running' ? (last?.memoryResidentMiB ?? 0) : 0,
          diskUsedBytes: last?.diskUsedBytes ?? 0,
          egressBytesThisMonth: last && last.day.slice(0, 7) === day.slice(0, 7) ? last.egressBytesThisMonth : 0,
          sampledAt: last?.sampledAt ?? iso(),
        };
      }),
      bind(fleetRoutes.listEvents, o.serviceToken, async ({ query }) => {
        const after = Number(query.after ?? 0);
        const page = state.events.filter((e) => Number(e.id) > after).slice(0, query.limit ?? 100);
        return { events: page, nextCursor: page.at(-1)?.id ?? query.after ?? null };
      }),
      bind(syncRoute, o.hostToken, async ({ params, body }) => sync(params.hostId ?? '', body)),
    ],
    log,
  );

  await new Promise<void>((resolve) => server.listen(listen.port ?? 0, listen.host ?? '127.0.0.1', resolve));
  // SAFETY: a server listening on a TCP port reports an AddressInfo.
  const { address, port } = server.address() as AddressInfo;
  let checking = Promise.resolve();
  const timer = setInterval(() => {
    checking = checking.then(check).catch((error: unknown) => log({ msg: 'check failed', error: String(error) }));
  }, o.checkIntervalMs ?? 5_000);
  log({ msg: 'fleet API listening', address, port });

  return {
    url: `http://${address.includes(':') ? `[${address}]` : address}:${port}`,
    async close() {
      clearInterval(timer);
      await checking;
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
      await save();
    },
  };
}
