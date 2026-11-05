import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TimezoneManager, ianaToWindows, lookupExitTimezone } from '../desktop/timezone.mjs';

const dirs = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(d => rm(d, { recursive: true, force: true }))); });
async function fixture() {
  const dataDir = await mkdtemp(join(tmpdir(), 'aiguard-tz-')); dirs.push(dataDir);
  const system = { current: 'China Standard Time', automatic: false, deny: false, ignore: false, calls: [] };
  const zones = ['China Standard Time', 'Pacific Standard Time', 'UTC'].map(id => ({ Id: id, DisplayName: id }));
  const run = async (file, args, options) => {
    expect(options.windowsHide).toBe(true); expect(options.shell).toBe(false);
    system.calls.push([file, args]);
    if (file.endsWith('powershell.exe')) {
      if (args.at(-1).includes('ListAvailable')) return { stdout: JSON.stringify(zones) };
      if (args.at(-1).includes('Set-Service')) { if (system.deny) throw Object.assign(new Error('Access denied'), { code: 5 }); system.automatic = !args.at(-1).includes('Disabled'); return { stdout: '' }; }
      if (args.at(-1).includes('tzautoupdate')) return { stdout: system.automatic ? '3' : '4' };
    }
    if (file.endsWith('tzutil.exe') && args[0] === '/g') return { stdout: system.current };
    if (file.endsWith('tzutil.exe') && args[0] === '/s') {
      if (system.deny) throw Object.assign(new Error('Access is denied'), { code: 5 });
      if (!system.ignore) system.current = args[1];
      return { stdout: '' };
    }
    throw new Error(`Unexpected command ${file} ${args}`);
  };
  return { dataDir, system, manager: new TimezoneManager({ dataDir, run }), run };
}

describe('TimezoneManager', () => {
  it('reads current Windows ID, installed zones and automatic setting without modifying anything', async () => {
    const { manager, system } = await fixture();
    expect(await manager.status()).toEqual({ current: 'China Standard Time', original: null,
      zones: ['China Standard Time', 'Pacific Standard Time', 'UTC'].map(id => ({ id, displayName: id })), automatic: false });
    system.automatic = true; expect((await manager.status()).automatic).toBe(true);
    expect(system.calls.some(([, args]) => args[0] === '/s')).toBe(false);
  });
  it('disables automatic timezone even when the target is already current, and restores its previous setting', async () => {
    const { manager, system, dataDir } = await fixture();
    system.automatic = true;
    expect((await manager.set('China Standard Time')).automatic).toBe(false);
    expect(JSON.parse(await readFile(join(dataDir, 'timezone-backup.json'), 'utf8')).automaticStart).toBe(3);
    await manager.set('UTC');
    const result = await manager.restore();
    expect(result.current).toBe('China Standard Time');
    expect(result.automatic).toBe(true);
  });
  it('does not change the timezone when disabling automatic mode is denied', async () => {
    const { manager, system, dataDir } = await fixture();
    system.automatic = true;
    system.deny = true;
    await expect(manager.set('UTC')).rejects.toThrow(/权限|privilege/i);
    expect(system.current).toBe('China Standard Time');
    expect(JSON.parse(await readFile(join(dataDir, 'timezone-backup.json'), 'utf8')).automaticStart).toBe(3);
  });
  it('persists first original across changes/restarts and removes it only after verified restore', async () => {
    const { manager, dataDir, run } = await fixture();
    expect((await manager.set('Pacific Standard Time')).original).toBe('China Standard Time');
    await manager.set('UTC');
    const restarted = new TimezoneManager({ dataDir, run });
    expect((await restarted.status()).original).toBe('China Standard Time');
    expect(await restarted.restore()).toMatchObject({ current: 'China Standard Time', original: null });
    await expect(readFile(join(dataDir, 'timezone-backup.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('rejects values outside the system list before writing a backup or modifying the OS', async () => {
    const { manager, dataDir, system } = await fixture();
    for (const id of ['UTC & calc.exe', 'UTC_dstoff', '', null]) await expect(manager.set(id)).rejects.toThrow(/时区|zone/i);
    expect(system.current).toBe('China Standard Time');
    await expect(readFile(join(dataDir, 'timezone-backup.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('retains original on permission denial and restore verification failure, and recovers queue', async () => {
    const { manager, system } = await fixture();
    system.deny = true;
    await expect(manager.set('UTC')).rejects.toThrow(/权限|privilege|permission/i);
    system.deny = false; await manager.set('UTC'); system.ignore = true;
    await expect(manager.restore()).rejects.toThrow(/验证|verify/i);
    expect((await manager.status()).original).toBe('China Standard Time');
    system.ignore = false; expect((await manager.restore()).original).toBe(null);
  });
  it('serializes concurrent changes and preserves a single original', async () => {
    const { manager } = await fixture();
    const states = await Promise.all([manager.set('UTC'), manager.set('Pacific Standard Time'), manager.restore()]);
    expect(states.map(s => s.current)).toEqual(['UTC', 'Pacific Standard Time', 'China Standard Time']);
  });
  it('does not overwrite malformed recovery data', async () => {
    const { manager, dataDir } = await fixture();
    await writeFile(join(dataDir, 'timezone-backup.json'), '{broken');
    await expect(manager.set('UTC')).rejects.toThrow(/备份|backup/i);
    expect(await readFile(join(dataDir, 'timezone-backup.json'), 'utf8')).toBe('{broken');
  });
  it('rejects a command transport with missing stdout instead of reporting an invented current zone', async () => {
    const { dataDir, run } = await fixture();
    const manager = new TimezoneManager({ dataDir, run: async (file, args, options) => args[0] === '/g' ? {} : run(file, args, options) });
    await expect(manager.status()).rejects.toThrow(/output|stdout/i);
  });
  it('does not create recovery data when selecting the current timezone', async () => {
    const { manager, dataDir, system } = await fixture();
    expect((await manager.set('China Standard Time')).original).toBe(null);
    expect(system.calls.some(([, args]) => args[0] === '/s')).toBe(false);
    await expect(readFile(join(dataDir, 'timezone-backup.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('serializes managers sharing the same backup file', async () => {
    const { manager, dataDir, run } = await fixture();
    const other = new TimezoneManager({ dataDir, run });
    const results = await Promise.all([manager.set('UTC'), other.set('Pacific Standard Time'), manager.restore()]);
    expect(results.map(s => s.current)).toEqual(['UTC', 'Pacific Standard Time', 'China Standard Time']);
  });
});

describe('exit timezone lookup', () => {
  const response = (overrides = {}) => new Response(JSON.stringify({ success: true, ip: '8.8.8.8', timezone: { id: 'America/Los_Angeles' }, ...overrides }));
  it('maps CLDR primary, territory zones and modern IANA aliases', () => {
    for (const [iana, id] of [['Asia/Shanghai', 'China Standard Time'], ['America/Los_Angeles', 'Pacific Standard Time'],
      ['America/Detroit', 'Eastern Standard Time'], ['Asia/Kolkata', 'India Standard Time'], ['Asia/Kathmandu', 'Nepal Standard Time'],
      ['Etc/UTC', 'UTC'], ['Europe/Kyiv', 'FLE Standard Time']]) expect(ianaToWindows(iana)).toBe(id);
    expect(() => ianaToWindows('Fake/Timezone')).toThrow();
  });
  it('queries HTTPS only through injected proxy fetch and checks exit IP', async () => {
    const calls = [];
    const result = await lookupExitTimezone({ expectedIp: '8.8.8.8', fetchFn: async (...args) => { calls.push(args); return response(); } });
    expect(result).toEqual({ ip: '8.8.8.8', iana: 'America/Los_Angeles', windowsId: 'Pacific Standard Time', source: 'ipwho.is' });
    expect(calls[0][0]).toBe('https://ipwho.is/');
    expect(calls[0][1]).toMatchObject({ redirect: 'error', credentials: 'omit' });
    await expect(lookupExitTimezone({ expectedIp: '1.1.1.1', fetchFn: async () => response() })).rejects.toThrow(/IP/);
  });
  it('accepts equivalent public IPv6 spellings', async () => {
    expect(await lookupExitTimezone({ expectedIp: '2001:4860:4860:0:0:0:0:8888', fetchFn: async () => response({ ip: '2001:4860:4860::8888' }) })).toMatchObject({ ip: '2001:4860:4860::8888' });
  });
  it.each(['127.0.0.1', '10.1.2.3', '100.64.0.1', '192.0.2.1', '224.0.0.1', '::1', 'fc00::1', 'fe80::1', '2001:db8::1', '::ffff:127.0.0.1', '8.8.8.8:443', 'bad'])('rejects non-public IP %s', async ip => {
    await expect(lookupExitTimezone({ fetchFn: async () => response({ ip }) })).rejects.toThrow(/IP/);
  });
  it('fails clearly on TLS, rate limits, API rejection, invalid JSON and absent/invalid zones', async () => {
    await expect(lookupExitTimezone({})).rejects.toThrow(/fetch/i);
    await expect(lookupExitTimezone({ fetchFn: async () => { throw new Error('TLS certificate expired'); } })).rejects.toThrow(/TLS certificate expired/);
    await expect(lookupExitTimezone({ fetchFn: async () => new Response('', { status: 429 }) })).rejects.toThrow(/429/);
    await expect(lookupExitTimezone({ fetchFn: async () => new Response('oops') })).rejects.toThrow(/JSON/);
    for (const payload of [{ success: false, message: 'Reserved range' }, { timezone: null }, { timezone: { id: 'Bad/Timezone' } }]) {
      await expect(lookupExitTimezone({ fetchFn: async () => response(payload) })).rejects.toThrow();
    }
  });
});
