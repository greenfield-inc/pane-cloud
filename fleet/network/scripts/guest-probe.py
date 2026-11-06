#!/usr/bin/env python3
"""Journey 7 from inside a real guest (network.kvm.test.ts). Reads its role from /proc/cmdline and
prints one `PANE_PROBE <name> <result>` line per check on the serial console, then PANE_PROBE_DONE.
Outside a VM, set PANE_PROBE_ARGS to the same key=value words and it prints to stdout instead.

  pane_probe=listen   listens on TCP 7000 and reports whether it reaches itself
  pane_probe=client   pane_peer=<ip> runs the isolation checks against the peer and the outside
"""
import os, random, socket, struct, time

def say(line):
    with open("/dev/stdout" if "PANE_PROBE_ARGS" in os.environ else "/dev/ttyS0", "w") as out:
        out.write(line + "\n")

def tcp(host, port):
    try:
        with socket.create_connection((host, port), timeout=3):
            return "open"
    except ConnectionRefusedError:
        return "refused"
    except socket.timeout:
        return "timeout"
    except OSError as e:
        return "error-%s" % e.errno

def dns(server, name, tcp_mode=False):
    """Returns 'A <ip>', 'NXDOMAIN', 'rcode-<n>' or 'timeout'."""
    qid = random.randint(0, 65535)
    q = struct.pack(">HHHHHH", qid, 0x0100, 1, 0, 0, 0)
    q += b"".join(bytes([len(p)]) + p.encode() for p in name.split(".")) + b"\0" + struct.pack(">HH", 1, 1)
    try:
        if tcp_mode:
            with socket.create_connection((server, 53), timeout=3) as s:
                s.sendall(struct.pack(">H", len(q)) + q)
                r = s.recv(4096)[2:]
        else:
            s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            s.settimeout(3)
            s.sendto(q, (server, 53))
            r = s.recv(4096)
    except (socket.timeout, OSError):
        return "timeout"
    rcode = r[3] & 0xF
    if rcode == 3:
        return "NXDOMAIN"
    if rcode != 0:
        return "rcode-%d" % rcode
    i = r.index(b"\xc0\x0c")  # first answer, name compressed to the question
    while i < len(r):
        rtype, _, _, rdlen = struct.unpack(">HHIH", r[i + 2 : i + 12])
        if rtype == 1:
            return "A " + ".".join(str(b) for b in r[i + 12 : i + 16])
        i += 12 + rdlen
    return "noanswer"

def stun(host):
    """A STUN binding request on UDP 3478, the port Tailscale uses for STUN."""
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    s.settimeout(3)
    try:
        s.sendto(struct.pack(">HHI", 1, 0, 0x2112A442) + os.urandom(12), (host, 3478))
        return "open" if s.recv(2048)[:2] == b"\x01\x01" else "bad-reply"
    except (socket.timeout, OSError):
        return "timeout"

words = os.environ.get("PANE_PROBE_ARGS") or open("/proc/cmdline").read()
def send_bulk(host, datagrams=1000, size=1000):
    """Sends a known volume over UDP and returns the IP bytes sent (payload plus 28 bytes of headers)."""
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sent = 0
    for _ in range(datagrams):
        sent += s.sendto(b"\0" * size, (host, 9)) + 28
    return sent

args = dict(a.split("=", 1) for a in words.split() if "=" in a)
role = args.get("pane_probe")
time.sleep(2)
if role == "listen":
    server = socket.socket()
    server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    server.bind(("0.0.0.0", 7000))
    server.listen()
    ip = args["ip"].split(":")[0]
    say("PANE_PROBE self %s" % tcp(ip, 7000))
    say("PANE_PROBE_DONE")
    while True:
        server.accept()[0].close()
elif role == "client":
    peer = args["pane_peer"]
    resolve = lambda name: dns("8.8.8.8", name).split(" ")[-1]
    say("PANE_PROBE peer %s" % tcp(peer, 7000))
    say("PANE_PROBE metadata %s" % tcp("169.254.169.254", 80))
    say("PANE_PROBE smtp %s" % tcp("1.1.1.1", 25))
    say("PANE_PROBE dot %s" % tcp("1.1.1.1", 853))
    say("PANE_PROBE https %s" % tcp("1.1.1.1", 443))
    say("PANE_PROBE dns-redirect %s" % dns("8.8.8.8", "pane-redirect.test"))
    say("PANE_PROBE dns-redirect-tcp %s" % dns("8.8.8.8", "pane-redirect.test", tcp_mode=True))
    say("PANE_PROBE dns-blocked %s" % dns("8.8.8.8", "pool.supportxmr.com"))
    say("PANE_PROBE tailscale-control %s" % tcp(resolve("controlplane.tailscale.com"), 443))
    say("PANE_PROBE tailscale-derp %s" % tcp(resolve("derp1.tailscale.com"), 443))
    # DERP servers answer only Tailscale's own STUN requests, so this uses a public STUN server on the same port.
    say("PANE_PROBE stun %s" % stun(resolve("stun.cloudflare.com")))
    # 192.0.2.1 (TEST-NET-1) is never routed on the internet, so this only crosses the host's uplink.
    say("PANE_PROBE egress-sent %d" % send_bulk("192.0.2.1"))
    say("PANE_PROBE_DONE")
