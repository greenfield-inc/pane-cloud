/**
 * The host agent: runs on every fleet host, verifies each signed operation itself, and drives F1's
 * runtime, F3's network, F4's fair use and the guest agent. It has no inbound port; it calls the
 * fleet API to report and to receive work (`sync.ts`).
 */
import { createHash } from 'node:crypto';
import { lchown, lstat, mkdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { type HostSample, type MachineSample, RECLAIM_RULES, readHostMemory } from '@pane-cloud/fleet-fair-use';
import { checkEgressAbuse, checkMonthlyEgress, type CounterSample, type EgressPolicy, type MachineAddress } from '@pane-cloud/fleet-network';
import { createDiskFromTemplate, type MachineSpec, type RateLimit, type Runtime, type Vm } from '@pane-cloud/fleet-runtime';
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
import { callGuest, GuestBootstrap, GuestDiagnostics, GuestStatus, operationError } from './guest.js';
import { copySparse } from './local.js';
import type { DiagnosticsStore, FairUsePort, HostMetrics, MaintenanceSignal, NetworkPort, ReleaseList, SnapshotStore, VolumeRecovery } from './ports.js';
import { createSaver, type StateStore } from './store.js';
import { type HostReport, type Placement, syncRoute, type Work } from './sync.js';

/** No agent running and no client connected for this long stops a machine (journey 9). */
export const IDLE_STOP_MS = 30 * 60 * 1000;
/** How long a stop waits for the guest agent's prepare_to_stop before snapshotting anyway. */
const PREPARE_TO_STOP_TIMEOUT_MS = 10_000;
/**
 * The plan's egress limits (F3's README): stop at 10 GB out in an hour, alert at 30 GB a month, cap
 * at the contract's 100 GiB a month. D-23 keeps the real abuse thresholds in private config.
 */
export const DEFAULT_EGRESS_POLICY: EgressPolicy = {
  monthlyCapBytes: MACHINE_LIMITS.monthlyEgressBytes,
  monthlyAlertBytes: 30e9,
  abuseBytes: 10e9,
  abuseWindowMs: 60 * 60 * 1000,
};
/**
 * A machine past the monthly cap sends at about 1 MiB/s until the month ends. An assumption: the
 * plan says only "capped"; Parsa may choose another rate, or a stop.
 */
export const CAPPED_TX: RateLimit = { size: 1024 * 1024, refillTimeMs: 1000 };
/** A token bucket of size 0 turns Firecracker's limiter off. */
const UNLIMITED_TX: RateLimit = { size: 0, refillTimeMs: 0 };

type State = FleetMachine['state'];
type Reason = NonNullable<FleetMachine['stateReason']>;

/** States in which a machine holds a slot, a disk and usually a VM on this host. */
const ACTIVE: readonly State[] = ['creating', 'running', 'stopping', 'resuming', 'deleting'];
/** How long a stopped or deleted machine stays in reports, so the fleet sees its last state. */
const FINISHED_RECORD_MS = 60 * 60 * 1000;
const MAX_EVENTS = 10_000;

interface HostMachine {
  machine: FleetMachine;
  /** The fleet's slot for the machine: uid `uidBase + slot` and F3's address for the slot. */
  slot: number;
  metrics: MachineMetrics | null;
  /** This month's egress, and the F3 counter's reading it was last updated from. */
  egress: { month: string; bytes: number; counter: number };
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
  network: NetworkPort;
  hostMetrics: HostMetrics;
  egressPolicy?: EgressPolicy;
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
  /** Host memory now; defaults to /proc/meminfo. */
  hostMemory?: () => Promise<HostSample>;
  now?: () => Date;
  syncIntervalMs?: number;
  /** How often to read guest status, metrics, egress, maintenance and F4's budget and reclaim decisions. */
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
  const hostMemory = o.hostMemory ?? (() => readHostMemory());
  const egressPolicy = o.egressPolicy ?? DEFAULT_EGRESS_POLICY;
  const guestTimeoutMs = o.guestTimeoutMs ?? 30_000;
  const createDisk = o.createDisk ?? createDiskFromTemplate;

  const state: HostState = (await o.store.load()) ?? { machines: {}, operations: {}, events: [], nextEventId: 1 };
  const save = createSaver(o.store, () => state);
  const vms = new Map<string, Vm>();
  const idleSince = new Map<string, number>();
  /** F3 counter readings from the last abuse window, for `checkEgressAbuse`. */
  const egressSamples = new Map<string, CounterSample[]>();
  /** Host-side resident memory samples from the last 15 minutes, by machine id, kept across a stop and resume. */
  const residentSamples = new Map<string, { at: number; mib: number }[]>();
  const queues = new Map<string, Promise<void>>();
  const changedOperations = new Set<string>();
  let draining = false;

  const diskPath = (id: string) => join(o.dataDir, 'disks', `${id}.ext4`);
  const snapshotDir = (id: string) => join(o.dataDir, 'snapshots', id);
  const month = () => iso().slice(0, 7);
  const capped = (m: HostMachine) => m.egress.month === month() && checkMonthlyEgress(m.egress.bytes, egressPolicy).capped;
  const spec = (record: HostMachine, extra: Partial<MachineSpec> = {}): MachineSpec => ({
    machineId: record.machine.machineId,
    uid: uidBase + record.slot,
    gid: uidBase + record.slot,
    vcpu: size.vcpu,
    memoryMiB: size.memoryMiB,
    kernelPath: o.kernelPath,
    diskPath: diskPath(record.machine.machineId),
    consoleLogPath: join(o.dataDir, 'console', `${record.machine.machineId}.log`),
    balloon: { deflateOnOom: true, statsPollingIntervalS: 5 },
    ...extra,
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
  const newRecord = (machineId: string, placement: Placement, from?: HostMachine): HostMachine => {
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
      slot: placement.slot,
      metrics: from?.metrics ?? null,
      egress: { month: month(), bytes: placement.egressBytesThisMonth, counter: 0 },
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

  /** Starts the machine, or restores it from a snapshot, on its F3 network and F4 ceilings. */
  async function boot(m: HostMachine, snapshot?: { statePath: string; memPath: string }) {
    const id = m.machine.machineId;
    const net: MachineAddress = await o.network.attach(id, m.slot, { uid: uidBase + m.slot });
    // A new tap's counter starts at 0.
    m.egress.counter = 0;
    const machineSpec = spec(m, {
      network: { tapName: net.tapName, guestMac: net.guestMac, kernelIpArg: net.kernelIpArg, ...(capped(m) ? { txRateLimit: CAPPED_TX } : {}) },
      cgroup: await o.fairUse.cgroupFor(id),
    });
    const vm = snapshot ? await o.runtime.restore(machineSpec, snapshot) : await o.runtime.start(machineSpec);
    vms.set(id, vm);
    // A snapshot keeps the rate limiter it was taken with; the month may have changed since.
    if (snapshot) await vm.updateNetworkRateLimit({ tx: capped(m) ? CAPPED_TX : UNLIMITED_TX });
  }

  async function release(id: string) {
    const vm = vms.get(id);
    vms.delete(id);
    if (vm) await vm.stop();
    await o.network.detach(id);
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
    // The guest's chance to flush. Its user can break the guest agent, so this is best effort and short.
    await guestCall(id, { operation: 'prepare_to_stop', parameters: {} }, undefined, Math.min(guestTimeoutMs, PREPARE_TO_STOP_TIMEOUT_MS)).catch((error: unknown) =>
      log({ msg: 'prepare_to_stop failed; stopping anyway', machineId: id, error: String(error) }),
    );
    // Charge the CPU and egress used since the last poll, so a stop loses none.
    await measure(m, vm).catch((error: unknown) => log({ msg: 'last measurement before stop failed', machineId: id, error: String(error) }));
    let files;
    try {
      files = await vm.snapshot(snapshotDir(id));
    } catch (error) {
      // Nothing was lost: the machine keeps running as it was.
      await vm.resume();
      setState(m, 'running', null, requestId);
      throw error;
    }
    log({ msg: 'snapshot written', machineId: id });
    await release(id);
    await o.snapshots.put(id, { diskPath: diskPath(id), ...files });
    log({ msg: 'snapshot uploaded', machineId: id });
    await rm(diskPath(id), { force: true });
    await rm(snapshotDir(id), { recursive: true, force: true });
    m.metrics = m.metrics && { ...m.metrics, memoryResidentMiB: 0 };
    egressSamples.delete(id);
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
          // Start from an empty directory so every file in it is one the store just wrote.
          await rm(snapshotDir(id), { recursive: true, force: true });
          const files = await o.snapshots.get(id, snapshotDir(id));
          if (!files) throw new CloudApiError('invalid_state', `Machine ${id} has no saved snapshot to resume from.`, 'Create a new machine, or collect diagnostics.');
          await rename(files.diskPath, diskPath(id));
          // F1 restores only snapshot files owned by the machine's uid, which this host may have changed.
          // The agent runs as root on a host; a non-root agent (tests) cannot chown and needs not.
          if (process.getuid?.() === 0) {
            for (const path of [files.statePath, files.memPath]) {
              const info = await lstat(path);
              if (!info.isFile() || info.nlink !== 1) throw new Error(`Snapshot file ${path} is not a regular file the store just wrote.`);
              await lchown(path, uidBase + m.slot, uidBase + m.slot);
            }
          }
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
      case 'update_pane': {
        const installed = await guestCall(id, { operation: payload.operation, parameters: { release: payload.parameters.release } }, payload.requestId, o.guestInstallTimeoutMs ?? 15 * 60_000);
        if (payload.operation === 'bootstrap') log({ msg: 'bootstrap answered', machineId: id, firstBoot: GuestBootstrap.safeParse(installed).data?.firstBoot ?? 'unreported' });
        m.machine = { ...m.machine, paneVersion: payload.parameters.release.version, updatedAt: iso() };
        await refreshStatus(m).catch(() => undefined);
        return null;
      }
      case 'prepare_to_stop':
        await guestCall(id, { operation: 'prepare_to_stop', parameters: {} }, payload.requestId);
        return null;
      case 'collect_diagnostics': {
        const found = GuestDiagnostics.parse(await guestCall(id, { operation: 'collect_diagnostics', parameters: {} }, payload.requestId));
        const archive = Buffer.from(found.archive.base64, 'base64');
        if (archive.length !== found.archive.bytes || createHash('sha256').update(archive).digest('hex') !== found.archive.sha256) {
          throw new Error('The diagnostics archive the guest agent sent does not match its own size and SHA-256.');
        }
        const archiveKey = `diagnostics/${id}/${payload.requestId}.tar.gz`;
        await o.diagnostics.put(archiveKey, archive);
        if (found.skipped.length > 0) log({ msg: 'diagnostics skipped files', machineId: id, requestId: payload.requestId, skipped: found.skipped });
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
  async function receive(envelope: OperationEnvelope, placement: Placement) {
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
      m = admit(payload, placement);
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
  function admit(payload: OperationPayload, placement: Placement): HostMachine {
    const { machineId: id, operation } = payload;
    const m = state.machines[id];
    const current = m?.machine.state;
    if (operation === 'create') {
      if (m && current !== 'deleted') throw new CloudApiError('machine_exists', `Machine ${id} already exists.`, 'Use a new machine id, or resume the existing machine.');
      if (draining) throw drainingError();
      const created = newRecord(id, placement);
      setState(created, 'creating', null, payload.requestId);
      return created;
    }
    if (operation === 'resume') {
      if (m && current !== 'stopped') throw invalidState(id, operation, current);
      if (draining) throw drainingError();
      const resumed = newRecord(id, placement, m);
      setState(resumed, 'resuming', null, payload.requestId);
      return resumed;
    }
    if (operation === 'delete') {
      if (current === 'deleting' || current === 'deleted') throw invalidState(id, operation, current);
      const target = m ?? newRecord(id, placement);
      setState(target, 'deleting', 'user', payload.requestId);
      return target;
    }
    if (!m || current !== 'running') throw invalidState(id, operation, current);
    if (operation === 'stop') setState(m, 'stopping', 'user', payload.requestId);
    return m;
  }

  function recover(machineId: string, fromHostId: string, placement: Placement) {
    const existing = state.machines[machineId];
    if (existing && ACTIVE.includes(existing.machine.state)) return;
    const m = newRecord(machineId, placement, existing);
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

  // ── Polling: guest status, idle stop, metrics, budget, egress, maintenance, reclaim ─────────────

  async function refreshStatus(m: HostMachine): Promise<GuestStatus> {
    const status = GuestStatus.parse(await guestCall(m.machine.machineId, { operation: 'status', parameters: {} }));
    const changed = status.paneVersion !== m.machine.paneVersion || JSON.stringify(status.tailnet) !== JSON.stringify(m.machine.tailnet);
    if (changed) m.machine = { ...m.machine, paneVersion: status.paneVersion ?? m.machine.paneVersion, tailnet: status.tailnet, updatedAt: iso() };
    return status;
  }

  /** Adds egress since the last reading to the month, and caps or uncaps the machine as the month's total says. */
  async function meterEgress(m: HostMachine, vm: Vm, at: Date): Promise<void> {
    const id = m.machine.machineId;
    const counter = await o.network.egressBytes(id);
    const thisMonth = at.toISOString().slice(0, 7);
    const before = m.egress.month === thisMonth ? m.egress.bytes : 0;
    const wasCapped = checkMonthlyEgress(m.egress.bytes, egressPolicy).capped;
    // A counter that went down was recreated, and counts from zero.
    const sent = counter >= m.egress.counter ? counter - m.egress.counter : counter;
    m.egress = { month: thisMonth, bytes: before + sent, counter };
    const after = checkMonthlyEgress(m.egress.bytes, egressPolicy);
    if (after.alert && !checkMonthlyEgress(before, egressPolicy).alert) log({ msg: 'egress alert: the machine passed the monthly alert threshold', machineId: id, bytesThisMonth: m.egress.bytes });
    if (after.capped !== wasCapped) {
      await vm.updateNetworkRateLimit({ tx: after.capped ? CAPPED_TX : UNLIMITED_TX });
      log({ msg: after.capped ? 'egress capped for the rest of the month' : 'egress cap lifted for the new month', machineId: id, bytesThisMonth: m.egress.bytes });
    }
    const samples = (egressSamples.get(id) ?? []).filter((sample) => sample.at >= at.getTime() - 2 * egressPolicy.abuseWindowMs);
    samples.push({ at: at.getTime(), bytes: counter });
    egressSamples.set(id, samples);
  }

  /** Charges CPU to F4's daily budget and egress to the month, and reads memory and disk: the machine's metrics. */
  async function measure(m: HostMachine, vm: Vm, at = now()): Promise<MachineMetrics> {
    const id = m.machine.machineId;
    await o.fairUse.applyCeilings(vm.cgroupPath);
    const cpu = await o.fairUse.check(id, vm.cgroupPath);
    if (cpu.event) {
      record({ machineId: id, kind: cpu.event, state: null, reason: null, requestId: null });
      log({ msg: cpu.event, machineId: id, cpuSecondsUsed: cpu.cpuSecondsUsed });
    }
    await meterEgress(m, vm, at);
    m.metrics = {
      machineId: id,
      day: cpu.day,
      cpuSecondsUsed: cpu.cpuSecondsUsed,
      cpuBudgetSeconds: MACHINE_LIMITS.dailyCpuSeconds,
      throttled: cpu.throttled,
      memoryResidentMiB: await o.fairUse.readResidentMiB(vm.cgroupPath),
      diskUsedBytes: await stat(diskPath(id)).then((s) => s.blocks * 512, () => 0),
      egressBytesThisMonth: m.egress.bytes,
      sampledAt: at.toISOString(),
    };
    return m.metrics;
  }

  /** How long, within the last 15 minutes, the machine's resident memory was above F4's 12 GiB line. */
  function residentAboveLimitMs(id: string, at: number, mib: number): number {
    const start = at - RECLAIM_RULES.residentWindowMs;
    const samples = [...(residentSamples.get(id) ?? []), { at, mib }];
    // Keep one sample from before the window: the first one inside counts from it.
    while (samples.length > 1 && (samples[1]?.at ?? at) < start) samples.shift();
    residentSamples.set(id, samples);
    let total = 0;
    for (let i = 1; i < samples.length; i += 1) {
      const [prev, next] = [samples[i - 1], samples[i]];
      if (prev && next && next.mib > RECLAIM_RULES.residentLimitMiB) total += next.at - Math.max(prev.at, start);
    }
    return total;
  }

  async function sample(m: HostMachine, at: Date): Promise<MachineSample | null> {
    const id = m.machine.machineId;
    const vm = vms.get(id);
    if (!vm) return null;
    const status = await refreshStatus(m).catch(() => null);
    // clientsConnected is 0 until Pane serves it to the guest agent (fleet/guest/README.md).
    const idle = status !== null && status.activity.agentsRunning === 0 && status.activity.clientsConnected === 0;
    if (!idle) idleSince.delete(id);
    else if (!idleSince.has(id)) idleSince.set(id, at.getTime());
    const metrics = await measure(m, vm, at);
    return {
      machineId: id,
      residentMiB: metrics.memoryResidentMiB,
      idle,
      balloon: await vm.balloonStats().catch(() => null),
      residentAboveLimitMsInWindow: residentAboveLimitMs(id, at.getTime(), metrics.memoryResidentMiB),
    };
  }

  async function poll() {
    const at = now();
    const memory = await hostMemory();
    await o.hostMetrics.publish({ memoryUsedPercent: (100 * memory.usedMiB) / memory.totalMiB }).catch((error: unknown) => log({ msg: 'host metrics failed', error: String(error) }));
    const running = Object.values(state.machines).filter((m) => m.machine.state === 'running' && vms.has(m.machine.machineId));
    const samples: MachineSample[] = [];
    for (const m of running) {
      const found = await sample(m, at).catch((error: unknown) => log({ msg: 'sampling failed', machineId: m.machine.machineId, error: String(error) }));
      if (found) samples.push(found);
    }
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
      const id = m.machine.machineId;
      const abuse = checkEgressAbuse(egressSamples.get(id) ?? [], egressPolicy);
      if (draining) stop(m, 'host_maintenance');
      else if (abuse.stop) {
        log({ msg: 'egress abuse; stopping the machine', machineId: id, bytesInWindow: abuse.bytesInWindow, windowMs: egressPolicy.abuseWindowMs });
        stop(m, 'abuse');
      } else if (at.getTime() - (idleSince.get(id) ?? at.getTime()) >= IDLE_STOP_MS) stop(m, 'idle');
    }
    if (draining) return;
    for (const action of o.fairUse.decideReclaim(memory, samples)) {
      const m = state.machines[action.machineId];
      if (!m || m.machine.state !== 'running') continue;
      log({ msg: 'reclaim', ...action });
      if (action.kind === 'snapshot_stop') stop(m, 'memory_pressure');
      else await vms.get(action.machineId)?.setBalloon(action.targetMiB ?? 0).catch((error: unknown) => log({ msg: 'balloon failed', machineId: action.machineId, error: String(error) }));
    }
    void save();
  }

  // ── Sync with the fleet ────────────────────────────────────────────────────────────────────────

  async function report(): Promise<HostReport> {
    const at = now().getTime();
    for (const [id, m] of Object.entries(state.machines)) {
      if (!ACTIVE.includes(m.machine.state) && m.machine.state !== 'error' && at - Date.parse(m.machine.updatedAt) > FINISHED_RECORD_MS) delete state.machines[id];
    }
    for (const [id, op] of Object.entries(state.operations)) {
      if (op.finishedAt && at - Date.parse(op.finishedAt) > 24 * FINISHED_RECORD_MS) delete state.operations[id];
    }
    const memory = await hostMemory();
    const machines = Object.values(state.machines);
    return {
      hostId: o.hostId,
      draining,
      maxMachines: o.maxMachines ?? 109,
      activeMachines: machines.filter((m) => ACTIVE.includes(m.machine.state)).length,
      memoryTargetMiB: memory.totalMiB * (o.memoryTargetFraction ?? 0.75),
      memoryUsedMiB: memory.usedMiB,
      // A stopped machine's last metrics carry its month's egress to the host it resumes on.
      machines: machines.map((m) => ({ machine: m.machine, metrics: m.machine.state === 'deleted' ? null : m.metrics })),
      // Copies: an operation can finish while the report is in flight.
      operations: [...changedOperations].flatMap((id) => (state.operations[id] ? [{ ...state.operations[id] }] : [])),
      events: state.events.slice(0, 500),
    };
  }

  async function sync() {
    await save();
    const body = await report();
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
    if (work.kind === 'operation') await receive(work.envelope, work.placement);
    else recover(work.machineId, work.fromHostId, work.placement);
  }

  // ── Startup: reattach to machines that kept running while the agent was down ────────────────────

  // Names this host on its data volume, so a host that adopts the volume after a loss can check it.
  await mkdir(o.dataDir, { recursive: true });
  await writeFile(join(o.dataDir, 'host-id'), `${o.hostId}\n`);

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
  // The firewall lasts until the host reboots. Replacing it would cut off machines still running.
  if (vms.size === 0) await o.network.installHostRules();
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
      // Machine work still running is not awaited: a new agent fails it and reattaches to the machine.
      await save();
    },
  };
}
