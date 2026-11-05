import { describe, it, expect } from 'vitest';
import { TUN_DNS, TUN_DNS6, buildApplyScript, buildRestoreScript } from '../core/runtime/sysdns';

describe('系统 DNS 接管', () => {
  it('TUN DNS 地址符合规范', () => {
    expect(TUN_DNS).toBe('198.18.0.2');
    expect(TUN_DNS6).toBe('fdfe:dcba:9876::2');
  });

  it('应用脚本排除虚拟网卡', () => {
    const s = buildApplyScript(true);
    expect(s).toContain('Meta');
    expect(s).toContain('Mihomo');
    expect(s).toContain(TUN_DNS);
  });

  it('含 IPv6 时脚本包含 TUN_DNS6', () => {
    expect(buildApplyScript(true)).toContain(TUN_DNS6);
  });

  it('绝不能使用 -AddressFamily 参数（该参数不存在，会让命令静默失败）', () => {
    // Set-DnsClientServerAddress 没有 -AddressFamily; 曾因加上它导致
    // 每条命令都报"找不到参数", 但被 SilentlyContinue 吞掉,
    // 表现为 DNS 永远接管不上。
    expect(buildApplyScript(true)).not.toContain('AddressFamily');
    expect(buildApplyScript(false)).not.toContain('AddressFamily');
    const backup = { adapters: [{ index: 19, name: 'WLAN', servers: ['1.1.1.1'], servers6: [] }], ipv6: false };
    expect(buildRestoreScript(backup)).not.toContain('AddressFamily');
  });

  it('IPv6 地址与 IPv4 地址一起传给 -ServerAddresses（由 PowerShell 自动归类）', () => {
    const s6 = buildApplyScript(true);
    expect(s6).toContain('198.18.0.2');
    expect(s6).toContain('fdfe:dcba:9876::2');
    // 一条命令里同时给出两种地址
    const cmd = s6.split('\n').find((l) => l.includes('Set-DnsClientServerAddress'));
    expect(cmd).toMatch(/198\.18\.0\.2.*fdfe:dcba:9876::2/);
  });

  it('不接管 IPv6 时只传 IPv4 地址', () => {
    const s4 = buildApplyScript(false);
    expect(s4).toContain('198.18.0.2');
    expect(s4).not.toContain('fdfe:dcba:9876::2');
  });



  it('恢复脚本使用备份中的原始 DNS', () => {
    const s = buildRestoreScript({
      adapters: [{ index: 19, name: 'WLAN', servers: ['8.8.8.8'], servers6: ['2001:db8::1'] }],
      ipv6: true,
    });
    expect(s).toContain('8.8.8.8');
    expect(s).toContain('19');
  });
});
