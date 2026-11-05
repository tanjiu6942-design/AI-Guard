import type { CheckResult, FetchFn } from './types.js';

/**
 * DNS 泄漏检测。
 *
 * 有三层保护机制, 检测必须逐层考虑, 否则会误报:
 *
 * 1. **网卡 DNS 接管**: 把物理网卡 DNS 改成 198.18.0.2 / fdfe:dcba:9876::2
 * 2. **TUN dns-hijack**: mihomo 的 `dns-hijack: ["any:53"]` 会劫持
 *    **任何**发往 53 端口的查询, 无论目标是哪个 DNS 服务器
 * 3. **HTTP 出口地区对照**: 作为最终佐证
 *
 * 踩过的坑: 早期只检查第 1 层, 于是当网卡 DNS 因 DHCP 刷新又变回
 * 114.114.114.114 时, 检测器直接报 fail —— 但实测向 114.114.114.114、
 * 8.8.8.8、系统默认分别查询 AI 域名, **全部返回 fake-ip**,
 * 说明 dns-hijack 仍然生效, 根本没泄漏。误报会让人白折腾。
 *
 * 所以现在: 第 1 层未接管时, 不立刻判 fail, 而是做第 2 层探测。
 */
export interface DnsServerEntry {
  iface: string;
  family: 4 | 6;
  servers: string[];
}

export type DnsServerReader = () => Promise<DnsServerEntry[]>;

/**
 * 探测 dns-hijack 是否生效: 向一个**公网 DNS** 查 AI 域名,
 * 若返回 fake-ip(198.18.0.0/16 或 fdfe:dcba:9876::/48), 说明查询被劫持。
 *
 * 由调用方注入, 因为要做真实 DNS 查询(core/ 保持纯逻辑)。
 * 返回: true=被劫持(安全) / false=未劫持(可能泄漏) / null=无法判断
 */
export type HijackProbe = () => Promise<boolean | null>;

const PROBE_HOST = process.env.AIGUARD_DNS_PROBE ?? 'www.cloudflare.com';

/** 判断一个 DNS 地址是否属于"已被接管"的安全值 */
export function isTunnelDns(addr: string): boolean {
  const a = addr.trim().toLowerCase();
  return a === '198.18.0.2' || a === 'fdfe:dcba:9876::2';
}

/** 判断是否是内网/本地地址(这些不算泄漏) */
function isLocalDns(addr: string): boolean {
  const a = addr.trim().toLowerCase();
  return (
    a === '127.0.0.1' ||
    a === '::1' ||
    /^192\.168\./.test(a) ||
    /^10\./.test(a) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(a) ||
    /^169\.254\./.test(a) ||
    /^fe80:/.test(a)
  );
}

/** 判断是否是 mihomo 的 fake-ip 段 */
function isFakeIp(addr: string): boolean {
  return /^198\.18\./.test(addr) || /^fdfe:dcba:9876:/i.test(addr);
}

export async function checkDnsLeak(
  fetchFn: FetchFn,
  expectedCountry: string,
  readServers?: DnsServerReader,
  hijackProbe?: HijackProbe,
): Promise<CheckResult> {
  let leaked: string[] = [];
  let nicTakenOver = false;

  // ── 第 1 层: 网卡 DNS 配置 ──
  if (readServers) {
    try {
      const entries = await readServers();
      for (const e of entries) {
        for (const s of e.servers) {
          if (!s || isTunnelDns(s) || isLocalDns(s)) continue;
          leaked.push(`${s} (${e.iface} IPv${e.family})`);
        }
      }
      nicTakenOver = leaked.length === 0;
    } catch (e) {
      if (process.env.AIGUARD_DEBUG) {
        console.error('[dns] 读取网卡失败: ' + (e as Error).message);
      }
    }
  }

  // 网卡已接管 → 直接通过, 无需再做探测
  if (nicTakenOver) {
    return {
      key: 'dns',
      title: 'DNS 泄漏',
      state: 'ok',
      detail: '网卡 DNS 已全部接管 (198.18.0.2 / fdfe:dcba:9876::2)',
    };
  }

  // ── 第 2 层: 网卡未接管, 但可能被 TUN 的 dns-hijack 兜住 ──
  if (leaked.length > 0 && hijackProbe) {
    let hijacked: boolean | null = null;
    try {
      hijacked = await hijackProbe();
    } catch (e) {
      if (process.env.AIGUARD_DEBUG) {
        console.error('[dns] 劫持探测失败: ' + (e as Error).message);
      }
    }

    if (hijacked === true) {
      return {
        key: 'dns',
        title: 'DNS 泄漏',
        state: 'ok',
        detail:
          `网卡 DNS 未接管 (${leaked.join('、')}), 但 TUN 的 dns-hijack 生效: ` +
          '向公网 DNS 的查询被拦截并返回 fake-ip, 真实解析请求未出网',
      };
    }

    if (hijacked === null) {
      return {
        key: 'dns',
        title: 'DNS 泄漏',
        state: 'unknown',
        detail:
          `网卡 DNS 未接管 (${leaked.join('、')}), 且劫持探测失败, 无法判断`,
      };
    }
  }

  // 网卡未接管且劫持未生效 → 真泄漏
  if (leaked.length > 0) {
    return {
      key: 'dns',
      title: 'DNS 泄漏',
      state: 'fail',
      detail:
        `网卡 DNS 未被接管, 且 dns-hijack 未生效: ${leaked.join('、')}。` +
        '这些查询会直接送到运营商, AI 站点能看到你的真实位置',
    };
  }

  // ── 第 3 层: HTTP 出口地区对照(读不到网卡配置时的兜底) ──
  try {
    const res = await fetchFn(`https://${PROBE_HOST}/cdn-cgi/trace`, {
      signal: AbortSignal.timeout(8000),
      cache: 'no-store',
    } as RequestInit);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const text = await res.text();
    const ip = /^ip=(.+)$/m.exec(text)?.[1]?.trim();
    const loc = /^loc=(.+)$/m.exec(text)?.[1]?.trim();

    if (!ip) {
      return {
        key: 'dns',
        title: 'DNS 泄漏',
        state: 'unknown',
        detail: '探测服务未返回有效数据',
      };
    }
    if (expectedCountry && loc && loc !== expectedCountry) {
      return {
        key: 'dns',
        title: 'DNS 泄漏',
        state: 'warn',
        detail: `${PROBE_HOST} 出口在 ${loc}, 与预期 ${expectedCountry} 不一致`,
      };
    }
    return {
      key: 'dns',
      title: 'DNS 泄漏',
      state: 'ok',
      detail: `出口地区一致 (${loc ?? '未知'})`,
    };
  } catch (e) {
    return {
      key: 'dns',
      title: 'DNS 泄漏',
      state: 'unknown',
      detail: '连不上探测服务: ' + (e as Error).message,
    };
  }
}
