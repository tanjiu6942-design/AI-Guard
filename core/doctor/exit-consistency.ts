import type { CheckResult, FetchFn } from './types.js';

export interface ExitTarget {
  host: string;
  label: string;
  /** trace 端点路径; 不填则视为裸 IP 回显(直接返回纯 IP 文本) */
  path?: string;
}

/**
 * 默认探测目标: 只用不带账号语义、且**属于 AI 规则覆盖范围**的公开端点。
 *
 * 两个约束同时成立才行:
 * 1. 不碰 claude.ai / chatgpt.com —— 那是用户的线上账号环境, 用户不愿工具向其发请求。
 * 2. 必须是规则里会走"AI Guard 专用"的域名 —— 否则它命中 MATCH 走机场,
 *    测出来必然不一致, 那是探测目标选错, 不是配置有问题。
 *
 * 三个都在严格模式的 cloudflare.com 兜底范围内, 且都是公开无账号端点。
 */
export const DEFAULT_TARGETS: ExitTarget[] = [
  { host: 'www.cloudflare.com', label: 'cloudflare', path: '/cdn-cgi/trace' },
  { host: 'challenges.cloudflare.com', label: 'challenges', path: '/cdn-cgi/trace' },
  { host: 'cloudflare-dns.com', label: 'cloudflare-dns', path: '/cdn-cgi/trace' },
];

async function traceIp(fetchFn: FetchFn, t: ExitTarget): Promise<string | null> {
  try {
    const url = `https://${t.host}${t.path ?? '/'}`;
    const res = await fetchFn(url, {
      signal: AbortSignal.timeout(10000),
      cache: 'no-store',
    } as RequestInit);
    if (!res.ok) return null;
    const text = await res.text();

    // trace 端点返回 ip=xxx 行; 裸 IP 端点直接返回纯 IP
    const m = /^ip=(.+)$/m.exec(text);
    if (m) return m[1].trim();

    const bare = text.trim();
    return /^\d{1,3}(\.\d{1,3}){3}$/.test(bare) ? bare : null;
  } catch (e) {
    if (process.env.AIGUARD_DEBUG) {
      console.error(`[trace] ${t.host}${t.path ?? '/'} -> ${(e as Error).message}`);
    }
    return null;
  }
}

export async function checkExitConsistency(
  fetchFn: FetchFn,
  expectedIp: string,
  targets: ExitTarget[] = DEFAULT_TARGETS,
): Promise<CheckResult> {
  const results = await Promise.all(
    targets.map(async (t) => ({ ...t, ip: await traceIp(fetchFn, t) })),
  );

  const failed = results.filter((r) => !r.ip);
  const got = results.filter((r) => r.ip);

  if (got.length === 0) {
    return {
      key: 'exit',
      title: '出口一致性',
      state: 'unknown',
      detail: '所有目标站点都无法访问, 无法判断出口',
    };
  }

  const distinct = [...new Set(got.map((r) => r.ip))];

  if (distinct.length > 1) {
    const desc = got.map((r) => `${r.label}=${r.ip}`).join(', ');
    return {
      key: 'exit',
      title: '出口一致性',
      state: 'fail',
      detail: `出口 IP 不一致: ${desc}。这会让 AI 服务看到跳变的来源, 是最典型的风控特征`,
    };
  }

  const ip = distinct[0]!;
  if (expectedIp && ip !== expectedIp) {
    return {
      key: 'exit',
      title: '出口一致性',
      state: 'fail',
      detail: `出口是 ${ip}, 但预期是 ${expectedIp}`,
    };
  }

  if (failed.length > 0) {
    return {
      key: 'exit',
      title: '出口一致性',
      state: 'warn',
      detail: `一致 (${ip}), 但 ${failed.map((f) => f.label).join('、')} 未响应`,
    };
  }

  return {
    key: 'exit',
    title: '出口一致性',
    state: 'ok',
    detail: `全部一致: ${ip}`,
  };
}
