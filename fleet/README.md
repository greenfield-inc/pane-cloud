# Pane Cloud fleet

One always-on machine per seat, packed as Firecracker microVMs on Graviton bare-metal hosts
(`r7g.metal`, 64 vCPU, 512 GiB). The Pane Cloud service drives the fleet only through the fleet API
in [`pane-cloud-contract`](https://github.com/greenfield-inc/Pane/tree/cloud/p0-contracts/packages/pane-cloud-contract):
signed, allow-listed operations with fixed parameters (D-6).

## Packages

| Directory | Package | What it does |
| --- | --- | --- |
| [`host/`](host) | F1 | The host image: Firecracker and jailer at a pinned version, kernel and sysctl settings from Firecracker's production host guide, the systemd units |
| [`runtime/`](runtime) | F1 | `@pane-cloud/fleet-runtime`: starts, pauses, snapshots, restores and stops one jailed Firecracker microVM |
| `agent/` | F2 | `@pane-cloud/fleet-agent`: the fleet API server (scheduler) and the host agent |
| `network/` | F3 | `@pane-cloud/fleet-network`: per-machine tap, NAT, egress metering and caps, filtering DNS, flow logs |
| `fair-use/` | F4 | `@pane-cloud/fleet-fair-use`: CPU and memory ceilings, the daily CPU budget, balloon reclaim, memory-pressure stops |
| `guest/` | F5 | The guest image (Ubuntu 24.04 arm64) and the guest agent |
| `../infra/` | F6 | Terraform: the member account's IAM roles, buckets, keys, logs, alarms and the host fleet |

Host-side code is TypeScript on Node 22 or later, so the host agent checks operations with the
contract's own `verifyOperation`. The guest agent is Python 3 with only the standard library, which
has `AF_VSOCK`, so the guest image needs no extra runtime.

## How a machine runs

```
service (S1) ──signed operation──▶ fleet API (agent/, scheduler)
                                      │ forwards the same signed envelope
                                      ▼
                                   host agent (agent/) ── verifyOperation, then:
                                      ├─ runtime/   jailer + firecracker, one process and uid per machine
                                      ├─ network/   tap, nftables, DNS
                                      ├─ fair-use/  cgroup v2 limits, budget, balloon
                                      └─ vsock ──▶ guest agent (guest/) ── bootstrap, update_pane,
                                                                           prepare_to_stop, collect_diagnostics
```

- **Machine disk.** A 50 GiB sparse ext4 file per machine on the host's data volume
  (`/srv/fleet/disks/<machineId>.ext4`), created as a reflink copy of the guest template, so a new
  disk costs no copy time. The data volume is a separate EBS volume that outlives its host, so a
  replacement host reattaches it after a host loss.
- **Stop and resume.** Stop pauses the VM, writes a full memory and VM-state snapshot, stops the
  process and uploads disk and snapshot to the fleet's snapshot bucket. Resume restores them on any
  host.
- **Jailing.** Every VM runs under Firecracker's jailer: its own uid and gid, a chroot under
  `/srv/jailer/firecracker/<machineId>/root`, a new PID and network namespace, and its own cgroup
  under `fleet.slice`.

## Seams between packages

These are the interfaces each package builds against. A package that needs another's seam before it
exists uses an in-memory implementation of the same interface.

### F1 runtime (`@pane-cloud/fleet-runtime`)

See [`runtime/src/index.ts`](runtime/src/index.ts). In short:

```ts
const runtime = createRuntime({ firecrackerBin, jailerBin, chrootBase, cgroupParent });
const vm = await runtime.start(spec);           // MachineSpec: id, vcpu, memoryMiB, kernel, disk, network?, vsock, balloon
await vm.pause(); await vm.snapshot(paths);     // full snapshot: memory file and VM state
await vm.resume(); await vm.setBalloon(mib); await vm.balloonStats();
await vm.updateNetworkRateLimit(limits);        // F3 egress caps on the tap
await vm.stop();                                // ends the process and cleans the jail
const restored = await runtime.restore(spec, paths);
vm.cgroupPath;                                  // F4 writes cpu.max, cpu.weight, memory.max here
vm.vsockPath;                                   // host side of the guest agent's vsock
```

### F3 network (`@pane-cloud/fleet-network`)

```ts
const net = createHostNetwork();                // uplink defaults to the default route's interface, subnet to 10.200.0.0/16
await net.installHostRules();                   // once per host boot
const m = await net.attach(machineId, slot, { uid });  // { tapName, guestMac, guestIp, gatewayIp, kernelIpArg }; the tap is owned by the machine's uid
await net.egressBytes(machineId);               // bytes out since attach
await net.detach(machineId);
checkEgressAbuse(samples, policy);              // pure: { stop: true, reason: 'abuse' } at 10 GB out in an hour
checkMonthlyEgress(bytesThisMonth, policy);     // pure: { alert, capped } at 30 GB and 100 GiB
```

Each machine gets its own `/30` from the slot number. The host forwards nothing between taps. The
guest's DNS resolver is its gateway address. See [`network/`](network).

### F4 fair use (`@pane-cloud/fleet-fair-use`)

```ts
applyCeilings(cgroupPath);                      // 8 vCPU, memory.max for 16 GiB plus VMM overhead
const budget = createCpuBudget(store);          // reads cpu.stat usage_usec, throttles to 0.5 vCPU at 43,200 s a UTC day
decideReclaim(hostSample, machineSamples);      // pure: [{ kind: 'inflate' | 'snapshot_stop', machineId, reason }]
```

The host agent runs F4's decisions on a timer; F4 never stops a machine itself.

### F5 guest agent protocol (vsock)

The guest agent listens on vsock port `1024`. The host agent connects through Firecracker's vsock
socket (`CONNECT 1024\n`, answered `OK <port>\n`) and sends one JSON object per line:

```json
{ "id": "<requestId>", "operation": "update_pane", "parameters": { "release": { "version": "1.4.0", "arch": "arm64", "debSha256": "…" } } }
{ "id": "<id>", "operation": "status", "parameters": {} }
```

It answers one line per request:

```json
{ "id": "<id>", "ok": true, "result": { … } }
{ "id": "<id>", "ok": false, "error": { "code": "invalid_request", "message": "…", "next": "…" } }
```

The guest agent accepts only `bootstrap`, `update_pane`, `prepare_to_stop`, `collect_diagnostics`
and `status`, each with exactly the parameters the contract allows. `status` returns:

```json
{ "paneVersion": "1.4.0", "tailnet": { "status": "awaiting_login", "loginUrl": "https://login.tailscale.com/a/…", "hostname": null },
  "activity": { "agentsRunning": 0, "clientsConnected": 0, "lastActivityAt": "2026-11-06T06:00:00Z" } }
```

Idle stop (F2) reads `activity`: no agent running and no client connected for 30 minutes.

`collect_diagnostics` returns `{ "files": [{ "path", "bytes" }], "archiveBase64": "<.tar.gz>" }`; the
host agent stores the archive in the diagnostics bucket and returns its key.

### F2 fleet API and host agents

Hosts have no inbound ports, so each host agent calls the fleet API once a second:
`POST /v1/hosts/<hostId>/sync` with its machines, metrics, changed operations and new events, and
receives its work: signed envelopes exactly as the service sent them, and machines to rebuild from a
lost host's disk. See [`agent/src/sync.ts`](agent/src/sync.ts).

## Where checks run

Firecracker needs `/dev/kvm`. The KVM checks run in CI on GitHub's Ubuntu x86_64 runners, which
expose `/dev/kvm`; the code is the same on arm64. Checks that need a real `r7g.metal` (boot time on
Graviton, full-density load, the balloon under real memory pressure) wait until the AWS account
exists (D-21).
