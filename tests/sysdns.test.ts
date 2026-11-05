import { describe, it, expect } from 'vitest';
import { TUN_DNS, TUN_DNS6, buildApplyScript, buildRestoreScript, buildCleanupResidualDnsScript, buildListScript } from '../core/runtime/sysdns';

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

  it('物理网卡仅接管 IPv4 TUN_DNS，保持 IPv6 纯净（对齐商用策略防蓝屏与校园网审计）', () => {
    expect(buildApplyScript(true)).toContain(TUN_DNS);
    expect(buildApplyScript(true)).not.toContain(TUN_DNS6);
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

  it('网卡只传 IPv4 地址，由系统自动清空 IPv6 DNS', () => {
    const s6 = buildApplyScript(true);
    expect(s6).toContain('198.18.0.2');
    expect(s6).not.toContain('fdfe:dcba:9876::2');
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

  it('保底清理脚本包含隧道 DNS 判定与重置命令', () => {
    const s = buildCleanupResidualDnsScript();
    expect(s).toContain(TUN_DNS);
    expect(s).toContain(TUN_DNS6);
    expect(s).toContain('ResetServerAddresses');
    expect(s).toContain('Clear-DnsClientCache');
  });

  it('网卡列表采集时过滤掉隧道 DNS，防止备份被污染', () => {
    const s = buildListScript();
    expect(s).toContain(TUN_DNS);
    expect(s).toContain(TUN_DNS6);
  });
});
