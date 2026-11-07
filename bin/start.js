#!/usr/bin/env node
// core/ 是 TypeScript 源码, bin/ 是纯 JS。Node 无法跨文件解析 .js → .ts,
// 所以这里 import 编译产物 dist/core/。dist 缺失时先跑一次 tsc(见下)。
import { spawn, execFile } from 'node:child_process';
import { writeFileSync, readFileSync, mkdirSync, existsSync, createWriteStream } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const DIST = join(ROOT, 'dist', 'core');

// 首次运行或源码改动后, 保证 dist 存在
if (!existsSync(join(DIST, 'config', 'builder.js'))) {
  console.log('首次运行: 编译 core/ 到 dist/ ...');
  const { execFileSync } = await import('node:child_process');
  try {
    execFileSync(process.execPath, [join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc')], {
      cwd: ROOT, stdio: 'inherit',
    });
  } catch {
    console.error('编译失败。请在 aiguard/ 目录手动运行: npx tsc');
    process.exit(1);
  }
}

const { buildConfig } = await import('../dist/core/config/builder.js');
const { loadRuleSets } = await import('../dist/core/domain/rule-source.js');
const { configToYaml, findMihomo, ensureGeodata } = await import('../dist/core/runtime/mihomo.js');
const { apply: applyDns, restore: restoreDns } = await import('../dist/core/runtime/sysdns.js');
const { loadSettings } = await import('../dist/core/settings.js');

const settingsPath = join(process.env.APPDATA ?? '.', 'aiguard', 'settings.json');
const s = loadSettings(settingsPath);

// mihomo 路径解析顺序: settings.mihomoPath (用户手动指定) → findMihomo() 自动查找
// → AIGUARD_MIHOMO_PATH (测试用) → 报错退出。
// findMihomo() 只覆盖硬编码候选目录, 装在任意自定义位置时靠 mihomoPath 指定。
const mihomo = s.mihomoPath || findMihomo() || process.env.AIGUARD_MIHOMO_PATH || '';
if (!mihomo) {
  console.error('找不到 mihomo。请在 settings.json 的 mihomoPath 字段填上 mihomo.exe 的完整路径:');
  console.error(`  ${settingsPath}`);
  console.error('  例如: { "mihomoPath": "D:\\\\tools\\\\mihomo\\\\mihomo.exe" }');
  process.exit(1);
}

// 规则文件是运行期数据, 不是编译产物, 始终读源码目录
const sets = loadRuleSets(join(ROOT, 'rules', 'domains'));

/**
 * 检查端口是否已被占用, 返回占用者的进程名(空串表示空闲)。
 * 之前没有这一步: 本机其他程序可能也用 7891, 谁先启动占住端口, 另一个
 * 就绑不上 —— mihomo 只打一行 "bind: Only one usage of each socket address",
 * 进程照常"运行", 但流量实际走的是占用端口的另一个代理, 极难排查。
 */
async function portOwner(port) {
  return new Promise((resolve) => {
    execFile('netstat', ['-ano'], { windowsHide: true, timeout: 10000 }, (_e, out) => {
      const lines = String(out ?? '').split(/\r?\n/);
      for (const line of lines) {
        if (!/LISTENING/i.test(line)) continue;
        // 匹配 ":7891 " 或 ":7891$", 避免误配 17891
        if (!new RegExp(`[:\\.]${port}\\s`).test(line)) continue;
        const parts = line.trim().split(/\s+/);
        const pid = Number(parts[parts.length - 1]);
        if (!Number.isInteger(pid) || pid <= 0) continue;
        execFile('tasklist', ['/fi', `pid eq ${pid}`, '/fo', 'csv', '/nh'],
          { windowsHide: true }, (_e2, t) => {
            const name = String(t ?? '').split(',')[0]?.replace(/^"|"$/g, '').trim();
            resolve(name || `PID ${pid}`);
          });
        return;
      }
      resolve('');
    });
  });
}

// 启动前确认端口可用; 被占则自动顺延, 而不是静默绑不上
let mixedPort = s.mixedPort;
let controllerPort = s.controllerPort;
const occupied = await portOwner(mixedPort);
if (occupied) {
  console.warn(`[警告] 端口 ${mixedPort} 已被「${occupied}」占用。`);
  let next = mixedPort;
  for (let i = 1; i <= 20; i++) {
    if (!(await portOwner(mixedPort + i))) { next = mixedPort + i; break; }
  }
  if (next === mixedPort) {
    console.error('20 个端口都被占用, 无法启动。请先关闭占用端口的程序。');
    process.exit(1);
  }
  console.warn(`        自动改用 ${next}(避免与对方抢端口导致流量走错)。`);
  console.warn(`        若想固定端口, 请修改 %APPDATA%\\aiguard\\settings.json 的 mixedPort。`);
  mixedPort = next;
}
// 控制端口冲突不影响转发, 但也顺延以免 API 不可用
if (await portOwner(controllerPort)) {
  let next = controllerPort;
  for (let i = 1; i <= 20; i++) {
    if (!(await portOwner(controllerPort + i))) { next = controllerPort + i; break; }
  }
  if (next !== controllerPort) {
    console.warn(`[警告] 控制端口 ${controllerPort} 被占用, 改用 ${next}。`);
    controllerPort = next;
  }
}

const cfg = buildConfig({
  mode: s.mode,
  sets,
  residential: s.residential,
  airportUrl: s.airportUrl,
  mixedPort,
  controllerPort,
  secret: s.secret || 'aiguard',
  homeRegion: s.homeRegion,
  tunEnabled: s.tunEnabled,
});

// 把实际使用的端口写回 settings, UI 和体检器据此连接正确的端口
if (mixedPort !== s.mixedPort || controllerPort !== s.controllerPort) {
  try {
    const raw = JSON.parse(readFileSync(settingsPath, 'utf8'));
    raw.mixedPort = mixedPort;
    raw.controllerPort = controllerPort;
    writeFileSync(settingsPath, JSON.stringify(raw, null, 2), 'utf8');
  } catch { /* 写不进去不影响运行 */ }
}

const workDir = join(process.env.APPDATA ?? '.', 'aiguard', 'mihomo');
mkdirSync(workDir, { recursive: true });
writeFileSync(join(workDir, 'config.yaml'), configToYaml(cfg), 'utf8');

// TUN 需要管理员权限(实测: 无权限会报 "configure tun interface: Access is denied")。
// 未提权时自动用 UAC 重新拉起自己, 而不是让用户对着一行 error 猜。
if (s.tunEnabled && process.env.AIGUARD_ELEVATED !== '1') {
  const isAdmin = await new Promise((resolve) => {
    const ps = '([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent())' +
      '.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)';
    execFile('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps],
      { windowsHide: true }, (_e, out) => resolve(String(out).trim() === 'True'));
  });

  if (!isAdmin) {
    console.log('TUN 模式需要管理员权限, 正在请求提权...');
    console.log('(会弹出 UAC 窗口, 请点「是」)');
    const self = join(HERE, 'start.js');
    const cmd = `$env:AIGUARD_ELEVATED='1'; & '${process.execPath}' '${self}'`;
    const r = await new Promise((resolve) => {
      execFile('powershell', ['-NoProfile', '-Command',
        `Start-Process powershell -Verb RunAs -ArgumentList '-NoExit','-NoProfile','-Command',"${cmd.replace(/"/g, '\\"')}" -WindowStyle Normal`,
      ], { windowsHide: true }, (e) => resolve(!e));
    });
    if (r) {
      console.log('已在新窗口以管理员身份启动, 请查看那个窗口的输出。');
      process.exit(0);
    }
    console.error('提权失败。请手动以管理员身份打开 PowerShell 后运行:');
    console.error(`  cd "${ROOT}"`);
    console.error('  node bin/start.js');
    process.exit(1);
  }
}

// geodata 三件套必须在启动前就位: 配置里的 GEOIP/GEOSITE 规则要读它们,
// 缺失时内核会联网下载, 国内直连 GitHub 常失败 → 直接启动失败。
const geodataReady = ensureGeodata(workDir, mihomo);
if (!geodataReady) {
  console.warn('[警告] geodata 未就位 (Country.mmdb / geoip.dat / geosite.dat)。');
  console.warn('        mihomo 将尝试联网下载, 网络受限时会下载失败并退出。');
  console.warn(`        可把这三个文件放到 ${workDir} 或 mihomo.exe 同目录后重试。`);
}

// 只有 TUN 模式才接管系统 DNS: TUN 关着时系统 DNS 指向 198.18.0.2 会直接断网。
//
// 必须**同时接管 IPv4 和 IPv6 的 DNS**。之前的 bug: 这里硬编码传了 false,
// 只改 IPv4 DNS, 物理网卡的 IPv6 DNS 仍然是运营商给的(如 2408:8422:...),
// 结果浏览器/系统会通过 IPv6 去做 DNS 查询, 直接泄漏到国内 114/移动 DNS,
// 表现为 ipcheck.ing 之类报「中国DNS泄漏」。体检器当时也没测出来。
const dnsBackupPath = join(workDir, 'dns-backup.json');
let dnsTaken = false;
if (s.tunEnabled) {
  try {
    // 检测本机是否有公网 IPv6, 有才覆盖 IPv6 DNS(没有时不写无用的 v6 记录)
    const hasPub6 = await new Promise((resolve) => {
      const ps = "Get-NetIPAddress -AddressFamily IPv6 -EA SilentlyContinue | " +
        "Where-Object { $_.IPAddress -notmatch '^(fe80|fc|fd|::1)' } | " +
        "Select-Object -First 1 -ExpandProperty IPAddress";
      execFile('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps],
        { windowsHide: true, timeout: 15000 }, (_e, out) => resolve(String(out ?? '').trim().length > 0));
    });

    const names = await applyDns(dnsBackupPath, hasPub6);
    dnsTaken = names.length > 0;
    if (dnsTaken) {
      console.log(`已接管系统 DNS: ${names.join(', ')} → 198.18.0.2${hasPub6 ? ' / fdfe:dcba:9876::2' : ''}`);
    } else {
      console.warn('[警告] 未找到可接管的网卡, 系统 DNS 保持原样');
    }
  } catch (e) {
    console.error(`[警告] 系统 DNS 接管失败 (需要管理员权限): ${e instanceof Error ? e.message : String(e)}`);
  }
}

// 日志必须落盘: 之前用 stdio='inherit', 输出只在提权窗口里, 窗口一关就没了,
// 排查 ChatGPT 重连这类问题时完全无据可查(踩过)。
// 同时写文件 + 透传到控制台, 便于在窗口里直接看。
const logPath = join(workDir, 'mihomo.log');
const logStream = createWriteStream(logPath, { flags: 'w' });
const child = spawn(mihomo, ['-d', workDir], {
  stdio: ['ignore', 'pipe', 'pipe'],
});
child.stdout.on('data', (d) => {
  logStream.write(d);
  process.stdout.write(d);
});
child.stderr.on('data', (d) => {
  logStream.write(d);
  process.stderr.write(d);
});
console.log(`内核日志: ${logPath}`);

let restored = false;
async function restoreOnce() {
  if (!s.tunEnabled || !dnsTaken || restored) return;
  restored = true;
  try {
    await restoreDns(dnsBackupPath);
    console.log('已恢复系统 DNS');
  } catch (e) {
    console.error(`[警告] 系统 DNS 恢复失败, 请手工检查网卡 DNS: ${e instanceof Error ? e.message : String(e)}`);
  }
}

child.on('error', async (e) => {
  console.error(`启动 mihomo 失败: ${e.message}`);
  await restoreOnce();
  process.exit(1);
});

child.on('exit', async (code) => {
  await restoreOnce();
  process.exit(code ?? 0);
});

for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, async () => {
    try { child.kill(); } catch { /* 已退出 */ }
    await restoreOnce();
    process.exit(0);
  });
}
