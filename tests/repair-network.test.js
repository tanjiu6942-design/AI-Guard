import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkerClient } from '../desktop/worker-client.mjs';

/**
 * 「一键修复」：软件异常退出后整机断网的紧急自救。
 *
 * 现场(2026-11-07)：
 *   protection-state.json -> phase: lock_failed
 *   reason: 检测能力：检测超过截止时间
 *   error: ...；The operation was aborted due to timeout
 *
 * block() 的顺序是 guard.lock() -> configure(true)。第一步把 WFP 4 条
 * Persistent 规则装上了，第二步配置热重载超时失败 -> 抛错 -> lock_failed。
 * 结果是：WFP 锁着（除内核外全阻断），但配置文件还是正常态，内核又已退出
 * -> 整机没有任何程序能上网。
 *
 * 而原「退出保护并恢复普通网络」按钮在 lock_failed 下不一定可用：
 * 它走 releaseProtection -> recover()，虽然会尝试解锁，但失败时只报错，
 * 用户需要懂技术才知道要做什么。
 *
 * 所以需要一个**明确的、显眼的、一次点击就完成**的入口：
 *   1. 不管当前是什么状态，都去解除 WFP
 *   2. 不依赖 worker（worker 死了正是要救的场景）
 *   3. 重启内核能力（可选，让用户能继续用）
 *   4. 做完回读真实状态，如实报告
 */
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'aiguard-repair-'));
  writeFileSync(join(dir, 'protection-state.json'), JSON.stringify({
    phase: 'lock_failed',
    reason: '检测能力：检测超过截止时间',
    error: 'Private configuration must be UTF-8 text no larger than 16 MiB；The operation was aborted due to timeout',
    items: [],
  }));
  return dir;
}

function fakeGuard({ locked = true, unlockFails = false } = {}) {
  const calls = [];
  const state = { locked };
  return {
    state,
    calls,
    async status() {
      calls.push('status');
      return { locked: state.locked, complete: true, filterCount: state.locked ? 4 : 0, errors: [] };
    },
    async unlock() {
      calls.push('unlock');
      if (unlockFails) throw Error('Administrator elevation is required');
      state.locked = false;
      return { locked: false, complete: true, filterCount: 0, errors: [] };
    },
    async unlockEscalated() {
      calls.push('unlockEscalated');
      if (unlockFails) throw Error('未获得管理员授权');
      state.locked = false;
      return { locked: false, complete: true, filterCount: 0, errors: [] };
    },
  };
}

const client = (dir, guard) => new WorkerClient({
  executable: 'C:\\fixture\\AI Guard.exe', root: '.', dataDir: dir, resources: '.', guard,
});

describe('一键修复: 解除异常退出导致的整机断网', () => {
  it('WFP 锁着时, 修复会真正解锁并回报成功', async () => {
    const dir = fixture();
    try {
      const guard = fakeGuard({ locked: true });
      const c = client(dir, guard);

      const result = await c.repairNetwork();

      expect(result.ok).toBe(true);
      expect(result.unlocked).toBe(true);
      expect(guard.state.locked).toBe(false);
      expect(guard.calls).toContain('unlockEscalated');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('修复不依赖 worker 存活(worker 已死正是要救的场景)', async () => {
    const dir = fixture();
    try {
      const guard = fakeGuard({ locked: true });
      const c = client(dir, guard);
      // 模拟 worker 已退出：无 socket
      c.socket = null;
      c.running = false;

      const result = await c.repairNetwork();

      expect(result.ok).toBe(true);
      // 必须走提权路径，而不是 worker 内部 unlock
      expect(guard.calls).toContain('unlockEscalated');
      expect(guard.calls).not.toContain('unlock');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('修复后清空保护状态文件, 避免下次启动误判「上次断流未解除」', async () => {
    const dir = fixture();
    try {
      const guard = fakeGuard({ locked: true });
      const c = client(dir, guard);

      await c.repairNetwork();

      const state = JSON.parse(readFileSync(join(dir, 'protection-state.json'), 'utf8'));
      expect(state.phase).toBe('off');
      expect(state.reason).toBeNull();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('解锁失败时如实报错, 不谎称已修复', async () => {
    const dir = fixture();
    try {
      const guard = fakeGuard({ locked: true, unlockFails: true });
      const c = client(dir, guard);

      const result = await c.repairNetwork();

      expect(result.ok).toBe(false);
      expect(result.error).toBeTruthy();
      expect(result.error).toMatch(/管理员|提权|失败/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('本来就没锁时也返回成功, 并说明无需修复', async () => {
    const dir = fixture();
    try {
      const guard = fakeGuard({ locked: false });
      const c = client(dir, guard);

      const result = await c.repairNetwork();

      expect(result.ok).toBe(true);
      expect(result.unlocked).toBe(false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('修复是幂等的: 连续点两次不会出错', async () => {
    const dir = fixture();
    try {
      const guard = fakeGuard({ locked: true });
      const c = client(dir, guard);

      const first = await c.repairNetwork();
      const second = await c.repairNetwork();

      expect(first.ok).toBe(true);
      expect(second.ok).toBe(true);
      expect(guard.state.locked).toBe(false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('修复后不得谎报内核已停止(内核往往还活着, 只是链路断了)', async () => {
    const dir = fixture();
    try {
      const guard = fakeGuard({ locked: true });
      const c = client(dir, guard);
      c.running = true;
      c.phase = 'running';
      c.corePid = 4242;

      await c.repairNetwork();

      // 内核还活着 -> 状态必须如实反映
      expect(c.running).toBe(true);
      expect(c.phase).toBe('running');
      expect(c.corePid).toBe(4242);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('worker 还活着时, 修复必须先让它暂停自动断流', async () => {
    const dir = fixture();
    try {
      const guard = fakeGuard({ locked: true });
      const c = client(dir, guard);
      const rpcs = [];
      c.rpc = async (method) => { rpcs.push(method); };
      c.socket = { write() {}, end() {} };

      await c.repairNetwork();

      // 关键: 必须发 suspendAutoLock, 否则解锁后会被立刻重新锁上
      expect(rpcs).toContain('suspendAutoLock');
      // 顺序: 暂停必须在解锁之前
      expect(rpcs.indexOf('suspendAutoLock')).toBeLessThan(
        guard.calls.indexOf('unlockEscalated'),
      );
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('worker 存活并返回 suspended 快照时，repairNetwork 保留 suspended 状态而非复位为 off', async () => {
    const dir = fixture();
    try {
      const guard = fakeGuard({ locked: true });
      const c = client(dir, guard);
      const suspendedSnap = {
        phase: 'suspect',
        reason: '已执行一键修复，暂停自动断流',
        items: [],
        suspended: true,
      };
      c.rpc = async (method) => {
        if (method === 'suspendAutoLock') return suspendedSnap;
      };
      c.socket = { write() {}, end() {} };

      const result = await c.repairNetwork();

      expect(result.ok).toBe(true);
      expect(c.protection.suspended).toBe(true);
      expect(c.protection.phase).toBe('suspect');
      expect(c.protection.reason).toBe('已执行一键修复，暂停自动断流');

      const saved = JSON.parse(readFileSync(join(dir, 'protection-state.json'), 'utf8'));
      expect(saved.suspended).toBe(true);
      expect(saved.phase).toBe('suspect');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
