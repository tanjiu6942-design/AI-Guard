import { describe, it, expect, vi } from 'vitest';
import { ProtectionMonitor } from '../desktop/protection.mjs';

/**
 * 缺陷: `lock_failed` 状态下，定时器每 15 秒无条件再 `trip()` 一次。
 *
 * ```js
 * if (this.state.phase === 'lock_failed') void this.trip(this.state.reason);
 * ```
 *
 * 而 `trip()` 的第一件事就是再 `lock()`。如果 lock 持续失败（WFP 拒绝、
 * 权限不足、helper 缺失），状态就永远停在 `lock_failed`，于是：
 *
 *   每 15 秒 -> trip() -> lock() 失败 -> lock_failed -> 每 15 秒 ...
 *
 * 后果不是"安全"，是**无限重试 + 无限刷日志 + 后台常驻占用**。
 * 昨夜(2026-11-06)的 protection-state.json 正停在 `lock_failed`，
 * 与这条循环吻合。
 *
 * 正确语义: 锁定失败要如实保留 `lock_failed` 并停止自动重试，
 * 交由用户手动复检 —— 重复失败不会因为多试几次就成功，
 * 只会把一次失败放大成持续的后台噪音。
 */
describe('lock_failed 不得无限重试', () => {
  it('锁定持续失败时, 定时器不再反复调用 lock', async () => {
    vi.useFakeTimers();
    let lockCalls = 0;
    const monitor = new ProtectionMonitor({
      check: async () => [{ key: 'exit', title: '出口', state: 'fail', detail: 'leak', critical: true }],
      lock: async () => { lockCalls++; throw Error('WFP denied'); },
      unlock: async () => {},
      notify: () => {},
    });
    try {
      await monitor.start();
      expect(monitor.snapshot().phase).toBe('lock_failed');
      const afterFirst = lockCalls;

      // 推进 2 分钟（约 8 个 15 秒周期）
      await vi.advanceTimersByTimeAsync(120000);

      expect(lockCalls).toBe(afterFirst);       // 没有额外重试
      expect(monitor.snapshot().phase).toBe('lock_failed');   // 状态如实保留
    } finally {
      monitor.active = false;
      vi.useRealTimers();
    }
  });

  it('锁定失败后用户手动复检仍可重试(能力未削弱)', async () => {
    let lockCalls = 0;
    const monitor = new ProtectionMonitor({
      check: async () => [{ key: 'exit', title: '出口', state: 'fail', detail: 'leak', critical: true }],
      lock: async () => { lockCalls++; if (lockCalls === 1) throw Error('WFP denied'); },
      unlock: async () => {},
      notify: () => {},
    });
    await monitor.start();
    expect(monitor.snapshot().phase).toBe('lock_failed');

    // 用户修好权限后手动触发
    await monitor.trip('手动重试');
    expect(lockCalls).toBe(2);
    await monitor.shutdown();
  });
});
