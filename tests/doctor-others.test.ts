import { describe, it, expect } from 'vitest';
import { checkDnsLeak } from '../core/doctor/dns-leak';
import { checkIpv6 } from '../core/doctor/ipv6';
import { checkWebrtc } from '../core/doctor/webrtc';
import { checkLongConnection } from '../core/doctor/long-connection';
import { checkConflict } from '../core/doctor/conflict';

describe('DNS 泄漏', () => {
  it('无公网 IPv6 时直接通过', async () => {
    const r = await checkIpv6(false);
    expect(r.state).toBe('ok');
  });

  it('有公网 IPv6 但探测不到时通过', async () => {
    const r = await checkIpv6(true, async () => null);
    expect(r.state).toBe('ok');
  });

  it('有公网 IPv6 且探测到时失败', async () => {
    const r = await checkIpv6(true, async () => '2001:db8::1');
    expect(r.state).toBe('fail');
    expect(r.detail).toContain('2001:db8::1');
  });

  it('TUN 没配 IPv6 时直接判失败（配置层，核心回归）', async () => {
    const r = await checkIpv6(true, async () => null, async () => ({
      physicalPublic: [{ iface: 'WLAN', addr: '2408:8422::1' }],
      tunHasIpv6: false,
      ipv6DefaultRoutes: ['WLAN'],
      tunAlias: 'Meta',
    }));
    expect(r.state).toBe('fail');
    expect(r.detail).toContain('TUN 网卡没有 IPv6');
  });

  it('::/0 默认路由不在 TUN 上时判失败（配置层，核心回归）', async () => {
    const r = await checkIpv6(true, async () => null, async () => ({
      physicalPublic: [{ iface: 'WLAN', addr: '2408:8422::1' }],
      tunHasIpv6: true,
      ipv6DefaultRoutes: ['WLAN'],
      tunAlias: 'Meta',
    }));
    expect(r.state).toBe('fail');
    expect(r.detail).toContain('绕过隧道');
  });

  it('配置正确时通过，即使 STUN 探不到', async () => {
    const r = await checkIpv6(true, async () => null, async () => ({
      physicalPublic: [{ iface: 'WLAN', addr: '2408:8422::1' }],
      tunHasIpv6: true,
      ipv6DefaultRoutes: ['Meta'],
      tunAlias: 'Meta',
    }));
    expect(r.state).toBe('ok');
    expect(r.detail).toContain('TUN 有 IPv6 地址');
  });

  it('配置正确但 STUN 仍探到真实 IPv6 时判失败', async () => {
    const r = await checkIpv6(true, async () => '2001:db8::9', async () => ({
      physicalPublic: [{ iface: 'WLAN', addr: '2408:8422::1' }],
      tunHasIpv6: true,
      ipv6DefaultRoutes: ['Meta'],
      tunAlias: 'Meta',
    }));
    expect(r.state).toBe('fail');
    expect(r.detail).toContain('2001:db8::9');
  });
});

describe('WebRTC', () => {
  it('探测到的 IP 等于预期时通过', async () => {
    const r = await checkWebrtc('1.1.1.1', '1.1.1.1');
    expect(r.state).toBe('ok');
  });

  it('探测到的 IP 不等于预期时失败', async () => {
    const r = await checkWebrtc('2.2.2.2', '1.1.1.1');
    expect(r.state).toBe('fail');
  });

  it('探测不到时 unknown', async () => {
    const r = await checkWebrtc(null, '1.1.1.1');
    expect(r.state).toBe('unknown');
  });
});

describe('长连接', () => {
  it('全部保持成功时通过', async () => {
    const r = await checkLongConnection(async () => ({ aliveMs: 30000, closed: false }), 30000);
    expect(r.state).toBe('ok');
  });

  it('被提前掐断时失败', async () => {
    const r = await checkLongConnection(async () => ({ aliveMs: 3000, closed: true }), 30000);
    expect(r.state).toBe('fail');
  });
});

describe('DNS 泄漏检测 — dns-hijack 兜底', () => {
  const manyPublicDns = async () => [
    { iface: 'WLAN', family: 4 as const, servers: ['114.114.114.114'] },
  ];

  it('网卡未接管但 dns-hijack 生效 → 判通过（核心回归：避免误报）', async () => {
    const r = await checkDnsLeak(
      async () => { throw new Error('不该走到 HTTP 探测'); },
      'US',
      manyPublicDns,
      async () => true,          // 劫持生效
    );
    expect(r.state).toBe('ok');
    expect(r.detail).toContain('dns-hijack');
  });

  it('网卡未接管且 dns-hijack 失效 → 判泄漏', async () => {
    const r = await checkDnsLeak(
      async () => { throw new Error('x'); },
      'US',
      manyPublicDns,
      async () => false,         // 劫持失效
    );
    expect(r.state).toBe('fail');
    expect(r.detail).toContain('114.114.114.114');
  });

  it('劫持探测无法判断时 → unknown 而非误判 ok', async () => {
    const r = await checkDnsLeak(
      async () => { throw new Error('x'); },
      'US',
      manyPublicDns,
      async () => null,
    );
    expect(r.state).toBe('unknown');
  });

  it('网卡已接管 → 直接通过, 不做劫持探测', async () => {
    let probed = false;
    const r = await checkDnsLeak(
      async () => { throw new Error('x'); },
      'US',
      async () => [{ iface: 'WLAN', family: 4 as const, servers: ['198.18.0.2'] }],
      async () => { probed = true; return true; },
    );
    expect(r.state).toBe('ok');
    expect(probed).toBe(false);
  });
});

describe('DNS 泄漏检测', () => {
  it('请求失败时 unknown 而非误判', async () => {
    const r = await checkDnsLeak(async () => { throw new Error('x'); }, 'US');
    expect(r.state).toBe('unknown');
  });
});

describe('代理冲突', () => {
  it('返回结构合法的结果', async () => {
    const r = await checkConflict(async () => []);
    expect(r.key).toBe('conflict');
    expect(['ok', 'warn', 'unknown']).toContain(r.state);
  });

  it('没有代理进程时通过', async () => {
    const r = await checkConflict(async () => [{ name: 'chrome.exe', cmd: 'chrome' }]);
    expect(r.state).toBe('ok');
  });

  it('不把 AI Guard 自己的内核报成冲突（核心回归）', async () => {
    const r = await checkConflict(async () => [{ name: 'mihomo.exe', pid: 48860 }], [48860]);
    expect(r.state).toBe('ok');
    expect(r.detail).toContain('自身内核');
  });

  it('检测到别家客户端时报 warn', async () => {
    const r = await checkConflict(async () => [{ name: 'mihomo.exe', pid: 1234 }], [48860]);
    expect(r.state).toBe('warn');
    expect(r.detail).toContain('mihomo.exe');
  });

  it('自己内核与别家客户端同时存在时只报别家', async () => {
    const r = await checkConflict(async () => [
      { name: 'mihomo.exe', pid: 48860 },
      { name: 'Clash.exe', pid: 999 },
    ], [48860]);
    expect(r.state).toBe('warn');
    expect(r.detail).toContain('Clash.exe');
    expect(r.detail).not.toContain('mihomo.exe、Clash.exe');
  });
});
