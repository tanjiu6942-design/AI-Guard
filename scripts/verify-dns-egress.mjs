// Opt-in live diagnostic. Uses saved credentials without printing them, no TUN,
// no DNS adapter changes, and removes its temporary configuration on exit.
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:net';
import { createSocket } from 'node:dgram';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { loadSettings } from '../dist/core/settings.js';
import { buildConfig } from '../dist/core/config/builder.js';
import { loadRuleSets } from '../dist/core/domain/rule-source.js';
import { configToYaml, ensureGeodata } from '../dist/core/runtime/mihomo.js';

async function freePort() {
  const server = createServer();
  await new Promise((r, j) => { server.once('error', j); server.listen(0, '127.0.0.1', r); });
  const port = server.address().port;
  await new Promise(r => server.close(r));
  return port;
}

function query(port, hostname) {
  return new Promise((resolveQuery, reject) => {
    const socket = createSocket('udp4');
    const id = randomBytes(2);
    const name = Buffer.concat(hostname.split('.').map(s => Buffer.concat([Buffer.from([s.length]), Buffer.from(s)])));
    const packet = Buffer.concat([id, Buffer.from('01000001000000000000', 'hex'), name, Buffer.from([0, 0, 16, 0, 1])]);
    const timer = setTimeout(() => finish(Error('DNS query timed out')), 12000);
    function finish(error, result) { clearTimeout(timer); socket.close(); error ? reject(error) : resolveQuery(result); }
    socket.once('error', finish);
    socket.once('message', data => {
      try {
        if (!data.subarray(0, 2).equals(id) || (data[3] & 15)) throw Error('DNS returned an error');
        let offset = 12;
        function skipName() {
          while (data[offset]) {
            if ((data[offset] & 192) === 192) { offset += 2; return; }
            offset += data[offset] + 1;
          }
          offset++;
        }
        for (let i = 0; i < data.readUInt16BE(4); i++) { skipName(); offset += 4; }
        const answers = [];
        for (let i = 0; i < data.readUInt16BE(6); i++) {
          skipName();
          const type = data.readUInt16BE(offset), size = data.readUInt16BE(offset + 8);
          offset += 10;
          const end = offset + size, fields = [];
          if (type === 16) while (offset < end) { const n = data[offset++]; fields.push(data.subarray(offset, offset + n).toString()); offset += n; }
          if (fields.length) answers.push(fields);
          offset = end;
        }
        finish(null, answers);
      } catch (e) { finish(e); }
    });
    socket.send(packet, port, '127.0.0.1');
  });
}

const root = resolve(import.meta.dirname, '..');
const settings = loadSettings(join(process.env.APPDATA, 'aiguard', 'settings.json'));
if (!settings.airportUrl || !settings.residential.password) throw Error('Saved connection settings are incomplete');
const directory = mkdtempSync(join(tmpdir(), 'aiguard-dns-egress-'));
let child;
try {
  const kernel = join(root, 'vendor', 'mihomo', 'mihomo.exe');
  ensureGeodata(directory, kernel);
  const [mixedPort, controllerPort, dnsPort] = await Promise.all([freePort(), freePort(), freePort()]);
  const config = buildConfig({ ...settings, tunEnabled: false, mixedPort, controllerPort,
    secret: randomBytes(24).toString('hex'), sets: loadRuleSets(join(root, 'rules', 'domains')) });
  for (const provider of Object.values(config['proxy-providers'])) for (const node of provider.payload || []) {
    for (const key of ['server', 'username', 'password']) if (typeof node[key] === 'string') node[key] = JSON.stringify(node[key]);
  }
  config['proxy-providers']['airport-sub'].url = JSON.stringify(settings.airportUrl);
  const file = join(directory, 'probe.yaml');
  writeFileSync(file, configToYaml(config).replace('\ndns:\n', `\ndns:\n  listen: 127.0.0.1:${dnsPort}\n`));
  child = spawn(kernel, ['-d', directory, '-f', file], { windowsHide: true, stdio: 'ignore' });
  let spawnError;
  child.on('error', e => { spawnError = e; });
  let answers, lastError;
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    if (spawnError || child.exitCode !== null) throw Error('Isolated DNS core could not start');
    await new Promise(r => setTimeout(r, 1000));
    try { answers = await query(dnsPort, 'whoami.ds.akahelp.net'); if (answers.some(x => x[0] === 'ns')) break; }
    catch (e) { lastError = e; }
  }
  if (!answers?.some(x => x[0] === 'ns')) throw lastError || Error('No resolver identity received');
  console.log(JSON.stringify({ ok: true, method: 'Akamai authoritative TXT resolver observation', answers }, null, 2));
  if (process.argv.includes('--timezone')) {
    const { lookupExitTimezone } = await import('../desktop/timezone.mjs');
    const { proxyFetch } = await import('../desktop/network.mjs');
    const { probeTraceIp } = await import('../dist/core/doctor/ai-route.js');
    const fetchFn = url => proxyFetch(mixedPort, url, 20000);
    const ip = await probeTraceIp(fetchFn, 'https://cloudflare-dns.com/cdn-cgi/trace');
    if (!ip) throw Error('Residential exit cannot be verified');
    console.log(JSON.stringify({ timezone: await lookupExitTimezone({ fetchFn, expectedIp: ip }), systemTimezoneChanged: false }, null, 2));
  }
} finally {
  if (child && child.exitCode === null) {
    const ended = new Promise(r => child.once('close', r));
    child.kill();
    await ended;
  }
  rmSync(directory, { recursive: true, force: true });
}
