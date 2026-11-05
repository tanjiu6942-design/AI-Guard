import { it, expect, vi } from 'vitest';
import { stopProtectedSession } from '../desktop/protected-stop.mjs';

it('正常退出(shutdown)释放保护而不是记为断流', async () => {
  // 回归: service.mjs 的 shutdown 曾传 preserveProtection:true,
  // 导致每次正常关闭程序都被 trip() 记成"已断流", 而 WFP 其实没锁。
  // 用户下次打开就看见"已断流", 但网络是通的。
  const calls = [];
  const protection = {
    trip: async () => calls.push('trip'),
    assertSystemLocked: async () => calls.push('assertSystemLocked'),
    shutdown: async () => calls.push('shutdown'),
    release: async () => calls.push('release'),
  };
  const session = { stop: async () => calls.push('stop') };

  // 正常退出 = preserve 为 false
  await stopProtectedSession({ protection, session, preserve: false, reason: '正常退出' });
  expect(calls).toEqual(['shutdown', 'stop', 'release']);
  expect(calls).not.toContain('trip');
});

it('强杀/管理连接断开(preserve)仍然保留断流', async () => {
  const calls = [];
  const protection = {
    trip: async () => calls.push('trip'),
    assertSystemLocked: async () => calls.push('assertSystemLocked'),
    shutdown: async () => calls.push('shutdown'),
    release: async () => calls.push('release'),
  };
  const session = { stop: async () => calls.push('stop') };

  await stopProtectedSession({ protection, session, preserve: true, reason: 'UI disconnected' });
  expect(calls).toEqual(['trip', 'assertSystemLocked', 'shutdown', 'stop']);
  expect(calls).not.toContain('release');
});
