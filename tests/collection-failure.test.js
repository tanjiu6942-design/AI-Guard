import { describe, it, expect, vi } from 'vitest';
import { ProtectionMonitor } from '../desktop/protection.mjs';
import { readProtectionSnapshot } from '../desktop/health.mjs';

/**
 * 回归: 「检测超时」曾被当成「确认泄漏」立刻断流。
 *
 * 现场(2026-11-06 07:04): 住宅链路全部 i/o timeout -> collect() 的
 * 45 秒硬超时触发 -> 返回 collection-full(unknown) -> 代码里
 * `collectionFailed || hasCriticalLeak` 走 trip() -> 整机断流
 * -> 内核随后 exitCode -> WFP 4 条 Persistent 规则仍在 -> 全网黑洞。
 *
 * full 检测含一条 30 秒长连接 + 3 个出口 trace, 全都要过跨境住宅隧道
 * (实测单连接排队可达 10 秒), 45 秒硬超时很容易踩中。
 *
 * 关键区分:
 *   - 读不到本机状态(权限被拒/异常) -> 无法证明安全 -> 立即锁(保持原契约)
 *   - 只是探测超时                   -> 测量问题 -> 连续两轮才锁
 */

const okItem = () => [{ key: 'exit', title: '出口一致性', state: 'ok', detail: 'consistent' }];

function makeMonitor(check) {
  const events = [];
  const monitor = new ProtectionMonitor({
    check,
    lock: async () => events.push('lock'),
    unlock: async () => events.push('unlock'),
    notify: () => {},
  });
  return { monitor, events };
}

/** 让 collect() 走真实超时分支: check 永不 resolve, 由调度器推进时间。 */
function hungMonitor() {
  vi.useFakeTimers();
  const events = [];
  const monitor = new ProtectionMonitor({
    check: vi.fn(() => new Promise(() => {})),
    lock: async () => events.push('lock'),
    unlock: async () => events.push('unlock'),
    notify: () => {},
  });
  return { monitor, events };
}

describe('探测超时不等于确认泄漏', () => {
  it('启动首轮探测超时: 只标记可疑, 不立即断流', async () => {
    const { monitor, events } = hungMonitor();
    try {
      const start = monitor.start();
      await vi.advanceTimersByTimeAsync(46000);
      await start;

      expect(events).not.toContain('lock');
      expect(monitor.snapshot().phase).not.toBe('locked');
    } finally { await monitor.shutdown(); vi.useRealTimers(); }
  });

  it('连续两轮探测超时仍然锁定(fail-closed 语义不变)', async () => {
    const { monitor, events } = hungMonitor();
    try {
      const start = monitor.start();
      await vi.advanceTimersByTimeAsync(46000);
      await start;
      expect(events).not.toContain('lock');    // 第 1 轮: 不锁

      monitor.graceUntil = 0;                  // 离开启动宽限期
      // 直接走 run(), 避免 arm() 的周期定时器同时触发造成竞争。
      const second = monitor.run('full', false);
      await vi.advanceTimersByTimeAsync(46000);
      await second;

      expect(events).toContain('lock');        // 连续第 2 轮: 锁
      expect(monitor.snapshot().phase).toBe('locked');
    } finally {
      // check 永不 resolve, shutdown 会等挂起的 flight; 先停定时器再让出一次。
      monitor.active = false;
      vi.useRealTimers();
    }
  });

  it('读取本机状态失败(权限被拒)仍然立即锁定', async () => {
    const { monitor, events } = makeMonitor(async () => { throw Error('permission denied'); });

    await monitor.start();

    expect(events).toContain('lock');
    expect(monitor.snapshot().phase).toBe('locked');
    await monitor.shutdown();
  });

  it('真正确认的泄漏(critical)仍然立即断流', async () => {
    const { monitor, events } = makeMonitor(async () => [
      { key: 'exit', title: '出口一致性', state: 'fail', detail: '出口已改变', critical: true },
    ]);

    await monitor.start();

    expect(events).toContain('lock');
    expect(monitor.snapshot().phase).toBe('locked');
    await monitor.shutdown();
  });

  it('单轮普通异常(exit unknown)在宽限期内不锁', async () => {
    const { monitor, events } = makeMonitor(async () => [
      { key: 'exit', title: '出口一致性', state: 'unknown', detail: '端点无响应', critical: false },
    ]);

    await monitor.start();

    expect(events).not.toContain('lock');
    await monitor.shutdown();
  });

  it('全绿时正常放行', async () => {
    const { monitor, events } = makeMonitor(async () => okItem());

    await monitor.start();

    expect(events).toContain('unlock');
    expect(monitor.snapshot().phase).toBe('healthy');
    await monitor.shutdown();
  });

  it('readProtectionSnapshot 子进程超时(killed/SIGTERM)标记 timedOut=true 且不泄漏 Base64 脚本，单轮不锁、连续两轮才锁', async () => {
    const rawCmdError = Object.assign(
      Error('Command failed: powershell.exe -NoProfile -NonInteractive -EncodedCommand CgAkAEUAcgByAG8AcgBBAGMAdABpAG8AbgBQAHIAZQBmAGUAcgBlAG4AYwBlACAAPQAgACcAUwB0AG8AcAAnAA=='),
      { killed: true, signal: 'SIGTERM', code: null },
    );
    const execTimeout = (_file, _args, _opts, cb) => cb(rawCmdError, '', '');

    let caught;
    try {
      await readProtectionSnapshot(execTimeout);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(caught.timedOut).toBe(true);
    expect(caught.message).not.toContain('CgAkAEUAcgBy');
    expect(caught.message).toContain('超时');

    // 接入 ProtectionMonitor：运行期单轮超时只进 suspect，连续第 2 轮才锁
    let shouldTimeout = false;
    const { monitor, events } = makeMonitor(async () => {
      if (shouldTimeout) return readProtectionSnapshot(execTimeout);
      return okItem();
    });
    try {
      await monitor.start();
      expect(monitor.snapshot().phase).toBe('healthy');
      events.length = 0;

      shouldTimeout = true;
      await monitor.tick('local');
      expect(events).not.toContain('lock');
      expect(monitor.snapshot().phase).toBe('suspect');
      expect(monitor.snapshot().reason).not.toContain('CgAkAEUAcgBy');

      await monitor.tick('local');
      expect(events).toContain('lock');
      expect(monitor.snapshot().phase).toBe('locked');
    } finally {
      await monitor.shutdown();
    }
  });

  it('readProtectionSnapshot 非超时失败不标记 timedOut，脱敏 Base64 且仍然立即锁定', async () => {
    const rawCrashError = Object.assign(
      Error('Command failed: powershell.exe -NoProfile -NonInteractive -EncodedCommand CgAkAEUAcgByAG8AcgBBAGMAdABpAG8AbgBQAHIAZQBmAGUAcgBlAG4AYwBlACAAPQAgACcAUwB0AG8AcAAnAA=='),
      { killed: false, signal: null, code: 1 },
    );
    const execCrash = (_file, _args, _opts, cb) => cb(rawCrashError, '', '');

    let caught;
    try {
      await readProtectionSnapshot(execCrash);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(caught.timedOut).toBeFalsy();
    expect(caught.message).not.toContain('CgAkAEUAcgBy');

    const { monitor, events } = makeMonitor(async () => readProtectionSnapshot(execCrash));
    await monitor.start();
    expect(events).toContain('lock');
    expect(monitor.snapshot().phase).toBe('locked');
    await monitor.shutdown();
  });

  it('readProtectionSnapshot 并发调用复用在途采集，避免 local 与 full 同时拉起多个 PowerShell', async () => {
    let spawns = 0;
    let resolveExec;
    const slowExec = (_file, _args, _opts, cb) => {
      spawns++;
      resolveExec = () => cb(null, JSON.stringify({ tunUp: true, dns: [], routes: [], processes: [], otherTun: [] }), '');
    };
    const p1 = readProtectionSnapshot(slowExec);
    const p2 = readProtectionSnapshot(slowExec);
    expect(spawns).toBe(1);
    resolveExec();
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1).toEqual(r2);
  });
});
