import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

/**
 * 回归: 保存失败时界面不回滚，让用户以为改动生效了。
 *
 * 现场(2026-11-07):
 *   用户在「连接配置」把实时保护关掉 -> 界面复选框变空 -> 点保存
 *   -> service 拒绝："请先停止内核，再修改连接配置"
 *   -> 只弹一句红字提示，**settings 仍是内存里那个 false**
 *   -> 用户看到"没打勾"，以为关掉了
 *   -> 启动内核时读磁盘，仍是 true，保护照跑
 *
 * 用户为此困惑了两轮，而我一开始还误判成"他没滚动到那里"。
 *
 * 修法: 保存失败时把 settings 重新拉回磁盘真值，让界面不再撒谎。
 */
const app = readFileSync(new URL('../gui/src/App.tsx', import.meta.url), 'utf8');

describe('保存失败必须回滚界面状态', () => {
  it('act() 的 catch 分支里会重新拉取真实配置', () => {
    const start = app.indexOf('async function act(');
    expect(start).toBeGreaterThan(-1);
    const body = app.slice(start, app.indexOf('const transitioning', start));
    expect(body).toMatch(/catch \(e\)/);
    // 必须有一次"从服务端重新读配置"的动作
    expect(body).toMatch(/api\.settings\(\)/);
  });

  it('回滚发生在提示错误之前, 保证用户看到的勾选状态与磁盘一致', () => {
    const start = app.indexOf('async function act(');
    const body = app.slice(start, app.indexOf('const transitioning', start));
    const catchAt = body.indexOf('catch (e)');
    const refetchAt = body.indexOf('api.settings()');
    const noticeAt = body.indexOf('setNotice', catchAt);
    expect(refetchAt).toBeGreaterThan(catchAt);
    expect(noticeAt).toBeGreaterThan(catchAt);
  });
});
