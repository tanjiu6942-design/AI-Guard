import { it, expect } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OrdinaryNodes } from '../desktop/nodes.mjs';

async function fixture(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'aiguard-nodes-'));
  let selected = 'AI Guard 自动选择', allowed = true;
  const requests = [];
  const controller = async (path, options) => {
    requests.push({ path, options });
    if (options?.method === 'PUT') { selected = JSON.parse(options.body).name; return null; }
    if (path === 'providers/proxies/airport-sub') return { proxies: [{ name: '香港 / A', type: 'Shadowsocks', alive: true, history: [{ delay: 57 }] }] };
    return { proxies: {
      '普通代理': { type: 'Selector', now: selected, all: ['AI Guard 自动选择', '香港 / A', 'DIRECT'] },
      'AI Guard 自动选择': { type: 'URLTest', all: ['香港 / A'], alive: true, history: [] },
      DIRECT: { type: 'DIRECT' },
    } };
  };
  const nodes = new OrdinaryNodes({ controller, dataDir: dir, canSelect: () => allowed });
  try { await fn(nodes, requests, () => { allowed = false; }, { controller, dir }); }
  finally { rmSync(dir, { recursive: true, force: true }); }
}
it('lists only ordinary members and distinguishes unmeasured latency', async () => fixture(async nodes => {
  const state = await nodes.read();
  expect(state.nodes.map(x => x.name)).toEqual(['AI Guard 自动选择', '香港 / A']);
  expect(state.nodes[0]).toMatchObject({ delay: null, alive: null });
  expect(state.nodes[1]).toMatchObject({ delay: 57, alive: true });
}));
it('changes only the ordinary selector and restores the confirmed selection', async () => fixture(async (nodes, requests, _lock, env) => {
  expect((await nodes.select('香港 / A')).selected).toBe('香港 / A');
  const next = new OrdinaryNodes({ controller: env.controller, dataDir: env.dir });
  await next.restore();
  const writes = requests.filter(x => x.options);
  expect(writes.every(x => x.path === `proxies/${encodeURIComponent('普通代理')}` && x.options.method === 'PUT')).toBe(true);
}));
it('rejects unknown nodes and locked selection without controller writes', async () => fixture(async (nodes, requests, lock) => {
  await expect(nodes.select('AI Guard 专用')).rejects.toThrow('不在');
  lock();
  await expect(nodes.select('香港 / A')).rejects.toThrow('保护');
  expect(requests.some(x => x.options)).toBe(false);
}));
it('rolls back the live selection if its recovery record cannot be saved', async () => fixture(async (nodes, _requests, _lock, { dir }) => {
  mkdirSync(join(dir, 'ordinary-node.json'));
  await expect(nodes.select('香港 / A')).rejects.toThrow('已恢复原节点');
  expect((await nodes.read()).selected).toBe('AI Guard 自动选择');
}));
