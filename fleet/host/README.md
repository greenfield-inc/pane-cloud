# Fleet host image (F1)

What a fleet host runs before any machine starts: Ubuntu 24.04 on a Graviton bare-metal instance
(`r7g.metal`), Firecracker and its jailer at the version pinned in [`versions.env`](versions.env),
and Node for the host agent. Every download is checked against its pinned SHA-256.

| File | Runs | What it does |
| --- | --- | --- |
| [`setup-host.sh`](setup-host.sh) | Once, while baking the image | Installs packages, Firecracker, jailer and Node; removes the SSH server; keeps swap off for good |
| [`host-boot.sh`](host-boot.sh) | Every boot (`fleet-host-boot.service`) | Checks `/dev/kvm`; turns SMT and KSM off; turns swap off; enables cgroup v2 controllers under `/sys/fs/cgroup/fleet`; mounts the data volume at `/srv` |
| [`host.pkr.hcl`](host.pkr.hcl) | `packer build` | Bakes the AMI from Canonical's Ubuntu 24.04 arm64 image |
| [`install-firecracker.sh`](install-firecracker.sh) | `setup-host.sh`, CI | Downloads and checks the pinned Firecracker release |
| [`fetch-test-artifacts.sh`](fetch-test-artifacts.sh) | CI | Firecracker, a test kernel and a test rootfs for the runtime's KVM tests |

`setup-host.sh` also installs F3's filtering DNS resolver (`files/dns`, `fleet-dns.service`) and the
flow log files (`files/rsyslog`, `files/logrotate`). See [`../network`](../network).

The host follows Firecracker's [production host setup](https://github.com/firecracker-microvm/firecracker/blob/main/docs/prod-host-setup.md):

- Every machine runs under the jailer: its own uid and gid, a chroot, a new PID namespace and its own
  cgroup under `/sys/fs/cgroup/fleet`.
- SMT is off. Graviton has no SMT, which is why the fleet uses it: on Intel, turning SMT off halves
  the usable vCPUs.
- KSM is off, so no memory pages are shared between tenants.
- Swap is off, so guest memory never reaches the host's disk.
- The host has no SSH server and, through F6, no inbound security group rules.

## Data volume

Machine disks (`/srv/fleet/disks`), snapshots and jails live on a separate EBS volume labelled
`fleet-data`, formatted XFS with reflink so a new disk is an instant copy of the guest template.
`host-boot.sh` formats it only when it is blank. The volume outlives its host: after a host loss, a
replacement host mounts it and its machines boot from their own disks.

## Decision: Firecracker driven directly, not E2B

E2B's runtime (Apache-2.0) wraps Firecracker with its own orchestrator and template service. Its
AWS example runs on Intel with nested virtualization, and Graviton support is unverified. Pane Cloud
needs only one jailed Firecracker process per machine, driven by a host agent that runs nothing
outside the contract's allow-list, so the fleet drives Firecracker's API directly
([`../runtime`](../runtime)). That keeps the code that can touch a user's machine small enough to
review, on the hardware the margin depends on.
