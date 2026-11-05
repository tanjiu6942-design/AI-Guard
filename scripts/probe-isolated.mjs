import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { loadSettings } from '../dist/core/settings.js';
import { buildConfig } from '../dist/core/config/builder.js';
import { loadRuleSets } from '../dist/core/domain/rule-source.js';
import { ensureGeodata } from '../dist/core/runtime/mihomo.js';
import { buildProtectedYaml } from '../desktop/protected-config.mjs';
import { proxyFetch } from '../desktop/network.mjs';
const delay = ms => new Promise(r => setTimeout(r, ms));
const free = () => new Promise(r => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
const dir = mkdtempSync(join(tmpdir(), 'aiguard-isolated-'));
let child;
try {
  const data = join(process.env.APPDATA, 'aiguard');
  const settings = loadSettings(join(data, 'settings.json'));
  const mixedPort = await free(), controllerPort = await free(), probePort = await free();
  const secret = randomBytes(24).toString('hex');
  const cfg = buildConfig({ ...settings, mixedPort, controllerPort, secret, tunEnabled: false, sets: loadRuleSets(resolve('rules/domains')) });
  if (process.env.AIGUARD_DIAG_INTERFACE) cfg['interface-name'] = process.env.AIGUARD_DIAG_INTERFACE;
  for (const p of Object.values(cfg['proxy-providers'])) for (const n of p.payload || [])
    for (const k of ['server', 'username', 'password']) if (typeof n[k] === 'string') n[k] = JSON.stringify(n[k]);
  cfg['proxy-providers']['airport-sub'].url = JSON.stringify(settings.airportUrl);
  mkdirSync(join(dir, 'proxies'));
  copyFileSync(join(data, 'mihomo/proxies/airport.yaml'), join(dir, 'proxies/airport.yaml'));
  const exe = resolve('vendor/mihomo/mihomo.exe');
  ensureGeodata(dir, exe);
  writeFileSync(join(dir, 'config.yaml'), buildProtectedYaml(cfg, { probePort, probeSecret: secret, businessBlocked: true, airportUrl: settings.airportUrl }));
  child = spawn(exe, ['-d', dir, '-f', join(dir, 'config.yaml')], { windowsHide: true, stdio: 'ignore' });
  const auth = 'Basic ' + Buffer.from(`aiguard-health:${secret}`).toString('base64');
  for (const wait of [1500, 10000]) {
    await delay(wait);
    try { const r = await proxyFetch(probePort, 'https://www.cloudflare.com/cdn-cgi/trace', 12000, auth); console.log(JSON.stringify({ status: r.status, hasIp: /^ip=/m.test(await r.text()) })); }
    catch(e) { console.log('probe: ' + e.message); }
    const r = await fetch(`http://127.0.0.1:${controllerPort}/proxies`, { headers: { Authorization: `Bearer ${secret}` } });
    const p = (await r.json()).proxies;
    console.log(JSON.stringify(Object.fromEntries(Object.entries(p).filter(([k]) => k.startsWith('AI Guard')).map(([k,v]) => [k,{type:v.type,now:v.now,count:v.all?.length}]))));
  }
} finally {
  if (child && child.exitCode === null) await new Promise(r => { child.once('exit', r); child.kill(); });
  if (!resolve(dir).startsWith(resolve(tmpdir()) + sep) || !dir.includes('aiguard-isolated-')) throw Error('Unsafe cleanup');
  rmSync(dir, { recursive: true, force: true });
}
