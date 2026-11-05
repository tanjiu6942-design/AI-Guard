export interface PatchFinding {
  domain: string;
  count: number;
  actualGroup: string;
  suggestedRule: string;
}

const LOG_LINE = /-->\s+([a-zA-Z0-9.-]+):\d+\s+match\s+.*?\s+using\s+([^\[]+?)\s*(?:\[([^\]]*)\])?\s*"?\s*$/;

/** 判断域名是否属于某个 AI 域名后缀 */
function belongsTo(domain: string, suffixes: string[]): string | null {
  for (const s of suffixes) {
    if (domain === s || domain.endsWith(`.${s}`)) return s;
  }
  return null;
}

export function analyzeLog(logText: string, aiDomains: string[]): PatchFinding[] {
  const bad = new Map<string, { count: number; group: string; suffix: string }>();

  for (const raw of logText.split(/\r?\n/)) {
    const m = LOG_LINE.exec(raw);
    if (!m) continue;
    const [, domain, group] = m;
    // 被主动阻断的请求没有发往其他出口, 例如强制 QUIC 回退 TCP 的 UDP/443。
    if (group === 'REJECT' || group === 'REJECT-DROP') continue;
    // 走了专用组说明正确
    if (group.includes('AI Guard')) continue;
    const suffix = belongsTo(domain, aiDomains);
    if (!suffix) continue;
    const cur = bad.get(domain);
    if (cur) cur.count += 1;
    else bad.set(domain, { count: 1, group, suffix });
  }

  return [...bad.entries()]
    .map(([domain, v]) => ({
      domain,
      count: v.count,
      actualGroup: v.group,
      // 建议用所属后缀兜底, 而非单个域名
      suggestedRule: `DOMAIN-SUFFIX,${v.suffix}`,
    }))
    .sort((a, b) => b.count - a.count);
}
