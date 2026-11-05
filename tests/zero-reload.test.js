import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkerProtection } from '../desktop/worker-protection.mjs';

async function fixture(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'aiguard-zero-'));
  const events = [];
  const guard = {
    status: async () => ({ locked: false }),
    check: async () => events.push('check'),
    lock: async () => events.push('guard.lock'),
    unlock: async () => events.push('guard.unlock'),
  };
  const runtime = new WorkerProtection({
    guard, dataDir: dir, settings: {},
    configure: async (blocked) => events.push(blocked ? 'configure(blocked)' : 'configure(normal)'),
    controller: async () => events.push('close-conns'),
    emit: () => {},
    check: async () => [{ key: 'exit', title: '出口', state: 'ok', detail: 'valid' }],
  });
  try { await fn(runtime, guard, events, dir); }
  finally { await runtime.shutdown(); rmSync(dir, { recursive: true, force: true }); }
}

describe('启动即正常态: 检测全绿后零配置重载', () => {
  it('完整启动流程不含任何 configure 调用', async () => {
    await fixture(async (runtime, _g, events) => {
      await runtime.prepare('C:\\fixture\\mihomo.exe');
      await runtime.activate(123);
      // 唯一允许的事件: 检查 -> WFP 上锁 -> WFP 解锁。没有配置重载。
      expect(events).toEqual(['check', 'guard.lock', 'guard.unlock']);
      expect(events.filter(e => e.startsWith('configure'))).toEqual([]);
      expect(runtime.snapshot().phase).toBe('healthy');
    });
  });

  it('后续多轮周期检测全绿也不产生配置重载', async () => {
    await fixture(async (runtime, _g, events) => {
      await runtime.prepare('C:\\fixture\\mihomo.exe');
      await runtime.activate(123);
      events.length = 0;
      for (let i = 0; i < 5; i++) {
        await runtime.monitor.tick('local');
        await runtime.monitor.tick('exit');
      }
      expect(events.filter(e => e.startsWith('configure'))).toEqual([]);
      expect(runtime.snapshot().phase).toBe('healthy');
    });
  });

  it('检测到真实泄漏时仍然断流(隔离能力未被削弱)', async () => {
    await fixture(async (runtime, guard, events, dir) => {
      await runtime.prepare('C:\\fixture\\mihomo.exe');
      await runtime.activate(123);
      events.length = 0;
      runtime.check = async () => [{ key: 'ipv6', title: 'IPv6', state: 'fail', detail: '泄漏', critical: true }];
      await runtime.trip('检测到泄漏');
      // 断流必须: WFP 上锁 + 切换到隔离配置 + 关闭现有连接
      expect(events).toContain('guard.lock');
      expect(events).toContain('configure(blocked)');
      expect(events).toContain('close-conns');
      expect(runtime.snapshot().phase).toBe('locked');
    });
  });
});
