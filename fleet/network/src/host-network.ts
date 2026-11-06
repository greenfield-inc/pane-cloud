import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { addressForSlot, assertMachineId, DEFAULT_SUBNET, parseSubnet, type MachineAddress } from './address.js';
import { egressCounter, machineChain, renderAttach, renderDetach, renderHostRules, TABLE } from './ruleset.js';

export interface HostNetworkOptions {
  /** The interface guests' traffic leaves by. Defaults to the interface of the host's default route. */
  uplink?: string;
  /** Guest addresses, one /30 per slot. Defaults to 10.200.0.0/16. */
  subnet?: string;
  /** Paths of the `nft` and `ip` binaries. Default: found on PATH. */
  nftBin?: string;
  ipBin?: string;
}

export interface HostNetwork {
  /** Replaces the fleet's nftables table. Run once per host boot, before any machine is attached. */
  installHostRules(): Promise<void>;
  /**
   * Creates the machine's tap, owned by the machine's uid so its jailed Firecracker can open it, and
   * its egress counter and flow log. Pass the result to the runtime as `MachineSpec.network`.
   */
  attach(machineId: string, slot: number, owner: { uid: number }): Promise<MachineAddress>;
  /** Bytes the machine sent out of the host since its first attach. Gone after detach or a host reboot. */
  egressBytes(machineId: string): Promise<number>;
  /** Removes the machine's tap, rules and counter. Run after the machine stops. */
  detach(machineId: string): Promise<void>;
}

export function createHostNetwork(options: HostNetworkOptions = {}): HostNetwork {
  const subnet = options.subnet ?? DEFAULT_SUBNET;
  parseSubnet(subnet);
  const nft = (...args: string[]) => run(options.nftBin ?? 'nft', args);
  const ip = (...args: string[]) => run(options.ipBin ?? 'ip', args);
  /** Applies a script as one atomic transaction. nft reads `-f` only from a regular file. */
  async function nftApply(script: string): Promise<void> {
    const dir = await mkdtemp(join(tmpdir(), 'fleet-nft-'));
    try {
      await writeFile(join(dir, 'rules.nft'), script, { mode: 0o600 });
      await nft('-f', join(dir, 'rules.nft'));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  async function tapOf(machineId: string): Promise<string | null> {
    const out = await nft('-j', 'list', 'map', ...TABLE.split(' '), 'machines');
    const map = (JSON.parse(out) as NftJson).nftables.find((o) => o.map)?.map;
    const target = machineChain(machineId);
    const entry = (map?.elem ?? []).find(([, verdict]) => verdict.jump?.target === target);
    return entry ? entry[0] : null;
  }

  return {
    async installHostRules() {
      const uplink = options.uplink ?? (await defaultRouteInterface(ip));
      if (!/^[A-Za-z0-9_.-]{1,15}$/.test(uplink)) throw new TypeError(`"${uplink}" is not an interface name.`);
      await nftApply(renderHostRules({ uplink, subnet }));
    },

    async attach(machineId, slot, owner) {
      const address = addressForSlot(machineId, slot, subnet);
      const tap = address.tapName;
      await ip('link', 'del', tap).catch(() => undefined);
      await ip('tuntap', 'add', 'dev', tap, 'mode', 'tap', 'user', String(owner.uid));
      // No IPv6 link-local address on the host side of the tap.
      await ip('link', 'set', 'dev', tap, 'addrgenmode', 'none');
      await ip('addr', 'add', `${address.gatewayIp}/30`, 'dev', tap);
      await ip('link', 'set', 'dev', tap, 'up');
      await nftApply(renderAttach(machineId, tap));
      return address;
    },

    async egressBytes(machineId) {
      assertMachineId(machineId);
      const out = await nft('-j', 'list', 'counter', ...TABLE.split(' '), egressCounter(machineId));
      const counter = (JSON.parse(out) as NftJson).nftables.find((o) => o.counter)?.counter;
      if (!counter) throw new Error(`No egress counter for machine ${machineId}; it is not attached.`);
      return counter.bytes;
    },

    async detach(machineId) {
      assertMachineId(machineId);
      const tap = await tapOf(machineId);
      await nftApply(renderDetach(machineId, tap));
      if (tap) await ip('link', 'del', tap).catch(() => undefined);
    },
  };
}

interface NftJson {
  nftables: Array<{
    counter?: { bytes: number };
    map?: { elem?: Array<[string, { jump?: { target: string } }]> };
  }>;
}

async function defaultRouteInterface(ip: (...args: string[]) => Promise<string>): Promise<string> {
  const routes = JSON.parse(await ip('-j', 'route', 'show', 'default')) as Array<{ dev?: string }>;
  const dev = routes[0]?.dev;
  if (!dev) throw new Error('The host has no default route, so the uplink is unknown. Pass `uplink`.');
  return dev;
}

function run(bin: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
    child.once('error', reject);
    child.once('close', (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`${bin} ${args.join(' ')} exited with ${code}: ${stderr.trim()}`));
    });
  });
}
