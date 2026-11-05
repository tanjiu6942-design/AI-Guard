import { it, expect } from 'vitest';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runInNewContext } from 'node:vm';

it('copies offline nodes and selection cache using the worker filesystem bindings', () => {
  const source = fs.readFileSync(new URL('../desktop/worker.mjs', import.meta.url), 'utf8');
  const names = source.match(/import\s*\{([^}]+)\}\s*from "node:fs"/)[1].split(',').map(x => x.trim()).filter(Boolean);
  const scope = Object.fromEntries(names.map(name => [name, fs[name]]));
  const dir = fs.mkdtempSync(join(tmpdir(), 'aiguard-cache-'));
  try {
    const dataDir = join(dir, 'data'), workDir = join(dir, 'runtime');
    fs.mkdirSync(join(dataDir, 'mihomo', 'proxies'), { recursive: true });
    fs.mkdirSync(workDir);
    fs.writeFileSync(join(dataDir, 'mihomo', 'proxies', 'airport.yaml'), 'proxies: []\n');
    fs.writeFileSync(join(dataDir, 'mihomo', 'cache.db'), 'selection-fixture');
    const logs = [];
    const start = source.indexOf('      const appDataProxies =');
    const end = source.indexOf('      activeConfig =', start);
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    runInNewContext(source.slice(start, end), { ...scope, join, dataDir, workDir, log: value => logs.push(value) });
    expect(logs.some(x => x.includes('失败'))).toBe(false);
    expect(fs.readFileSync(join(workDir, 'proxies', 'airport.yaml'), 'utf8')).toBe('proxies: []\n');
    expect(fs.readFileSync(join(workDir, 'cache.db'), 'utf8')).toBe('selection-fixture');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
