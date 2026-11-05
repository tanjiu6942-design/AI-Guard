import { execFile } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export const TUN_DNS = '198.18.0.2';
export const TUN_DNS6 = 'fdfe:dcba:9876::2';

export interface AdapterBackup {
  index: number;
  name: string;
  servers: string[];
  servers6: string[];
}

export interface DnsBackup {
  at?: string;
  adapters: AdapterBackup[];
  ipv6: boolean;
}

/** 列出在线物理网卡(排除虚拟网卡)并记录当前 DNS */
export function buildListScript(): string {
  return [
    "$ErrorActionPreference = 'SilentlyContinue'",
    "Get-NetAdapter | Where-Object { $_.Status -eq 'Up' -and $_.InterfaceDescription -notmatch 'Meta|Mihomo|Clash|TUN|TAP|WireGuard|Loopback|Hyper-V|VMware|VirtualBox|Bluetooth' } | ForEach-Object {",
    '  $i = $_.ifIndex',
    '  $all = Get-DnsClientServerAddress -InterfaceIndex $i -ErrorAction SilentlyContinue',
    '  $v4 = ($all | Where-Object { $_.AddressFamily -eq 2 }).ServerAddresses',
    '  $v6 = ($all | Where-Object { $_.AddressFamily -eq 23 }).ServerAddresses',
    '  [PSCustomObject]@{ index = $i; name = $_.Name; servers = @($v4); servers6 = @($v6) }',
    '} | ConvertTo-Json -Compress',
  ].join('\n');
}

/**
 * 生成"接管 DNS"的脚本。
 *
 * ⚠️ 两个踩过的坑, 别再改回去:
 *
 * 1. `Set-DnsClientServerAddress` **没有 `-AddressFamily` 参数**
 *    (可用参数只有 InterfaceIndex / InterfaceAlias / InputObject / ServerAddresses
 *     / Validate / ResetServerAddresses)。
 *    曾为了"分开设置 v4/v6"而加上这个参数, 结果每条命令都报
 *    "找不到与参数名称 AddressFamily 匹配的参数" —— 因为脚本里设了
 *    $ErrorActionPreference='SilentlyContinue', 错误被吞掉, 表现为
 *    "DNS 一直没接管", 极难发现。
 *
 * 2. 正确做法: 不带该参数, 把 v4 和 v6 地址一起传给 -ServerAddresses,
 *    PowerShell 会按地址格式**自动归类**到对应地址族 —— 不会混写,
 *    实测结果: AF=2 得到 198.18.0.2, AF=23 得到 fdfe:dcba:9876::2。
 *
 * 早期确实出现过 DNS 混族导致 MediaTek 网卡驱动蓝屏(0x50), 但那是因为
 * 当时把 v4/v6 写进了同一个地址族。自动归类不会产生这个问题。
 */
export function buildApplyScript(ipv6: boolean): string {
  const addrs = ipv6 ? `@('${TUN_DNS}','${TUN_DNS6}')` : `@('${TUN_DNS}')`;
  return [
    "$ErrorActionPreference = 'SilentlyContinue'",
    "Get-NetAdapter | Where-Object { $_.Status -eq 'Up' -and $_.InterfaceDescription -notmatch 'Meta|Mihomo|Clash|TUN|TAP|WireGuard|Loopback|Hyper-V|VMware|VirtualBox|Bluetooth' } | ForEach-Object {",
    '  $i = $_.ifIndex',
    `  Set-DnsClientServerAddress -InterfaceIndex $i -ServerAddresses ${addrs}`,
    '}',
    'Clear-DnsClientCache',
  ].join('\n');
}

/**
 * 生成"恢复 DNS"的脚本。
 *
 * 同样不能带 -AddressFamily。恢复时把原 v4 + v6 地址一起传回去,
 * PowerShell 自动归类。若原本没有 v6, 只需传 v4, v6 会随
 * -ResetServerAddresses 回到 DHCP 下发。
 */
export function buildRestoreScript(backup: DnsBackup): string {
  const lines = [
    "$ErrorActionPreference = 'SilentlyContinue'",
  ];
  for (const a of backup.adapters) {
    const ok4 = (a.servers ?? []).filter((s) => s && s !== TUN_DNS);
    const ok6 = (a.servers6 ?? []).filter((s) => s && s !== TUN_DNS6);

    // 先重置, 清掉隧道残留
    lines.push(`Set-DnsClientServerAddress -InterfaceIndex ${a.index} -ResetServerAddresses`);

    const all = [...ok4, ...ok6];
    if (all.length) {
      const list = all.map((s) => `'${s}'`).join(',');
      lines.push(
        `Set-DnsClientServerAddress -InterfaceIndex ${a.index} -ServerAddresses @(${list})`,
      );
    } else {
      // 原配置就是 DHCP 下发, 重置即可
      lines.push(`Clear-DnsClientCache`);
    }
  }
  lines.push('Clear-DnsClientCache');
  return lines.join('\n');
}

function ps(script: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'powershell',
      ['-NoProfile', '-NonInteractive', '-Command', `[Console]::OutputEncoding = [Text.Encoding]::UTF8; ${script}`],
      { windowsHide: true, timeout: 20000 },
      (e, stdout, stderr) => {
        if (e) reject(new Error(String(stderr || e.message).trim()));
        else resolve(String(stdout ?? ''));
      },
    );
  });
}

export async function listAdapters(): Promise<AdapterBackup[]> {
  const out = await ps(buildListScript());
  const raw = JSON.parse(out.trim() || '[]');
  const arr = Array.isArray(raw) ? raw : [raw];
  return arr.map((a: Record<string, unknown>) => ({
    index: Number(a.index),
    name: String(a.name),
    servers: (a.servers as string[]) ?? [],
    servers6: (a.servers6 as string[]) ?? [],
  }));
}

export async function apply(backupPath: string, ipv6: boolean): Promise<string[]> {
  // 已有备份说明上次没恢复干净, 先按备份还原再重新接管
  if (existsSync(backupPath)) {
    const prev = JSON.parse(readFileSync(backupPath, 'utf8')) as DnsBackup;
    await ps(buildRestoreScript(prev)).catch(() => {});
  }

  const adapters = await listAdapters();
  if (!adapters.length) return [];

  const backup: DnsBackup = { at: new Date().toISOString(), adapters, ipv6 };
  mkdirSync(dirname(backupPath), { recursive: true });
  writeFileSync(backupPath, JSON.stringify(backup, null, 2), 'utf8');

  await ps(buildApplyScript(ipv6));
  return adapters.map((a) => a.name);
}

export async function restore(backupPath: string): Promise<void> {
  if (!existsSync(backupPath)) return;
  const backup = JSON.parse(readFileSync(backupPath, 'utf8')) as DnsBackup;
  await ps(buildRestoreScript(backup));
}
