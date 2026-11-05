import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { G_PROXY, G_AUTO } from '../dist/core/config/constants.js';

function snapshot(payload, provider) {
  // Provider-owned nodes are not included in /proxies by the bundled core.
  // Merge their public metadata while retaining built-in group identities.
  const members = Array.isArray(provider?.proxies) ? provider.proxies : [];
  const proxies = { ...Object.fromEntries(members.filter(n => typeof n?.name === 'string').map(n => [n.name, n])), ...payload?.proxies };
  const group = proxies?.[G_PROXY];
  if (group?.type !== 'Selector' || !Array.isArray(group.all) || typeof group.now !== 'string')
    throw Error('无法读取普通代理的可选节点');
  const names = [...new Set(group.all)].filter(name => {
    const type = proxies[name]?.type;
    return typeof name === 'string' && typeof type === 'string'
      && !['direct', 'reject', 'rejectdrop', 'pass', 'passrule', 'compatible'].includes(type.toLowerCase())
      && (!Array.isArray(proxies[name].all) || name === G_AUTO);
  });
  return {
    group: G_PROXY,
    selected: group.now,
    nodes: names.map(name => {
      const node = proxies[name];
      const history = Array.isArray(node.history) ? node.history : [];
      const latest = history.at(-1)?.delay;
      return { name, type: node.type,
        delay: Number.isFinite(latest) && latest > 0 ? latest : null,
        alive: history.length && typeof node.alive === 'boolean' ? node.alive : null };
    }),
  };
}

export class OrdinaryNodes {
  constructor({ controller, dataDir, canSelect = () => true }) {
    Object.assign(this, { controller, canSelect });
    this.path = join(dataDir, 'ordinary-node.json');
    this.queue = Promise.resolve();
  }
  async read() {
    const [groups, provider] = await Promise.all([
      this.controller('proxies'), this.controller('providers/proxies/airport-sub'),
    ]);
    return snapshot(groups, provider);
  }
  select(name) {
    const task = this.queue.then(async () => {
      if (!this.canSelect()) throw Error('请在保护正常且内核运行时切换节点');
      if (typeof name !== 'string' || !name.length || name.length > 1024 || /[\x00-\x1f]/.test(name))
        throw Error('节点名称无效');
      const previous = await this.read();
      if (!previous.nodes.some(node => node.name === name)) throw Error('该节点不在普通代理可选列表中，请刷新节点');
      if (!this.canSelect()) throw Error('保护状态已改变，请稍后切换节点');
      if (previous.selected !== name) {
        await this.controller(`proxies/${encodeURIComponent(G_PROXY)}`, { method: 'PUT', body: JSON.stringify({ name }) });
      }
      let current;
      try { current = await this.read(); }
      catch { throw Error('切换请求已发送，但无法确认当前节点，请刷新列表'); }
      if (current.selected !== name) throw Error('内核未确认节点选择，请刷新后重试');
      try {
        writeFileSync(this.path + '.tmp', JSON.stringify({ name }));
        renameSync(this.path + '.tmp', this.path);
      } catch {
        try {
          await this.controller(`proxies/${encodeURIComponent(G_PROXY)}`, { method: 'PUT', body: JSON.stringify({ name: previous.selected }) });
          if ((await this.read()).selected !== previous.selected) throw Error('rollback failed');
        } catch { throw Error('节点选择已改变，但保存和回滚失败，请刷新确认当前节点'); }
        throw Error('无法保存节点选择，已恢复原节点，请检查配置目录写入权限');
      }
      return current;
    });
    this.queue = task.catch(() => {});
    return task;
  }
  async restore() {
    let saved;
    try { saved = JSON.parse(readFileSync(this.path, 'utf8')).name; }
    catch { return; }
    const current = await this.read();
    if (current.nodes.some(node => node.name === saved)) {
      // Startup is still quarantined, before the regular selection gate opens.
      await this.controller(`proxies/${encodeURIComponent(G_PROXY)}`, { method: 'PUT', body: JSON.stringify({ name: saved }) });
      if ((await this.read()).selected !== saved) throw Error('无法恢复普通节点选择');
    }
  }
}
