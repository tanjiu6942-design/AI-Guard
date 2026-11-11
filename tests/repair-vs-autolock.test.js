import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProtectionMonitor } from '../desktop/protection.mjs';

/**
 * 回归(2026-11-11)：「一键修复网络」点了没有用。
 *
 * 现场：06:23~06:35 连续 8 次断流诊断，全部 locked:true / filterCount:4。
 * 内核一直活着(controllerAvailable:true)，但住宅 SOCKS5 链路断了：
 *   exit=unknown（三个探针全部 ECONNRESET）
 *   long=fail（长连接 0.0s~5.0s 断开）
 *
 * 用户的操作：点「一键修复网络」-> WFP 解锁成功 -> 但住宅链路仍然是断的
 * -> 下一轮周期检测照样失败 -> persistent 判定成立 -> trip() -> 重新 lock()
 * -> 15 秒后又是"已断流"，网络再次全断。
 *
 * 也就是说：**解锁本身是对的，但只要故障源还在，监控器会立刻再锁一次。**
 * 用户的体感就是"按钮完全没用"。
 *
 * 修复方向：一键修复必须同时**停掉监控器**（或把它置于"不自动锁"状态），
 * 否则用户永远在和监控器打架。
 */
describe('一键修复后不得被监控器立刻重新锁定', () => {
  it('修复动作必须让监控器停止自动断流', async () => {
    const events = [];
    const monitor = new ProtectionMonitor({
      check: async () => [
        { key: 'exit', title: '出口一致性', state: 'unknown', detail: '端点无响应', critical: false },
        { key: 'long', title: '长连接稳定性', state: 'fail', detail: '连接在 0.0s 时被断开', critical: false },
      ],
      lock: async () => events.push('lock'),
      unlock: async () => events.push('unlock'),
      notify: () => {},
    });
    try {
      await monitor.start();
      monitor.graceUntil = 0;

      // 第一轮：记一次失败
      await monitor.run('full', false);
      const afterFirst = events.filter((e) => e === 'lock').length;

      // 模拟「一键修复」：解锁系统规则 + 暂停自动断流（两者必须成对）
      events.push('unlock');
      monitor.suspendAutoLock();

      // 关键：修复之后，监控器不得再自己 lock()
      await monitor.run('full', false);
      await monitor.run('full', false);

      expect(events.filter((e) => e === 'lock').length).toBe(afterFirst);
      expect(monitor.snapshot().phase).not.toBe('locked');
    } finally {
      monitor.active = false;
      await monitor.shutdown();
    }
  });

  it('存在一个显式的"停止自动断流"开关, 修复后由它接管', async () => {
    const monitor = new ProtectionMonitor({
      check: async () => [{ key: 'long', title: '长连接', state: 'fail', detail: '断了', critical: false }],
      lock: async () => {},
      unlock: async () => {},
      notify: () => {},
    });
    try {
      await monitor.start();
      monitor.graceUntil = 0;

      // 修复前：会锁
      await monitor.run('full', false);
      await monitor.run('full', false);
      expect(monitor.snapshot().phase).toBe('locked');

      // 用户点了「一键修复」-> 监控器进入"只看不动"状态
      monitor.suspendAutoLock();

      // 之后即使继续检测失败，也不得再锁
      const state = monitor.snapshot();
      expect(state.phase).not.toBe('locked');
      expect(monitor.autoLockSuspended).toBe(true);
    } finally {
      monitor.active = false;
      await monitor.shutdown();
    }
  });

  it('恢复自动断流后, 判定逻辑回到原样', async () => {
    const monitor = new ProtectionMonitor({
      check: async () => [{ key: 'long', title: '长连接', state: 'fail', detail: '断了', critical: false }],
      lock: async () => {},
      unlock: async () => {},
      notify: () => {},
    });
    try {
      await monitor.start();
      monitor.suspendAutoLock();
      expect(monitor.autoLockSuspended).toBe(true);

      monitor.resumeAutoLock();
      expect(monitor.autoLockSuspended).toBe(false);

      monitor.graceUntil = 0;
      await monitor.run('full', false);
      await monitor.run('full', false);
      expect(monitor.snapshot().phase).toBe('locked');
    } finally {
      monitor.active = false;
      await monitor.shutdown();
    }
  });
});
