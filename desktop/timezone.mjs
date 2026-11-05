import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync } from 'node:fs';
import { mkdir, open, readFile, unlink, writeFile, rename } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { BlockList, isIP } from 'node:net';

const exec = promisify(execFile);
const cldr = JSON.parse(readFileSync(new URL('./timezone-data/windows-zones.json', import.meta.url), 'utf8'));
const exactZones = new Map();
const canonicalZones = new Map();
function canonicalZone(value) {
  return new Intl.DateTimeFormat('en', { timeZone: value }).resolvedOptions().timeZone;
}
// CLDR territory 001 supplies the global representative. Exact names take
// precedence over Intl aliases; remaining alias collisions use CLDR row order.
for (const row of [...cldr.zones].sort((a, b) => Number(b.territory === '001') - Number(a.territory === '001'))) {
  for (const name of row.iana) {
    if (!exactZones.has(name)) exactZones.set(name, row.windowsId);
    try {
      const canonical = canonicalZone(name);
      if (!canonicalZones.has(canonical)) canonicalZones.set(canonical, row.windowsId);
    } catch { /* Older ICU may not know newer CLDR names; exact mapping survives. */ }
  }
}

export function ianaToWindows(iana) {
  if (typeof iana !== 'string' || !iana || iana.length > 120 || !/^[A-Za-z0-9_+./-]+$/.test(iana)) {
    throw new Error('Invalid IANA timezone');
  }
  let result = exactZones.get(iana);
  if (!result) {
    try { result = canonicalZones.get(canonicalZone(iana)); } catch {}
  }
  if (!result) throw new Error(`No CLDR Windows timezone mapping for ${iana}`);
  return result;
}

const blocked = new BlockList();
for (const [address, prefix] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.168.0.0', 16],
  ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4]]) blocked.addSubnet(address, prefix, 'ipv4');
const globalV6 = new BlockList(); globalV6.addSubnet('2000::', 3, 'ipv6');
for (const [address, prefix] of [['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['3fff::', 20]]) blocked.addSubnet(address, prefix, 'ipv6');
function publicIp(value) {
  const version = typeof value === 'string' && !value.includes('%') ? isIP(value) : 0;
  if (!version || (version === 4 ? blocked.check(value, 'ipv4') : !globalV6.check(value, 'ipv6') || blocked.check(value, 'ipv6'))) {
    throw new Error('Exit lookup requires a valid public IP address');
  }
  return version === 6 ? new URL(`https://[${value}]/`).hostname : value;
}

/** fetchFn must use the existing residential proxy transport. Never fall back to global fetch. */
export async function lookupExitTimezone({ fetchFn, expectedIp } = {}) {
  if (typeof fetchFn !== 'function') throw new Error('Proxy fetchFn is required for exit timezone lookup');
  const expected = expectedIp == null ? null : publicIp(expectedIp);
  let response;
  try {
    response = await fetchFn('https://ipwho.is/', {
      method: 'GET', redirect: 'error', credentials: 'omit', signal: AbortSignal.timeout(15000),
    });
  } catch (error) {
    throw new Error(`Exit timezone HTTPS lookup failed: ${error.message}`, { cause: error });
  }
  if (!response?.ok) throw new Error(`Exit timezone lookup HTTP ${response?.status ?? 'invalid response'}${response?.status === 429 ? ' (rate limit)' : ''}`);
  let payload;
  try { payload = await response.json(); } catch (error) { throw new Error('Exit timezone lookup returned invalid JSON', { cause: error }); }
  if (!payload || payload.success !== true) throw new Error(`Exit timezone lookup rejected: ${String(payload?.message || 'success was not true').slice(0, 200)}`);
  const actual = publicIp(payload.ip);
  if (expected !== null && expected !== actual) throw new Error('Exit timezone lookup IP does not match expected proxy exit IP');
  const iana = payload.timezone?.id;
  return { ip: payload.ip, iana, windowsId: ianaToWindows(iana), source: 'ipwho.is' };
}

const LIST = "$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false); @(Get-TimeZone -ListAvailable | Select-Object Id,DisplayName) | ConvertTo-Json -Compress";
const AUTOMATIC = "$ErrorActionPreference='Stop'; (Get-ItemProperty -LiteralPath 'HKLM:\\SYSTEM\\CurrentControlSet\\Services\\tzautoupdate' -Name Start).Start";
// Serialize by backup path, including separate manager instances in this process.
const queues = new Map();
export class TimezoneManager {
  constructor({ dataDir, run = exec }) {
    if (typeof dataDir !== 'string' || !isAbsolute(dataDir)) throw new Error('Timezone backup requires an absolute dataDir');
    if (typeof run !== 'function') throw new Error('Timezone run must be a function');
    this.dataDir = dataDir;
    this.backupPath = join(dataDir, 'timezone-backup.json');
    this.run = run;
    const systemRoot = process.env.SystemRoot || 'C:\\Windows';
    this.tzutil = join(systemRoot, 'System32', 'tzutil.exe');
    this.powershell = join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  }

  enqueue(operation) {
    const previous = queues.get(this.backupPath) || Promise.resolve();
    const next = previous.catch(() => {}).then(operation);
    queues.set(this.backupPath, next);
    next.finally(() => { if (queues.get(this.backupPath) === next) queues.delete(this.backupPath); }).catch(() => {});
    return next;
  }

  async command(file, args) {
    try {
      const result = await this.run(file, args, { windowsHide: true, shell: false, encoding: 'utf8', timeout: 15000, maxBuffer: 1024 * 1024 });
      if (result?.code != null && result.code !== 0) throw Object.assign(new Error(result.stderr || `exit ${result.code}`), { code: result.code });
      const output = typeof result === 'string' ? result : result?.stdout;
      if (typeof output !== 'string') throw new Error('Windows timezone command returned no stdout output');
      return output.replace(/^\uFEFF/, '').trim();
    } catch (error) {
      if (error.code === 'EACCES' || error.code === 'EPERM' || error.code === 5 || /access.*denied|privilege|权限|拒绝访问|特权/i.test(`${error.message} ${error.stderr || ''}`)) {
        throw new Error('修改或读取系统时区权限不足 (SeTimeZonePrivilege)；请使用已有管理员 worker 通道。', { cause: error });
      }
      throw new Error(`Windows timezone command failed: ${error.message}`, { cause: error });
    }
  }

  async backup() {
    let text;
    try { text = await readFile(this.backupPath, 'utf8'); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    try {
      const value = JSON.parse(text);
      if (value.version !== 1 || typeof value.original !== 'string' || !value.original || value.original.length > 200) throw new Error('invalid original');
      if (value.automaticStart !== undefined && ![2, 3, 4].includes(value.automaticStart)) throw new Error('invalid automatic timezone backup');
      return value.original;
    } catch (error) { throw new Error('Timezone backup is invalid; refusing to overwrite recovery data', { cause: error }); }
  }

  async snapshot() {
    const current = await this.command(this.tzutil, ['/g']);
    if (!current || /[\r\n\0]/.test(current)) throw new Error('Invalid current Windows timezone');
    let zones;
    try {
      const result = JSON.parse(await this.command(this.powershell, ['-NoProfile', '-NonInteractive', '-Command', LIST]));
      const entries = Array.isArray(result) ? result : [result];
      if (!entries.length || entries.some(z => typeof z?.Id !== 'string' || !z.Id || typeof z.DisplayName !== 'string' || /[\r\n\0]/.test(z.Id))) throw new Error('invalid zone list');
      zones = entries.map(z => ({ id: z.Id, displayName: z.DisplayName }));
    } catch (error) { throw new Error('Cannot read Windows timezone list', { cause: error }); }
    const start = await this.command(this.powershell, ['-NoProfile', '-NonInteractive', '-Command', AUTOMATIC]);
    if (!/^[0-4]$/.test(start)) throw new Error('Cannot read Windows automatic timezone setting');
    this.automaticStart = Number(start);
    return { current, original: await this.backup(), zones, automatic: start !== '4' };
  }

  status() { return this.enqueue(() => this.snapshot()); }

  async change(id, zones) {
    if (typeof id !== 'string' || !zones.some(z => z.id === id)) throw new Error('Invalid or unavailable Windows timezone');
    await this.command(this.tzutil, ['/s', id]);
    const actual = await this.command(this.tzutil, ['/g']);
    if (actual !== id) throw new Error(`Cannot verify timezone change: expected ${id}, found ${actual}`);
  }

  async automatic(start) {
    const types = { 2: 'Automatic', 3: 'Manual', 4: 'Disabled' };
    if (!types[start]) throw Error('Unsupported automatic timezone setting');
    const script = "$ErrorActionPreference='Stop'; Set-Service -Name tzautoupdate -StartupType " + types[start]
      + (start === 4 ? "; Stop-Service -Name tzautoupdate -ErrorAction Stop" : '');
    await this.command(this.powershell, ['-NoProfile', '-NonInteractive', '-Command', script]);
    const actual = await this.command(this.powershell, ['-NoProfile', '-NonInteractive', '-Command', AUTOMATIC]);
    if (actual !== String(start)) throw Error('无法确认 Windows 自动时区设置，恢复记录已保留');
  }

  set(id) {
    return this.enqueue(async () => {
      const state = await this.snapshot();
      if (typeof id !== 'string' || !state.zones.some(z => z.id === id)) throw new Error('Invalid or unavailable Windows timezone');
      if (state.current === id && !state.automatic) return state;
      if (state.original === null) {
        // Only restore IDs accepted by the system list. /g may have _dstoff;
        // refuse that unsupported mode rather than silently lose its DST choice.
        if (!state.zones.some(z => z.id === state.current)) throw new Error('Current timezone cannot be safely backed up for restore');
        await mkdir(this.dataDir, { recursive: true });
        const handle = await open(this.backupPath, 'wx', 0o600);
        try { await handle.writeFile(JSON.stringify({ version: 1, original: state.current }) + '\n'); await handle.sync(); }
        finally { await handle.close(); }
      }
      const record = JSON.parse(await readFile(this.backupPath, 'utf8'));
      if (record.automaticStart === undefined) {
        record.automaticStart = this.automaticStart;
        if (![2, 3, 4].includes(record.automaticStart)) throw Error('Unsupported automatic timezone setting');
        await writeFile(this.backupPath + '.tmp', JSON.stringify(record) + '\n');
        await rename(this.backupPath + '.tmp', this.backupPath);
      }
      if (state.automatic) await this.automatic(4);
      await this.change(id, state.zones);
      const applied = await this.snapshot();
      if (applied.automatic || applied.current !== id) throw Error('系统时区被其他设置覆盖，恢复记录已保留');
      return applied;
    });
  }

  restore() {
    return this.enqueue(async () => {
      const state = await this.snapshot();
      if (state.original === null) return state;
      const record = JSON.parse(await readFile(this.backupPath, 'utf8'));
      await this.change(state.original, state.zones);
      if (record.automaticStart !== undefined) await this.automatic(record.automaticStart);
      // Read the complete result before removing the only recovery record.
      const restored = await this.snapshot();
      if (restored.current !== state.original) throw new Error('Cannot verify timezone restore');
      await unlink(this.backupPath);
      return { ...restored, original: null };
    });
  }
}
