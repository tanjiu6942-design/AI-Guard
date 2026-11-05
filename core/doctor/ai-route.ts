import { isIP } from 'node:net';
import type { CheckResult, FetchFn } from './types.js';
import { G_AI } from '../config/constants.js';
import { RESIDENTIAL_PROXY_NAME } from '../config/groups.js';

/** mihomo 代理组快照（来自 GET /proxies/<组名>） */
export interface GroupSnapshot {
  type?: string;   // 'Fallback' | 'Selector' | 'URLTest'
  now?: string;
  all?: string[];  // 成员名列表
}

/** mihomo 规则快照（来自 GET /rules） */
export interface RuleSnapshot {
  type?: string;   // 'ProcessName' | 'DomainSuffix' | 'Domain' | ...
  payload?: string;
  proxy?: string;
}

/** mihomo 运行时连接快照（来自 GET /connections） */
export interface ConnectionSnapshot {
  process?: string;
  host?: string;
  /** 从出口到入口，例如 ['AI Guard · 独享 IP', 'AI Guard 专用'] */
  chains?: string[];
}

export interface ClaudeRouteFacts {
  rules: RuleSnapshot[];
  connections: ConnectionSnapshot[] | null;
  aiGroup?: string;          // 缺省用 G_AI
  residentialName?: string;  // 缺省用 RESIDENTIAL_PROXY_NAME
}

export interface KillSwitchFacts {
  groupType?: string | null;
  groupMembers?: string[] | null;
  guardNodeNames?: string[] | null;
  aiGroup?: string;
}

/** Claude Code 相关进程名（Windows） */
export const CLAUDE_CODE_PROCESSES = ['claude.exe', 'Claude.exe', 'Claude Helper'];
/** Claude 相关域名 */
export const CLAUDE_CODE_DOMAINS = ['claude.ai', 'anthropic.com'];

/** 仅接受有效 IP，IPv6 使用 URL 的规范形式比较。 */
function normalizeIp(value: string): string | null {
  if (!isIP(value)) return null;
  return isIP(value) === 6 ? new URL(`http://[${value}]/`).hostname : value;
}

function parseTraceIp(text: string): string | null {
  // HTML 错误页面不能作为 trace 证据。
  if (/<[a-z!/]/i.test(text)) return null;
  const ip = /^ip=([^\r\n]+)$/m.exec(text)?.[1]?.trim();
  return ip && isIP(ip) ? ip : null;
}

/**
 * 探测出口 IP。
 *
 * 走 cloudflare 的 /cdn-cgi/trace: 它在响应体里回一行 `ip=1.2.3.4`,
 * 是公开无账号端点, 不会碰用户的线上账号环境。
 * 探测失败一律返回 null 而不是抛错 —— 体检项只需要"知道结果"，
 * 失败原因由上层决定是判 unknown 还是 fail。
 */
export async function probeTraceIp(fetchFn: FetchFn, url: string): Promise<string | null> {
  try {
    const res = await fetchFn(url, {
      signal: AbortSignal.timeout(10000),
      cache: 'no-store',
    } as RequestInit);
    if (!res.ok) return null;
    const text = await res.text();
    return parseTraceIp(text);
  } catch {
    return null;
  }
}

/** 出口 IP 是否就是用户配置的那个独享 IP */
export function checkExclusiveIp(observedIp: string | null, expectedIp: string): CheckResult {
  // 网关地址不能作为预期出口；调用方应传真实的出口 IP。
  if (!normalizeIp(expectedIp)) {
    return {
      key: 'exclusive',
      title: '独享 IP',
      state: 'unknown',
      detail: '未配置住宅 IP，无法核对独享出口',
    };
  }
  if (!observedIp || !normalizeIp(observedIp)) {
    return {
      key: 'exclusive',
      title: '独享 IP',
      state: 'unknown',
      detail: '未能获取出口 IP',
    };
  }
  if (normalizeIp(observedIp) !== normalizeIp(expectedIp)) {
    return {
      key: 'exclusive',
      title: '独享 IP',
      state: 'fail',
      detail: `出口是 ${observedIp}，不是你的独享 IP ${expectedIp}`,
    };
  }
  return {
    key: 'exclusive',
    title: '独享 IP',
    state: 'ok',
    detail: `出口即你的独享 IP ${observedIp}`,
  };
}

/**
 * 断网保护: 住宅 IP 失效时, 流量到底是被阻断, 还是回落直连。
 *
 * 依据是 mihomo 代理组的类型语义:
 *   - Fallback 组按成员的健康检查依次选, 前面的挂了会退到下一个 ——
 *     把"阻断节点"排在住宅 IP 后面, 住宅 IP 一挂就切到阻断节点(连不存在的端口)。
 *   - Selector 组是手动选, 不会自动切, 住宅 IP 挂了流量就直接断, 不会泄漏,
 *     但也不会自动切到阻断节点, 语义和 Fallback 不同。
 * 所以组类型必须是 Fallback, 否则"住宅 IP 失效即阻断"这条保证不存在。
 */
export function checkKillSwitch(facts: KillSwitchFacts): CheckResult {
  if (!facts.groupType) {
    return {
      key: 'killswitch',
      title: '断网保护',
      state: 'unknown',
      detail: '无法读取内核代理组状态',
    };
  }
  if (facts.groupType !== 'Fallback') {
    return {
      key: 'killswitch',
      title: '断网保护',
      state: 'fail',
      detail: `AI Guard 专用 组类型为 ${facts.groupType}，住宅 IP 失效时不会自动切换到阻断节点`,
    };
  }
  // 阻断节点缺失 = 底线破了。
  // 组一旦为空, mihomo 会给它填上 COMPATIBLE, 而 COMPATIBLE 就是直连 ——
  // 那正是"住宅 IP 失效后流量裸奔"的场景, 必须判 fail 而不是 unknown。
  if (!facts.guardNodeNames || facts.guardNodeNames.length === 0) {
    return {
      key: 'killswitch',
      title: '断网保护',
      state: 'fail',
      detail: '内核缺少阻断节点，独享 IP 失效时流量会直连泄漏',
    };
  }
  if (!facts.groupMembers) {
    return {
      key: 'killswitch',
      title: '断网保护',
      state: 'unknown',
      detail: '无法读取内核代理组成员',
    };
  }
  const guardInGroup = facts.guardNodeNames.some((n) => facts.groupMembers!.includes(n));
  if (!guardInGroup) {
    return {
      key: 'killswitch',
      title: '断网保护',
      state: 'fail',
      detail: '阻断节点未加入 AI Guard 专用 组',
    };
  }
  return {
    key: 'killswitch',
    title: '断网保护',
    state: 'ok',
    detail: '住宅 IP 失效时流量会被阻断，不会回落直连',
  };
}

/** 是否存在"进程名 -> aiGroup"的规则 */
function hasProcessRule(rules: RuleSnapshot[], processName: string, aiGroup: string): boolean {
  return rules.some(
    (r) => r.type === 'ProcessName' && r.payload === processName && r.proxy === aiGroup,
  );
}

/** 是否存在"域名 -> aiGroup"的规则(DomainSuffix 与 Domain 都认) */
function hasDomainRule(rules: RuleSnapshot[], domain: string, aiGroup: string): boolean {
  return rules.some(
    (r) =>
      (r.type === 'DomainSuffix' || r.type === 'Domain') &&
      r.payload === domain &&
      r.proxy === aiGroup,
  );
}

/**
 * 这条连接算不算 Claude 的流量。
 *
 * 进程名按大小写不敏感匹配: Windows 上实际落盘的大小写不受控
 * (claude.exe / Claude.exe 都见过)。
 * 域名按后缀匹配并要求点号边界, 否则 "notanthropic.com" 会被误判成 Claude 流量。
 */
function isClaudeConnection(conn: ConnectionSnapshot): boolean {
  const proc = conn.process?.toLowerCase();
  if (proc && CLAUDE_CODE_PROCESSES.some((p) => p.toLowerCase() === proc)) return true;
  const host = conn.host?.toLowerCase();
  if (!host) return false;
  return CLAUDE_CODE_DOMAINS.some((d) => {
    const domain = d.toLowerCase();
    return host === domain || host.endsWith('.' + domain);
  });
}

/**
 * Claude Code 的流量到底走没走独享 IP。
 *
 * 分两层看, 缺一不可:
 *   - 规则层: 内核里必须有"进程名/域名 -> AI Guard 专用"的规则,
 *     否则新起的 Claude Code 进程根本不会被导向专用组。
 *   - 运行时层: 光有规则不够 —— 连接快照是**实际发生**的链路,
 *     它能证明规则真的生效了; 规则层齐了但运行时看到 Claude 流量走了别的链,
 *     说明有别的规则抢先命中了。
 */
export function checkClaudeCodeRoute(facts: ClaudeRouteFacts): CheckResult {
  const aiGroup = facts.aiGroup ?? G_AI;
  const residentialName = facts.residentialName ?? RESIDENTIAL_PROXY_NAME;

  const missing: string[] = [];
  for (const p of CLAUDE_CODE_PROCESSES) {
    if (!hasProcessRule(facts.rules, p, aiGroup)) missing.push(p);
  }
  for (const d of CLAUDE_CODE_DOMAINS) {
    if (!hasDomainRule(facts.rules, d, aiGroup)) missing.push(`DOMAIN ${d}`);
  }
  if (missing.length > 0) {
    return {
      key: 'claude-code',
      title: 'Claude Code 线路',
      state: 'fail',
      detail: `缺少 Claude 线路规则：${missing.join('、')}`,
    };
  }

  if (facts.connections === null) {
    return { key: 'claude-code', title: 'Claude Code 线路', state: 'unknown',
      detail: 'Claude Code 规则已就绪，但无法读取内核连接，无法验证实际链路' };
  }
  const claudeConns = facts.connections.filter(isClaudeConnection);
  for (const conn of claudeConns) {
    const chains = conn.chains ?? [];
    if (!chains.includes(residentialName)) {
      const chainText = chains.join(' → ');
      return {
        key: 'claude-code',
        title: 'Claude Code 线路',
        state: 'fail',
        detail: `Claude Code 流量走了 ${chainText}，未经过独享 IP`,
      };
    }
  }

  if (claudeConns.length === 0) {
    return {
      key: 'claude-code', title: 'Claude Code 线路', state: 'warn',
      detail: 'Claude Code 规则已就绪；当前没有 Claude 活跃连接，等待产生连接后验证实际链路',
    };
  }
  return {
    key: 'claude-code', title: 'Claude Code 线路', state: 'ok',
    detail: `Claude Code 的规则与运行时链路都走 ${aiGroup} → ${residentialName}`,
  };
}

/**
 * claude.ai 的公开 Cloudflare trace 观察到的来源地址。
 * 比较独立探测的住宅出口；这不是对 Claude Code 后端 API 的验证。
 */
export async function checkClaudeIp(fetchFn: FetchFn, expectedIp: string): Promise<CheckResult> {
  // 缺少有效的住宅出口基准时不能进行比较。
  if (!normalizeIp(expectedIp)) {
    return {
      key: 'claude-ip',
    title: 'Claude 看到的 IP',
      state: 'unknown',
      detail: '未配置住宅 IP，无法核对 Claude 看到的出口',
    };
  }
  let res: Response;
  try {
    res = await fetchFn('https://claude.ai/cdn-cgi/trace', {
      signal: AbortSignal.timeout(10000),
      cache: 'no-store',
    } as RequestInit);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      key: 'claude-ip',
    title: 'Claude 看到的 IP',
      state: 'unknown',
      detail: `未能获取 Claude 侧出口信息：${msg}`,
    };
  }
  if (!res.ok) {
    return {
      key: 'claude-ip',
    title: 'Claude 看到的 IP',
      state: 'unknown',
      detail:
        typeof res.status === 'number'
          ? `Claude 侧探测返回 HTTP ${res.status}`
          : 'Claude 侧探测失败',
    };
  }
  let text: string;
  try {
    text = await res.text();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      key: 'claude-ip',
    title: 'Claude 看到的 IP',
      state: 'unknown',
      detail: `未能获取 Claude 侧出口信息：${msg}`,
    };
  }
  const ip = parseTraceIp(text);
  if (!ip) {
    return {
      key: 'claude-ip',
    title: 'Claude 看到的 IP',
      state: 'unknown',
      detail: 'Claude 侧未返回出口信息',
    };
  }
  if (normalizeIp(ip) !== normalizeIp(expectedIp)) {
    return {
      key: 'claude-ip',
    title: 'Claude 看到的 IP',
      state: 'fail',
      detail: `claude.ai 的 Cloudflare 边缘观察到 ${ip}，与住宅出口 ${expectedIp} 不一致；未验证 Claude Code 后端 API`,
    };
  }
  return {
    key: 'claude-ip',
    title: 'Claude 看到的 IP',
    state: 'ok',
    detail: `claude.ai 的 Cloudflare 边缘观察到 ${ip}，与住宅出口一致；未验证 Claude Code 后端 API`,
  };
}
