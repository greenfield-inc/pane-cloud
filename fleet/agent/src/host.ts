/**
 * The host agent: runs on every fleet host, verifies each signed operation itself, and drives F1's
 * runtime, F3's network, F4's fair use and the guest agent. It has no inbound port; it calls the
 * fleet API to report and to receive work (`sync.ts`).
 */
import { readFile, rename, rm, stat } from 'node:fs/promises';
import { freemem, totalmem } from 'node:os';
import { join } from 'node:path';
import { createDiskFromTemplate, type MachineSpec, type Runtime, type Vm } from '@pane-cloud/fleet-runtime';
import {
  callRoute,
  CloudApiError,
  FLEET_OPERATIONS,
  type FleetEvent,
  type FleetMachine,
  MACHINE_LIMITS,
  type MachineMetrics,
  type OperationEnvelope,
  type OperationPayload,
  type OperationStatus,
  verifyOperation,
} from 'pane-cloud-contract';
import { callGuest, GuestDiagnostics, GuestStatus, operationError } from './guest.js';
import { copySparse } from './local.js';
import type { DiagnosticsStore, FairUsePort, HostMemorySample, MaintenanceSignal, MachineAttachment, NetworkPort, ReleaseList, SnapshotStore, VolumeRecovery } from './ports.js';
import { createSaver, type StateStore } from './store.js';
import { type HostReport, syncRoute, type Work } from './sync.js';

/** No agent running and no client connected for this long stops a machine (journey 9). */
export const IDLE_STOP_MS = 30 * 60 * 1000;

type State = FleetMachine['state'];
type Reason = NonNullable<FleetMachine['stateReason']>;

/** States in which a machine holds a slot, a disk and usually a VM on this host. */
const ACTIVE: readonly State[] = ['creating', 'running', 'stopping', 'resuming', 'deleting'];
/** How long a stopped or deleted machine stays in reports, so the fleet sees its last state. */
const FINISHED_RECORD_MS = 60 * 60 * 1000;
const MAX_EVENTS = 10_000;

interface HostMachine {
  machine: FleetMachine;
  slot: number;
  metrics: MachineMetrics | null;
}

export interface HostState {
  machines: Record<string, HostMachine>;
  operations: Record<string, OperationStatus>;
  /** Events the fleet has not acknowledged, oldest first. */
  events: FleetEvent[];
  nextEventId: number;
}

export interface HostAgentOptions {
  hostId: string;
  fleetUrl: string;
  /** Bearer token for the fleet's host sync route. */
  token: string;
  /** Service signing keys this host trusts, by key id (PEM public keys). */
  trustedKeys: Record<string, string>;
  runtime: Runtime;
  releases: ReleaseList;
  snapshots: SnapshotStore;
  diagnostics: DiagnosticsStore;
  volumes: VolumeRecovery;
  maintenance: MaintenanceSignal;
  fairUse: FairUsePort;
  /** F3. Without it machines boot with no network interface. */
  network?: NetworkPort;
  store: StateStore<HostState>;
  /** Machine disks go in `<dataDir>/disks`, snapshots being written in `<dataDir>/snapshots`. */
  dataDir: string;
  kernelPath: string;
  templatePath: string;
  createDisk?: (templatePath: string, diskPath: string, sizeGiB: number) => Promise<void>;
  /** The machine size; D-13's limits unless a test host needs smaller. */
  machineSize?: { vcpu: number; memoryMiB: number };
  /** Machine i runs as uid and gid `uidBase + slot`. */
  uidBase?: number;
  maxMachines?: number;
  /** Share of host memory the scheduler may fill (F4's overcommit target). */
  memoryTargetFraction?: number;
  hostMemory?: () => HostMemorySample;
  now?: () => Date;
  syncIntervalMs?: number;
  /** How often to read guest status, metrics, maintenance and F4's reclaim decisions. */
  pollIntervalMs?: number;
  guestTimeoutMs?: number;
  /** For bootstrap and update_pane, which download and install a release. */
  guestInstallTimeoutMs?: number;
  log?: (entry: Record<string, unknown>) => void;
}

export interface HostAgent {
  /** Starts the sync and poll loops. */
  start(): void;
  /** Stops the loops. Machines keep running; a new agent reattaches to them. */
  close(): Promise<void>;
}

const drainingError = () => new CloudApiError('no_capacity', 'This host is stopping for maintenance.', 'Send a new operation; the fleet places it on another host.');
const invalidState = (machineId: string, operation: string, state: string | undefined) =>
  new CloudApiError('invalid_state', `${operation} cannot run on machine ${machineId} while it is ${state ?? 'absent from this host'}.`, 'Read the machine state and send the operation that fits it.');

/** Loads the host's state, reattaches to machines that kept running, and returns the agent. */
export async function createHostAgent(options: HostAgentOptions): Promise<HostAgent> {
  const o = options;
  const now = o.now ?? (() => new Date());
  const iso = () => now().toISOString();
  const log = o.log ?? ((entry) => console.log(JSON.stringify({ at: iso(), host: o.hostId, ...entry })));
  const size = o.machineSize ?? { vcpu: MACHINE_LIMITS.vcpu, memoryMiB: MACHINE_LIMITS.memoryMiB };
  const uidBase = o.uidBase ?? 200_000;
  const hostMemory = o.hostMemory ?? (() => ({ totalMiB: totalmem() / 2 ** 20, usedMiB: (totalmem() - freemem()) / 2 ** 20 }));
  const guestTimeoutMs = o.guestTimeoutMs ?? 30_000;
  const createDisk = o.createDisk ?? createDiskFromTemplate;

  const state: HostState = (await o.store.load()) ?? { machines: {}, operations: {}, events: [], nextEventId: 1 };
  const save = createSaver(o.store, () => state);
  const vms = new Map<string, Vm>();
  const idleSince = new Map<string, number>();
  const queues = new Map<string, Promise<void>>();
  const changedOperations = new Set<string>();
  let draining = false;

  const diskPath = (id: string) => join(o.dataDir, 'disks', `${id}.ext4`);
  const snapshotDir = (id: string) => join(o.dataDir, 'snapshots', id);
  const spec = (record: HostMachine, net?: MachineAttachment): MachineSpec => ({
    machineId: record.machine.machineId,
    uid: uidBase + record.slot,
    gid: uidBase + record.slot,
    vcpu: size.vcpu,
    memoryMiB: size.memoryMiB,
    kernelPath: o.kernelPath,
    diskPath: diskPath(record.machine.machineId),
    consoleLogPath: join(o.dataDir, 'console', `${record.machine.machineId}.log`),
    ...(net ? { network: { tapName: net.tapName, guestMac: net.guestMac, kernelIpArg: net.kernelIpArg } } : {}),
    balloon: { deflateOnOom: true, statsPollingIntervalS: 5 },
  });

  const record = (event: Omit<FleetEvent, 'id' | 'at'>) => {
    state.events.push({ ...event, id: String(state.nextEventId++), at: iso() });
    if (state.events.length > MAX_EVENTS) state.events.splice(0, state.events.length - MAX_EVENTS);
  };
  const setState = (m: HostMachine, next: State, reason: Reason | null, requestId: string | null = null) => {
    m.machine = { ...m.machine, state: next, stateReason: reason, updatedAt: iso() };
    if (next !== 'running') idleSince.delete(m.machine.machineId);
    record({ machineId: m.machine.machineId, kind: 'state_changed', state: next, reason, requestId });
    void save();
  };
  const freeSlot = () => {
    const used = new Set(Object.values(state.machines).filter((m) => ACTIVE.includes(m.machine.state)).map((m) => m.slot));
    let slot = 0;
    while (used.has(slot)) slot += 1;
    return slot;
  };
  const newRecord = (machineId: string, from?: HostMachine): HostMachine => {
    const m: HostMachine = {
      machine: {
        machineId,
        state: 'creating',
        stateReason: null,
        hostId: o.hostId,
        paneVersion: from?.machine.paneVersion ?? null,
        tailnet: from?.machine.tailnet ?? { status: 'awaiting_login', loginUrl: null, hostname: null },
        updatedAt: iso(),
      },
      slot: freeSlot(),
      metrics: null,
    };
    state.machines[machineId] = m;
    return m;
  };
  /** Runs machine work one step at a time per machine. */
  const enqueue = (machineId: string, step: () => Promise<void>) => {
    const next = (queues.get(machineId) ?? Promise.resolve()).then(step).catch((error: unknown) => log({ msg: 'machine step failed', machineId, error: String(error) }));
    queues.set(machineId, next);
    return next;
  };

  // ── Lifecycle ──────────────────────────────────────────────────────────────────────────────────

  async function boot(m: HostMachine, snapshot?: { statePath: string; memPath: string }) {
    const id = m.machine.machineId;
    const net = o.network ? await o.network.attach(id, m.slot) : undefined;
    const vm = snapshot ? await o.runtime.restore(spec(m, net), snapshot) : await o.runtime.start(spec(m, net));
    vms.set(id, vm);
    await o.fairUse.applyCeilings(vm.cgroupPath);
  }

  async function release(id: string) {
    const vm = vms.get(id);
    vms.delete(id);
    if (vm) await vm.stop();
    await o.network?.detach(id);
  }

  async function guestCall(id: string, request: Parameters<typeof callGuest>[1], requestId?: string, timeoutMs = guestTimeoutMs) {
    const vm = vms.get(id);
    if (!vm) throw invalidState(id, request.operation, state.machines[id]?.machine.state);
    return callGuest(vm.vsockPath, request, timeoutMs, requestId);
  }

  async function stopMachine(m: HostMachine, reason: Reason, requestId: string | null) {
    const id = m.machine.machineId;
    if (m.machine.state !== 'stopping') setState(m, 'stopping', reason, requestId);
    const vm = vms.get(id);
    if (!vm) throw new Error(`Machine ${id} has no VM on this host.`);
    // The guest's chance to flush; a guest that does not answer is stopped anyway.
    await guestCall(id, { operation: 'prepare_to_stop', parameters: {} }).catch((error: unknown) => log({ msg: 'prepare_to_stop failed', machineId: id, error: String(error) }));
    let files;
    try {
      files = await vm.snapshot(snapshotDir(id));
    } catch (error) {
      // Nothing was lost: the machine keeps running as it was.
      await vm.resume();
      setState(m, 'running', null, requestId);
      throw error;
    }
    await release(id);
    await o.snapshots.put(id, { diskPath: diskPath(id), ...files });
    await rm(diskPath(id), { force: true });
    await rm(snapshotDir(id), { recursive: true, force: true });
    m.metrics = m.metrics && { ...m.metrics, memoryResidentMiB: 0 };
    setState(m, 'stopped', reason, requestId);
  }

  async function lifecycle(m: HostMachine, payload: OperationPayload): Promise<void> {
    const id = m.machine.machineId;
    try {
      switch (payload.operation) {
        case 'create':
          await createDisk(o.templatePath, diskPath(id), MACHINE_LIMITS.diskGiB);
          await boot(m);
          break;
        case 'resume': {
          const files = await o.snapshots.get(id, snapshotDir(id));
          if (!files) throw new CloudApiError('invalid_state', `Machine ${id} has no saved snapshot to resume from.`, 'Create a new machine, or collect diagnostics.');
          await rename(files.diskPath, diskPath(id));
          await boot(m, files);
          await rm(snapshotDir(id), { recursive: true, force: true });
          break;
        }
        case 'stop':
          return await stopMachine(m, 'user', payload.requestId);
        case 'delete':
          await release(id);
          await rm(diskPath(id), { force: true });
          await rm(snapshotDir(id), { recursive: true, force: true });
          await o.snapshots.delete(id);
          return setState(m, 'deleted', 'user', payload.requestId);
        default:
          throw new Error(`${payload.operation} is not a lifecycle operation.`);
      }
      setState(m, 'running', null, payload.requestId);
    } catch (error) {
      if (m.machine.state !== 'running') setState(m, 'error', 'failed', payload.requestId);
      throw error;
    }
  }

  async function guestOperation(m: HostMachine, payload: OperationPayload): Promise<OperationStatus['result']> {
    const id = m.machine.machineId;
    switch (payload.operation) {
      case 'bootstrap':
      case 'update_pane':
        await guestCall(id, { operation: payload.operation, parameters: { release: payload.parameters.release } }, payload.requestId, o.guestInstallTimeoutMs ?? 15 * 60_000);
        m.machine = { ...m.machine, paneVersion: payload.parameters.release.version, updatedAt: iso() };
        await refreshStatus(m).catch(() => undefined);
        return null;
      case 'prepare_to_stop':
        await guestCall(id, { operation: 'prepare_to_stop', parameters: {} }, payload.requestId);
        return null;
      case 'collect_diagnostics': {
        const found = GuestDiagnostics.parse(await guestCall(id, { operation: 'collect_diagnostics', parameters: {} }, payload.requestId));
        const archiveKey = `diagnostics/${id}/${payload.requestId}.tar.gz`;
        await o.diagnostics.put(archiveKey, Buffer.from(found.archiveBase64, 'base64'));
        return { files: found.files, archiveKey };
      }
      default:
        throw new Error(`${payload.operation} is not a guest operation.`);
    }
  }

  // ── Operations ─────────────────────────────────────────────────────────────────────────────────

  const finish = (status: OperationStatus, outcome: { error: OperationStatus['error'] } | { result: OperationStatus['result'] }) => {
    Object.assign(status, { status: 'error' in outcome ? 'failed' : 'succeeded', finishedAt: iso() }, outcome);
    changedOperations.add(status.requestId);
    record({ machineId: status.machineId, kind: 'operation_finished', state: null, reason: null, requestId: status.requestId });
    log({ msg: 'operation finished', requestId: status.requestId, machineId: status.machineId, operation: status.operation, status: status.status, error: status.error?.code });
    void save();
  };

  /** Checks a signed operation against this host's own keys, releases and machine states, then runs it. */
  async function receive(envelope: OperationEnvelope) {
    const { requestId, machineId, operation, reason } = envelope.payload;
    if (state.operations[requestId]) return;
    const status: OperationStatus = { requestId, machineId, operation, status: 'accepted', error: null, result: null, acceptedAt: iso(), finishedAt: null };
    state.operations[requestId] = status;
    changedOperations.add(requestId);
    log({ msg: 'operation received', requestId, machineId, operation, reason, keyId: envelope.signature.keyId });
    let payload: OperationPayload;
    let m: HostMachine;
    try {
      payload = verifyOperation(envelope, o.trustedKeys, now()).payload;
      if ((payload.operation === 'bootstrap' || payload.operation === 'update_pane') && !(await o.releases.isPublished(payload.parameters.release))) {
        throw new CloudApiError('release_not_published', `Pane ${payload.parameters.release.version} with that checksum is not a published release.`, 'Name a published release and its exact .deb checksum.');
      }
      m = admit(payload);
    } catch (error) {
      return finish(status, { error: operationError(error) });
    }
    await save();
    void enqueue(machineId, async () => {
      status.status = 'running';
      changedOperations.add(requestId);
      try {
        const result = FLEET_OPERATIONS[payload.operation].runsOn === 'host' ? (await lifecycle(m, payload), null) : await guestOperation(m, payload);
        finish(status, { result });
      } catch (error) {
        finish(status, { error: operationError(error) });
      }
    });
  }

  /** Checks the machine's state allows the operation and takes its first step, before any await. */
  function admit(payload: OperationPayload): HostMachine {
    const { machineId: id, operation } = payload;
    const m = state.machines[id];
    const current = m?.machine.state;
    if (operation === 'create') {
      if (m && current !== 'deleted') throw new CloudApiError('machine_exists', `Machine ${id} already exists.`, 'Use a new machine id, or resume the existing machine.');
      if (draining) throw drainingError();
      const created = newRecord(id);
      setState(created, 'creating', null, payload.requestId);
      return created;
    }
    if (operation === 'resume') {
      if (m && current !== 'stopped') throw invalidState(id, operation, current);
      if (draining) throw drainingError();
      const resumed = newRecord(id, m);
      setState(resumed, 'resuming', null, payload.requestId);
      return resumed;
    }
    if (operation === 'delete') {
      if (current === 'deleting' || current === 'deleted') throw invalidState(id, operation, current);
      const target = m ?? newRecord(id);
      setState(target, 'deleting', 'user', payload.requestId);
      return target;
    }
    if (!m || current !== 'running') throw invalidState(id, operation, current);
    if (operation === 'stop') setState(m, 'stopping', 'user', payload.requestId);
    return m;
  }

  function recover(machineId: string, fromHostId: string) {
    const existing = state.machines[machineId];
    if (existing && ACTIVE.includes(existing.machine.state)) return;
    const m = newRecord(machineId, existing);
    setState(m, 'resuming', 'host_lost');
    log({ msg: 'recovering machine from a lost host', machineId, fromHostId });
    void enqueue(machineId, async () => {
      try {
        await copySparse(await o.volumes.diskOf(fromHostId, machineId), diskPath(machineId));
        await boot(m);
        setState(m, 'running', null);
      } catch (error) {
        setState(m, 'error', 'host_lost');
        throw error;
      }
    });
  }

  // ── Polling: guest status, idle stop, metrics, budget, maintenance, reclaim ─────────────────────

  async function refreshStatus(m: HostMachine): Promise<GuestStatus> {
    const status = GuestStatus.parse(await guestCall(m.machine.machineId, { operation: 'status', parameters: {} }));
    const changed = status.paneVersion !== m.machine.paneVersion || JSON.stringify(status.tailnet) !== JSON.stringify(m.machine.tailnet);
    if (changed) m.machine = { ...m.machine, paneVersion: status.paneVersion ?? m.machine.paneVersion, tailnet: status.tailnet, updatedAt: iso() };
    return status;
  }

  async function sample(m: HostMachine): Promise<{ residentMiB: number; idle: boolean }> {
    const id = m.machine.machineId;
    const vm = vms.get(id);
    if (!vm) return { residentMiB: 0, idle: false };
    const at = now();
    const status = await refreshStatus(m).catch(() => null);
    const idle = status !== null && status.activity.agentsRunning === 0 && status.activity.clientsConnected === 0;
    if (!idle) idleSince.delete(id);
    else if (!idleSince.has(id)) idleSince.set(id, at.getTime());

    const resident = Number((await readFile(join(vm.cgroupPath, 'memory.current'), 'utf8').catch(() => '0')).trim()) / 2 ** 20;
    const cpu = await o.fairUse.chargeCpu(id, vm.cgroupPath, at);
    const disk = await stat(diskPath(id)).then((s) => s.blocks * 512, () => 0);
    const egress = o.network ? await o.network.egressBytes(id) : 0;
    const before = m.metrics;
    m.metrics = {
      machineId: id,
      day: cpu.day,
      cpuSecondsUsed: cpu.cpuSecondsUsed,
      cpuBudgetSeconds: MACHINE_LIMITS.dailyCpuSeconds,
      throttled: cpu.throttled,
      memoryResidentMiB: resident,
      diskUsedBytes: disk,
      egressBytesThisMonth: egress,
      sampledAt: at.toISOString(),
    };
    if (cpu.throttled && !before?.throttled) record({ machineId: id, kind: 'budget_exhausted', state: null, reason: null, requestId: null });
    if (!cpu.throttled && before?.throttled) record({ machineId: id, kind: 'budget_reset', state: null, reason: null, requestId: null });
    return { residentMiB: resident, idle };
  }

  async function poll() {
    const running = Object.values(state.machines).filter((m) => m.machine.state === 'running' && vms.has(m.machine.machineId));
    const samples = [];
    for (const m of running) samples.push({ machineId: m.machine.machineId, ...(await sample(m)) });
    const at = now().getTime();
    const stop = (m: HostMachine, reason: Reason) => {
      // An operation may have changed the machine while this poll sampled it.
      if (m.machine.state !== 'running') return;
      setState(m, 'stopping', reason);
      void enqueue(m.machine.machineId, () =>
        stopMachine(m, reason, null).catch((error: unknown) => {
          if (m.machine.state === 'stopping') setState(m, 'error', 'failed');
          throw error;
        }),
      );
    };
    if (!draining && (await o.maintenance.requested())) {
      draining = true;
      log({ msg: 'maintenance requested; stopping every machine' });
    }
    for (const m of running) {
      if (draining) stop(m, 'host_maintenance');
      else if (at - (idleSince.get(m.machine.machineId) ?? at) >= IDLE_STOP_MS) stop(m, 'idle');
    }
    if (draining) return;
    for (const decision of o.fairUse.decideReclaim(hostMemory(), samples)) {
      const m = state.machines[decision.machineId];
      if (!m || m.machine.state !== 'running') continue;
      log({ msg: 'reclaim', ...decision });
      if (decision.kind === 'snapshot_stop') stop(m, 'memory_pressure');
      else await vms.get(decision.machineId)?.setBalloon(decision.balloonMiB);
    }
    void save();
  }

  // ── Sync with the fleet ────────────────────────────────────────────────────────────────────────

  function report(): HostReport {
    const at = now().getTime();
    for (const [id, m] of Object.entries(state.machines)) {
      if (!ACTIVE.includes(m.machine.state) && m.machine.state !== 'error' && at - Date.parse(m.machine.updatedAt) > FINISHED_RECORD_MS) delete state.machines[id];
    }
    for (const [id, op] of Object.entries(state.operations)) {
      if (op.finishedAt && at - Date.parse(op.finishedAt) > 24 * FINISHED_RECORD_MS) delete state.operations[id];
    }
    const memory = hostMemory();
    const machines = Object.values(state.machines);
    return {
      hostId: o.hostId,
      draining,
      maxMachines: o.maxMachines ?? 109,
      activeMachines: machines.filter((m) => ACTIVE.includes(m.machine.state)).length,
      memoryTargetMiB: memory.totalMiB * (o.memoryTargetFraction ?? 0.75),
      memoryUsedMiB: memory.usedMiB,
      machines: machines.map((m) => ({ machine: m.machine, metrics: m.machine.state === 'running' ? m.metrics : null })),
      // Copies: an operation can finish while the report is in flight.
      operations: [...changedOperations].flatMap((id) => (state.operations[id] ? [{ ...state.operations[id] }] : [])),
      events: state.events.slice(0, 500),
    };
  }

  async function sync() {
    await save();
    const body = report();
    const sent = new Set(changedOperations);
    const answer = await callRoute({ baseUrl: o.fleetUrl, token: o.token }, syncRoute, { params: { hostId: o.hostId }, body });
    for (const id of sent) {
      if (state.operations[id]?.status === body.operations.find((op) => op.requestId === id)?.status) changedOperations.delete(id);
    }
    if (answer.eventsAck !== null) {
      const acked = Number(answer.eventsAck);
      state.events = state.events.filter((e) => Number(e.id) > acked);
    }
    for (const work of answer.work) await handle(work);
  }

  async function handle(work: Work) {
    if (work.kind === 'operation') await receive(work.envelope);
    else recover(work.machineId, work.fromHostId);
  }

  // ── Startup: reattach to machines that kept running while the agent was down ────────────────────

  for (const op of Object.values(state.operations)) {
    if (!op.finishedAt) finish(op, { error: { code: 'internal', message: 'The host agent restarted while the operation ran.', next: 'Read the machine state, then send the operation again if it is still needed.' } });
  }
  for (const m of Object.values(state.machines)) {
    if (!ACTIVE.includes(m.machine.state)) continue;
    const vm = await o.runtime.attach(spec(m)).catch(() => null);
    if (vm) {
      vms.set(m.machine.machineId, vm);
      if (m.machine.state !== 'running') setState(m, 'running', null);
    } else {
      setState(m, 'error', 'failed');
    }
  }
  log({ msg: 'host agent ready', machines: vms.size });
  await save();

  const timers: NodeJS.Timeout[] = [];
  let closed = false;
  const loop = (fn: () => Promise<void>, everyMs: number, what: string) => {
    let current: Promise<void> = Promise.resolve();
    const tick = () => {
      if (closed) return;
      current = fn()
        .catch((error: unknown) => log({ msg: `${what} failed`, error: String(error) }))
        .finally(() => {
          if (!closed) timers.push(setTimeout(tick, everyMs));
        });
    };
    tick();
    return () => current;
  };
  const running: (() => Promise<void>)[] = [];

  return {
    start() {
      running.push(loop(sync, o.syncIntervalMs ?? 1000, 'sync'), loop(poll, o.pollIntervalMs ?? 60_000, 'poll'));
    },
    async close() {
      closed = true;
      for (const timer of timers) clearTimeout(timer);
      await Promise.all(running.map((current) => current()));
      await Promise.all(queues.values());
      await save();
    },
  };
}
