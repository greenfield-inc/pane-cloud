// Network probe for the Linux tests, run inside a network namespace that stands in for a guest.
//   node probe.mjs serve <tcpPort,...> <udpPort,...>   TCP: replies "hello <peer>" and swallows input; UDP: echoes
//   node probe.mjs tcp <host> <port> [sendBytes] [localAddress]   prints {"result":"open"|"refused"|"timeout"|<code>,"reply"}
//   node probe.mjs udp <host> <port>                    prints {"result":"open"|"timeout","reply"}
import dgram from 'node:dgram';
import net from 'node:net';

const [mode, ...args] = process.argv.slice(2);
const done = (out) => {
  console.log(JSON.stringify(out));
  process.exit(0);
};

if (mode === 'serve') {
  const [tcp = '', udp = ''] = args;
  for (const port of tcp.split(',').filter(Boolean)) {
    net.createServer((s) => {
      s.on('error', () => undefined);
      s.end(`hello ${s.remoteAddress}\n`);
      s.resume();
    }).listen(Number(port), '0.0.0.0');
  }
  for (const port of udp.split(',').filter(Boolean)) {
    const sock = dgram.createSocket('udp4');
    sock.on('message', (msg, peer) => sock.send(`echo ${peer.address} ${msg}`, peer.port, peer.address));
    sock.bind(Number(port), '0.0.0.0');
  }
  console.log('ready');
} else if (mode === 'tcp') {
  const [host, port, send = '0', localAddress] = args;
  const sock = net.connect({ host, port: Number(port), ...(localAddress ? { localAddress } : {}) });
  const timer = setTimeout(() => done({ result: 'timeout' }), 3000);
  let reply = '';
  sock.on('data', (d) => (reply += d));
  sock.on('connect', () => {
    sock.end(Buffer.alloc(Number(send)));
  });
  sock.on('close', () => {
    clearTimeout(timer);
    if (reply) done({ result: 'open', reply: reply.trim() });
  });
  sock.on('error', (e) => {
    clearTimeout(timer);
    done({ result: e.code === 'ECONNREFUSED' || e.code === 'ECONNRESET' ? 'refused' : e.code });
  });
} else if (mode === 'udp') {
  const [host, port] = args;
  const sock = dgram.createSocket('udp4');
  setTimeout(() => done({ result: 'timeout' }), 3000);
  sock.on('message', (msg) => done({ result: 'open', reply: String(msg) }));
  sock.on('error', (e) => done({ result: e.code }));
  sock.send('ping', Number(port), host);
} else {
  console.error('usage: probe.mjs serve|tcp|udp ...');
  process.exit(2);
}
