/**
 * Journey 7 (isolation) from real Firecracker guests. Needs root, /dev/kvm, dnsmasq and the artifacts
 * that `host/fetch-test-artifacts.sh` writes to FLEET_TEST_ARTIFACTS. The test copies the test rootfs,
 * adds `scripts/guest-probe.py` as a boot unit, and boots two machines through F1's runtime: one
 * listens, the other runs the checks and prints `PANE_PROBE <check> <result>` on its console.
 */
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createRuntime, type Vm } from '../../runtime/src/index.js';
import { createHostNetwork, type HostNetwork, type MachineAddress } from './index.js';

const artifacts = process.env.FLEET_TEST_ARTIFACTS ?? '';
const canRun = artifacts !== '' && existsSync('/dev/kvm') && process.getuid?.() === 0;
const here = dirname(fileURLToPath(import.meta.url));
const exec = promisify(execFile);
const sh = async (cmd: string) => (await exec('bash', ['-c', cmd])).stdout;

async function waitForConsole(path: string, pattern: RegExp, timeoutMs: number): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const text = await readFile(path, 'utf8').catch(() => '');
    if (pattern.test(text)) return text;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`Console never matched ${pattern}. Tail:\n${(await readFile(path, 'utf8').catch(() => '')).slice(-3000)}`);
}

function probes(consoleText: string): Record<string, string> {
  return Object.fromEntries([...consoleText.matchAll(/^PANE_PROBE (\S+) (.+?)\r?$/gm)].map((m) => [m[1], m[2]]));
}

/** Whether the host itself can open a TCP connection, to show a refused guest check is the firewall's doing. */
function hostReaches(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.connect({ host, port, timeout: 3000 }, () => {
      sock.destroy();
      resolve(true);
    });
    sock.on('error', () => resolve(false));
    sock.on('timeout', () => {
      sock.destroy();
      resolve(false);
    });
  });
}

describe.skipIf(!canRun)('journey 7: isolation from real guests', () => {
  let work: string;
  let hostNet: HostNetwork;
  let resolver: ChildProcess | undefined;
  const vms: Vm[] = [];
  const results: Record<'listen' | 'client', Record<string, string>> = { listen: {}, client: {} };

  beforeAll(async () => {
    work = await mkdtemp('/srv/fleet-net-test-');
    await copyFile(join(artifacts, 'vmlinux'), join(work, 'vmlinux'));
    await mkdir(join(work, 'disks'));

    // The test rootfs plus the probe, started at boot.
    const template = join(work, 'probe.ext4');
    await copyFile(join(artifacts, 'rootfs.ext4'), template);
    const mnt = join(work, 'mnt');
    await mkdir(mnt);
    await sh(`mount -o loop ${template} ${mnt}`);
    try {
      await mkdir(join(mnt, 'usr/local/bin'), { recursive: true });
      await copyFile(join(here, '..', 'scripts', 'guest-probe.py'), join(mnt, 'usr/local/bin/pane-net-probe'));
      await writeFile(
        join(mnt, 'etc/systemd/system/pane-net-probe.service'),
        '[Unit]\nAfter=network.target\n[Service]\nExecStart=/usr/bin/python3 /usr/local/bin/pane-net-probe\n[Install]\nWantedBy=multi-user.target\n',
      );
      await sh(`chmod 755 ${mnt}/usr/local/bin/pane-net-probe && mkdir -p ${mnt}/etc/systemd/system/multi-user.target.wants && ln -sf ../pane-net-probe.service ${mnt}/etc/systemd/system/multi-user.target.wants/pane-net-probe.service`);
    } finally {
      await sh(`umount ${mnt}`);
    }

    // The host image's resolver, with a public upstream and one test-only name that proves who answered.
    const dns = join(here, '..', '..', 'host', 'files', 'dns');
    const conf = (await readFile(join(dns, 'dns.conf'), 'utf8'))
      .replace(/^server=.*$/m, 'server=1.1.1.1')
      .replace(/^conf-file=.*$/m, `conf-file=${join(dns, 'dns-blocklist.conf')}\naddress=/pane-redirect.test/192.0.2.1`);
    await writeFile(join(work, 'dns.conf'), conf);
    resolver = spawn('dnsmasq', ['--keep-in-foreground', `--conf-file=${join(work, 'dns.conf')}`, '--user=root', '--pid-file='], { stdio: 'inherit' });

    hostNet = createHostNetwork();
    await hostNet.installHostRules();
    const runtime = createRuntime({
      firecrackerBin: join(artifacts, 'firecracker'),
      jailerBin: join(artifacts, 'jailer'),
      chrootBase: join(work, 'jail'),
      cgroupParent: 'fleet-test',
    });

    const boot = async (role: 'listen' | 'client', slot: number, extra: (m: MachineAddress) => string) => {
      const machineId = `net-${role}`;
      const uid = 61_000 + slot;
      const address = await hostNet.attach(machineId, slot, { uid });
      const diskPath = join(work, 'disks', `${machineId}.ext4`);
      await copyFile(template, diskPath);
      const consoleLogPath = join(work, 'console', `${machineId}.log`);
      vms.push(
        await runtime.start({
          machineId,
          uid,
          gid: uid,
          vcpu: 1,
          memoryMiB: 512,
          kernelPath: join(work, 'vmlinux'),
          diskPath,
          consoleLogPath,
          network: { tapName: address.tapName, guestMac: address.guestMac, kernelIpArg: address.kernelIpArg },
          extraBootArgs: extra(address),
        }),
      );
      results[role] = probes(await waitForConsole(consoleLogPath, /PANE_PROBE_DONE/, 90_000));
      return address;
    };
    const listener = await boot('listen', 1, () => 'pane_probe=listen');
    await boot('client', 2, () => `pane_probe=client pane_peer=${listener.guestIp}`);
  }, 240_000);

  afterAll(async () => {
    for (const vm of vms) await vm.stop().catch(() => undefined);
    if (!canRun) return;
    for (const id of ['net-listen', 'net-client']) await hostNet.detach(id).catch(() => undefined);
    resolver?.kill('SIGKILL');
    await sh('nft delete table inet fleet').catch(() => undefined);
    if (work) await rm(work, { recursive: true, force: true });
  });

  test('no route to another machine', () => {
    expect(results.listen.self).toBe('open');
    expect(results.client.peer).toBe('refused');
  });

  test('no instance metadata', async () => {
    expect(await hostReaches('169.254.169.254', 80)).toBe(true);
    expect(results.client.metadata).toBe('refused');
  });

  test('outbound port 25 is refused', () => {
    expect(results.client.smtp).toBe('refused');
  });

  test('DNS goes only through the host resolver', async () => {
    expect(results.client['dns-redirect']).toBe('A 192.0.2.1');
    expect(results.client['dns-redirect-tcp']).toBe('A 192.0.2.1');
    expect(results.client['dns-blocked']).toBe('NXDOMAIN');
    expect(await hostReaches('1.1.1.1', 853)).toBe(true);
    expect(results.client.dot).toBe('refused');
  });

  test('ordinary egress and Tailscale work, and are metered', async () => {
    expect(results.client.https).toBe('open');
    expect(results.client['tailscale-control']).toBe('open');
    expect(results.client['tailscale-derp']).toBe('open');
    expect(results.client.stun).toBe('open');
    expect(await hostNet.egressBytes('net-client')).toBeGreaterThan(1000);
  });
});
