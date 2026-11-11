import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WindowsGuard } from '../desktop/firewall.mjs';

/**
 * 回归(2026-11-11)：用户点「一键修复网络」报防火墙相关错误。
 *
 * 真实场景：WFP 里**只残留了一部分**规则（比如 4 条里只剩 2 条，
 * 或者规则还在但 provider/sublayer 已被删）。
 *
 * native/GuardFilter/Guard.cs 的 Status()：
 *   count > 0 && (!provider || !sublayer)  -> errors.Add("...provider/sublayer missing or invalid")
 *   count > 0 && count != 4               -> errors.Add("...filter set incomplete")
 *   return new(count > 0 || errors.Count > 0, errors.Count == 0, count, errors)
 *
 * 于是「部分残留」会被判成 complete=false —— 这是**正确的**（状态确实不完整）。
 * 但 unlock 时：
 *   Guard.Unlock() -> DeleteFilters() 删掉还在的规则
 *                  -> Status() 复核
 *   若删除过程中 provider/sublayer 的删除失败，或有规则删不掉，
 *   就会抛 "AI Guard unlock verification failed"，
 *   提权进程的 stderr 被丢弃 -> 用户只看到一句含糊的"防火墙"错误。
 *
 * 修复方向：
 *   1. 提权执行时**必须拿到 helper 的输出**，才能把真实原因告诉用户
 *   2. unlock 失败不应让用户看到原始英文异常
 */
const fixturePath = new URL('./fixtures/guard-filter.mjs', import.meta.url).pathname.replace(/^\//, '');

function setup(mode) {
  const dir = mkdtempSync(join(tmpdir(), 'aiguard-guardout-'));
  const file = join(dir, 'fixture.json');
  require('fs').writeFileSync(file, JSON.stringify({ mode, calls: [], rules: { foreign: ['keep'], aiguard: ['x'] } }));
  return { dir, file };
}

describe('提权解锁必须带回真实原因', () => {
  it('unlockEscalated 在提权失败时抛出的错误里含可读原因, 而不是原始英文异常', async () => {
    const { dir } = setup('');
    try {
      const guard = new WindowsGuard({
        executable: [process.execPath, fixturePath],
        dataDir: dir,
        timeout: 5000,
        // 模拟提权进程返回非 0（真实场景：UAC 被拒 / helper 报权限错误）
        elevation: async () => 1,
      });
      await expect(guard.unlockEscalated()).rejects.toThrow(/防火墙|断流|解除/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('提权器能把 helper 的 stderr 传回来, 供界面展示真实原因', async () => {
    const { dir } = setup('');
    try {
      const guard = new WindowsGuard({
        executable: [process.execPath, fixturePath],
        dataDir: dir,
        timeout: 5000,
        // 模拟真实提权器：helper 的原因已经被写进 Error.message，
        // 并保留原始输出在 guardOutput 上。
        elevation: async () => {
          const e = new Error('系统防火墙规则解除失败：AI Guard unlock verification failed');
          e.guardOutput = '{"error":"AI Guard unlock verification failed","code":"InvalidOperationException"}';
          e.elevationDenied = false;
          throw e;
        },
      });
      // 真实原因必须透出，不能被笼统文案覆盖
      await expect(guard.unlockEscalated()).rejects.toThrow(/unlock verification failed/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('状态不完整时, 界面能拿到具体缺什么', async () => {
    const { dir } = setup('partial');
    try {
      const guard = new WindowsGuard({
        executable: [process.execPath, fixturePath],
        dataDir: dir,
        timeout: 5000,
      });
      const state = await guard.status();
      // partial = 过滤器装了一半 -> 必须判为不完整
      expect(state.complete).toBe(false);
      expect(state.locked).toBe(true);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('unlockEscalated 在状态不完整时, 错误里必须包含 helper 的具体原因', async () => {
    const { dir } = setup('partial');
    try {
      const guard = new WindowsGuard({
        executable: [process.execPath, fixturePath],
        dataDir: dir,
        timeout: 5000,
        elevation: async () => {
          const e = new Error('系统防火墙规则解除失败：AI Guard unlock verification failed');
          e.guardOutput = '{"error":"AI Guard unlock verification failed"}';
          throw e;
        },
      });
      // 真实原因必须透出，不能被笼统文案覆盖
      await expect(guard.unlockEscalated()).rejects.toThrow(/unlock verification failed/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
