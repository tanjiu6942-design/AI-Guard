import { describe, it, expect } from 'vitest';
import { buildGroups, buildProviders, buildResidentialProxy, GUARD } from '../core/config/groups';

describe('代理组', () => {
  it('守卫节点指向 discard 端口 9', () => {
    expect(GUARD.port).toBe(9);
    expect(GUARD.server).toBe('127.0.0.1');
    expect(GUARD.type).toBe('socks5');
  });

  it('AI Guard 专用组是 fallback 类型', () => {
    const groups = buildGroups();
    const ai = groups.find((g) => g.name === 'AI Guard 专用');
    expect(ai?.type).toBe('fallback');
  });

  it('AI Guard 专用组同时引用节点源与守卫', () => {
    const groups = buildGroups();
    const ai = groups.find((g) => g.name === 'AI Guard 专用');
    expect(ai?.use).toContain('guard-ip');
    expect(ai?.use).toContain('guard-block');
  });

  it('健康检查超时为 10000ms', () => {
    const groups = buildGroups();
    const ai = groups.find((g) => g.name === 'AI Guard 专用');
    expect(ai?.timeout).toBe(10000);
  });

  it('前置组存在且为 fallback，并优先继承普通代理所选节点', () => {
    const groups = buildGroups();
    const front = groups.find((g) => g.name === 'AI Guard 前置');
    expect(front?.type).toBe('fallback');
    expect(front?.proxies).toContain('普通代理');
  });

  it('含 url-test 自动选择组（从 早期实现 迁移）', () => {
    const groups = buildGroups();
    const auto = groups.find((g) => g.name === 'AI Guard 自动选择');
    expect(auto).toBeDefined();
    expect(auto?.type).toBe('url-test');
    expect(auto?.tolerance).toBe(50);
  });

  it('普通代理组可切到自动选择', () => {
    const groups = buildGroups();
    const proxy = groups.find((g) => g.name === '普通代理');
    expect(proxy?.proxies).toContain('AI Guard 自动选择');
  });

  it('providers 含 inline 守卫与机场订阅', () => {
    const p = buildProviders('https://example.com/sub');
    expect(p['guard-block'].type).toBe('inline');
    expect(p['guard-block'].payload?.[0].port).toBe(9);
    expect(p['airport-sub'].type).toBe('http');
    expect(p['airport-sub'].url).toBe('https://example.com/sub');
  });

  it('住宅节点带 dialer-proxy 指向前置组', () => {
    const node = buildResidentialProxy({
      server: '1.2.3.4', port: 1000, username: 'u', password: 'p',
    });
    expect(node['dialer-proxy']).toBe('AI Guard 前置');
    expect(node.type).toBe('socks5');
    expect(node.udp).toBe(true);
  });
});
