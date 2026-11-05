import { describe, it, expect, vi } from 'vitest';
import { evaluateSystem } from '../desktop/health.mjs';
import { ProtectionMonitor, STARTUP_GRACE_MS } from '../desktop/protection.mjs';

const okSystem = () => ({
  tunUp: true,
  dns: [{ iface: 'WLAN', servers: ['198.18.0.2', 'fdfe:dcba:9876::2'] }],
  route4: true, hasPublicIpv6: true, tunIpv6: true, route6: true,
  processes: [], otherTun: [],
});
const notReadySystem = () => ({ ...okSystem(), tunUp: false, route4: false, tunIpv6: false, route6: false });

const stateOf = (items, key) => items.find((x) => x.key === key)?.state;

describe('启动宽限期: TUN 未就绪不得判 fail', () => {
  it('宽限期内 TUN 接管与 IPv6 为 unknown, 不是 fail', () => {
    const items = evaluateSystem(notReadySystem(), 1, { gracePeriod: true });
    expect(stateOf(items, 'tun')).toBe('unknown');
    expect(stateOf(items, 'ipv6')).toBe('unknown');
    expect(stateOf(items, 'dns')).toBe('ok');
  });

  it('宽限期外仍然是 fail(真实接管失效不会被放过)', () => {
    const items = evaluateSystem(notReadySystem(), 1, { gracePeriod: false });
    expect(stateOf(items, 'tun')).toBe('fail');
    expect(stateOf(items, 'ipv6')).toBe('fail');
  });

  it('默认不传参数时行为与原来一致(fail)', () => {
    const items = evaluateSystem(notReadySystem(), 1);
    expect(stateOf(items, 'tun')).toBe('fail');
  });

  it('就绪状态下宽限期内外都是 ok', () => {
    expect(stateOf(evaluateSystem(okSystem(), 1, { gracePeriod: true }), 'tun')).toBe('ok');
    expect(stateOf(evaluateSystem(okSystem(), 1, { gracePeriod: false }), 'tun')).toBe('ok');
  });
});

describe('监控器宽限期窗口', () => {
  function fixture(items) {
    const deps = {
      check: vi.fn(async () => items),
      lock: vi.fn(async () => {}),
      unlock: vi.fn(async () => {}),
      notify: vi.fn(),
    };
    return { monitor: new ProtectionMonitor(deps), deps };
  }
  const unknownExit = { key: 'exit', title: '出口一致性', state: 'unknown', detail: '端点未响应', critical: false };

  it('启动后处于宽限期内', async () => {
    const { monitor } = fixture([unknownExit]);
    await monitor.start();
    expect(monitor.inStartupGrace()).toBe(true);
    await monitor.shutdown();
  });

  it('宽限期长度足够覆盖 TUN 建立与首个探测往返', () => {
    // 实测 TUN 网卡比内核监听晚 855ms, 首个探测往返约 8s
    expect(STARTUP_GRACE_MS).toBeGreaterThanOrEqual(30000);
  });

  it('配置热重载后重新开启宽限期(重建 TUN 的空窗不得判 fail)', async () => {
    // 实测: 00:41:49 热重载 -> 同一秒断流, 因为重载会拆掉并重建 TUN 网卡与路由
    let t = 1_000_000;
    const deps = {
      check: vi.fn(async () => [{ key: 'tun', title: 'TUN 接管', state: 'unknown', detail: '重建中', critical: false }]),
      lock: vi.fn(async () => {}),
      unlock: vi.fn(async () => {}),
      notify: vi.fn(),
      now: () => t,
    };
    const monitor = new ProtectionMonitor(deps);
    await monitor.start();
    t += STARTUP_GRACE_MS + 1;
    expect(monitor.inStartupGrace()).toBe(false);
    monitor.markReload();
    expect(monitor.inStartupGrace()).toBe(true);
    await monitor.shutdown();
  });

  it('宽限期内 unknown 不断流, 且显示"检查中"而非"已断流"', async () => {
    const { monitor, deps } = fixture([unknownExit]);
    await monitor.start();
    // 启动宽限期内: 隔离是正常流程, 显示 checking, 不能显示 locked
    expect(deps.lock).not.toHaveBeenCalled();
    expect(monitor.snapshot().phase).toBe('checking');
    // 非 release 的周期检测走 suspect 分支(它本来就不是"锁")
    await monitor.tick('exit');
    expect(deps.lock).not.toHaveBeenCalled();
    expect(['checking', 'suspect']).toContain(monitor.snapshot().phase);
    await monitor.shutdown();
  });
});
