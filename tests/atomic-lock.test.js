import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkerProtection } from '../desktop/worker-protection.mjs';

/**
 * 根因(2026-11-07 二次事故)：block() 里 ① guard.lock() 成功、
 * ② configure(true) 超时失败 -> 系统停在「WFP 锁着 + 配置正常 + 内核已退」
 * 的中间态 -> 整机没有任何出网通道 -> 用户只能重装。
 *
 * 但回滚不是无条件的 —— 这里有真实的安全权衡：
 *
 *   场景 A：内核**还活着**，只是配置切换失败
 *     必须保留封锁。此刻内核仍能出网，若摘掉 WFP 规则，
 *     应用可能在"配置未隔离"的情况下直接走直连泄漏真实 IP。
 *     （这条正是原有测试 `retains a system block even if proxy policy
 *       updates fail` 所要保护的契约。）
 *
 *   场景 B：内核**已经死了**（崩溃 / 被强杀）
 *     WFP 规则失去意义：它豁免的唯一对象不存在了，
 *     没有任何流量会经过内核。继续锁着 = 纯粹的全网黑洞。
 *     此时必须回滚，让用户能上网。
 *
 * 所以判断依据是「内核是否还活着」，而不是「configure 有没有抛错」。
 */
function fixture({ kernelAlive }) {
  const dir = mkdtempSync(join(tmpdir(), 'aiguard-atomic-'));
  const events = [];
  const guard = {
    async status() { return { locked: !events.includes('unlock'), complete: true, filterCount: 4 }; },
    async check() {},
    async lock() { events.push('lock'); },
    async unlock() { events.push('unlock'); },
  };
  const runtime = new WorkerProtection({
    guard, dataDir: dir, settings: {},
    configure: async (blocked) => {
      events.push(blocked ? 'deny' : 'allow');
      if (blocked) throw Error('The operation was aborted due to timeout');
    },
    controller: async () => events.push('close'),
    emit: () => {},
    check: async () => [{ key: 'exit', title: '出口', state: 'ok', detail: 'ok' }],
    // 注入内核存活判断
    isKernelAlive: () => kernelAlive,
  });
  return { runtime, guard, events, dir };
}

describe('A: 内核仍存活时, 配置失败必须保留封锁', () => {
  it('不回滚 WFP 规则', async () => {
    const { runtime, events, dir } = fixture({ kernelAlive: true });
    try {
      await runtime.prepare('C:\\fixture\\mihomo.exe');
      events.length = 0;
      await expect(runtime.block()).rejects.toThrow();
      expect(events).toContain('lock');
      expect(events).not.toContain('unlock');
      expect(runtime.guardLocked).toBe(true);
    } finally { await runtime.shutdown(); rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('B: 内核已死时, 配置失败必须回滚封锁', () => {
  it('摘掉 WFP 规则, 让系统恢复上网', async () => {
    const { runtime, events, dir } = fixture({ kernelAlive: false });
    try {
      await runtime.prepare('C:\\fixture\\mihomo.exe');
      events.length = 0;
      await expect(runtime.block()).rejects.toThrow();
      expect(events).toContain('lock');
      expect(events).toContain('unlock');
      expect(events.indexOf('unlock')).toBeGreaterThan(events.indexOf('lock'));
    } finally { await runtime.shutdown(); rmSync(dir, { recursive: true, force: true }); }
  });

  it('回滚后本地记录必须回到未锁', async () => {
    const { runtime, events, dir } = fixture({ kernelAlive: false });
    try {
      await runtime.prepare('C:\\fixture\\mihomo.exe');
      events.length = 0;
      await expect(runtime.block()).rejects.toThrow();
      expect(runtime.guardLocked).toBe(false);
    } finally { await runtime.shutdown(); rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('C: 正常路径不受影响', () => {
  it('配置成功时保持锁定', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'aiguard-ok-'));
    const events = [];
    const guard = {
      async status() { return { locked: true, complete: true, filterCount: 4 }; },
      async check() {}, async lock() { events.push('lock'); }, async unlock() { events.push('unlock'); },
    };
    const runtime = new WorkerProtection({
      guard, dataDir: dir, settings: {},
      configure: async (b) => events.push(b ? 'deny' : 'allow'),
      controller: async () => events.push('close'),
      emit: () => {},
      check: async () => [{ key: 'exit', title: '出口', state: 'ok', detail: 'ok' }],
      isKernelAlive: () => true,
    });
    try {
      await runtime.prepare('C:\\fixture\\mihomo.exe');
      events.length = 0;
      await runtime.block();
      expect(events).toContain('lock');
      expect(events).not.toContain('unlock');
      expect(runtime.guardLocked).toBe(true);
    } finally { await runtime.shutdown(); rmSync(dir, { recursive: true, force: true }); }
  });

  it('guard.lock 自己失败时不需要回滚', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'aiguard-fail-'));
    const events = [];
    const guard = {
      async status() { return { locked: false, complete: true, filterCount: 0 }; },
      async check() {}, async lock() { events.push('lock'); throw Error('WFP denied'); },
      async unlock() { events.push('unlock'); },
    };
    const runtime = new WorkerProtection({
      guard, dataDir: dir, settings: {},
      configure: async (b) => events.push(b ? 'deny' : 'allow'),
      controller: async () => events.push('close'),
      emit: () => {},
      check: async () => [{ key: 'exit', title: '出口', state: 'ok', detail: 'ok' }],
      isKernelAlive: () => true,
    });
    try {
      await runtime.prepare('C:\\fixture\\mihomo.exe').catch(() => {});
      events.length = 0;
      await expect(runtime.block()).rejects.toThrow();
      expect(events).not.toContain('unlock');
    } finally { await runtime.shutdown(); rmSync(dir, { recursive: true, force: true }); }
  });
});
