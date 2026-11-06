/**
 * The contract values this package needs, copied from pane-cloud-contract's src/fleet.ts at
 * greenfield-inc/Pane 5c3d3c6 (MACHINE_LIMITS and MachineId). The contract installs from git with a
 * full Pane monorepo build, which fails on Linux CI, so it is not a dependency here yet.
 */
export const MACHINE_LIMITS = {
  vcpu: 8,
  memoryMiB: 16_384,
  /** 12 vCPU-hours per UTC day; past it the machine runs at 0.5 vCPU until the next UTC midnight. */
  dailyCpuSeconds: 43_200,
  throttledVcpu: 0.5,
} as const;

const MACHINE_ID = /^[A-Za-z0-9_-]{1,64}$/;

export function checkMachineId(machineId: string): string {
  if (!MACHINE_ID.test(machineId)) throw new Error(`"${machineId}" is not a machine id.`);
  return machineId;
}
