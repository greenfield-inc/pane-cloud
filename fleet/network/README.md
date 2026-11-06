# Fleet network (F3)

`@pane-cloud/fleet-network` gives each machine its own network on the host: a tap device, NAT to the
internet, a firewall that keeps it away from everything else, a filtering DNS resolver, an egress
counter and a flow log. The host agent (F2) calls it and assigns each machine a slot number that is free on the host. It
runs `ip` and `nft` as root, and needs `net.ipv4.ip_forward=1` (set by
[`host/files/sysctl/90-fleet.conf`](../host/files/sysctl/90-fleet.conf)).

```ts
const net = createHostNetwork();                 // uplink: the default route's interface; subnet: 10.200.0.0/16
await net.installHostRules();                    // once per host boot, before any machine
const m = await net.attach(machineId, slot, { uid });   // { tapName, guestMac, guestIp, gatewayIp, kernelIpArg }
// F1's runtime (`fleet/runtime`) boots the machine on that tap, as the same uid.
await runtime.start({ ...spec, uid, network: { tapName: m.tapName, guestMac: m.guestMac, kernelIpArg: m.kernelIpArg } });
await net.egressBytes(machineId);                // bytes out since attach
await net.detach(machineId);                     // after the machine stops
```

Package names (F1 to F6) are in the [fleet README](../README.md); D-numbers and journeys are the
Pane Cloud plan's decisions and acceptance checks.

## Addresses

Slot `n` owns the n-th `/30` of `10.200.0.0/16`: the host end is `10.200.0.(4n+1)`, the guest
`10.200.0.(4n+2)`; slot 64 is `10.200.1.1` and `10.200.1.2`. That is 16,384 slots, far more than
the 109 machines a host holds. The tap is `fctap<n>`, owned by the machine's uid so its jailed
Firecracker can open it. The guest MAC is `06:00:` followed by the guest address in hex, so
`10.200.0.6` gets `06:00:0a:c8:00:06`. The guest's eth0 is set by the
kernel argument `ip=<guest>::<gateway>:255.255.255.252:<machineId>:eth0:off:<gateway>`, so the guest
image (F5) must not run DHCP on eth0. The VPC (F6) must not use `10.200.0.0/16`.

## Firewall

`installHostRules` replaces one nftables table, `inet fleet`, in a single `nft -f` transaction. It
matches only packets that enter or leave a `fctap*` interface, so the host's own traffic is
untouched. For each guest:

- **Out:** only through the uplink, NATed to the host's address. Nothing reaches another machine.
- **Refused:** private and shared ranges (`10/8`, `172.16/12`, `192.168/16`, `100.64/10`: the VPC,
  other hosts, other machines), `169.254.0.0/16` (instance metadata and the VPC resolver),
  loopback, `0/8`, multicast, reserved ranges and the host's own addresses.
- **Port 25 refused**, since direct-to-MX mail on 25 is how spam leaves a cloud. Ports 465 and 587
  stay open: sending there needs an account at a mail provider, which polices its own senders, and
  developers use them for real mail.
- **DNS:** every query on port 53, to any server, is redirected to the resolver on the guest's
  gateway. DNS over TLS (853) is refused. DNS over HTTPS runs on 443 like any website and cannot be
  blocked by port; the flow logs still show where a guest connected.
- **No IPv6.** Guests get no IPv6 address. The host forwards no IPv6 packet from a tap, so
  `fd00:ec2::254` is out of reach, and refuses IPv6 sent to itself. The host side of a tap has no
  IPv6 address.
- **No spoofing.** A packet whose source address does not route back out of its own tap is dropped.
- **In:** only replies to connections the guest opened.

Tailscale inside the guest needs only outbound connections: TCP 443 to its control plane and DERP
relays, UDP 3478 for STUN and UDP 41641 for WireGuard. All are allowed; replies come back through
connection tracking.

Another firewall on the host must not drop forwarded packets. Docker, for example, sets the
iptables `FORWARD` policy to drop, so fleet hosts do not run Docker.

## DNS resolver

`dnsmasq` from the host image ([`host/files/dns/dns.conf`](../host/files/dns/dns.conf), unit
`fleet-dns.service`), installed by `host/setup-host.sh` to `/etc/fleet/dns.conf`. It listens only on
the taps' gateway addresses, picking up new taps as they appear, and runs as the `dnsmasq` user. It
forwards to the VPC's Route 53 Resolver at `169.254.169.253`. The domains in
[`dns-blocklist.conf`](../host/files/dns/dns-blocklist.conf) (`/etc/fleet/dns-blocklist.conf`) are
public mining pools; they and their subdomains answer NXDOMAIN. The operators' fuller list is private
config (D-23) installed over that file.

## Egress metering and limits

Each machine has a named nft counter, `egress_<machineId>`, of the bytes it sends out of the uplink.
`egressBytes` reads it. The counter starts at 0 on the first attach and is gone after a detach or a
host reboot, so the host agent keeps the monthly total. Two pure checks decide what to do; the host agent acts on them:

- `checkEgressAbuse(samples, policy)` returns `{ stop: true, reason: 'abuse' }` when the counter
  readings show `abuseBytes` or more sent in the last `abuseWindowMs` (journey 9: 10 GB in an hour).
  A counter that went down was reset and counts from zero.
- `checkMonthlyEgress(bytesThisMonth, policy)` returns `alert` at `monthlyAlertBytes` (30 GB a seat)
  and `capped` at `monthlyCapBytes` (the contract's `MACHINE_LIMITS.monthlyEgressBytes`, 100 GiB).

The thresholds come from the host agent's config (D-23).

## Flow logs

The kernel logs the first packet of every new outbound connection, up to 100 a second per machine
with bursts of 500. Connections past that limit still go through, unlogged but counted:

```
fleet-flow <machineId> IN=fctap1 OUT=ens5 SRC=10.200.0.6 DST=203.0.113.2 ... PROTO=TCP SPT=58994 DPT=443 ...
```

rsyslog writes these lines to `/var/log/fleet/flows.log`, rotated daily and kept 3 days on the host. F6's CloudWatch
agent ships the file to a log group kept 90 days, so an abuse report about a destination and a time
leads to a machine. `SRC` is the guest's address before NAT.

## Checks

| Command | Where | What it checks |
| --- | --- | --- |
| `pnpm test` | anywhere | Address plan, kernel argument, abuse and monthly checks |
| `pnpm test:linux` | any Docker host | The real ruleset, resolver, counters and flow logs, in a privileged Ubuntu 24.04 container, with network namespaces as guests |
| `FLEET_TEST_ARTIFACTS=<dir> vitest run src/network.kvm.test.ts` | Linux with KVM, as root | Journey 7 (isolation) from two real Firecracker guests; `<dir>` comes from `host/fetch-test-artifacts.sh`. CI: `.github/workflows/fleet-network.yml` |

The Linux and KVM tests skip unless their requirements are met (`FLEET_NETWORK_TEST=1`, which
`test:linux` sets, or `FLEET_TEST_ARTIFACTS` with `/dev/kvm`). `pnpm test:linux` turns on
`net.netfilter.nf_log_all_netns` on the Docker host so the kernel logs flows from the container,
and leaves it on.

## Not yet verified

- The KVM test has not run yet: it needs a Linux host with `/dev/kvm`, and runs in CI on the PR.
- On a real `r7g.metal`: the uplink name, the VPC resolver at `169.254.169.253`, AWS NAT of the
  host's address, and the CloudWatch shipping of flow logs (F6), all wait for the AWS account (D-21).
- Throughput and CPU cost of the ruleset with 109 machines sending at once.
