#!/usr/bin/env node
// AI Guard 体检器 CLI
// 读编译产物 dist/core (Node 无法跨文件解析 .js → .ts)
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, execFile } from 'node:child_process';
import { networkInterfaces } from 'node:os';
import { connect } from 'node:tls';
import { createConnection } from 'node:net';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
if (!existsSync(join(ROOT, 'dist', 'core', 'doctor', 'index.js'))) {
  console.log('首次运行: 编译 core/ 到 dist/ ...');
  execFileSync(process.execPath, [join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc')], {
    cwd: ROOT, stdio: 'inherit',
  });
}

const { runDoctor } = await import('../dist/core/doctor/index.js');
const { runAiRouteChecks } = await import('../dist/core/doctor/ai-route-report.js');
const { loadSettings } = await import('../dist/core/settings.js');

// settings.json 是住宅独享 IP / 控制端口的唯一来源。
// 读不到就退化成默认值(loadSettings 已经这么做了), 不能让体检器自己崩。
const SETTINGS = join(process.env.APPDATA ?? '.', 'aiguard', 'settings.json');
const settings = loadSettings(SETTINGS);

/**
 * 体检必须走 AI Guard 自己的代理端口, 否则测到的是本机真实出口(包括 IPv6),
 * 完全没测到代理效果 —— 那会误报"出口不一致 / DNS 泄漏"。
 *
 * Node 内置 fetch 不遵循 HTTP_PROXY 环境变量, 所以这里手写一个
 * HTTP CONNECT 代理, 用 undici 的 ProxyAgent 不引入依赖不容易;
 * 干脆用 node:http 自己发请求, 保持零依赖。
 */
const PROXY_ADDR = process.env.AIGUARD_PROXY ?? '127.0.0.1:7891';
const USE_PROXY = process.env.AIGUARD_NO_PROXY !== '1';

import { request as httpRequest } from 'node:http';

/** 经 HTTP 代理请求 URL, 返回 { ok, text() } 形状以兼容 FetchFn 接口 */
function proxiedFetch(url, init = {}) {
  if (!USE_PROXY) return fetch(url, init);
  const u = new URL(url);
  const [ph, pp] = PROXY_ADDR.split(':');
  // AbortSignal.timeout() 返回的 signal 不带 .timeout 属性, 各 Node 版本不一致,
  // 所以用固定超时, 由环境变量覆盖即可。
  const timeoutMs = Number(process.env.AIGUARD_TIMEOUT_MS ?? 12000);

  return new Promise((resolve, reject) => {
    const req = httpRequest({
      host: ph,
      port: Number(pp),
      method: 'CONNECT',
      path: `${u.hostname}:443`,
      headers: { Host: `${u.hostname}:443` },
      timeout: timeoutMs,
    });

    req.on('connect', (res, socket) => {
      if (res.statusCode !== 200) {
        socket.destroy();
        return reject(new Error(`CONNECT ${res.statusCode}`));
      }
      const tlsSock = connect({ socket, servername: u.hostname, rejectUnauthorized: false }, () => {
        tlsSock.write(
          `GET ${u.pathname}${u.search} HTTP/1.1\r\nHost: ${u.hostname}\r\n` +
          `User-Agent: AI-Guard-Doctor/1.0\r\nAccept: */*\r\nConnection: close\r\n\r\n`,
        );
      });

      let raw = '';
      tlsSock.setEncoding('utf8');
      tlsSock.on('data', (d) => {
        raw += d;
        // 收到数据就取消空闲超时, 否则慢响应的站点会被误判为超时
        tlsSock.setTimeout(0);
      });
      tlsSock.on('end', () => {
        const sep = raw.indexOf('\r\n\r\n');
        const head = sep >= 0 ? raw.slice(0, sep) : raw;
        const body = sep >= 0 ? raw.slice(sep + 4) : '';
        const status = Number(/^HTTP\/\d\.\d (\d+)/.exec(head)?.[1] ?? 0);
        // 处理 chunked 编码
        let text = body;
        if (/transfer-encoding:\s*chunked/i.test(head)) {
          text = '';
          let rest = body;
          while (rest.length) {
            const nl = rest.indexOf('\r\n');
            if (nl < 0) break;
            const size = parseInt(rest.slice(0, nl), 16);
            if (!Number.isFinite(size) || size === 0) break;
            text += rest.slice(nl + 2, nl + 2 + size);
            rest = rest.slice(nl + 2 + size + 2);
          }
        }
        resolve({
          ok: status >= 200 && status < 300,
          status,
          text: async () => text,
          json: async () => JSON.parse(text),
        });
      });
      tlsSock.on('error', reject);
      tlsSock.setTimeout(timeoutMs, () => { tlsSock.destroy(); reject(new Error('timeout')); });
    });

    req.on('timeout', () => { req.destroy(); reject(new Error('CONNECT timeout')); });
    req.on('error', reject);
    req.end();
  });
}

const fetchFn = (url, init) => proxiedFetch(url, init);

/**
 * 读 mihomo 控制接口的某个路径, 返回解析后的 JSON。
 *
 * 控制接口读不到(内核没跑/端口不通/鉴权错)必须 reject:
 * 上层的 runAiRouteChecks 会把"读不到"降级成 unknown, 而不是把
 * "内核没运行"误报成"漏配了规则"。
 */
const CTRL_PORT = Number(process.env.AIGUARD_CTRL_PORT ?? settings.controllerPort ?? 9090);
const CTRL_SECRET = process.env.AIGUARD_CTRL_SECRET ?? settings.secret ?? '';

function controllerGet(path) {
  return new Promise((resolve, reject) => {
    const req = httpRequest({
      host: '127.0.0.1',
      port: CTRL_PORT,
      method: 'GET',
      path,
      headers: CTRL_SECRET ? { Authorization: `Bearer ${CTRL_SECRET}` } : {},
      timeout: 5000,
    }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (d) => { body += d; });
      res.on('end', () => {
        const code = res.statusCode ?? 0;
        if (code < 200 || code >= 300) {
          reject(new Error(`controller ${path} -> HTTP ${code}`));
          return;
        }
        try {
          resolve(JSON.parse(body));
        } catch (e) {
          reject(new Error(`controller ${path} -> 非法 JSON`));
        }
      });
    });
    req.on('timeout', () => { req.destroy(); reject(new Error(`controller ${path} -> 超时`)); });
    req.on('error', reject);
    req.end();
  });
}

/** 检测本机是否有公网 IPv6 (排除链路本地与私有段, 排除虚拟网卡) */
function hasPublicIpv6() {
  return Object.entries(networkInterfaces()).some(([name, list]) =>
    !/Meta|Mihomo|Clash|TUN|wintun/i.test(name) &&
    (list ?? []).some(
      (x) => (x.family === 'IPv6' || x.family === 6) && !x.internal && !/^(fe80|fc|fd)/i.test(x.address),
    ),
  );
}

/** 用 STUN 探测 WebRTC 可见的公网 IP (UDP 打洞, 不走 HTTP 代理) */
function stunProbe(host = 'stun.l.google.com', port = 19302, timeoutMs = 4000) {
  return new Promise((resolve) => {
    const sock = createConnection({ host, port, type: 'udp' });
    const tx = Buffer.from(Array.from({ length: 12 }, () => Math.floor(Math.random() * 256)));
    const req = Buffer.alloc(20);
    req.writeUInt16BE(1, 0);
    req.writeUInt16BE(0, 2);
    req.writeUInt32BE(0x2112a442, 4);
    tx.copy(req, 8);

    const timer = setTimeout(() => { sock.destroy(); resolve(null); }, timeoutMs);

    sock.on('connect', () => sock.write(req));
    sock.on('data', (msg) => {
      clearTimeout(timer);
      sock.destroy();
      if (msg.length < 20 || msg.readUInt16BE(0) !== 0x0101) return resolve(null);
      const end = Math.min(msg.length, 20 + msg.readUInt16BE(2));
      for (let p = 20; p + 4 <= end;) {
        const type = msg.readUInt16BE(p);
        const len = msg.readUInt16BE(p + 2);
        const v = msg.subarray(p + 4, p + 4 + len);
        if ((type === 0x0020 || type === 0x0001) && v.length >= 8 && v[1] === 0x01) {
          const raw = v.readUInt32BE(4);
          const n = type === 0x0020 ? (raw ^ 0x2112a442) >>> 0 : raw;
          return resolve([n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.'));
        }
        p += 4 + len + ((4 - (len % 4)) % 4);
      }
      resolve(null);
    });
    sock.on('error', () => { clearTimeout(timer); resolve(null); });
  });
}

/** 长连接保持测试。
 *  刻意不使用 ws.chatgpt.com / claude.ai —— 用户不愿让工具向其线上账号环境
 *  发请求。长连接能否保持取决于链路本身, 用一个中立的、同属 Cloudflare 边缘的
 *  主机同样能验证 (它和 AI 域名走同一条前置->住宅IP 链路)。
 *
 *  注意: 纯空闲的 CONNECT 隧道会被 mihomo 的空闲超时(实测约 16s)关掉, 那是
 *  内核的 idle-timeout 而非链路故障, 所以探测必须发心跳, 否则会误判。 */
function longConnProbe(idleMs) {
  const HOST = process.env.AIGUARD_LONG_HOST ?? 'www.cloudflare.com';
  return () => new Promise((resolve) => {
    const t0 = Date.now();
    const proxy = process.env.AIGUARD_PROXY ?? '127.0.0.1:7891';
    const [ph, pp] = proxy.split(':');
    const req = createConnection({ host: ph, port: Number(pp) });
    let done = false;
    let heartbeat = null;

    const finish = (closed) => {
      if (done) return;
      done = true;
      if (heartbeat) clearInterval(heartbeat);
      resolve({ aliveMs: Date.now() - t0, closed });
    };

    req.on('connect', () => {
      req.write(`CONNECT ${HOST}:443 HTTP/1.1\r\nHost: ${HOST}:443\r\n\r\n`);
    });
    req.once('data', (d) => {
      if (!String(d).includes('200')) { req.destroy(); return finish(true); }
      const tlsSock = connect({ socket: req, servername: HOST, rejectUnauthorized: false }, () => {
        // 每 8s 发一次 TLS 心跳(keepalive 记录), 模拟真实长连接活动
        heartbeat = setInterval(() => {
          if (tlsSock.destroyed) return;
          try { tlsSock.write(Buffer.from([0x17, 0x03, 0x03, 0x00, 0x01, 0x00])); } catch { /* 已断 */ }
        }, 8000);
        setTimeout(() => { tlsSock.destroy(); finish(false); }, idleMs);
      });
      tlsSock.on('error', () => finish(true));
      tlsSock.on('close', () => finish(true));
    });
    req.on('error', () => finish(true));
    req.on('close', () => finish(true));
  });
}

/** 枚举代理相关进程的 名字+命令行。
 *  只取命令行才能区分"AI Guard 自己的 mihomo"和"别的客户端的 mihomo";
 *  tasklist 不给命令行, 所以用 PowerShell 的 CIM 查询。 */
/** 通过监听端口反查 PID。不需要提权, 而查询管理员进程的 CommandLine 需要。 */
function pidsOnPorts(ports) {
  return new Promise((resolve) => {
    execFile('netstat', ['-ano'], { windowsHide: true, timeout: 15000 }, (_e, out) => {
      const pids = new Set();
      for (const line of String(out ?? '').split(/\r?\n/)) {
        if (!/LISTENING/i.test(line)) continue;
        if (!ports.some((p) => line.includes(':' + p + ' '))) continue;
        const parts = line.trim().split(/\s+/);
        const pid = Number(parts[parts.length - 1]);
        if (Number.isInteger(pid) && pid > 0) pids.add(pid);
      }
      resolve([...pids]);
    });
  });
}


/** 读物理网卡的 DNS 配置。排除 TUN 虚拟网卡, 否则会把自己的 198.18.0.2 当泄漏源。 */

/** 读 IPv6 的系统配置: 物理网卡公网地址 / TUN 是否配 IPv6 / ::\/0 默认路由指向 */
function readIpv6Snapshot() {
  const ps = [
    '$phys = Get-NetIPAddress -AddressFamily IPv6 -ErrorAction SilentlyContinue |',
    "  Where-Object { $_.IPAddress -notmatch '^(fe80|fc|fd|::1)' -and $_.InterfaceAlias -notmatch 'Meta|Mihomo|Clash|TUN' } |",
    '  Select-Object InterfaceAlias,IPAddress',
    '$tun = Get-NetIPAddress -InterfaceAlias Meta -AddressFamily IPv6 -ErrorAction SilentlyContinue |',
    '  Select-Object -First 1 -ExpandProperty IPAddress',
    '$r = Get-NetRoute -DestinationPrefix "::/0" -ErrorAction SilentlyContinue | Select-Object -ExpandProperty InterfaceAlias',
    '[PSCustomObject]@{',
    '  physical = @($phys | ForEach-Object { [PSCustomObject]@{ iface = $_.InterfaceAlias; addr = $_.IPAddress } })',
    '  tunHasIpv6 = [bool]$tun',
    '  routes = @($r)',
    '} | ConvertTo-Json -Compress -Depth 4',
  ].join('\n');
  return new Promise((resolve) => {
    execFile('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps],
      { windowsHide: true, timeout: 15000 }, (_e, out) => {
        const raw = String(out ?? '').trim();
        if (!raw) return resolve({ physicalPublic: [], tunHasIpv6: false, ipv6DefaultRoutes: [], tunAlias: 'Meta' });
        try {
          const o = JSON.parse(raw);
          const physArr = Array.isArray(o.physical) ? o.physical : (o.physical ? [o.physical] : []);
          const routes = Array.isArray(o.routes) ? o.routes : (o.routes ? [o.routes] : []);
          resolve({
            physicalPublic: physArr.filter(Boolean).map((x) => ({
              iface: String(x.iface ?? ''), addr: String(x.addr ?? ''),
            })),
            tunHasIpv6: !!o.tunHasIpv6,
            ipv6DefaultRoutes: routes.filter(Boolean).map(String),
            tunAlias: 'Meta',
          });
        } catch {
          resolve({ physicalPublic: [], tunHasIpv6: false, ipv6DefaultRoutes: [], tunAlias: 'Meta' });
        }
      });
  });
}


/**
 * 探测 TUN 的 dns-hijack 是否生效。
 * 方法: 向一个**公网 DNS**(114.114.114.114) 查询 AI 域名,
 * 若返回 fake-ip(198.18.x.x), 说明查询被 TUN 劫持 —— 没有真出网。
 * 若返回真实 IP, 说明劫持失效, DNS 请求真的送到了运营商。
 */
function dnsHijackProbe() {
  return new Promise((resolve) => {
    // nslookup 输出里找 Address 行; -timeout 限时避免卡住
    execFile('nslookup', ['-timeout=3', 'claude.ai', '114.114.114.114'],
      { windowsHide: true, timeout: 8000 }, (_e, out) => {
        const text = String(out ?? '');
        // nslookup 输出分两段: 前段是"服务器"自身地址, 后段才是解析结果。
        // 只在「名称:」之后的段落里找 Address, 避免把服务器地址算进来。
        const nameIdx = text.search(/^\s*(?:����|Name):/m);
        const body = nameIdx >= 0 ? text.slice(nameIdx) : text;
        const addrs = [...body.matchAll(/^\s*Address(?:es)?:\s*(\S+)/gim)]
          .map((m) => m[1].trim())
          .filter((a) => /^\d{1,3}(\.\d{1,3}){3}$/.test(a));
        if (!addrs.length) return resolve(null);
        // 只要解析结果里出现 fake-ip, 就说明查询被 TUN 劫持, 没有真出网
        resolve(addrs.some((a) => /^198\.18\./.test(a)));
      });
  });
}

function readDnsServers() {
  const ps = [
    "Get-NetAdapter | Where-Object { $_.Status -eq 'Up' -and $_.InterfaceDescription -notmatch 'Meta|Mihomo|Clash|TUN|TAP|WireGuard|Loopback|Hyper-V|VMware|VirtualBox|Bluetooth' } | ForEach-Object {",
    '  $i = $_.ifIndex; $n = $_.Name',
    '  foreach ($fam in @(2,23)) {',
    '    $s = (Get-DnsClientServerAddress -InterfaceIndex $i -AddressFamily $fam -ErrorAction SilentlyContinue).ServerAddresses',
    '    if ($s) { [PSCustomObject]@{ iface = $n; family = $fam; servers = @($s) } }',
    '  }',
    '} | ConvertTo-Json -Compress',
  ].join('\n');
  return new Promise((resolve) => {
    execFile('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps],
      { windowsHide: true, timeout: 15000 }, (_e, out) => {
        const raw = String(out ?? '').trim();
        if (!raw) return resolve([]);
        try {
          const arr = JSON.parse(raw);
          const list = Array.isArray(arr) ? arr : [arr];
          resolve(list.map((x) => ({
            iface: String(x.iface ?? ''),
            family: Number(x.family) === 23 ? 6 : 4,
            servers: (Array.isArray(x.servers) ? x.servers : [x.servers])
              .filter(Boolean).map((s) => String(s)),
          })));
        } catch { resolve([]); }
      });
  });
}

function listProcesses() {
  const ps = "Get-CimInstance Win32_Process | Where-Object { $_.Name -match 'clash|mihomo|v2ray|xray|sing-box|hysteria|tuic|wireguard|openvpn|surge|quantumult' } | " +
    "Select-Object Name,ProcessId | ConvertTo-Json -Compress";
  return new Promise((resolve) => {
    execFile('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps],
      { windowsHide: true, timeout: 15000 }, (_e, out) => {
        const raw = String(out ?? '').trim();
        if (!raw) return resolve([]);
        try {
          const arr = JSON.parse(raw);
          const list = Array.isArray(arr) ? arr : [arr];
          resolve(list.map((x) => ({
            name: String(x.Name ?? ''),
            pid: Number(x.ProcessId ?? 0) || undefined,
          })));
        } catch { resolve([]); }
      });
  });
}

const hasIpv6 = hasPublicIpv6();
const idleMs = 30000;

// 先单独确认 "经代理能不能上网", 用它区分两种 STUN 失败:
//   网络通 + STUN 不通 = UDP 被规则拦了 = 防护生效
//   网络不通          = 什么都测不了
async function probeNetworkOk() {
  try {
    const res = await fetchFn('https://www.cloudflare.com/cdn-cgi/trace', {
      signal: AbortSignal.timeout(12000),
      cache: 'no-store',
    });
    return res.ok;
  } catch {
    return false;
  }
}

const [webrtcIp, networkOk] = await Promise.all([stunProbe(), probeNetworkOk()]);

// 住宅独享 IP: 环境变量优先, 其次 settings.json 里的 residential.server。
//
// 但 residential.server 是住宅 SOCKS5 的**接入地址**, 供应商可能给域名而不是 IP。
// core 的 exit-consistency 假定 expectedIp 要么为空、要么就是 IP 字面量
// (exit-consistency.ts: `if (expectedIp && ip !== expectedIp)`), 传域名会恒定假失败
// ("出口是 1.2.3.4, 但预期是 proxy.example.com")。
// 守卫加在调用点, 与 desktop/service.mjs 的写法保持一致。
// 守卫作用在**最终值**上(env 与 settings 合并之后), 这样手工把
// AIGUARD_EXPECTED_IP 设成域名同样不会假失败。
const rawExpectedIp = process.env.AIGUARD_EXPECTED_IP || settings.residential.server || '';
const expectedIp = /^\d+\.\d+\.\d+\.\d+$/.test(rawExpectedIp) ? rawExpectedIp : '';

const report = await runDoctor({
  fetchFn,
  expectedIp,
  expectedCountry: process.env.AIGUARD_EXPECTED_COUNTRY ?? 'US',
  hasIpv6,
  ipv6Probe: async () => null,        // TUN 接管后 IPv6 应探测不到
  webrtcObserved: webrtcIp,
  networkOk,
  longConnProbe: longConnProbe(idleMs),
  idleMs,
  processLister: listProcesses,
  readDnsServers,
  dnsHijackProbe,
  ipv6Snapshot: readIpv6Snapshot,
  ownPids: await pidsOnPorts([process.env.AIGUARD_OWN_PORT ?? '7891', process.env.AIGUARD_CTRL_PORT ?? '9091']),
});

// AI 线路四项(独享 IP / 断网保护 / Claude Code 线路 / Claude 看到的 IP)。
// 追加在原有 6 项之后, 不改动原有项。
const aiRouteItems = await runAiRouteChecks({
  fetchFn,
  expectedIp,
  controllerGet,
});
report.items.push(...aiRouteItems);

// overall 由调用方自己重算(core 不管追加项)。
// 严重度顺序与 core/doctor/index.ts 的 SEVERITY 保持一致。
const SEVERITY = { ok: 0, warn: 1, unknown: 2, fail: 3 };
report.overall = report.items.reduce(
  (worst, i) => (SEVERITY[i.state] > SEVERITY[worst] ? i.state : worst),
  'ok',
);

if (process.argv.includes('--json')) {
  console.log(JSON.stringify(report.items));
} else {
  const ICON = { ok: '✓', fail: '✗', warn: '!', unknown: '?' };
  console.log('\n=== AI Guard 体检 ===\n');
  for (const i of report.items) {
    console.log(`${ICON[i.state] ?? '?'} ${i.title}`);
    console.log(`   ${i.detail}\n`);
  }
  console.log(`总体: ${report.overall.toUpperCase()}`);
  if (report.overall === 'fail') process.exitCode = 1;
}
