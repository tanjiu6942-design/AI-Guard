#!/usr/bin/env node
// 读编译产物 dist/core (Node 无法跨文件解析 .js → .ts)
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
if (!existsSync(join(ROOT, 'dist', 'core', 'settings.js'))) {
  execFileSync(process.execPath, [join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc')], {
    cwd: ROOT, stdio: 'inherit',
  });
}
const { loadSettings, saveSettings } = await import('../dist/core/settings.js');

const mode = process.argv[2];
if (mode !== 'strict' && mode !== 'precise') {
  console.error('用法: set-mode.js strict|precise');
  process.exit(1);
}
const p = join(process.env.APPDATA ?? '.', 'aiguard', 'settings.json');
const s = loadSettings(p);
s.mode = mode;
saveSettings(p, s);
console.log(`模式已切换为 ${mode}`);
console.log(`配置: ${p}`);
console.log('重启 AI Guard 后生效 (bin/start.js 或 GUI 的启动按钮)。');
