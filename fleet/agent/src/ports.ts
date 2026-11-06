/**
 * The seams the host agent drives. F3 (network) and F4 (fair use) plug their packages in here; the
 * rest are AWS services in production (S3, the EBS data volume, CloudWatch, the instance's lifecycle
 * state) with local implementations in `local.ts`.
 */
import type { CpuBudget, HostSample, MachineSample, ReclaimAction } from '@pane-cloud/fleet-fair-use';
import type { HostNetwork } from '@pane-cloud/fleet-network';
import type { PaneRelease } from 'pane-cloud-contract';

/** F3's per-machine network: tap, NAT, firewall, egress counter (`createHostNetwork`). */
export type NetworkPort = HostNetwork;

/**
 * F4's fair use: ceilings, the daily CPU budget and memory reclaim (`fleetFairUse` in local.ts).
 * F4 decides; the host agent acts.
 */
export interface FairUsePort extends CpuBudget {
  applyCeilings(cgroupPath: string): Promise<void>;
  readResidentMiB(cgroupPath: string): Promise<number>;
  decideReclaim(host: HostSample, machines: readonly MachineSample[]): ReclaimAction[];
}

/** F6: host health in CloudWatch, read by the fleet's alarms. */
export interface HostMetrics {
  /** Publishes `Heartbeat` (1) and `MemoryUsedPercent` once a poll. */
  publish(sample: { memoryUsedPercent: number }): Promise<void>;
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

/** The data volume of a lost host, attached to this host. */
export interface VolumeRecovery {
  /** Returns the path of a machine's disk on the lost host's data volume, mounting the volume first if needed. */
  diskOf(lostHostId: string, machineId: string): Promise<string>;
}

/** Whether this host is due for maintenance and must stop its machines. */
export interface MaintenanceSignal {
  requested(): Promise<boolean>;
}
