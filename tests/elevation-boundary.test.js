import { describe, it, expect } from 'vitest';
import { WindowsGuard } from '../desktop/firewall.mjs';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 回归: 主进程以 asInvoker 运行(electron-builder.yml 的 requestedExecutionLevel),
 * 而 guard-filter 的 unlock 明确要求管理员权限
 * (native/GuardFilter/Program.cs: `if (!status) RequireAdministrator()`)。
 *
 * 所以「worker 已退出后由主进程自己 unlock」这条修复路径,
 * 如果直接 execFile 调用, 在生产环境必然报
 * UnauthorizedAccessException —— 看起来修好了, 实际一次都跑不通。
 * 实测确认: 普通权限下 `status` 返回 0, `unlock` 返回 1。
 *
 * 正确做法: 状态查询走非提权路径, 变更操作走 UAC 提权。
 */
const fixturePath = fileURLToPath(new URL('./fixtures/guard-filter.mjs', import.meta.url));

function setup() {
  const d = mkdtempSync(join(tmpdir(), 'aiguard-esc-'));
  const file = join(d, 'fixture.json');
  writeFileSync(file, JSON.stringify({ mode: '', calls: [], rules: { foreign: ['keep'], aiguard: ['locked'] } }));
  const guard = (opts = {}) => new WindowsGuard({
    executable: [process.execPath, fixturePath], dataDir: d, timeout: 5000, ...opts,
  });
  const read = () => JSON.parse(readFileSync(file, 'utf8'));
  return { d, file, guard, read };
}

describe('提权边界: status 不需要, unlock 需要', () => {
  it('WindowsGuard 暴露 mutatingRequiresElevation 标记, 供调用方决定走不走 UAC', () => {
    const { d, guard } = setup();
    try { expect(guard().mutatingRequiresElevation).toBe(true); }
    finally { rmSync(d, { recursive: true, force: true }); }
  });

  it('unlockEscalated 在没有提权能力时给出可读的错误, 而不是静默失败', async () => {
    const { d, guard } = setup();
    try {
      await expect(guard({ elevation: null }).unlockEscalated()).rejects.toThrow(/管理员|提权/);
    } finally { rmSync(d, { recursive: true, force: true }); }
  });

  it('unlockEscalated 通过提权器执行命令, 并回读真实状态确认已解除', async () => {
    const { d, guard, read } = setup();
    try {
      const called = [];
      // 提权器只负责"以管理员身份再跑一次这个 exe"; 这里同步模拟它真的执行了。
      const g = guard({
        elevation: async (exe, args) => {
          called.push([exe, args]);
          const { execFileSync } = await import('node:child_process');
          execFileSync(exe, args, { cwd: g.dataDir, windowsHide: true });
          return 0;
        },
      });
      await g.unlockEscalated();
      expect(called[0][1]).toEqual([fixturePath, 'unlock']);
      // fixture 的 unlock 会删掉 aiguard 规则, 保留 foreign
      expect(read().rules.foreign).toEqual(['keep']);
      expect(read().rules.aiguard).toBeUndefined();
    } finally { rmSync(d, { recursive: true, force: true }); }
  });

  it('提权器返回非 0 时抛错, 不谎称成功', async () => {
    const { d, guard } = setup();
    try {
      const g = guard({ elevation: async () => 1 });
      await expect(g.unlockEscalated()).rejects.toThrow(/退出码|失败/);
    } finally { rmSync(d, { recursive: true, force: true }); }
  });

  it('提权后状态仍锁着时报错(不能只信退出码)', async () => {
    const { d, guard } = setup();
    try {
      // 提权器谎称成功但没有真的解除
      const g = guard({ elevation: async () => 0 });
      await expect(g.unlockEscalated()).rejects.toThrow(/did not|incomplete|未/);
    } finally { rmSync(d, { recursive: true, force: true }); }
  });
});
