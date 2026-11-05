import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WindowsGuard } from '../desktop/firewall.mjs';

const dirs = [];
const fixture = fileURLToPath(new URL('./fixtures/guard-filter.mjs', import.meta.url));
async function setup(mode = '') {
  const dataDir = await mkdtemp(join(tmpdir(), 'aiguard-guard-'));
  dirs.push(dataDir);
  const file = join(dataDir, 'fixture.json');
  await writeFile(file, JSON.stringify({ mode, calls: [], rules: { foreign: ['keep'] } }));
  const guard = new WindowsGuard({ executable: [process.execPath, fixture], dataDir, timeout: 2000 });
  return { guard, file, read: async () => JSON.parse(await readFile(file, 'utf8')) };
}
afterEach(async () => { await Promise.all(dirs.splice(0).map(d => rm(d, { recursive: true, force: true }))); });

describe('WindowsGuard native protocol', () => {
  it('prepares a private runtime through the elevated helper', async () => {
    const { guard, read, file } = await setup();
    const kernel = join(tmpdir(), 'protected', 'mihomo.exe');
    expect(await guard.prepareRuntime(kernel)).toBe(join(file, '..', 'protected kernel', 'runtime-123'));
    expect((await read()).calls).toEqual([['prepare-runtime', '--kernel', kernel]]);
  });
  it('sends private YAML through stdin without exposing its contents in arguments', async () => {
    const { guard, read } = await setup();
    const directory = join(tmpdir(), 'protected runtime');
    const contents = 'secret: secret-value-123\nprofile: 中文\n';
    expect(await guard.writeConfig(directory, 'desktop-test.yaml', contents)).toBe(join(directory, 'desktop-test.yaml'));
    expect((await read()).config.contents).toBe(contents);
    expect((await read()).calls).toEqual([['write-config', '--runtime', directory, '--name', 'desktop-test.yaml']]);
  });
  it.each(['../escape.yaml', 'desktop-a.yaml:stream', 'other.yaml', 'desktop-../x.yaml'])('rejects unsafe private config name %s', async name => {
    const { guard, read } = await setup();
    await expect(guard.writeConfig(join(tmpdir(), 'runtime'), name, 'secret: 1')).rejects.toThrow(/name/i);
    expect((await read()).calls).toEqual([]);
  });
  it('reports private config permission failures even when stdin is supplied', async () => {
    const { guard } = await setup('error');
    await expect(guard.writeConfig(join(tmpdir(), 'runtime'), 'desktop-test.yaml', 'x'.repeat(200000))).rejects.toThrow('BFE access denied');
  });
  it('stages a protected kernel without unlocking existing filters', async () => {
    const { guard, read, file } = await setup();
    const source = join(tmpdir(), 'source kernel & harmless.exe');
    await guard.lock(source);
    const protectedPath = await guard.stageKernel(source);
    expect(protectedPath).toBe(join(file, '..', 'protected kernel', 'mihomo.exe'));
    expect((await read()).calls).toContainEqual(['stage-kernel', '--source', source]);
    expect(await guard.status()).toMatchObject({ locked: true });
  });
  it('rejects relative staging inputs without launching a privileged helper', async () => {
    const { guard, read } = await setup();
    await expect(guard.stageKernel('relative.exe')).rejects.toThrow(/absolute/i);
    expect((await read()).calls).toEqual([]);
  });
  it('rejects a staged result with a relative or missing kernel path', async () => {
    const { guard } = await setup('badStagedPath');
    await expect(guard.stageKernel(join(tmpdir(), 'mihomo.exe'))).rejects.toThrow(/path/i);
  });
  it('propagates staging elevation and filesystem errors', async () => {
    const { guard } = await setup('error');
    await expect(guard.stageKernel(join(tmpdir(), 'mihomo.exe'))).rejects.toThrow('BFE access denied');
  });
  it('reports actual helper state rather than remembering a previous command', async () => {
    const { guard, read } = await setup();
    expect(await guard.status()).toMatchObject({ locked: false });
    const kernelPath = join(tmpdir(), 'kernel path & harmless.exe');
    expect(await guard.lock(kernelPath)).toMatchObject({ locked: true });
    expect(await guard.status()).toMatchObject({ locked: true });
    expect((await read()).calls).toContainEqual(['lock', '--allow-app', kernelPath]);
  });
  it('removes only its own rules and verifies the resulting state', async () => {
    const { guard, read } = await setup();
    await guard.lock(join(tmpdir(), 'mihomo.exe'));
    expect(await guard.unlock()).toMatchObject({ locked: false });
    expect((await read()).rules).toEqual({ foreign: ['keep'] });
    expect((await read()).calls.at(-1)).toEqual(['status']);
  });
  it('rejects a lock that exits successfully but did not install filters', async () => {
    const { guard } = await setup('ignore');
    await expect(guard.lock(join(tmpdir(), 'mihomo.exe'))).rejects.toThrow(/lock|locked|阻断/i);
  });
  it('rejects an unlock that leaves filters installed', async () => {
    const { guard, file, read } = await setup();
    await guard.lock(join(tmpdir(), 'mihomo.exe'));
    await writeFile(file, JSON.stringify({ ...await read(), mode: 'ignore' }));
    await expect(guard.unlock()).rejects.toThrow(/unlock|locked|解除/i);
  });
  it('passes capability checking to the native helper', async () => {
    const { guard, read } = await setup();
    expect(await guard.check()).toMatchObject({ available: true });
    expect((await read()).calls).toEqual([['check']]);
  });
  it('propagates BFE and permission errors instead of returning unlocked', async () => {
    const { guard } = await setup('error');
    await expect(guard.status()).rejects.toThrow('BFE access denied');
    await expect(guard.check()).rejects.toThrow('BFE access denied');
  });
  it.each(['malformed', 'missingLocked', 'partial'])('fails closed for %s status', async mode => {
    const { guard } = await setup(mode);
    await expect(guard.status()).rejects.toThrow();
  });
  it('preserves a partially installed lock without presenting it as unlocked', async () => {
    const { guard } = await setup('partialInstalled');
    expect(await guard.status()).toMatchObject({ locked: true, complete: false });
    await expect(guard.lock(join(tmpdir(), 'mihomo.exe'))).rejects.toThrow(/complete/i);
  });
  it('rejects relative kernel paths before starting the helper', async () => {
    const { guard, read } = await setup();
    await expect(guard.lock('mihomo.exe')).rejects.toThrow(/absolute|绝对/i);
    expect((await read()).calls).toEqual([]);
  });
  it('limits a hung helper and reports failure', async () => {
    const { file } = await setup('timeout');
    const guard = new WindowsGuard({ executable: [process.execPath, fixture], dataDir: join(file, '..'), timeout: 150 });
    await expect(guard.status()).rejects.toThrow(/timeout|timed out|超时/i);
  });
});
