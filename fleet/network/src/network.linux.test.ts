/**
 * The host's real ruleset and resolver, with network namespaces standing in for guests. Needs Linux,
 * root, nft, ip, dnsmasq and dig, and changes the host's network, so it runs only with
 * FLEET_NETWORK_TEST=1; `scripts/test-in-docker.sh` runs it in a throwaway privileged container.
 *
 *   guest ns "ga" 10.200.0.6 ─ fctap1 ┐                   ┌ up0 203.0.113.1 ─ ns "net" 203.0.113.2: the internet,
 *   guest ns "gb" 10.200.0.10 ─ fctap2 ┴─ host (nft, DNS) ─┘   plus 169.254.169.254, 10.0.0.5 (VPC) and 198.51.100.53 (upstream DNS)
 *
 * Firecracker's taps are swapped for veth pairs of the same name, so the namespaces can send packets.
 */
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createHostNetwork, type HostNetwork } from './index.js';

const canRun = process.env.FLEET_NETWORK_TEST === '1' && process.platform === 'linux' && process.getuid?.() === 0;
const here = dirname(fileURLToPath(import.meta.url));
const probe = join(here, '..', 'scripts', 'probe.mjs');
const hostFiles = join(here, '..', '..', 'host', 'files', 'dns');
const exec = promisify(execFile);

const sh = async (cmd: string) => (await exec('bash', ['-c', cmd])).stdout;
const inNs = (ns: string, cmd: string) => sh(`ip netns exec ${ns} ${cmd}`);
const tcp = async (ns: string, host: string, port: number, extra = '') => JSON.parse(await inNs(ns, `node ${probe} tcp ${host} ${port} ${extra}`)) as { result: string; reply?: string };
const udp = async (ns: string, host: string, port: number) => JSON.parse(await inNs(ns, `node ${probe} udp ${host} ${port}`)) as { result: string; reply?: string };
// Unique per run, so flow log lines from an earlier run in the same kernel never match.
const run = Date.now().toString(36);
const [A, B, C] = ['a', 'b', 'c'].map((g) => `guest-${g}-${run}`) as [string, string, string];
const dig = (ns: string, server: string, name: string, extra = '') => inNs(ns, `dig +time=2 +tries=1 ${extra} @${server} ${name}`);

describe.skipIf(!canRun)('host network on Linux', () => {
  let net: HostNetwork;
  let work: string;
  const children: ChildProcess[] = [];

  function background(cmd: string): Promise<void> {
    const child = spawn('bash', ['-c', `exec ${cmd}`], { stdio: ['ignore', 'pipe', 'inherit'] });
    children.push(child);
    return new Promise((resolve) => setTimeout(resolve, 500));
  }

  async function guest(ns: string, machineId: string, slot: number): Promise<void> {
    const m = await net.attach(machineId, slot, { uid: 0 });
    await sh(`ip link del ${m.tapName}; ip netns add ${ns}; ip link add ${m.tapName} type veth peer name eth0 netns ${ns}`);
    await sh(`ip link set dev ${m.tapName} addrgenmode none; ip addr add ${m.gatewayIp}/30 dev ${m.tapName}; ip link set ${m.tapName} up`);
    await inNs(ns, `sh -c 'ip link set lo up; ip addr add ${m.guestIp}/30 dev eth0; ip link set eth0 up; ip route add default via ${m.gatewayIp}'`);
  }

  beforeAll(async () => {
    work = await mkdtemp(join(tmpdir(), 'fleet-net-'));
    await sh('sysctl -qw net.ipv4.ip_forward=1');
    // The internet, the VPC and instance metadata, all in namespace "net".
    await sh('ip netns add net; ip link add up0 type veth peer name eth0 netns net');
    await sh('ip addr add 203.0.113.1/24 dev up0; ip link set up0 up');
    await inNs('net', `sh -c 'ip link set lo up; ip addr add 203.0.113.2/24 dev eth0; ip link set eth0 up; ip route add default via 203.0.113.1;
      for a in 169.254.169.254 10.0.0.5 198.51.100.53; do ip addr add $a/32 dev lo; done'`);
    await sh('for a in 169.254.169.254/32 10.0.0.5/32 198.51.100.0/24; do ip route add $a via 203.0.113.2; done');
    await background(`ip netns exec net node ${probe} serve 22,25,80,443,853 3478,41641`);
    await background(
      `ip netns exec net dnsmasq --keep-in-foreground --no-resolv --no-hosts --listen-address=198.51.100.53 --bind-interfaces --user=root --pid-file= ` +
        `--address=/example.test/203.0.113.80 --address=/supportxmr.com/203.0.113.81`,
    );

    net = createHostNetwork({ uplink: 'up0' });
    await net.installHostRules();
    await guest('ga', A, 1);
    await guest('gb', B, 2);
    await background(`ip netns exec gb node ${probe} serve 22 41641`);
    await background(`node ${probe} serve 8080 ''`);

    // The host image's resolver config, pointed at the test's upstream instead of the VPC's.
    const conf = (await readFile(join(hostFiles, 'dns.conf'), 'utf8'))
      .replace(/^server=.*$/m, 'server=198.51.100.53')
      .replace(/^conf-file=.*$/m, `conf-file=${join(hostFiles, 'dns-blocklist.conf')}`);
    await writeFile(join(work, 'dns.conf'), conf);
    await background(`dnsmasq --keep-in-foreground --conf-file=${join(work, 'dns.conf')} --user=root --pid-file=`);
  }, 60_000);

  afterAll(async () => {
    for (const child of children) child.kill('SIGKILL');
    if (!canRun) return;
    await net.detach(A).catch(() => undefined);
    await net.detach(B).catch(() => undefined);
    await sh('ip netns del ga; ip netns del gb; ip netns del net; nft delete table inet fleet').catch(() => undefined);
    await rm(work, { recursive: true, force: true });
  });

  test('allowed egress leaves through the uplink, NATed to the host address', async () => {
    expect(await tcp('ga', '203.0.113.2', 443)).toEqual({ result: 'open', reply: 'hello 203.0.113.1' });
    expect(await tcp('ga', '203.0.113.2', 80)).toMatchObject({ result: 'open' });
  });

  test('Tailscale works: DERP on TCP 443, WireGuard on UDP 41641 and STUN on UDP 3478', async () => {
    expect(await tcp('ga', '203.0.113.2', 443)).toMatchObject({ result: 'open' });
    expect(await udp('ga', '203.0.113.2', 41641)).toEqual({ result: 'open', reply: 'echo 203.0.113.1 ping' });
    expect(await udp('ga', '203.0.113.2', 3478)).toMatchObject({ result: 'open' });
  });

  test('no route from one machine to another', async () => {
    expect((await tcp('ga', '10.200.0.10', 22)).result).toBe('refused');
    expect((await udp('ga', '10.200.0.10', 41641)).result).not.toBe('open');
    expect((await tcp('gb', '10.200.0.6', 22)).result).toBe('refused');
  });

  test("a machine cannot send from another machine's address", async () => {
    await inNs('ga', 'ip addr add 10.200.0.10/32 dev eth0');
    const before = await net.egressBytes(A);
    expect((await tcp('ga', '203.0.113.2', 443, '0 10.200.0.10')).result).toBe('timeout');
    // Dropped as it enters the host: not one byte left through the uplink.
    expect(await net.egressBytes(A)).toBe(before);
    await inNs('ga', 'ip addr del 10.200.0.10/32 dev eth0');
  });

  test('instance metadata, the VPC and the host itself are refused', async () => {
    expect((await tcp('ga', '169.254.169.254', 80)).result).toBe('refused');
    expect((await tcp('ga', '10.0.0.5', 22)).result).toBe('refused');
    expect((await tcp('ga', '10.200.0.5', 8080)).result).toBe('refused');
    expect((await tcp('ga', '203.0.113.1', 8080)).result).toBe('refused');
    // The listener is there: the host itself reaches it.
    expect((await tcp('net', '203.0.113.1', 8080)).result).toBe('open');
  });

  test('outbound TCP 25 is refused', async () => {
    expect((await tcp('ga', '203.0.113.2', 25)).result).toBe('refused');
  });

  test('every DNS query goes to the filtering resolver, whichever server the guest asks', async () => {
    // 1.1.1.1 is not reachable in this test, so an answer proves the host's resolver gave it.
    expect(await dig('ga', '1.1.1.1', 'example.test', '+short')).toBe('203.0.113.80\n');
    expect(await dig('ga', '1.1.1.1', 'example.test', '+short +tcp')).toBe('203.0.113.80\n');
    expect(await dig('ga', '10.200.0.5', 'example.test', '+short')).toBe('203.0.113.80\n');
    expect(await dig('ga', '1.1.1.1', 'pool.supportxmr.com')).toContain('status: NXDOMAIN');
    expect((await tcp('ga', '203.0.113.2', 853)).result).toBe('refused');
  });

  test('each new outbound flow is logged with the machine id', async () => {
    expect((await tcp('ga', '203.0.113.2', 443)).result).toBe('open');
    const log = await sh('dmesg');
    expect(log).toMatch(new RegExp(`fleet-flow ${A} IN=fctap1 OUT=up0 .*SRC=10\\.200\\.0\\.6 DST=203\\.0\\.113\\.2 .*PROTO=TCP .*DPT=443 `));
    expect(log).not.toContain(`fleet-flow ${B} IN=fctap1`);
  });

  test('egress is metered per machine', async () => {
    const before = await net.egressBytes(A);
    const otherBefore = await net.egressBytes(B);
    expect((await tcp('ga', '203.0.113.2', 443, String(5_000_000))).result).toBe('open');
    expect((await net.egressBytes(A)) - before).toBeGreaterThanOrEqual(5_000_000);
    expect((await net.egressBytes(B)) - otherBefore).toBeLessThan(10_000);
  });

  test('detach removes the tap and the counter', async () => {
    await net.attach(C, 3, { uid: 0 });
    expect(await net.egressBytes(C)).toBe(0);
    expect(await sh('ip -br link show fctap3')).toContain('fctap3');
    await net.detach(C);
    await expect(net.egressBytes(C)).rejects.toThrow();
    await expect(sh('ip link show fctap3')).rejects.toThrow();
    await net.detach(C);
  });
});
