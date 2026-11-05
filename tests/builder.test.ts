import { describe, it, expect } from 'vitest';
import { buildConfig } from '../core/config/builder';

const baseOpts = {
  mode: 'strict' as const,
  sets: {
    'chatgpt-core': ['DOMAIN-SUFFIX,chatgpt.com'],
    'claude-core': ['DOMAIN-SUFFIX,claude.ai'],
  },
  residential: { server: '1.2.3.4', port: 1000, username: 'u', password: 'p' },
  airportUrl: 'https://example.com/sub',
  mixedPort: 7890,
  controllerPort: 9090,
  secret: 'test-secret',
  homeRegion: 'CN',
  tunEnabled: true,
};

describe('配置组装', () => {
  it('生成完整的 MihomoConfig', () => {
    const c = buildConfig(baseOpts);
    expect(c['mixed-port']).toBe(7890);
    expect(c['external-controller']).toBe('127.0.0.1:9090');
    expect(c.secret).toBe('test-secret');
    expect(c.mode).toBe('rule');
  });

  it('TUN 配置正确', () => {
    const c = buildConfig(baseOpts);
    expect(c.tun.enable).toBe(true);
    expect(c.tun['inet6-address']).toEqual(['fdfe:dcba:9876::1/126']);
    expect(c.tun['dns-hijack']).toEqual(['any:53']);
  });

  it('TUN 可关闭（用于并行验证期）', () => {
    const c = buildConfig({ ...baseOpts, tunEnabled: false });
    expect(c.tun.enable).toBe(false);
  });

  it('住宅节点被放入 guard-ip provider', () => {
    const c = buildConfig(baseOpts);
    const payload = c['proxy-providers']['guard-ip'].payload;
    expect(payload?.[0].server).toBe('1.2.3.4');
    expect(payload?.[0]['dialer-proxy']).toBe('AI Guard 前置');
  });

  it('规则中 AI 域名走专用组', () => {
    const c = buildConfig(baseOpts);
    expect(c.rules).toContain('DOMAIN-SUFFIX,chatgpt.com,AI Guard 专用');
  });

  it('严格模式含 cloudflare 兜底', () => {
    const c = buildConfig(baseOpts);
    expect(c.rules).toContain('DOMAIN-SUFFIX,cloudflare.com,AI Guard 专用');
  });

  it('精确模式也含 cloudflare 兜底（a.nel.cloudflare.com 走机场会导致 ChatGPT 无限重连）', () => {
    const c = buildConfig({ ...baseOpts, mode: 'precise' });
    expect(c.rules).toContain('DOMAIN-SUFFIX,cloudflare.com,AI Guard 专用');
    expect(c.rules).toContain('DOMAIN-SUFFIX,cloudflare-dns.com,AI Guard 专用');
    // 兜底不应把通用域名也拉进住宅，precise 仍走机场兜底
    expect(c.rules[c.rules.length - 1]).toBe('MATCH,普通代理');
  });

  it('profile 保留 selected 与 fake-ip', () => {
    const c = buildConfig(baseOpts);
    expect(c.profile['store-selected']).toBe(true);
    expect(c.profile['store-fake-ip']).toBe(true);
  });

  it('TUN 开启时 ipv6 也必须开启, 否则 Meta 网卡不会有 IPv6 地址', () => {
    const c = buildConfig(baseOpts);          // baseOpts.tunEnabled = true
    expect(c.ipv6).toBe(true);
    expect(c.dns.ipv6).toBe(true);
  });

  it('TUN 关闭时 ipv6 跟随关闭', () => {
    const c = buildConfig({ ...baseOpts, tunEnabled: false });
    expect(c.ipv6).toBe(false);
    expect(c.dns.ipv6).toBe(false);
  });
});
