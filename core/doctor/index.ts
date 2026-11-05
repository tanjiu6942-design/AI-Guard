import type { CheckResult, DoctorReport, CheckState, FetchFn } from './types.js';
import { checkExitConsistency } from './exit-consistency.js';
import { checkDnsLeak, type DnsServerReader, type HijackProbe } from './dns-leak.js';
import { checkIpv6, type Ipv6SnapshotReader } from './ipv6.js';
import { checkWebrtc } from './webrtc.js';
import { checkLongConnection, type ConnectProbe } from './long-connection.js';
import { checkConflict, type ProcessLister } from './conflict.js';

export * from './types.js';
export * from './ai-route.js';
export * from './ai-route-report.js';

export interface DoctorOptions {
  fetchFn: FetchFn;
  expectedIp: string;
  expectedCountry: string;
  hasIpv6: boolean;
  ipv6Probe?: () => Promise<string | null>;
  webrtcObserved: string | null;
  longConnProbe: ConnectProbe;
  idleMs: number;
  processLister: ProcessLister;
  /** 网络是否可正常访问; 用来区分 "STUN 被拦截" 和 "网络根本不通" */
  networkOk?: boolean;
  /** TUN 是否开启; 非 TUN 时 STUN 的 UDP 不经过代理, 泄漏属架构限制 */
  tunEnabled?: boolean;
  /** AI Guard 自身内核的 PID 列表(由监听端口反查), 不计入冲突 */
  ownPids?: number[];
  /** 读物理网卡 DNS 配置; 传入则能做权威的 DNS 泄漏判断 */
  readDnsServers?: DnsServerReader;
  /** 探测 TUN 的 dns-hijack 是否生效(网卡 DNS 未接管时的兜底判断) */
  dnsHijackProbe?: HijackProbe;
  /** 读 IPv6 网卡与路由配置; 传入则能做权威的 IPv6 泄漏判断 */
  ipv6Snapshot?: Ipv6SnapshotReader;
}

const SEVERITY: Record<CheckState, number> = { ok: 0, warn: 1, unknown: 2, fail: 3 };

export async function runDoctor(opts: DoctorOptions): Promise<DoctorReport> {
  const items: CheckResult[] = await Promise.all([
    checkExitConsistency(opts.fetchFn, opts.expectedIp),
    checkDnsLeak(opts.fetchFn, opts.expectedCountry, opts.readDnsServers, opts.dnsHijackProbe),
    checkIpv6(opts.hasIpv6, opts.ipv6Probe, opts.ipv6Snapshot),
    checkWebrtc(opts.webrtcObserved, opts.expectedIp, opts.networkOk ?? false, opts.tunEnabled ?? false),
    checkLongConnection(opts.longConnProbe, opts.idleMs),
    checkConflict(opts.processLister, opts.ownPids),
  ]);

  const overall = items.reduce<CheckState>(
    (worst, i) => (SEVERITY[i.state] > SEVERITY[worst] ? i.state : worst),
    'ok',
  );

  return { at: new Date().toISOString(), items, overall };
}