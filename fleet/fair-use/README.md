# Fair use and memory (F4)

`@pane-cloud/fleet-fair-use` holds each machine to D-13's fair-use limits and keeps host memory in
check. It decides and writes cgroup files. It never stops a machine itself: the host agent (F2) runs
its decisions on a timer, stops machines with the contract's `memory_pressure` reason and tells the
user.

```ts
import { MACHINE_CGROUP, applyCeilings, createCpuBudget, createFileBudgetStore, decideReclaim, readHostMemory, readResidentMiB } from '@pane-cloud/fleet-fair-use';

await runtime.start({ ...spec, memoryMiB: 16_384, vcpu: 8, cgroup: MACHINE_CGROUP, balloon: { deflateOnOom: true, statsPollingIntervalS: 5 } });

const budget = createCpuBudget(createFileBudgetStore('/srv/fleet/state/cpu-budget'));
const { cpuSecondsUsed, throttled, event } = await budget.check(machineId, vm.cgroupPath); // every minute, and before a stop

const actions = decideReclaim(await readHostMemory(), samples); // samples: residentMiB from readResidentMiB, idle, vm.balloonStats()
```

## Ceilings

`MACHINE_CGROUP` is what the jailer writes before Firecracker starts. `applyCeilings(cgroupPath)`
writes the same files into a running machine's cgroup.

| File | Value | Why |
| --- | --- | --- |
| `cpu.max` | `800000 100000` | 8 vCPU at most |
| `cpu.weight` | `100` | Every machine weighs the same. On a 64-vCPU host where 11 machines burst at once, each gets about 64 / 11 = 5.8 vCPU (journey 6) |
| `memory.max` | 16 GiB + 256 MiB | The guest sees 16 GiB. A process that asks for 17 GiB is OOM-killed inside the guest; the host never kills the VM (journey 5) |
| `memory.swap.max` | `0` | Guest memory never reaches the host's disk |
| `pids.max` | `64` | Firecracker runs a main thread, an API thread and one thread per vCPU, and never forks |

**The 256 MiB of VMM headroom.** A fully touched 16 GiB guest needs 32 MiB of host page tables and
32 MiB of KVM stage-2 page tables at 4 KiB pages (16 GiB / 4 KiB × 8 bytes, twice). Firecracker's
own threads take at most 5 MiB ([SPECIFICATION.md](https://github.com/firecracker-microvm/firecracker/blob/v1.17.0/SPECIFICATION.md)).
The rest covers vCPU stacks, vsock buffers and the disk's dirty page cache while a snapshot is
written. The headroom is a ceiling, not a reservation, so it costs memory only while a guest is full.
The KVM test fills a guest until its own OOM killer fires, measures what the Firecracker process holds
beyond guest RAM, and checks that this plus 64 MiB of page tables fits in 256 MiB.

Measured in CI (run 42176951522, x86_64 nested KVM, 1 GiB guest filled to 1,007 MiB): 5.5 MiB
beyond guest RAM, of which 2.0 MiB host page tables and 2.0 MiB stage-2 page tables. Page tables
scale with guest memory, so a full 16 GiB guest needs about 64 MiB for them plus about 1.5 MiB for
the rest: roughly 66 MiB, well inside 256 MiB.

## Daily CPU budget

`createCpuBudget(store).check(machineId, cgroupPath)` reads `usage_usec` from the cgroup's
`cpu.stat` and adds what the machine used since the last check to the UTC day's total. At 43,200
vCPU-seconds (the contract's `MACHINE_LIMITS.dailyCpuSeconds`) it writes `cpu.max 50000 100000` (0.5 vCPU) and
returns `event: 'budget_exhausted'`. The first check after the next UTC midnight writes 8 vCPU back
and returns `event: 'budget_reset'`. The result's `cpuSecondsUsed` and `throttled` are the fleet
API's metric fields.

The store keeps the running total, so a host agent restart doesn't reset the budget. A machine that
stops and resumes on the same host the same day keeps its total and its throttle: the check notices
the new cgroup and writes `cpu.max` again. `createFileBudgetStore(dir)` keeps one JSON file per
machine.

## Memory reclaim

`decideReclaim(host, machines)` is pure. It returns `inflate`, `deflate` and `snapshot_stop` actions.
Stops use host-side numbers only, so a guest whose user unloads the balloon driver or fakes its
statistics is still caught.

1. **Balloon on idle guests.** For an idle machine whose guest reports its counters, the balloon
   target becomes what the guest has available (free memory plus page cache) less 1 GiB, and never
   leaves the guest less than 2 GiB. It moves only in steps of 256 MiB or more, and only once the
   guest reached the last target. A machine in use again gets its balloon deflated to 0.
2. **12 GiB for 10 minutes.** While the host is above 75% memory, any machine whose host-side
   resident memory has stayed above 12 GiB for 10 minutes is snapshotted and stopped.
3. **85% host memory.** The largest idle machines are snapshotted and stopped until the host is
   under 85%.

`readResidentMiB(cgroupPath)` is `memory.current` less the disk's page cache (`memory.stat file`),
which the kernel reclaims on its own. The caller tracks how long it has stayed above 12 GiB.

### Free page reporting and hinting

Firecracker v1.17 has both (added in v1.14, `free_page_reporting` and `free_page_hinting` on
`PUT /balloon`). This package uses neither yet:

- Hinting is a developer preview. Its docs warn that a guest can reuse a page before Firecracker
  frees it, which can corrupt guest memory.
- Reporting was announced in the v1.14 release notes as "a developer preview not for production",
  and no later release notes promote it. Firecracker's release policy gives developer-preview
  features no security fixes. It also needs `CONFIG_PAGE_REPORTING` in the guest kernel (F5).
- Inflating the balloon already returns freed memory and page cache from idle guests, which is what
  journey 5 checks.

Reporting would also return memory from busy guests between builds. Turning it on means adding
`free_page_reporting: true` to F1's `PUT /balloon`.

## Contract values

[`src/limits.ts`](src/limits.ts) copies the contract's `MACHINE_LIMITS` and machine id rule from
pane-cloud-contract at greenfield-inc/Pane 5c3d3c6. Installing the contract from git runs a full Pane
monorepo install, which fails on Linux (it rebuilds better-sqlite3 for Electron), so it is not a
dependency yet. Replace the copy with an import once the contract installs on its own.

## Checks

```sh
cd fleet && pnpm install
pnpm --filter @pane-cloud/fleet-fair-use typecheck
pnpm --filter @pane-cloud/fleet-fair-use lint
pnpm --filter @pane-cloud/fleet-fair-use test     # budget and reclaim; the root and KVM tests skip
```

- `src/cgroup.privileged.test.ts` needs root and a cgroup v2 parent with `cpu`, `memory` and `pids`
  delegated, named in `FLEET_CGROUP_TEST_PARENT`. It checks the kernel accepts every ceiling and that
  a CPU burner runs at about 0.5 CPU under the throttle and at full speed after midnight. It runs in
  CI (`.github/workflows/fleet-fair-use.yml`) and in `docker run --privileged`.
- `src/fair-use.kvm.test.ts` needs root, `/dev/kvm` and F1's test artifacts plus a rootfs with a
  memory hog, which the workflow builds. It runs journey 5 scaled to a CI runner: a 1 GiB guest that
  asks for 2 GiB is OOM-killed inside the guest only, and a 4 GiB guest that held 3 GiB gets its
  host-side memory back from the balloon.

## Not verified yet

These wait for a real `r7g.metal` (D-21):

- Full density: 109 machines a host, 11 of them bursting to 8 vCPU (journey 6), and the 2-hour load
  test.
- The rules under real host memory pressure, with real 16 GiB guests and F5's guest image.
- The headroom on arm64 with a full 16 GiB guest; CI measures a 1 GiB guest on x86_64 and scales it.
- Budget totals for a machine that resumes on another host the same day: each host keeps its own
  store, so the day's count starts again there.
