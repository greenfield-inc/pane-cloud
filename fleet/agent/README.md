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

Each new machine gets a network slot, unique across the fleet and kept until the machine is
deleted. The slot is the machine's uid on every host (`200000 + slot`) and its F3 address: tap
`fctap<slot>`, guest IP and MAC. A restored snapshot keeps the guest's IP and MAC in memory, so a
machine resumes on any host with the same ones. F3's subnet, `10.200.0.0/16`, has 16,384 slots, so
the fleet holds at most 16,384 machines, stopped ones included. The fleet sends the slot, and the
machine's egress so far this month, with each operation it hands a host.

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
| `create` | Disk from the template with F1's `createDiskFromTemplate` (50 GiB), F3 `attach`, start with F4's `cgroupFor` ceilings |
| `stop` | Guest `prepare_to_stop`, F4 budget `check` and a last egress reading, full snapshot (memory and VM state), stop the process, F3 `detach`, upload disk and snapshot, remove the local copies |
| `resume` | Download disk and snapshot, F3 `attach`, restore with F4's `cgroupFor` ceilings, set the egress rate limit for this month |
| `delete` | Stop the VM if running, F3 `detach`, delete the disk and the stored snapshot |
| `bootstrap`, `update_pane`, `prepare_to_stop`, `collect_diagnostics` | Sent to the guest agent over vsock (fleet/README.md, "F5 guest agent protocol") |

A stopped machine is on no host (`hostId: null`); `resume` can place it on any host.

On start the host agent writes its host id to `<dataDir>/host-id`, reattaches to every machine that
is still running (`runtime.attach`), and installs F3's firewall when no machine is running. The
firewall lasts until the host reboots, and replacing it would cut off running machines. A machine
whose VM is gone becomes `error` / `failed`.

`bootstrap` logs the guest's `firstBoot` state. `collect_diagnostics` checks the archive the guest
sends against its own `bytes` and `sha256`, stores it, and answers `{ files, archiveKey }`; files
the guest skipped are logged.

### Stops the fleet makes on its own

- **Idle.** The host agent reads the guest's `status` every poll (60 s). A machine with no agent
  running and no client connected for 30 minutes is stopped with reason `idle`. Pane 2.4.215 does
  not tell the guest agent about connected clients, so `clientsConnected` is always 0 and only
  running agents keep a machine awake. The rule takes effect once Pane serves connected clients to
  the guest agent (Pane's A4 package).
- **Memory pressure.** Every poll the host agent runs F4's `decideReclaim` on each machine's
  host-side resident memory, idle state and balloon statistics, plus how long the machine was above
  12 GiB in the last 15 minutes. That history is kept by machine id across a stop and resume on the
  host. Inflate and deflate go to the balloon; a stop has reason `memory_pressure`, which the user
  sees as a `state_changed` event.
- **Egress abuse.** Every poll the host agent reads F3's egress counter and runs
  `checkEgressAbuse`: 10 GB out within an hour stops the machine with reason `abuse` and logs it.
- **Host maintenance.** When maintenance is requested, the host reports `draining` and stops every
  machine with reason `host_maintenance`. A later `resume` places it on another host.
- **Host loss.** A host that has not synced for 2 minutes (`hostLostAfterSeconds`) is lost. Its
  running machines become `error` / `host_lost`, its unfinished operations fail, and each machine is
  rebuilt on another host from its own disk on the lost host's data volume. It boots from the disk,
  so running agents are interrupted and the `host_lost` event tells the user. Detection plus a cold
  boot fits journey 11's 15 minutes. A lost host that syncs again is refused.

Every state change is an event in `GET /v1/events`, with a monotonic cursor.

### Fair use and egress limits

- **CPU.** Every start, restore and recovery passes F4's `cgroupFor(machineId)` as the machine's
  cgroup, so a throttled machine starts throttled. Every poll writes the ceilings
  (`applyCeilings`) and then charges the daily budget (`check`); a stop charges it once more. The
  check's `budget_exhausted` and `budget_reset` become events.
- **Monthly egress.** The host agent adds each counter reading to the machine's month and runs
  `checkMonthlyEgress`. At 30 GB it logs an alert; the contract has no event for it yet. At the
  contract's 100 GiB it limits the machine's sending to about 1 MiB/s (`CAPPED_TX`) until the month
  ends. That rate is an assumption awaiting Parsa's call. The month follows the machine to the next
  host it resumes on.
- The thresholds are F3's defaults; the host config's `egress` object overrides them (D-23).

## Ports

These interfaces are in [`src/ports.ts`](src/ports.ts), with local implementations in
[`src/local.ts`](src/local.ts).

| Port | Now | Production |
| --- | --- | --- |
| `NetworkPort` (F3) | F3's `createHostNetwork` | The same |
| `FairUsePort` (F4) | `fleetFairUse`: F4's package, budgets kept in `<dataDir>/state/cpu-budget` | The same |
| `HostMetrics` (F6) | `noHostMetrics` | `cloudWatchHostMetrics`: `Heartbeat` and `MemoryUsedPercent` every poll to namespace `PaneCloud/Fleet`, dimension `Fleet=pane-cloud`, in `awsRegion` or `AWS_REGION` |
| `SnapshotStore` | `localSnapshotStore`: a directory | S3 (below) |
| `DiagnosticsStore` | `localDiagnosticsStore`: a directory | The diagnostics bucket |
| `ReleaseList` | `releasesFrom`: a list, a JSON file, or an https URL cached 5 minutes | The published release manifest |
| `VolumeRecovery` | `adoptedVolumeRecovery` (below); tests use `localVolumeRecovery` | The same, once something attaches the lost host's EBS volume here |
| `MaintenanceSignal` | `fileMaintenanceSignal`: maintenance while `/run/pane-fleet/maintenance` exists | The instance's Auto Scaling lifecycle state from instance metadata |

Metrics: `memoryResidentMiB` is F4's `readResidentMiB` (`memory.current` less the disk's page
cache); `diskUsedBytes` is the disk file's allocated blocks; `cpuSecondsUsed` and `throttled` come
from F4's budget check; `egressBytesThisMonth` is the month's total from F3's counter.

### Adopting a lost host's data volume

`host-boot.sh` mounts the volume labelled `fleet-data` at `/srv` and refuses to boot when two
volumes carry that label. To recover a machine, `adoptedVolumeRecovery` looks among unmounted
volumes labelled `fleet-data` (or `fleet-adopt`) for the one whose `fleet/host-id` names the lost
host, mounts it at `/srv/adopted/<lostHostId>`, and relabels it `fleet-adopt` (an XFS label holds 12
characters). The machine's disk is copied from there to `/srv/fleet/disks`, because F1 hard-links a
disk into its jail and the jail must be on the same filesystem. Attaching the volume to this
instance (the EC2 API) is not written yet.

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

The tests run the fleet API and host agents in one process, with F4's package on fake cgroup files.
A fake of F1's `Runtime`, a fake guest agent that speaks the real vsock line protocol, and a fake of
F3's `ip` and `nft` calls stand in for the kernel. They cover the contract's `fleetContractCases`,
signed-envelope refusals, `requestId` idempotency, placement and `no_capacity`, host loss, idle stop
on an injected clock, the host's own signature, expiry and release checks, reattach after restart,
host maintenance, a stable address and egress cap across hosts, the abuse stop, the CPU budget
throttle across a resume, the memory-pressure stop, and the diagnostics checksum.

Two tests need root and skip otherwise; CI runs both in
[`.github/workflows/fleet-agent.yml`](../../.github/workflows/fleet-agent.yml):

- `src/host.kvm.test.ts` runs create, stop, resume and delete on a real microVM, on a real F3 tap
  and F4 ceilings. It needs `/dev/kvm`, nft and F1's test artifacts.
- `src/volumes.linux.test.ts` adopts a lost host's volume from two XFS loop devices. It needs
  xfsprogs and `FLEET_VOLUME_TEST=1`.

## Not verified yet

- The S3 snapshot store, attaching a lost host's EBS volume, CloudWatch host metrics, the
  maintenance signal from instance metadata, Secrets Manager credentials and TLS: all need the AWS
  account (D-21).
- The F4 CPU budget restarts its day when a machine resumes on another host: each host keeps its
  own budget store (F4's README).
- Stop and resume time with a 16 GiB memory snapshot, and a full host of 109 machines: need an
  `r7g.metal`.
- The guest protocol against F5's real guest agent.
