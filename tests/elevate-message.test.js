import { describe, it, expect } from 'vitest';
import { ELEVATION_DENIED } from '../desktop/elevate-guard.mjs';

/**
 * 提权通道的错误必须说人话。
 *
 * 现场: PowerShell 的 -EncodedCommand 失败时会把错误序列化成 CLIXML
 * (一堆 XML), 里面还夹着脚本原文与本地代码页乱码。曾经把它直接拼进
 * 界面文案, 用户看到的是一屏乱码 —— 比不给信息更糟。
 *
 * 另外不能把两种失败混为一谈:
 *   - UAC 被拒(用户点了"否")     -> 提示需要管理员权限
 *   - 提权后命令本身失败(退出码非 0) -> 提示解除失败
 * 两者最终都要靠回读真实状态确认, 所以文案只需可区分、不含噪音。
 */
describe('提权通道的错误文案', () => {
  it('不包含 CLIXML / XML 标签', () => {
    expect(ELEVATION_DENIED).not.toMatch(/<Objs|<S S=|\/xml/i);
  });

  it('说明是权限问题, 且告诉用户断流尚未解除(不能让人误以为已恢复)', () => {
    expect(ELEVATION_DENIED).toMatch(/管理员/);
    expect(ELEVATION_DENIED).toMatch(/未解除|没有解除/);
  });

  it('长度适合直接放进界面提示', () => {
    expect(ELEVATION_DENIED.length).toBeLessThan(120);
  });
});
