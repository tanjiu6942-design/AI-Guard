import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkerProtection } from '../desktop/worker-protection.mjs';

/**
 * unblock() 失败时的补隔离策略。
 *
 * 背景(PROJECT_NOTES 坑 23): `block()` 内含 `configure(true)`，那是一次
 * PUT /configs 热重载，内核会拆掉并重建 TUN 网卡与接管路由；重建窗口内
 * 下一轮检测读到中间态 -> 判 fail -> trip()。实测三次断流触发时刻全部落在
 * configure 重载上。
 *
 * 但补隔离的安全语义不能丢：摘规则失败时如果业务配置已经放行，
 * 就会出现"系统规则没了、流量却放行"的绕过窗口。
 *
 * 所以按真实状态分两种情况：
 *
 *   A. configure(false) 自己就失败了 -> 配置仍是隔离态。
 *      此时只需补回 WFP 规则，**不需要**再下发一次隔离配置（否则纯属多一次重载）。
 *
 *   B. configure(false) 成功、只有 guard.unlock() 失败 -> 配置已放行。
 *      此时**必须**重新下发隔离配置，这次重载是安全所必需的。
 */
function fixture({ failConfigure }) {
  const dir = mkdtempSync(join(tmpdir(), 'aiguard-unblock-'));
  const events = [];
  const guard = {
    status: async () => ({ locked: true }),
    check: async () => {},
    lock: async () => events.push('guard.lock'),
    unlock: async () => { events.push('guard.unlock'); throw Error('Guard unlock left filters installed'); },
  };
  const runtime = new WorkerProtection({
    guard, dataDir: dir, settings: {},
    configure: async (blocked) => {
      if (blocked === false && failConfigure) { events.push('configure(normal) FAILED'); throw Error('reload failed'); }
      events.push(blocked ? 'configure(blocked)' : 'configure(normal)');
    },
    controller: async () => events.push('close-conns'),
    emit: () => {},
    check: async () => [{ key: 'exit', title: '出口', state: 'ok', detail: 'ok' }],
  });
  return { runtime, events, dir };
}

describe('unblock 失败时的补隔离策略', () => {
  it('A: 配置没切回正常态时, 只补 WFP 规则, 不重复下发隔离配置', async () => {
    const { runtime, events, dir } = fixture({ failConfigure: true });
    try {
      await runtime.prepare('C:\\fixture\\mihomo.exe');
      runtime.blockedConfig = true;      // 模拟已处于隔离态
      events.length = 0;

      await expect(runtime.unblock(() => true)).rejects.toThrow();

      // configure(false) 失败了，配置仍是隔离态 -> 不必再 configure(true)
      expect(events.filter(e => e === 'configure(blocked)')).toEqual([]);
      expect(events).toContain('guard.lock');   // 但必须补回系统规则
    } finally { await runtime.shutdown(); rmSync(dir, { recursive: true, force: true }); }
  });

  it('B: 配置已切回正常态时, 必须重新隔离(不能留下绕过窗口)', async () => {
    const { runtime, events, dir } = fixture({ failConfigure: false });
    try {
      await runtime.prepare('C:\\fixture\\mihomo.exe');
      runtime.blockedConfig = true;
      events.length = 0;

      // configure(false) 成功、随后 unlock 失败
      await expect(runtime.unblock(() => true)).rejects.toThrow();

      expect(events).toContain('configure(blocked)');   // 必须重新隔离
    } finally { await runtime.shutdown(); rmSync(dir, { recursive: true, force: true }); }
  });
});
