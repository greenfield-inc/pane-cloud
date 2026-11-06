# Fleet agent (F2)

`@pane-cloud/fleet-agent` is two programs in one package:

- **The fleet API** (`fleet-agent serve-fleet`). The Pane Cloud service calls it with signed
  operations. It implements the fleet API in
  [`pane-cloud-contract`](https://github.com/greenfield-inc/Pane/tree/cloud/p0-contracts/packages/pane-cloud-contract)
  and places machines on hosts.
- **The host agent** (`fleet-agent serve-host`). It runs on every fleet host and drives F1's runtime,
  F3's network, F4's fair use and the guest agent.

## How an operation runs

1. The service sends a signed envelope to `POST /v1/operations`.
2. The fleet API checks it with the contract's `verifyOperation` and its trusted keys. It refuses an
   unknown operation, an extra parameter, an untrusted key, a bad signature, an expired envelope, and
   a `bootstrap` or `update_pane` release that is not in its published list.
3. It checks the machine's state, places a `create` or `resume` on a host, stores the operation, and
   answers `202 accepted`. Sending the same `requestId` again returns the stored result.
4. Hosts have no inbound ports (F6). Each host agent calls `POST /v1/hosts/<hostId>/sync` every
   second. The answer carries the same signed envelope, unchanged.
5. The host agent runs `verifyOperation` again with its own keys and clock, checks the release
   against its own published list, checks the machine's state, then runs the operation. A refusal
   becomes a failed operation with the contract's error code. Nothing else runs.
6. The next sync reports the result, the host's machines and metrics, and new events. The fleet
   stores them and serves `GET /v1/operations/:id`, `GET /v1/machines/:id`, `GET .../metrics` and
   `GET /v1/events` from its own state.

Every operation is logged as one JSON line, on the fleet and on the host: received, refused or
finished, with request id, machine, operation, reason and signing key id.

## Scheduler

A new or resumed machine goes to the live host with the most memory headroom. Headroom is the host's
memory target (`memoryTargetFraction` of its memory, default 0.75, F4's overcommit target) minus the
memory it uses now. Each machine handed to a host that the host has not reported yet counts as
3 GiB (`newMachineMiB`). A host is full at `maxMachines` (default 109 for an `r7g.metal`). When no
host has room the fleet answers `no_capacity`. A draining host takes nothing.

Placement comes from what hosts report on each sync. The fleet stores only what it cannot rebuild:
operation results (for `requestId` idempotency and status), each machine's last state, host and
metrics, the event feed, and the last event id taken from each host.

## Lifecycle on the host

| Operation | What the host agent does |
| --- | --- |
| `create` | Disk from the template with F1's `createDiskFromTemplate` (50 GiB), F3 attach, start, F4 ceilings |
| `stop` | Guest `prepare_to_stop`, full snapshot (memory and VM state), stop the process, upload disk and snapshot, remove the local copies |
| `resume` | Download disk and snapshot, restore |
| `delete` | Stop the VM if running, delete the disk and the stored snapshot |
| `bootstrap`, `update_pane`, `prepare_to_stop`, `collect_diagnostics` | Sent to the guest agent over vsock (fleet/README.md, "F5 guest agent protocol") |

A stopped machine is on no host (`hostId: null`); `resume` can place it on any host.

On restart the host agent reattaches to every machine that is still running (`runtime.attach`). A
machine whose VM is gone becomes `error` / `failed`.

### Stops the fleet makes on its own

- **Idle.** The host agent reads the guest's `status` every poll (60 s). A machine with no agent
  running and no client connected for 30 minutes is stopped with reason `idle`.
- **Memory pressure.** The host agent runs F4's `decideReclaim` every poll: it inflates balloons and
  stops machines with reason `memory_pressure`.
- **Host maintenance.** When maintenance is requested, the host reports `draining` and stops every
  machine with reason `host_maintenance`. A later `resume` places it on another host.
- **Host loss.** A host that has not synced for 2 minutes (`hostLostAfterSeconds`) is lost. Its
  running machines become `error` / `host_lost`, its unfinished operations fail, and each machine is
  rebuilt on another host from its own disk on the lost host's data volume. It boots from the disk,
  so running agents are interrupted and the `host_lost` event tells the user. Detection plus a cold
  boot fits journey 11's 15 minutes. A lost host that syncs again is refused.

Every state change is an event in `GET /v1/events`, with a monotonic cursor.

## Ports

These interfaces are in [`src/ports.ts`](src/ports.ts), with local implementations in
[`src/local.ts`](src/local.ts).

| Port | Now | Production |
| --- | --- | --- |
| `NetworkPort` (F3) | None: machines boot without a network interface | F3's `createHostNetwork` |
| `FairUsePort` (F4) | `basicFairUse`: charges `cpu.stat` against the daily budget, writes no ceilings, never reclaims | F4's package |
| `SnapshotStore` | `localSnapshotStore`: a directory | S3 (below) |
| `DiagnosticsStore` | `localDiagnosticsStore`: a directory | The diagnostics bucket |
| `ReleaseList` | `releasesFrom`: a list, a JSON file, or an https URL cached 5 minutes | The published release manifest |
| `VolumeRecovery` | `localVolumeRecovery`: lost volumes mounted at `<recoveryDir>/<hostId>` | F6 detaches the lost host's EBS volume and attaches it here |
| `MaintenanceSignal` | `fileMaintenanceSignal`: maintenance while `/run/pane-fleet/maintenance` exists | The instance's Auto Scaling lifecycle state from instance metadata |

Metrics: `memoryResidentMiB` is the machine cgroup's `memory.current`; `diskUsedBytes` is the disk
file's allocated blocks; `cpuSecondsUsed` and `throttled` come from F4; egress comes from F3.

### S3 snapshot store (not written yet)

`put` uploads `snapshots/<machineId>/{disk.ext4,vmstate,mem}` with multipart upload (the AWS SDK's
`@aws-sdk/lib-storage` `Upload`), under the fleet KMS key, then writes a small `manifest.json` last
so a half-written snapshot is never read. `get` reads the manifest, then downloads the three objects.
`delete` deletes the prefix. The host role may use only that bucket and key (F6). It is not written
here because it could not be tested without AWS.

## Configuration

`serve-fleet` reads `/etc/pane-fleet/fleet.json` and `serve-host` reads `/etc/pane-fleet/host.json`
(or `--config <file>`). The schemas and defaults are at the top of [`src/cli.ts`](src/cli.ts). The
required fields are `trustedKeys` (key id to PEM public key) and `releases`; the host also needs
`fleetUrl`. The host id defaults to the hostname.

Tokens are never in the config file. Each one comes from an environment variable, or from a systemd
credential file:

| Token | Who sends it | Environment variable | systemd credential |
| --- | --- | --- | --- |
| Service token | The service, on every fleet API route | `FLEET_SERVICE_TOKEN` | `fleet-service-token` |
| Host token | Host agents, on the sync route only | `FLEET_HOST_TOKEN` | `fleet-host-token` |

The units in [`systemd/`](systemd) load them with `LoadCredential=` from
`/etc/pane-fleet/credentials/`. In production F6 writes those files from Secrets Manager at boot.
The fleet API speaks plain HTTP, so it must listen only inside the VPC behind a TLS load balancer.

## State store

The fleet and each host keep their state as one JSON document behind `StateStore`
([`src/store.ts`](src/store.ts)), saved atomically (write, then rename) before each answer. That is
enough for one fleet API process and a few thousand machines. Production should use Postgres in the
service's database cluster: `requestId` as a primary key makes idempotency one `INSERT ... ON
CONFLICT`, a `bigserial` gives the event cursor, and a second fleet API process can then run. The
interface would then change from whole-document to per-record.

## Checks

```sh
cd fleet
pnpm install
pnpm --filter @pane-cloud/fleet-agent typecheck
pnpm --filter @pane-cloud/fleet-agent lint
pnpm --filter @pane-cloud/fleet-agent test
```

The tests run the fleet API and host agents in one process. A fake of F1's `Runtime` and a fake
guest agent that speaks the real vsock line protocol stand in for Firecracker. They cover the
contract's `fleetContractCases`, signed-envelope refusals, `requestId` idempotency, placement and
`no_capacity`, host loss, idle stop on an injected clock, the host's own signature, expiry and
release checks, reattach after restart, and host maintenance.

`src/host.kvm.test.ts` runs create, stop, resume and delete on a real microVM. It needs root,
`/dev/kvm` and F1's test artifacts, and skips otherwise. CI runs it in
[`.github/workflows/fleet-agent.yml`](../../.github/workflows/fleet-agent.yml).

## Not verified yet

- The S3 snapshot store, the EBS volume reattach, the maintenance signal from instance metadata,
  Secrets Manager credentials and TLS: all need the AWS account (D-21).
- Stop and resume time with a 16 GiB memory snapshot, and a full host of 109 machines: need an
  `r7g.metal`.
- The guest protocol against F5's real guest agent.
