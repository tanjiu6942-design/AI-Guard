import { copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import type { MihomoConfig } from '../config/types.js';

/** 极简 YAML 序列化: 只处理本项目 config 结构, 避免引入依赖 */
export function configToYaml(c: MihomoConfig): string {
  const lines: string[] = [];

  const scalar = (k: string, v: unknown) => {
    if (typeof v === 'boolean' || typeof v === 'number') lines.push(`${k}: ${v}`);
    else if (typeof v === 'string') lines.push(`${k}: ${v === '' ? "''" : v}`);
  };

  scalar('mixed-port', c['mixed-port']);
  scalar('allow-lan', c['allow-lan']);
  scalar('mode', c.mode);
  scalar('log-level', c['log-level']);
  scalar('ipv6', c.ipv6);
  if (c['find-process-mode']) scalar('find-process-mode', c['find-process-mode']);
  if (c['tcp-concurrent'] !== undefined) scalar('tcp-concurrent', c['tcp-concurrent']);
  if (c['unified-delay'] !== undefined) scalar('unified-delay', c['unified-delay']);
  if (c['keep-alive-idle'] !== undefined) scalar('keep-alive-idle', c['keep-alive-idle']);
  if (c['keep-alive-interval'] !== undefined) scalar('keep-alive-interval', c['keep-alive-interval']);
  if (c['interface-name']) scalar('interface-name', c['interface-name']);
  scalar('external-controller', c['external-controller']);
  scalar('secret', c.secret);

  lines.push('tun:');
  scalar('  enable', c.tun.enable);
  scalar('  stack', c.tun.stack);
  scalar('  auto-route', c.tun['auto-route']);
  scalar('  auto-detect-interface', c.tun['auto-detect-interface']);
  lines.push('  dns-hijack:');
  for (const d of c.tun['dns-hijack']) lines.push(`    - ${d}`);
  lines.push('  inet6-address:');
  for (const d of c.tun['inet6-address']) lines.push(`    - ${d}`);

  lines.push('proxies: []');

  lines.push('proxy-providers:');
  for (const [name, p] of Object.entries(c['proxy-providers'])) {
    lines.push(`  ${name}:`);
    scalar('    type', p.type);
    if (p.url) scalar('    url', p.url);
    if (p.path) scalar('    path', p.path);
    if (p.interval) scalar('    interval', p.interval);
    // provider 自己的出站代理: 拉订阅时用, 与业务规则无关。
    // 受保护模式会把 MATCH,REJECT 放在规则首位, 若不显式指定, 拉订阅会被自己的规则拦死。
    if (p.proxy) scalar('    proxy', p.proxy);
    if (p['exclude-filter']) scalar('    exclude-filter', p['exclude-filter']);
    if (p.payload) {
      lines.push('    payload:');
      for (const node of p.payload) {
        lines.push(`      - name: "${node.name}"`);
        lines.push(`        type: ${node.type}`);
        lines.push(`        server: ${node.server}`);
        lines.push(`        port: ${node.port}`);
        if (node.username) lines.push(`        username: ${node.username}`);
        if (node.password) lines.push(`        password: ${node.password}`);
        if (node.udp !== undefined) lines.push(`        udp: ${node.udp}`);
        if (node['dialer-proxy']) lines.push(`        dialer-proxy: "${node['dialer-proxy']}"`);
      }
    }
    if (p['health-check']) {
      lines.push('    health-check:');
      scalar('      enable', p['health-check'].enable);
      scalar('      url', p['health-check'].url);
      scalar('      interval', p['health-check'].interval);
      scalar('      lazy', p['health-check'].lazy);
      scalar('      timeout', p['health-check'].timeout);
    }
  }

  lines.push('proxy-groups:');
  for (const g of c['proxy-groups']) {
    lines.push(`  - name: "${g.name}"`);
    lines.push(`    type: ${g.type}`);
    if (g.use) {
      lines.push('    use:');
      for (const u of g.use) lines.push(`      - ${u}`);
    }
    if (g.proxies) {
      lines.push('    proxies:');
      for (const p of g.proxies) lines.push(`      - "${p}"`);
    }
    if (g.url) scalar('    url', g.url);
    if (g.interval) scalar('    interval', g.interval);
    if (g.timeout) scalar('    timeout', g.timeout);
    if (g.lazy !== undefined) scalar('    lazy', g.lazy);
    if (g.tolerance !== undefined) scalar('    tolerance', g.tolerance);
  }

  lines.push('rules:');
  for (const r of c.rules) lines.push(`  - ${r}`);

  lines.push('dns:');
  scalar('  enable', c.dns.enable);
  scalar('  ipv6', c.dns.ipv6);
  scalar('  enhanced-mode', c.dns['enhanced-mode']);
  scalar('  respect-rules', c.dns['respect-rules']);
  lines.push('  default-nameserver:');
  for (const d of c.dns['default-nameserver']) lines.push(`    - ${d}`);
  lines.push('  nameserver:');
  for (const d of c.dns.nameserver) lines.push(`    - ${d}`);
  lines.push('  proxy-server-nameserver:');
  for (const d of c.dns['proxy-server-nameserver']) lines.push(`    - ${d}`);
  lines.push('  nameserver-policy:');
  for (const [k, v] of Object.entries(c.dns['nameserver-policy'])) {
    lines.push(`    '${k}':`);
    for (const s of v) lines.push(`      - ${s}`);
  }
  lines.push('  fake-ip-filter:');
  for (const d of c.dns['fake-ip-filter']) lines.push(`    - '${d}'`);

  lines.push('profile:');
  scalar('  store-selected', c.profile['store-selected']);
  scalar('  store-fake-ip', c.profile['store-fake-ip']);

  return lines.join('\n') + '\n';
}

/** 按优先级查找 mihomo 二进制 */
export function findMihomo(): string | null {
  const candidates = [
    join(process.env.APPDATA ?? homedir(), 'aiguard', 'mihomo', 'mihomo.exe'),
    join(process.env.LOCALAPPDATA ?? homedir(), 'Programs', '早期实现', 'resources', 'mihomo.exe'),
    join(process.env.LOCALAPPDATA ?? homedir(), 'Programs', 'aiguard', 'mihomo.exe'),
  ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  return null;
}

/**
 * mihomo 启动必需的 geodata 三件套。
 * 配置里的 GEOIP / GEOSITE 规则要读它们; 缺了内核会尝试联网下载,
 * 下载失败 (国内直连 GitHub 常见) 就直接启动失败:
 *   can't download MMDB: unexpected EOF
 *   rules[0] [GEOIP,private,DIRECT,no-resolve] error
 */
export const GEODATA_FILES = ['Country.mmdb', 'geoip.dat', 'geosite.dat'] as const;

/**
 * 把 geodata 三件套准备到 workDir, 返回是否三个文件都已就位。
 *
 * 查找顺序 (每个文件独立查找, 找到即复制):
 *   1. workDir 里已有 → 直接复用
 *   2. mihomo 二进制同目录 → 复制
 *   3. %LOCALAPPDATA%\Programs\早期实现\resources\ → 复制
 *   4. 都找不到 → 返回 false (调用方决定报错还是让 mihomo 联网下载)
 *
 * 注意: 不硬编码 早期实现 的安装盘符, 用户到期卸载后不至于连带炸掉。
 */
export function ensureGeodata(workDir: string, mihomoPath?: string | null): boolean {
  mkdirSync(workDir, { recursive: true });

  const sourceDirs: string[] = [];
  if (mihomoPath) sourceDirs.push(dirname(mihomoPath));
  sourceDirs.push(
    join(process.env.LOCALAPPDATA ?? homedir(), 'Programs', '早期实现', 'resources'),
  );

  for (const file of GEODATA_FILES) {
    const dest = join(workDir, file);
    if (existsSync(dest)) continue;

    for (const dir of sourceDirs) {
      const src = join(dir, file);
      if (!existsSync(src)) continue;
      try {
        copyFileSync(src, dest);
        break;
      } catch {
        // 复制失败 (权限/占用) 就继续找下一个来源, 由最终结果体现
      }
    }
  }

  return GEODATA_FILES.every((f) => existsSync(join(workDir, f)));
}

export interface StartOptions {
  mihomoPath: string;
  workDir: string;
  config: MihomoConfig;
}

export class MihomoRuntime {
  private child: ChildProcess | null = null;

  constructor(private readonly opts: StartOptions) {}

  writeConfig(): string {
    mkdirSync(this.opts.workDir, { recursive: true });
    const p = join(this.opts.workDir, 'config.yaml');
    writeFileSync(p, configToYaml(this.opts.config), 'utf8');
    return p;
  }

  status(): 'running' | 'stopped' {
    return this.child && !this.child.killed ? 'running' : 'stopped';
  }

  /** 启动内核; 配置先落盘, 再用 -d workDir -f config.yaml 启动 */
  start(): ChildProcess {
    if (this.status() === 'running') return this.child as ChildProcess;
    const configPath = this.writeConfig();
    this.child = spawn(
      this.opts.mihomoPath,
      ['-d', this.opts.workDir, '-f', configPath],
      { windowsHide: true, cwd: this.opts.workDir },
    );
    this.child.on('exit', () => {
      this.child = null;
    });
    return this.child;
  }

  /** 停止内核 */
  stop(): void {
    const child = this.child;
    if (!child) return;
    child.kill();
    this.child = null;
  }

  /** 热重载配置: 走 external-controller 的 PUT /configs */
  async reload(): Promise<void> {
    const configPath = this.writeConfig();
    const res = await fetch(
      `http://${this.opts.config['external-controller']}/configs?force=true`,
      {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.opts.config.secret}`,
        },
        body: JSON.stringify({ path: configPath }),
      },
    );
    if (!res.ok) throw new Error(`重载配置失败: HTTP ${res.status}`);
  }

  /** 校验配置: mihomo -t -d workDir -f config.yaml */
  validate(): Promise<{ ok: boolean; output: string }> {
    const configPath = this.writeConfig();
    return new Promise((resolve) => {
      const child = spawn(
        this.opts.mihomoPath,
        ['-t', '-d', this.opts.workDir, '-f', configPath],
        { windowsHide: true, cwd: this.opts.workDir },
      );
      let out = '';
      child.stdout.on('data', (d) => { out += String(d); });
      child.stderr.on('data', (d) => { out += String(d); });
      child.on('error', (e) => resolve({ ok: false, output: e.message }));
      child.on('close', (code) => resolve({ ok: code === 0, output: out }));
    });
  }
}
