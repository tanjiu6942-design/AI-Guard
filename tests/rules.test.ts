import { describe, it, expect } from 'vitest';
import { buildRules } from '../core/config/rules';
import { G_AI } from '../core/config/constants';
import { loadRuleSets } from '../core/domain/rule-source';

const sets: Record<string, string[]> = {
  'claude-core': ['DOMAIN-SUFFIX,claude.ai'],
  'chatgpt-core': ['DOMAIN-SUFFIX,chatgpt.com'],
  'verify-cloudflare': ['DOMAIN,challenges.cloudflare.com'],
};

describe('buildRules', () => {
  it('looks up timezone through the residential exit in every mode', () => {
    for (const mode of ['strict', 'precise', 'global'] as const) {
      expect(buildRules(mode, sets)).toContain('DOMAIN,ipwho.is,AI Guard 专用');
    }
  });
  it('严格模式包含 cloudflare.com 兜底规则', () => {
    const rules = buildRules('strict', sets);
    expect(rules).toContain('DOMAIN-SUFFIX,cloudflare.com,AI Guard 专用');
  });

  it('精确模式不含 cloudflare.com 兜底规则', () => {
    const rules = buildRules('precise', sets);
    expect(rules).not.toContain('DOMAIN-SUFFIX,cloudflare.com,AI Guard 专用');
  });

  it('两种模式都包含 AI 主链路', () => {
    for (const mode of ['strict', 'precise'] as const) {
      const rules = buildRules(mode, sets);
      expect(rules).toContain('DOMAIN-SUFFIX,claude.ai,AI Guard 专用');
      expect(rules).toContain('DOMAIN-SUFFIX,chatgpt.com,AI Guard 专用');
    }
  });

  it('两种模式都包含 challenges.cloudflare.com（人机验证需同 IP）', () => {
    for (const mode of ['strict', 'precise'] as const) {
      const rules = buildRules(mode, sets);
      expect(rules).toContain('DOMAIN,challenges.cloudflare.com,AI Guard 专用');
    }
  });

  it('AI 规则必须排在 MATCH 之前', () => {
    const rules = buildRules('strict', sets);
    const aiIdx = rules.findIndex((r) => r.startsWith('DOMAIN-SUFFIX,claude.ai'));
    const matchIdx = rules.findIndex((r) => r.startsWith('MATCH,'));
    expect(aiIdx).toBeGreaterThanOrEqual(0);
    expect(matchIdx).toBeGreaterThan(aiIdx);
  });

  it('第一条规则是局域网直连', () => {
    const rules = buildRules('strict', sets);
    expect(rules[0]).toBe('GEOIP,private,DIRECT,no-resolve');
  });

  it('全局模式: MATCH 走 AI Guard 专用', () => {
    const rules = buildRules('global', sets);
    expect(rules[rules.length - 1]).toBe('MATCH,AI Guard 专用');
  });

  it('严格/精确模式: MATCH 走普通代理', () => {
    for (const m of ['strict', 'precise'] as const) {
      const rules = buildRules(m, sets);
      expect(rules[rules.length - 1]).toBe('MATCH,普通代理');
    }
  });

  it('全局模式仍保留国内直连, 避免国内站点绕道美国', () => {
    const rules = buildRules('global', sets);
    expect(rules).toContain('GEOSITE,cn,DIRECT');
    expect(rules).toContain('GEOIP,CN,DIRECT');
  });

  it('全局模式仍含 STUN 拦截与局域网直连', () => {
    const rules = buildRules('global', sets);
    expect(rules.some((r) => r.includes('3478/5349/19302'))).toBe(true);
    expect(rules[0]).toBe('GEOIP,private,DIRECT,no-resolve');
  });

  it('桌面版 ChatGPT 的进程规则必须排在域名规则之前', () => {
    for (const m of ['strict', 'precise', 'global'] as const) {
      const rules = buildRules(m, sets);
      const procIdx = rules.findIndex((r) => r.startsWith('PROCESS-NAME,ChatGPT.exe'));
      const domIdx = rules.findIndex((r) => r.startsWith('DOMAIN-SUFFIX,chatgpt.com'));
      expect(procIdx).toBeGreaterThanOrEqual(0);
      expect(domIdx).toBeGreaterThan(procIdx);
    }
  });

  it('网页版域名仍走住宅 IP（不受桌面版规则影响）', () => {
    const rules = buildRules('strict', sets);
    expect(rules).toContain('DOMAIN-SUFFIX,chatgpt.com,AI Guard 专用');
  });

  it('QUIC: 先放行人机验证, 再无条件拦截其余 UDP/443（核心回归：桌面版重连）', () => {
    const rules = buildRules('strict', sets);
    const passIdx = rules.findIndex((r) =>
      r.includes('DST-PORT,443') && r.includes('challenges.cloudflare.com') && r.endsWith(G_AI));
    const blockIdx = rules.findIndex((r) => r === 'AND,((NETWORK,UDP),(DST-PORT,443)),REJECT');

    expect(passIdx).toBeGreaterThanOrEqual(0);
    expect(blockIdx).toBeGreaterThanOrEqual(0);
    // 放行必须排在拦截之前, 否则验证域名的 UDP 会被一起拦掉
    expect(passIdx).toBeLessThan(blockIdx);
  });

  it('DoH 域名与 IP 必须进专用组（防止绕过 dns-hijack 从机场 IP 泄漏）', () => {
    const rules = buildRules('strict', sets);
    // DoH 域名
    expect(rules).toContain('DOMAIN,dns.google,AI Guard 专用');
    expect(rules).toContain('DOMAIN,one.one.one.one,AI Guard 专用');
    // 公共 DNS 的 IP, 带 no-resolve
    for (const ip of ['1.1.1.1/32', '8.8.8.8/32', '9.9.9.9/32']) {
      const hit = rules.find((r) => r.startsWith(`IP-CIDR,${ip}`));
      expect(hit).toBeDefined();
      expect(hit).toContain('AI Guard 专用');
      expect(hit).toContain('no-resolve');
    }
  });

  it('三种模式都包含 DoH 规则', () => {
    for (const m of ['strict', 'precise', 'global'] as const) {
      const rules = buildRules(m, sets);
      expect(rules.some((r) => r.includes('1.1.1.1/32'))).toBe(true);
    }
  });

  it('QUIC 拦截是无条件的, 不依赖域名白名单（否则动态域名会漏网）', () => {
    for (const m of ['strict', 'precise', 'global'] as const) {
      const rules = buildRules(m, sets);
      expect(rules).toContain('AND,((NETWORK,UDP),(DST-PORT,443)),REJECT');
    }
  });

  it('包含 QUIC 拦截规则', () => {
    const rules = buildRules('strict', sets);
    const quic = rules.find((r) => r.startsWith('AND,((NETWORK,UDP),(DST-PORT,443)') && r.includes('REJECT'));
    expect(quic).toBeDefined();
    expect(quic).toContain('REJECT');
  });

  it('完整加载 10 个规则集（包含 gemini-core 与 pay-google）', () => {
    const loaded = loadRuleSets('rules/domains');
    const expectedSets = [
      'chatgpt-core',
      'claude-core',
      'gemini-core',
      'pay-google',
      'login-apple',
      'login-google',
      'login-microsoft',
      'pay-stripe',
      'verify-cloudflare',
      'ip-check',
    ];
    for (const name of expectedSets) {
      expect(loaded[name], `缺少规则集 ${name}`).toBeDefined();
      expect(loaded[name].length).toBeGreaterThan(0);
    }
    // 验证 gemini 与 google 支付关键域名正确解析
    expect(loaded['gemini-core']).toContain('DOMAIN,gemini.google.com');
    expect(loaded['gemini-core']).toContain('DOMAIN,aistudio.google.com');
    expect(loaded['pay-google']).toContain('DOMAIN,one.google.com');
  });
});
