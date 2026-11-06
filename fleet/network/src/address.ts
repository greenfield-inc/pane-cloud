/** The guest network every host uses unless told otherwise. It must not overlap the VPC (F6). */
export const DEFAULT_SUBNET = '10.200.0.0/16';
/** Every machine's tap is named `fctap<slot>`, so nft rules match all of them with `fctap*`. */
export const TAP_PREFIX = 'fctap';

/** The contract's machine id format. Ids go into nft scripts and log prefixes, so nothing else is accepted. */
const MACHINE_ID = /^[A-Za-z0-9_-]{1,64}$/;

export interface MachineAddress {
  tapName: string;
  guestMac: string;
  guestIp: string;
  /** The host end of the machine's /30; the guest's default route and DNS resolver. */
  gatewayIp: string;
  /** Kernel `ip=` boot argument that configures the guest's eth0 with no DHCP. */
  kernelIpArg: string;
}

/**
 * The address plan: slot `n` owns the n-th /30 of the subnet. The host takes its first usable
 * address, the guest the second, so 10.200.0.0/16 holds 16,384 machines.
 */
export function addressForSlot(machineId: string, slot: number, subnet = DEFAULT_SUBNET): MachineAddress {
  assertMachineId(machineId);
  const { base, prefix } = parseSubnet(subnet);
  const slots = 2 ** (30 - prefix);
  if (!Number.isInteger(slot) || slot < 0 || slot >= slots) {
    throw new RangeError(`Slot ${slot} is outside ${subnet}, which has slots 0 to ${slots - 1}.`);
  }
  const gateway = base + slot * 4 + 1;
  const guest = gateway + 1;
  const gatewayIp = formatIp(gateway);
  const guestIp = formatIp(guest);
  const mac = [0x06, 0x00, ...ipBytes(guest)].map((b) => b.toString(16).padStart(2, '0')).join(':');
  return {
    tapName: `${TAP_PREFIX}${slot}`,
    guestMac: mac,
    guestIp,
    gatewayIp,
    // ip=<client>:<server>:<gateway>:<netmask>:<hostname>:<device>:<autoconf>:<dns0>
    kernelIpArg: `ip=${guestIp}::${gatewayIp}:255.255.255.252:${machineId}:eth0:off:${gatewayIp}`,
  };
}

export function assertMachineId(machineId: string): void {
  if (!MACHINE_ID.test(machineId)) throw new TypeError(`"${machineId}" is not a machine id.`);
}

export function parseSubnet(subnet: string): { base: number; prefix: number } {
  const match = /^(\d+\.\d+\.\d+\.\d+)\/(\d+)$/.exec(subnet);
  const prefix = Number(match?.[2]);
  if (!match?.[1] || !Number.isInteger(prefix) || prefix < 8 || prefix > 30) {
    throw new TypeError(`"${subnet}" is not an IPv4 subnet between /8 and /30.`);
  }
  const base = parseIp(match[1]);
  if (base % 2 ** (32 - prefix) !== 0) throw new TypeError(`"${subnet}" has host bits set.`);
  return { base, prefix };
}

function parseIp(ip: string): number {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) throw new TypeError(`"${ip}" is not an IPv4 address.`);
  return parts.reduce((n, p) => n * 256 + p, 0);
}

function ipBytes(n: number): number[] {
  return [24, 16, 8, 0].map((shift) => Math.floor(n / 2 ** shift) % 256);
}

function formatIp(n: number): string {
  return ipBytes(n).join('.');
}
