import { describe, it, expect } from 'vitest';
import { toDnsKey, chunkDnsKeys, buildDns } from '../core/config/dns';

describe('DNS 策略', () => {
  it('routes unlisted and domestic application domains through encrypted residential DNS', () => {
    const dns = buildDns([], 'CN', true, 'sub.example.com');
    expect(dns.nameserver).toEqual(['https://1.1.1.1/dns-query#AI Guard 专用']);
    // 国内域名交给系统解析器直连：公共 DoH 最终仍由运营商递归，
    // 会被泄漏检测站判成"中国 DNS 泄漏"（实测 112.25.12.136 等）。
    expect(dns['nameserver-policy']['geosite:cn']).toEqual(['system#DIRECT', '223.5.5.5']);
    expect(dns['nameserver-policy']['sub.example.com']).toEqual(['223.5.5.5']);
    expect(dns['nameserver-policy']['.sub.example.com']).toBeUndefined();
    expect(dns['proxy-server-nameserver']).toEqual(['223.5.5.5', '119.29.29.29']);
  });
  it('DOMAIN-SUFFIX 转 +. 前缀', () => {
    expect(toDnsKey('DOMAIN-SUFFIX,chatgpt.com')).toBe('+.chatgpt.com');
  });

  it('DOMAIN 保持原样', () => {
    expect(toDnsKey('DOMAIN,accounts.google.com')).toBe('accounts.google.com');
  });

  it('分片后每片不超过 800 字符', () => {
    const keys = Array.from({ length: 200 }, (_, i) => `+.verylongdomainname${i}.example.com`);
    const chunks = chunkDnsKeys(keys);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(c.length).toBeLessThanOrEqual(800);
    }
  });

  it('分片不丢失任何 key', () => {
    const keys = Array.from({ length: 50 }, (_, i) => `+.d${i}.com`);
    const chunks = chunkDnsKeys(keys);
    const restored = chunks.flatMap((c) => c.split(','));
    expect(restored).toEqual(keys);
  });

  it('DNS 配置启用 fake-ip 且 respect-rules', () => {
    const dns = buildDns(['DOMAIN-SUFFIX,chatgpt.com'], 'CN');
    expect(dns['enhanced-mode']).toBe('fake-ip');
    expect(dns['respect-rules']).toBe(true);
    expect(dns.ipv6).toBe(false);
  });

  it('AI 域名走专用组解析', () => {
    const dns = buildDns(['DOMAIN-SUFFIX,chatgpt.com'], 'CN');
    const policies = Object.values(dns['nameserver-policy']);
    const flat = policies.flat();
    expect(flat.some((s) => s.includes('AI Guard 专用'))).toBe(true);
  });

  it('CN 地区使用国内 DNS', () => {
    const dns = buildDns([], 'CN');
    expect(dns['proxy-server-nameserver'].some((s) => s.includes('223.5.5.5'))).toBe(true);
  });
});
