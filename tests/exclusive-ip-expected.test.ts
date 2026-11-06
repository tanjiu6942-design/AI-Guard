import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { runAiRouteChecks } from '../core/doctor/ai-route-report';

/**
 * 回归: 「独享 IP」永远显示 unknown。
 *
 * desktop/worker.mjs 调用 runAiRouteChecks 时把 expectedEgressIp 写死成 null：
 *
 *   expectedIp: settings.residential?.server ?? '',
 *   expectedEgressIp: null,          // ← 写死
 *
 * 而 ai-route-report.ts 见到 null 就直接返回 unknown。
 * 结果: 不管出口多正确, 这一项永远是"未知"。
 *
 * 原意图是防"residential.server 填的是 SOCKS 网关地址、不是最终出口"。
 * 但同一个字段在 service.mjs(CLI 体检) 和 health.mjs(实时保护) 都被
 * 当作出口预期使用, README 也明确要求"应填住宅 IP（不是域名）"。
 * 只有 AI 线路这一处不信任它 —— 属于不一致, 不是设计。
 *
 * 修法: 字段是 IPv4 字面量时传它作为预期; 域名/空值时仍传 null(保持无法核对)。
 */
const worker = readFileSync(new URL('../desktop/worker.mjs', import.meta.url), 'utf8');

/** 从 worker.mjs 里抽出 aiRoute 调用的那段，检查它如何计算 expectedEgressIp */
function aiRouteBlock(): string {
  const start = worker.indexOf('runAiRouteChecks(');
  expect(start).toBeGreaterThan(-1);
  return worker.slice(start, start + 600);
}

describe('独享 IP: 调用方必须传真实出口预期', () => {
  it('worker.mjs 不再把 expectedEgressIp 写死为 null', () => {
    expect(aiRouteBlock()).not.toMatch(/expectedEgressIp:\s*null/);
  });

  it('worker.mjs 会用 residential.server 推导预期(仅 IPv4 字面量)', () => {
    const block = aiRouteBlock();
    expect(block).toMatch(/expectedEgressIp/);
    // 必须有 IPv4 判定，避免把域名当 IP 比对
    expect(block).toMatch(/residentialIsIp|\^\\d\{1,3\}/);
  });
});

describe('runAiRouteChecks 本身的语义(不变)', () => {
  const trace = (ip: string) => `ip=${ip}\nloc=US\nts=1\n`;
  const base = (extra: Record<string, unknown>) => ({
    fetchFn: async () => ({ ok: true, status: 200, text: async () => trace('203.0.113.7') }),
    expectedIp: '203.0.113.7',
    controllerGet: undefined,
    ...extra,
  });

  it('expectedEgressIp 为 null 时如实报 unknown', async () => {
    const items = await runAiRouteChecks(base({ expectedEgressIp: null }) as never);
    expect(items.find((x) => x.key === 'exclusive')?.state).toBe('unknown');
  });

  it('预期与出口一致时判 ok', async () => {
    const items = await runAiRouteChecks(base({ expectedEgressIp: '203.0.113.7' }) as never);
    const item = items.find((x) => x.key === 'exclusive');
    expect(item?.state).toBe('ok');
    expect(item?.detail).toContain('203.0.113.7');
  });

  it('预期与出口不符时判 fail', async () => {
    const items = await runAiRouteChecks(base({ expectedEgressIp: '198.51.100.9' }) as never);
    expect(items.find((x) => x.key === 'exclusive')?.state).toBe('fail');
  });
});
