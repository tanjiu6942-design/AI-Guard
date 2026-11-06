import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkerClient } from '../desktop/worker-client.mjs';

/**
 * 回归: 「退出保护并恢复普通网络」曾在 worker 已退出时只复位内存状态。
 *
 * 现场(2026-11-06): protection-state.json 记录 phase=lock_failed,
 * reason="管理进程断开，保持系统断流", 而同刻 diagnostic 记录
 * guard.locked=true / filterCount=4。用户点恢复 -> 界面变绿 -> 网仍全断,
 * 因为 unlock 只存在于 worker 进程里, worker 已死就没人执行它。
 *
 * WFP 规则是 Persistent + 绑 BFE 的, 重启电脑也不会自行消失。
 */
function fixture(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'aiguard-recover-'));
  writeFileSync(join(dir, 'protection-state.json'), JSON.stringify({
    phase: 'lock_failed',
    reason: '管理进程断开，保持系统断流',
    items: [],
  }));
  try { return fn(dir); }
  finally { rmSync(dir, { recursive: true, force: true }); }
}

function fakeGuard({ locked = true, unlockFails = false } = {}) {
  const state = { locked, unlockCalls: 0, escalatedCalls: 0, statusCalls: 0 };
  return {
    state,
    mutatingRequiresElevation: true,
    async status() {
      state.statusCalls++;
      return { locked: state.locked, complete: true, filterCount: state.locked ? 4 : 0, errors: [] };
    },
    async unlock() {
      if (unlockFails) throw Error('Administrator elevation is required');
      state.unlockCalls++;
      state.locked = false;
      return { locked: false, complete: true, filterCount: 0, errors: [] };
    },
    async unlockEscalated() {
      if (unlockFails) throw Error('未获得管理员授权或提权失败');
      state.escalatedCalls++;
      state.locked = false;
      return { locked: false, complete: true, filterCount: 0, errors: [] };
    },
  };
}

const client = (dir, guard) => new WorkerClient({
  executable: 'C:\\fixture\\AI Guard.exe', root: '.', dataDir: dir, resources: '.', guard,
});

describe('退出保护: worker 已退出时必须真正解除 WFP 锁定', () => {
  it('worker 已退出时走提权路径解除锁定(主进程是 asInvoker, 直接 unlock 会被拒)', async () => {
    await fixture(async (dir) => {
      const guard = fakeGuard({ locked: true });
      const c = client(dir, guard);

      await c.recover({});

      // worker 不在 -> 必须解锁, 且必须走提权那条路。
      expect(guard.state.escalatedCalls).toBe(1);
      expect(guard.state.unlockCalls).toBe(0);
      expect(guard.state.locked).toBe(false);
      expect(c.protection.phase).toBe('off');
    });
  });

  it('WFP 仍锁着时 recover 必须真的解除, 而不是只复位状态', async () => {
    await fixture(async (dir) => {
      const guard = fakeGuard({ locked: true });
      const c = client(dir, guard);

      await c.recover({});

      expect(guard.state.escalatedCalls + guard.state.unlockCalls).toBe(1);
      expect(guard.state.locked).toBe(false);
      expect(c.protection.phase).toBe('off');
    });
  });

  it('解锁失败时不得把界面刷成已恢复, 且必须抛出错误', async () => {
    await fixture(async (dir) => {
      const guard = fakeGuard({ locked: true, unlockFails: true });
      const c = client(dir, guard);

      await expect(c.recover({})).rejects.toThrow();

      // 关键: 界面必须仍然显示"断流未解除", 不能撒谎说已恢复。
      expect(c.protection.phase).not.toBe('off');
      expect(c.protection.error).toBeTruthy();
    });
  });

  it('本来就没有锁定时不调用 unlock, 直接复位', async () => {
    await fixture(async (dir) => {
      const guard = fakeGuard({ locked: false });
      const c = client(dir, guard);

      await c.recover({});

      expect(guard.state.unlockCalls).toBe(0);
      expect(c.protection.phase).toBe('off');
    });
  });

  it('resetOnly 显式跳过解锁(仅用于已知无需解锁的场景)', async () => {
    await fixture(async (dir) => {
      const guard = fakeGuard({ locked: true });
      const c = client(dir, guard);

      await c.recover({}, { resetOnly: true });

      expect(guard.state.escalatedCalls).toBe(0);
      expect(guard.state.unlockCalls).toBe(0);
    });
  });

  it('worker 仍连着时由它自己解锁, 不额外弹 UAC', async () => {
    await fixture(async (dir) => {
      const guard = fakeGuard({ locked: true });
      const c = client(dir, guard);
      // 模拟 worker 还活着: socket 存在, 走 stop({releaseProtection}) 分支。
      c.socket = { write() {}, end() {} };
      const seen = [];
      c.stop = async (opts) => { seen.push(opts); c.protection = { phase: 'off' }; };

      await c.recover({});

      expect(seen).toEqual([{ releaseProtection: true }]);
      // 关键: 不该绕过活着的 worker 自己去弹 UAC。
      expect(guard.state.escalatedCalls).toBe(0);
    });
  });
});
