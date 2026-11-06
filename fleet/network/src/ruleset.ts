import { TAP_PREFIX } from './address.js';

/** The one nftables table the fleet owns. Nothing else on the host writes to it. */
export const TABLE = 'inet fleet';

/**
 * Where guests may never send a packet: this-network, private and shared ranges (the VPC, other
 * machines, other hosts), loopback, link-local (instance metadata at 169.254.169.254 and the VPC
 * resolver at 169.254.169.253), multicast and reserved. Guests get no IPv6 at all, which also
 * covers IPv6 metadata at fd00:ec2::254.
 */
const BLOCKED_V4 = ['0.0.0.0/8', '10.0.0.0/8', '100.64.0.0/10', '127.0.0.0/8', '169.254.0.0/16', '172.16.0.0/12', '192.168.0.0/16', '224.0.0.0/4', '240.0.0.0/4'];

/**
 * New outbound flows a machine may open each second. Each one is logged; a flow over the budget is
 * dropped, so no flow leaves the host without a log line.
 */
const FLOW_BUDGET = '100/second burst 500 packets';
/** The first packet of a connection: its conntrack entry is not confirmed yet. Later packets of a flow
 * that has seen no reply are still `ct state new`, so matching on state alone would log each one. */
const FIRST_PACKET = 'ct status & confirmed == 0';
/** Every flow log line starts with this, then the machine id. */
const FLOW_LOG_PREFIX = 'fleet-flow';

const taps = `"${TAP_PREFIX}*"`;

/**
 * The host's ruleset, applied as one `nft -f` transaction that replaces the whole table. It only
 * matches packets that enter or leave a machine's tap, so the host's own traffic is untouched.
 */
export function renderHostRules({ uplink, subnet }: { uplink: string; subnet: string }): string {
  return `table ${TABLE} {}
delete table ${TABLE}
table ${TABLE} {
  # tap name -> jump to that machine's chain (flow budget, flow log, egress counter, accept).
  map machines {
    type ifname : verdict
  }

  set blocked_v4 {
    type ipv4_addr
    flags interval
    elements = { ${BLOCKED_V4.join(', ')} }
  }

  chain guard {
    type filter hook prerouting priority raw; policy accept;
    # A guest may only use its own address: the source must route back out of the tap it came in on.
    iifname ${taps} fib saddr . iif oif missing drop
  }

  chain dns_redirect {
    type nat hook prerouting priority dstnat; policy accept;
    # Every plain DNS query, to any server, is answered by the filtering resolver on the guest's gateway.
    iifname ${taps} meta nfproto ipv4 meta l4proto { tcp, udp } th dport 53 redirect
  }

  chain guest_to_host {
    type filter hook input priority filter; policy accept;
    iifname ${taps} meta nfproto ipv4 meta l4proto { tcp, udp } th dport 53 accept
    iifname ${taps} goto refuse
  }

  chain forward {
    type filter hook forward priority filter; policy accept;
    iifname ${taps} jump guest_out
    oifname ${taps} ct state established,related accept
    oifname ${taps} drop
  }

  chain guest_out {
    meta nfproto ipv6 drop
    # Every packet that leaves belongs to a tracked connection, so it is logged when the flow starts.
    ct state invalid drop
    # Out of the uplink only: no packet from one machine reaches another machine's tap.
    oifname != "${uplink}" goto refuse
    ip daddr @blocked_v4 goto refuse
    tcp dport 25 goto refuse
    # DNS over TLS would bypass the resolver. DNS over HTTPS on 443 cannot be told apart from HTTPS.
    meta l4proto { tcp, udp } th dport 853 goto refuse
    iifname vmap @machines
    drop
  }

  chain refuse {
    meta l4proto tcp reject with tcp reset
    reject with icmpx admin-prohibited
  }

  chain nat_out {
    type nat hook postrouting priority srcnat; policy accept;
    oifname "${uplink}" ip saddr ${subnet} masquerade
  }
}
`;
}

/** Adds one machine: its flow budget, flow log and egress counter, keyed by its tap. Safe to run twice. */
export function renderAttach(machineId: string, tapName: string): string {
  const chain = machineChain(machineId);
  const counter = egressCounter(machineId);
  return `destroy element ${TABLE} machines { "${tapName}" }
add counter ${TABLE} ${counter}
add chain ${TABLE} ${chain}
flush chain ${TABLE} ${chain}
add rule ${TABLE} ${chain} ${FIRST_PACKET} limit rate over ${FLOW_BUDGET} drop
add rule ${TABLE} ${chain} ${FIRST_PACKET} log prefix "${FLOW_LOG_PREFIX} ${machineId} " level info
add rule ${TABLE} ${chain} counter name ${counter}
add rule ${TABLE} ${chain} accept
add element ${TABLE} machines { "${tapName}" : jump ${chain} }
`;
}

/** Removes one machine's rules and counter. Safe to run when they are already gone. */
export function renderDetach(machineId: string, tapName: string | null): string {
  const chain = machineChain(machineId);
  return `${tapName ? `destroy element ${TABLE} machines { "${tapName}" }\n` : ''}add chain ${TABLE} ${chain}
flush chain ${TABLE} ${chain}
delete chain ${TABLE} ${chain}
destroy counter ${TABLE} ${egressCounter(machineId)}
`;
}

export function machineChain(machineId: string): string {
  return `m_${machineId}`;
}

export function egressCounter(machineId: string): string {
  return `egress_${machineId}`;
}
