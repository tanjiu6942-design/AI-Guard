import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * 回归: 应急解锁入口必须存在、可被发现、且自己能提权。
 *
 * 2026-11-06 的事故里, emergency-unlock.cmd 一直都躺在安装目录,
 * 但它要求用户先"以管理员身份运行", 又藏在 resources/guard-filter/ 深处,
 * 于是没人找到它, 用户最后只能还原系统。
 *
 * 三件事一起保证它可用:
 *   1. 脚本存在且会自我提权(UAC), 不要求用户懂怎么右键提权
 *   2. 打包时随 guard-filter 一起分发
 *   3. 安装时在开始菜单/桌面留下快捷方式
 */
const cmd = fileURLToPath(new URL('../vendor/guard-filter/emergency-unlock.cmd', import.meta.url));
const nsh = fileURLToPath(new URL('../build/emergency-unlock-shortcut.nsh', import.meta.url));
const builder = fileURLToPath(new URL('../electron-builder.yml', import.meta.url));

const source = () => readFileSync(cmd, 'utf8');
const nsis = () => readFileSync(nsh, 'utf8');
const config = () => readFileSync(builder, 'utf8');

describe('应急解锁入口', () => {
  it('脚本存在', () => {
    expect(existsSync(cmd)).toBe(true);
  });

  it('脚本会自我提权, 而不是只打印一句"请以管理员身份运行"', () => {
    const s = source();
    // 检测管理员身份：fltmc 比 net session 可靠（不受网络服务状态影响）
    expect(s).toMatch(/fltmc/);
    // 不是管理员时用 UAC 重启自己
    expect(s).toMatch(/-Verb RunAs/);
    expect(s).toMatch(/%~f0/);
    // 提权调用要绕过执行策略，否则部分机器的组策略会拦住
    expect(s).toMatch(/-ExecutionPolicy Bypass/);
  });

  it('脚本调用 unlock, 并在失败时明确报错而不是假装成功', () => {
    const s = source();
    expect(s).toMatch(/"%HELPER%"\s+unlock/);
    expect(s).toMatch(/errorlevel 1/);
    expect(s).toMatch(/失败/);
  });

  it('脚本只动 AI Guard 自己的规则与残留 DNS, 声明不碰其他配置', () => {
    const s = source();
    expect(s).toContain('不会改动其他软件的防火墙规则');
    // 清理的是本软件的两个残留 DNS 值
    expect(s).toContain('198.18.0.2');
    expect(s).toContain('fdfe:dcba:9876::2');
  });

  it('找不到 helper 时给出可操作的下一步, 而不是只说失败', () => {
    const s = source();
    // 脚本可能被单独拷走（如放 U 盘），必须告诉用户把它放到 exe 旁边
    expect(s).toMatch(/aiguard-guard-filter\.exe/);
    expect(s).toMatch(/同一个文件夹|同一目录/);
    // 并提供拿不到文件时的退路
    expect(s).toMatch(/卸载|实时保护/);
  });

  it('NSIS 用 electron-builder 认的钩子名 customInstall / customUnInstall', () => {
    const s = nsis();
    expect(s).toMatch(/!macro customInstall\b/);
    expect(s).toMatch(/!macro customUnInstall\b/);
    // 旧的、electron-builder 不会调用的名字不能出现
    expect(s).not.toMatch(/!macro CreateEmergencyShortcut/);
  });

  it('安装时把快捷方式放到开始菜单和桌面', () => {
    const s = nsis();
    expect(s).toContain('$SMPROGRAMS');
    expect(s).toContain('$DESKTOP');
    expect(s).toContain('emergency-unlock.cmd');
  });

  it('electron-builder 配置里挂上了这个 nsh', () => {
    expect(config()).toContain('emergency-unlock-shortcut.nsh');
  });

  it('guard-filter 会随包分发(否则脚本找不到 helper)', () => {
    const c = config();
    expect(c).toMatch(/from:\s*vendor\/guard-filter/);
    expect(c).toMatch(/to:\s*guard-filter/);
  });
});
