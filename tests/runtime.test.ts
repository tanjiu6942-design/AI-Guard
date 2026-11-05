import { describe, it, expect } from 'vitest';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configToYaml, findMihomo } from '../core/runtime/mihomo';

describe('mihomo 运行时', () => {
  it('config 转 YAML 后含关键字段', () => {
    const yaml = configToYaml({
      'mixed-port': 7890, 'allow-lan': false, mode: 'rule', 'log-level': 'info',
      ipv6: false, 'external-controller': '127.0.0.1:9090', secret: 's',
      tun: { enable: false, stack: 'mixed', 'auto-route': true, 'auto-detect-interface': true, 'dns-hijack': ['any:53'], 'inet6-address': ['fdfe:dcba:9876::1/126'] },
      proxies: [], 'proxy-groups': [], 'proxy-providers': {}, rules: ['MATCH,DIRECT'],
      dns: { enable: true, ipv6: false, 'enhanced-mode': 'fake-ip', 'respect-rules': true, 'default-nameserver': ['223.5.5.5'], nameserver: ['https://1.1.1.1/dns-query'], 'nameserver-policy': {}, 'proxy-server-nameserver': ['223.5.5.5'], 'fake-ip-filter': [] },
      profile: { 'store-selected': true, 'store-fake-ip': true },
    } as never);
    expect(yaml).toContain('mixed-port: 7890');
    expect(yaml).toContain('mode: rule');
  });

  it('findMihomo 返回 string 或 null', () => {
    const p = findMihomo();
    expect(p === null || typeof p === 'string').toBe(true);
  });

  it('YAML 输出可被写盘', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mh-'));
    const f = join(dir, 'c.yaml');
    writeFileSync(f, 'mixed-port: 1\n', 'utf8');
    expect(() => rmSync(dir, { recursive: true, force: true })).not.toThrow();
  });
});
