import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const worker = readFileSync(new URL('../desktop/worker.mjs', import.meta.url), 'utf8');

/**
 * 回归: 配置热重载失败时主动 kill 内核。
 *
 * 现场(2026-11-06 07:05:13): 探针全部 fetch failed -> configure 失败 ->
 * catch 里 rawChild.kill() -> "mihomo 已退出" -> 紧接着
 * "触发断流: 内核意外退出" + WFP filterCount=4 仍然生效。
 *
 * WFP 规则是 "APP_ID != 内核 -> BLOCK"。内核被杀之后, 除一个已死进程外
 * 所有应用都被内核态挡死 —— WiFi 连着没网、蓝牙共享建不起来, 且重启无效。
 * 内核活着时至少还能通过界面重新拉起 worker 去 unlock; 内核死了就没有恢复路径。
 */
describe('配置热重载失败: 绝不能杀内核', () => {
  // 只检查 updateConfig 函数体内的代码, 不扫注释 —— 注释要能自由描述历史写法。
  const start = worker.indexOf('function updateConfig(');
  const end = worker.indexOf('const restoreDns = async', start);
  const body = worker.slice(start, end);

  it('updateConfig 能定位到(防止切片失效导致测试空转)', () => {
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    expect(body.length).toBeGreaterThan(200);
  });

  it('updateConfig 函数体内不存在对内核的 kill 调用', () => {
    expect(body).not.toMatch(/rawChild[?.\w]*\.kill\(/);
  });

  it('配置失败分支只是抛出错误, 由保护状态机决定后续', () => {
    expect(body).toMatch(/catch \(e\) \{[\s\S]*throw e;/);
    expect(body).not.toMatch(/systemBlockConfirmed\s*\)\s*rawChild/);
  });
});
