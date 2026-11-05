import { describe, it, expect, vi } from 'vitest';
import { ProtectionMonitor } from '../desktop/protection.mjs';
import { buildProtectedYaml } from '../desktop/protected-config.mjs';
import { buildSourceRules, subscriptionHost } from '../core/config/groups';
import { buildConfig } from '../core/config/builder';
import { configToYaml } from '../core/runtime/mihomo';

const AIRPORT = 'https://sub.example.com/link/abc?clash=3';
const baseCfg = () => buildConfig({
  mode: 'strict', sets: {}, residential: { server: '1.2.3.4', port: 1, username: 'u', password: 'p' },
  airportUrl: AIRPORT, mixedPort: 7891, controllerPort: 9091, secret: 'x',
  homeRegion: 'CN', tunEnabled: true,
});

describe('信源放行: 订阅不能被自家规则拦死', () => {
  it('订阅域名可从订阅 URL 提取', () => {
    expect(subscriptionHost(AIRPORT)).toBe('sub.example.com');
    expect(subscriptionHost('not-a-url')).toBe(null);
  });

  it('订阅域名可从被 JSON.stringify 加过引号的 URL 提取', () => {
    // desktop/worker.mjs 的 makeYaml 会先 JSON.stringify 用户填的 URL,
    // 热重载时信源规则必须仍能提取到订阅域名。
    // 实测踩过: 带引号时 new URL() 失败 -> 热重载后订阅域名被自家 MATCH,REJECT 拒掉
    // -> 探测端点全无响应 -> 整机断流。
    expect(subscriptionHost(JSON.stringify(AIRPORT))).toBe('sub.example.com');
    expect(buildSourceRules(JSON.stringify(AIRPORT))).toContain('DOMAIN,sub.example.com,DIRECT');
  });

  it('信源规则包含订阅域名直连与公共 DNS 直连', () => {
    const rules = buildSourceRules(AIRPORT);
    expect(rules).toContain('DOMAIN,sub.example.com,DIRECT');
    expect(rules).toContain('IP-CIDR,223.5.5.5/32,DIRECT,no-resolve');
    expect(rules).toContain('IP-CIDR,119.29.29.29/32,DIRECT,no-resolve');
  });

  it('订阅 provider 必须显式走 DIRECT, 否则受保护模式会拦死拉取', () => {
    const cfg = baseCfg();
    expect(cfg['proxy-providers']['airport-sub'].proxy).toBe('DIRECT');
    expect(configToYaml(cfg)).toContain('proxy: DIRECT');
  });

  it('受保护模式下信源规则必须排在 MATCH,REJECT 之前', () => {
    const yaml = buildProtectedYaml(baseCfg(), { probePort: 49173, probeSecret: 's', businessBlocked: true, airportUrl: AIRPORT });
    const lines = yaml.split('\n');
    const sourceAt = lines.findIndex(l => l.includes('DOMAIN,sub.example.com,DIRECT'));
    const rejectAt = lines.findIndex(l => /MATCH,REJECT/.test(l));
    expect(sourceAt).toBeGreaterThan(-1);
    expect(rejectAt).toBeGreaterThan(-1);
    // mihomo 规则自上而下首次匹配即生效, MATCH 在首位会匹配一切
    expect(sourceAt).toBeLessThan(rejectAt);
  });

  it('非受保护模式不引入 MATCH,REJECT', () => {
    const yaml = buildProtectedYaml(baseCfg(), { probePort: 49173, probeSecret: 's', businessBlocked: false, airportUrl: AIRPORT });
    expect(yaml).not.toContain('MATCH,REJECT');
  });

  it('热重载场景: 即使 URL 被加过引号, 信源规则也必须含订阅域名', () => {
    // 模拟 desktop/worker.mjs 的 makeYaml: URL 先 JSON.stringify 再进 cfg
    const cfg = baseCfg();
    cfg['proxy-providers']['airport-sub'].url = JSON.stringify(AIRPORT);
    const yaml = buildProtectedYaml(cfg, { probePort: 49173, probeSecret: 's', businessBlocked: true, airportUrl: AIRPORT });
    expect(yaml).toContain('DOMAIN,sub.example.com,DIRECT');
    const sourceAt = yaml.split('\n').findIndex(l => l.includes('DOMAIN,sub.example.com,DIRECT'));
    const rejectAt = yaml.split('\n').findIndex(l => /MATCH,REJECT/.test(l));
    expect(sourceAt).toBeGreaterThan(-1);
    expect(sourceAt).toBeLessThan(rejectAt);
  });

  it('订阅域名用直连明文 DNS 解析, 避免与机场节点形成循环依赖', () => {
    // 必须是明文 IP: mihomo 用 default-nameserver 解析 DNS 服务器地址本身,
    // 若这里是 DoH 就自举失败(实测订阅拉取直接 EOF)。
    expect(baseCfg().dns['nameserver-policy']['sub.example.com']).toEqual(['223.5.5.5']);
    expect(baseCfg().dns['default-nameserver']).toEqual(['223.5.5.5', '119.29.29.29']);
    expect(baseCfg().dns.nameserver).toEqual(['https://1.1.1.1/dns-query#AI Guard 专用']);
    expect(baseCfg().dns['proxy-server-nameserver']).toEqual(['223.5.5.5', '119.29.29.29']);
  });
});

describe('判定层: unknown 不得单独触发整机断流', () => {
  const unknownItem = { key: 'exit', title: '出口一致性', state: 'unknown', detail: '所有受保护公共探测端点均未响应', critical: false };
  const okItem = { key: 'exit', title: '出口一致性', state: 'ok', detail: '出口保持一致', critical: false };

  function fixture(items) {
    const deps = {
      check: vi.fn(async () => items),
      lock: vi.fn(async () => {}),
      unlock: vi.fn(async () => {}),
      notify: vi.fn(),
    };
    return { monitor: new ProtectionMonitor(deps), deps };
  }

  it('运行期连续两轮 unknown 锁定并要求人工复检', async () => {
    const { monitor, deps } = fixture([okItem]);
    await monitor.start();
    expect(monitor.snapshot().phase).toBe('healthy');
    deps.check.mockResolvedValue([unknownItem]);
    await monitor.tick('exit');
    expect(monitor.snapshot().phase).toBe('suspect');
    await monitor.tick('exit');
    expect(monitor.snapshot().phase).toBe('locked');
    expect(deps.lock).toHaveBeenCalledTimes(1);
    await monitor.shutdown();
  });

  it('明确的 fail 仍然会断流', async () => {
    const fail = { key: 'ipv6', title: 'IPv6 防泄漏', state: 'fail', detail: '公网 IPv6 泄漏', critical: true };
    const { monitor, deps } = fixture([okItem]);
    await monitor.start();
    deps.check.mockResolvedValue([fail]);
    await monitor.tick('local');
    expect(deps.lock).toHaveBeenCalledTimes(1);
    expect(monitor.snapshot().phase).toBe('locked');
    await monitor.shutdown();
  });

  it('恢复复检只有 unknown 时保持隔离且不重复 trip', async () => {
    const { monitor, deps } = fixture([unknownItem]);
    await monitor.start();
    deps.lock.mockClear();
    deps.check.mockResolvedValue([unknownItem]);
    await monitor.run('full', true);
    expect(deps.lock).not.toHaveBeenCalled();
    // 从未锁定过 + 启动宽限期内 + 无法判断 -> 显示"检查中"(隔离仍在), 不是"已断流"。
    // 这正是本次修复: 内核刚启动、TUN 尚未就绪时不该报"已断流"。
    expect(monitor.snapshot().phase).toBe('checking');
    await monitor.shutdown();
  });

  it('恢复复检全部通过则解锁', async () => {
    const { monitor, deps } = fixture([unknownItem]);
    await monitor.start();
    deps.unlock.mockClear();
    deps.check.mockResolvedValue([okItem]);
    await monitor.run('full', true);
    expect(deps.unlock).toHaveBeenCalled();
    expect(monitor.snapshot().phase).toBe('healthy');
    await monitor.shutdown();
  });

  it('已锁定后原因无法确认时保持断流, 但链路自愈后自动解锁', async () => {
    const { monitor, deps } = fixture([unknownItem]);
    // 从"上次就锁着"开始(everLocked=true): 此时显示"已断流"是准确的
    await monitor.start({ locked: true, reason: '上次异常断流尚未解除' });
    expect(monitor.snapshot().phase).toBe('locked');
    deps.check.mockResolvedValue([okItem]);
    await monitor.resume();
    expect(deps.unlock).toHaveBeenCalled();
    expect(monitor.snapshot().phase).toBe('healthy');
    await monitor.shutdown();
  });
});
