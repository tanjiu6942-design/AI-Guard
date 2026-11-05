import type { CheckResult } from './types.js';

export interface ConnSample {
  aliveMs: number;
  closed: boolean;
}

export type ConnectProbe = () => Promise<ConnSample>;

export async function checkLongConnection(
  probe: ConnectProbe,
  idleMs: number,
): Promise<CheckResult> {
  const sample = await probe();
  // 允许 20% 的时序误差
  const threshold = idleMs * 0.8;

  if (!sample.closed && sample.aliveMs >= threshold) {
    return {
      key: 'long',
      title: '长连接稳定性',
      state: 'ok',
      detail: `保持 ${(sample.aliveMs / 1000).toFixed(1)}s 未断, 满足 ChatGPT 流式回复需求`,
    };
  }
  return {
    key: 'long',
    title: '长连接稳定性',
    state: 'fail',
    detail: `连接在 ${(sample.aliveMs / 1000).toFixed(1)}s 时被断开, 不足以支撑流式回复`,
  };
}
