import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkerProtection } from '../desktop/worker-protection.mjs';

async function fixture(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'aiguard-reload-'));
  const events = [];
  const guard = {
    status: async () => ({ locked: false }),
    check: async () => events.push('check'),
    lock: async () => events.push('lock'),
    unlock: async () => events.push('unlock'),
  };
  const runtime = new WorkerProtection({
    guard, dataDir: dir, settings: {},
    configure: async (blocked) => events.push(blocked ? 'deny' : 'allow'),
    controller: async () => events.push('close'),
    emit: () => {},
    check: async () => [{ key: 'exit', title: '出口', state: 'ok', detail: 'valid' }],
  });
  try { await fn(runtime, guard, events, dir); }
  finally { await runtime.shutdown(); rmSync(dir, { recursive: true, force: true }); }
}

describe('热重载抑制: 检测全绿后不得再制造一次配置重载', () => {
  it('首次检测全绿后不发生任何配置重载', async () => {
    await fixture(async (runtime, _g, events) => {
      await runtime.prepare('C:\\fixture\\mihomo.exe');
      await runtime.activate(123);
      // 启动流程: check -> lock -> (检测全绿) -> unlock
      // 启动配置已是正常态, 不需要 allow 这次热重载。
      expect(events).toEqual(['check', 'lock', 'unlock']);
      expect(events).not.toContain('allow');
      expect(runtime.snapshot().phase).toBe('healthy');

      // 关键: 后续周期检测全绿时, 不能再次 configure() ——
      // 每次 configure() 都是 PUT /configs 热重载, 会拆建 TUN 网卡与接管路由。
      // 实测三次断流的触发时刻(00:29:01 / 00:41:49 / 00:52:21)全部落在这类重载上。
      events.length = 0;
      await runtime.monitor.tick('exit');
      await runtime.monitor.tick('local');
      expect(events).not.toContain('allow');
      expect(events).not.toContain('deny');
      expect(runtime.snapshot().phase).toBe('healthy');
    });
  });

  it('解锁时若配置已是正常态则跳过重载', async () => {
    await fixture(async (runtime, _g, events) => {
      await runtime.prepare('C:\\fixture\\mihomo.exe');
      runtime.blockedConfig = false;   // 已是正常态
      events.length = 0;
      await runtime.unblock(() => true);
      expect(events).toEqual(['unlock']);   // 无 allow
    });
  });

  it('配置仍是隔离态时必须先切回正常配置再摘系统规则(安全顺序)', async () => {
    await fixture(async (runtime, _g, events) => {
      await runtime.prepare('C:\\fixture\\mihomo.exe');
      runtime.blockedConfig = true;
      events.length = 0;
      await runtime.unblock(() => true);
      expect(events).toEqual(['allow', 'unlock']);
    });
  });
});
