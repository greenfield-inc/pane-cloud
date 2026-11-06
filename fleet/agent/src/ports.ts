/**
 * The seams the host agent drives. F3 (network) and F4 (fair use) plug their packages in here; the
 * rest are AWS services in production (S3, the EBS data volume, the instance's lifecycle state) with
 * local implementations in `local.ts`.
 */
import type { PaneRelease } from 'pane-cloud-contract';

/** F3: what `attach` returns for one machine. */
export interface MachineAttachment {
  tapName: string;
  guestMac: string;
  guestIp: string;
  gatewayIp: string;
  /** Kernel `ip=` argument for the guest's eth0. */
  kernelIpArg: string;
}

/** F3's per-machine network: tap, NAT, egress counter. */
export interface NetworkPort {
  attach(machineId: string, slot: number): Promise<MachineAttachment>;
  detach(machineId: string): Promise<void>;
  /** Bytes the machine sent out since its counter was created. */
  egressBytes(machineId: string): Promise<number>;
}

export interface CpuUse {
  /** UTC day, YYYY-MM-DD. */
  day: string;
  cpuSecondsUsed: number;
  throttled: boolean;
}

export interface HostMemorySample {
  totalMiB: number;
  usedMiB: number;
}

export interface MachineMemorySample {
  machineId: string;
  /** Host-side resident memory of the machine's cgroup (`memory.current`). */
  residentMiB: number;
  /** No agent running and no client connected, by the guest's last status. */
  idle: boolean;
}

export type ReclaimDecision =
  | { kind: 'inflate'; machineId: string; balloonMiB: number; reason: string }
  | { kind: 'snapshot_stop'; machineId: string; reason: string };

/** F4: ceilings, the daily CPU budget and memory reclaim. F4 decides; the host agent acts. */
export interface FairUsePort {
  /** Writes the machine's CPU and memory ceilings into its cgroup. */
  applyCeilings(cgroupPath: string): Promise<void>;
  /** Charges CPU used since the last call to today's budget, throttling the cgroup once it is spent. */
  chargeCpu(machineId: string, cgroupPath: string, now: Date): Promise<CpuUse>;
  decideReclaim(host: HostMemorySample, machines: MachineMemorySample[]): ReclaimDecision[];
}

/** A stopped machine's files on the host. */
export interface MachineFiles {
  diskPath: string;
  statePath: string;
  memPath: string;
}

/** Where stopped machines live between hosts: S3 in production. */
export interface SnapshotStore {
  /** Uploads a stopped machine's disk and full snapshot, replacing any earlier one. */
  put(machineId: string, files: MachineFiles): Promise<void>;
  /** Downloads them into `dir`, or returns null when the machine has none. */
  get(machineId: string, dir: string): Promise<MachineFiles | null>;
  delete(machineId: string): Promise<void>;
}

/** The fleet's diagnostics bucket. */
export interface DiagnosticsStore {
  put(key: string, archive: Buffer): Promise<void>;
}

/** Releases `bootstrap` and `update_pane` may install. */
export interface ReleaseList {
  isPublished(release: PaneRelease): Promise<boolean>;
}

/** The data volume of a lost host, reattached here (F6 in production). */
export interface VolumeRecovery {
  /** Returns the path of a machine's disk on the lost host's data volume. */
  diskOf(lostHostId: string, machineId: string): Promise<string>;
}

/** Whether this host is due for maintenance and must stop its machines. */
export interface MaintenanceSignal {
  requested(): Promise<boolean>;
}
