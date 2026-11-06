#!/usr/bin/env node
// AI Guard 控制面板 —— 本地 HTTP 服务 + 浏览器界面。
//
// 为什么不用 Tauri: 本机 WebView2 装了两个版本(156.0.4314.56 / .58),
// Tauri 2.12 在其中创建窗口时报 "Failed to setup app: 拒绝访问 (os error 5)",
// 堆栈落在 tao 的 event_loop 里。用浏览器当界面完全不依赖 WebView2,
// 而且 CLI 与界面共用同一套 core 逻辑, 功能不打折。
//
// 用法: node bin/ui.js   然后浏览器打开 http://127.0.0.1:9123
import { createServer } from 'node:http';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, execFile } from 'node:child_process';
import { spawn } from 'node:child_process';
import { request as httpRequest } from 'node:http';
import { connect as tlsConnect } from 'node:tls';
import { createConnection } from 'node:net';
import { createSocket } from 'node:dgram';
import { networkInterfaces } from 'node:os';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
if (!existsSync(join(ROOT, 'dist', 'core', 'settings.js'))) {
  console.log('首次运行: 编译 core/ 到 dist/ ...');
  execFileSync(process.execPath, [join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc')], {
    cwd: ROOT, stdio: 'inherit',
  });
}

const { loadSettings, saveSettings } = await import('../dist/core/settings.js');
const { runDoctor } = await import('../dist/core/doctor/index.js');
const { runAiRouteChecks } = await import('../dist/core/doctor/ai-route-report.js');
const { analyzeLog } = await import('../dist/core/domain/patcher.js');

const SETTINGS = join(process.env.APPDATA ?? '.', 'aiguard', 'settings.json');
const LOG = join(process.env.APPDATA ?? '.', 'aiguard', 'mihomo', 'mihomo.log');
const PORT = Number(process.env.AIGUARD_UI_PORT ?? 9123);
const PROXY = `127.0.0.1:${loadSettings(SETTINGS).mixedPort}`;

const HTML = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>AI Guard</title>
<style>
:root{--bg:#0f1115;--card:#171a21;--line:#262b35;--fg:#e6e9ef;--dim:#8b93a7;
--ok:#3fb950;--bad:#f85149;--warn:#d29922;--unk:#6e7681}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);
font:14px/1.6 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif}
.wrap{max-width:900px;margin:0 auto;padding:22px}
header{display:flex;align-items:center;justify-content:space-between;margin-bottom:18px}
h1{font-size:19px;margin:0}
h2{font-size:13px;margin:0 0 12px;color:var(--dim);font-weight:600;
text-transform:uppercase;letter-spacing:.5px}
button{background:#21262d;color:var(--fg);border:1px solid var(--line);
border-radius:6px;padding:7px 15px;cursor:pointer;font-size:13px}
button:hover:not(:disabled){background:#2d333b}
button:disabled{opacity:.45;cursor:default}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;
padding:16px;margin-bottom:14px}
dl{display:grid;grid-template-columns:88px 1fr;gap:8px 12px;margin:0}
dt{color:var(--dim)}dd{margin:0;display:flex;align-items:center;gap:7px}
.dot{width:8px;height:8px;border-radius:50%;display:inline-block}
.dot.ok{background:var(--ok)}.dot.bad{background:var(--bad)}
.seg{display:inline-flex;border:1px solid var(--line);border-radius:8px;overflow:hidden}
.seg button{border:0;border-radius:0;background:transparent}
.seg button.on{background:#2d333b;color:#fff}
.hint{color:var(--dim);font-size:12px;margin:10px 0 0}
ul.checks{list-style:none;padding:0;margin:0}
ul.checks li{display:grid;grid-template-columns:54px 140px 1fr;gap:10px;
align-items:baseline;padding:10px 0;border-top:1px solid var(--line)}
ul.checks li:first-child{border-top:0}
.badge{font-size:11px;padding:2px 7px;border-radius:4px;text-align:center;font-weight:600}
.badge.ok{background:rgba(63,185,80,.15);color:var(--ok)}
.badge.fail{background:rgba(248,81,73,.15);color:var(--bad)}
.badge.warn{background:rgba(210,153,34,.15);color:var(--warn)}
.badge.unknown{background:rgba(110,118,129,.15);color:var(--unk)}
.detail{color:var(--dim);font-size:12px}
pre.log{background:#0d1014;border:1px solid var(--line);border-radius:6px;
padding:10px;height:200px;overflow:auto;font:12px/1.5 ui-monospace,Consolas,monospace;
color:#9aa4b8;margin:0;white-space:pre-wrap;word-break:break-all}
.row{display:flex;align-items:center;justify-content:space-between}
input{background:#0d1014;border:1px solid var(--line);border-radius:6px;
color:var(--fg);padding:7px 10px;width:100%;font-size:13px}
.field{margin-bottom:10px}
.field label{display:block;color:var(--dim);font-size:12px;margin-bottom:4px}
</style></head><body><div class="wrap">
<header><h1>AI Guard</h1>
<div><button id="toggle">启动</button></div></header>

<p class="hint" id="startHint" style="margin:-6px 0 12px"></p>
<section class="card"><h2>状态</h2><dl>
<dt>内核</dt><dd><span id="dot" class="dot"></span><span id="running">检查中…</span></dd>
<dt>出口 IP</dt><dd id="exit">—</dd>
<dt>模式</dt><dd id="mode">—</dd>
<dt>TUN</dt><dd id="tun">—</dd>
<dt>代理端口</dt><dd id="port">—</dd>
</dl></section>

<section class="card"><h2>分流模式</h2>
<div class="seg"><button id="bStrict">严格</button><button id="bPrecise">精确</button><button id="bGlobal">全局</button></div>
<p class="hint" id="modeHint"></p></section>

<section class="card"><div class="row"><h2>体检</h2>
<button id="runDoc">检测</button></div>
<ul class="checks" id="checks"><li><span></span><span></span>
<span class="detail">点击「检测」运行六项</span></li></ul></section>

<section class="card"><div class="row"><h2>规则补丁</h2>
<button id="runPatch">扫描日志</button></div>
<ul class="checks" id="patches"><li><span></span><span></span>
<span class="detail">扫描是否有 AI 域名走了错误出口</span></li></ul></section>

<section class="card"><div class="row"><h2>配置</h2>
<button id="saveCfg">保存</button></div>
<div class="field"><label>机场订阅 URL</label><input id="airport"/></div>
<div class="field"><label>住宅 IP:端口</label><input id="rsrv"/></div>
<div class="field"><label>用户名</label><input id="ruser"/></div>
<div class="field"><label>密码</label><input id="rpass" type="password"/></div>
<p class="hint">改完点保存，重启内核生效。TUN 模式需以管理员身份运行。</p>
</section>

<section class="card"><div class="row"><h2>内核日志</h2>
<button id="refreshLog">刷新</button></div>
<pre class="log" id="log">加载中…</pre></section>

</div><script>
const $=id=>document.getElementById(id);
const LABEL={ok:'通过',fail:'失败',warn:'警告',unknown:'未知'};
let cfg=null;

async function j(u,o){const r=await fetch(u,o);if(!r.ok)throw new Error(await r.text());return r.json()}

async function status(){
  try{
    const s=await j('/api/status');
    $('dot').className='dot '+(s.running?'ok':'bad');
    $('running').textContent=s.running?'运行中':'已停止';
    $('exit').textContent=s.exitIp?(s.exitIp+(s.loc?' ('+s.loc+')':'')):'—';
    $('mode').textContent={strict:'严格',precise:'精确',global:'全局'}[s.mode]||s.mode;
    $('tun').textContent=s.tunEnabled?'已接管':'未启用';
    $('port').textContent=s.mixedPort;
    $('toggle').textContent=s.running?'停止':'启动';
    $('bStrict').className=s.mode==='strict'?'on':'';
    $('bPrecise').className=s.mode==='precise'?'on':'';
    $('bGlobal').className=s.mode==='global'?'on':'';
    const HINT={
      strict:'Cloudflare 全家桶走独享 IP，出口绝对一致，防封最强。流量消耗较高。',
      precise:'仅规则覆盖的 AI 域名与 Cloudflare 兜底走独享 IP，其余走机场，更省流量。规则未覆盖的新域名仍可能走机场。',
      global:'除内网和国内站点外，所有流量都走独享 IP。出口最统一，但查 IP 会看到你的真实住宅 IP。'+
             '警告：流量消耗极大，看视频/下载都算独享 IP 流量。'
    };
    $('modeHint').textContent=HINT[s.mode]||HINT.strict;
    $('modeHint').style.color=s.mode==='global'?'var(--warn)':'';
  }catch(e){$('running').textContent='读取失败'}
}

function hint(msg,kind){
  const el=$('startHint');
  if(!el)return;
  el.textContent=msg||'';
  el.style.color=kind==='bad'?'var(--bad)':'var(--dim)';
}

async function loadCfg(){
  cfg=await j('/api/config');
  $('airport').value=cfg.airportUrl||'';
  $('rsrv').value=(cfg.residential?.server||'')+':'+(cfg.residential?.port||'');
  $('ruser').value=cfg.residential?.username||'';
  $('rpass').value=cfg.residential?.password||'';
}

$('toggle').onclick=async()=>{
  const s=await j('/api/status');
  const btn=$('toggle');
  // 启动/停止: 立刻发请求(不阻塞), 然后轮询 /api/start-state 直到有结论。
  try{
    const r=await j(s.running?'/api/stop':'/api/start',{method:'POST'});
    if(r&&r.note){hint(r.note)}
    if(s.running){await status();return}
    btn.disabled=true;
    for(let i=0;i<40;i++){
      await new Promise(z=>setTimeout(z,1500));
      const st=await j('/api/start-state');
      if(st.phase==='running'){hint('内核已启动');btn.disabled=false;await status();return}
      if(st.phase==='failed'){hint(st.error,'bad');btn.disabled=false;await status();return}
      hint(st.phase==='elevating'?'等待 UAC 确认…':'正在启动…');
    }
    hint('等待超时, 请手动检查','bad');
    btn.disabled=false;
  }catch(e){hint('操作失败: '+(e.message||e),'bad');btn.disabled=false}
};
async function switchMode(m){
  const r=await j('/api/mode?m='+m,{method:'POST'});
  if(r.note)hint(r.note);
  if(!r.restarted){await status();return}
  // 模式变了要重启内核才生效, 这里等服务起来再刷新状态
  for(let i=0;i<40;i++){
    await new Promise(z=>setTimeout(z,1500));
    const st=await j('/api/start-state');
    if(st.phase==='running'){hint('内核已按新模式重启');await status();return}
    if(st.phase==='failed'){hint(st.error,'bad');await status();return}
    hint(st.phase==='elevating'?'等待 UAC 确认…':'正在重启内核…');
  }
  hint('重启超时, 请手动检查','bad');
}
$('bStrict').onclick=()=>switchMode('strict');
$('bPrecise').onclick=()=>switchMode('precise');
$('bGlobal').onclick=()=>{
  if(!confirm('全局模式会让所有流量（含视频、下载）都走独享 IP，流量消耗极大。确定切换？'))return;
  switchMode('global');
};

$('runDoc').onclick=async()=>{
  $('runDoc').disabled=true;$('runDoc').textContent='检测中…';
  try{
    const items=await j('/api/doctor');
    $('checks').innerHTML=items.map(i=>
      '<li><span class="badge '+i.state+'">'+LABEL[i.state]+'</span>'+
      '<strong>'+i.title+'</strong><span class="detail">'+i.detail+'</span></li>').join('');
  }catch(e){$('checks').innerHTML='<li><span></span><span></span>'+
    '<span class="detail">检测失败: '+e.message+'</span></li>'}
  $('runDoc').disabled=false;$('runDoc').textContent='检测';
};

$('runPatch').onclick=async()=>{
  const f=await j('/api/patch');
  if(!f.length){$('patches').innerHTML='<li><span class="badge ok">正常</span>'+
    '<span>无问题</span><span class="detail">没有 AI 域名走错出口</span></li>';return}
  $('patches').innerHTML=f.map(x=>
    '<li><span class="badge warn">'+x.count+'次</span><strong>'+x.domain+'</strong>'+
    '<span class="detail">走了 '+x.actualGroup+'，建议加 '+x.suggestedRule+'</span></li>').join('');
};

$('saveCfg').onclick=async()=>{
  const [host,port]=(($('rsrv').value||'').split(':'));
  const body={airportUrl:$('airport').value.trim(),
    residential:{server:host||'',port:Number(port)||0,
    username:$('ruser').value.trim(),password:$('rpass').value}};
  await j('/api/config',{method:'POST',body:JSON.stringify(body),
    headers:{'content-type':'application/json'}});
  $('saveCfg').textContent='已保存';setTimeout(()=>$('saveCfg').textContent='保存',1500);
};

$('refreshLog').onclick=async()=>{
  const l=await j('/api/logs?n=80');
  $('log').textContent=l.join('\\n')||'暂无日志';
};

status();loadCfg();
$('refreshLog').onclick();
setInterval(status,5000);
</script></body></html>`;

// ---------- 经代理取出口 IP ----------
function proxiedGet(url, timeoutMs = 12000) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const [ph, pp] = PROXY.split(':');
    const req = httpRequest({
      host: ph, port: Number(pp), method: 'CONNECT',
      path: `${u.hostname}:443`, headers: { Host: `${u.hostname}:443` }, timeout: timeoutMs,
    });
    req.on('connect', (res, socket) => {
      if (res.statusCode !== 200) { socket.destroy(); return reject(new Error('CONNECT ' + res.statusCode)); }
      const t = tlsConnect({ socket, servername: u.hostname, rejectUnauthorized: false }, () => {
        t.write(`GET ${u.pathname}${u.search} HTTP/1.1\r\nHost: ${u.hostname}\r\n` +
          `User-Agent: AI-Guard/1.0\r\nConnection: close\r\n\r\n`);
      });
      let raw = '';
      t.setEncoding('utf8');
      t.on('data', (d) => { raw += d; t.setTimeout(0); });
      t.on('end', () => {
        const sep = raw.indexOf('\r\n\r\n');
        const body = raw.slice(sep + 4);
        resolve({ ok: true, text: async () => body, json: async () => JSON.parse(body) });
      });
      t.on('error', reject);
      t.setTimeout(timeoutMs, () => { t.destroy(); reject(new Error('timeout')); });
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('CONNECT timeout')); });
    req.on('error', reject);
    req.end();
  });
}

const fetchFn = (url, init) => {
  if (process.env.AIGUARD_NO_PROXY === '1') return fetch(url, init);
  return proxiedGet(url);
};

/**
 * 读 mihomo 控制接口的某个路径, 返回解析后的 JSON。
 * 控制接口读不到必须 reject, 由 runAiRouteChecks 降级成 unknown。
 */
function makeControllerGet(port, secret) {
  return (path) => new Promise((resolve, reject) => {
    const req = httpRequest({
      host: '127.0.0.1',
      port,
      method: 'GET',
      path,
      headers: secret ? { Authorization: `Bearer ${secret}` } : {},
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
        } catch {
          reject(new Error(`controller ${path} -> 非法 JSON`));
        }
      });
    });
    req.on('timeout', () => { req.destroy(); reject(new Error(`controller ${path} -> 超时`)); });
    req.on('error', reject);
    req.end();
  });
}


/** 本机是否有公网 IPv6(排除链路本地/私有段/虚拟网卡) */
function hasPublicIpv6() {
  return Object.entries(networkInterfaces()).some(([name, list]) =>
    !/Meta|Mihomo|Clash|TUN|wintun/i.test(name) &&
    (list ?? []).some(
      (x) => (x.family === 'IPv6' || x.family === 6) && !x.internal && !/^(fe80|fc|fd)/i.test(x.address),
    ),
  );
}

/** STUN 探测 WebRTC 可见的公网 IP(UDP 打洞, 不走 HTTP 代理) */
function stunProbe(host = 'stun.l.google.com', port = 19302, timeoutMs = 4000) {
  return new Promise((resolve) => {
    const sock = createSocket('udp4');
    const tx = Buffer.from(Array.from({ length: 12 }, () => Math.floor(Math.random() * 256)));
    const req = Buffer.alloc(20);
    req.writeUInt16BE(1, 0);
    req.writeUInt16BE(0, 2);
    req.writeUInt32BE(0x2112a442, 4);
    tx.copy(req, 8);
    const timer = setTimeout(() => { try { sock.close(); } catch {} resolve(null); }, timeoutMs);
    sock.on('message', (msg) => {
      clearTimeout(timer);
      try { sock.close(); } catch {}
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
    sock.on('error', () => { clearTimeout(timer); try { sock.close(); } catch {} resolve(null); });
    sock.send(req, port, host);
  });
}

/** 长连接保持: 建 TLS 后每 8s 发心跳, 看能否撑过 idleMs */
function longConnProbe(mixedPort, idleMs) {
  const HOST = 'www.cloudflare.com';
  return () => new Promise((resolve) => {
    const t0 = Date.now();
    const raw = createConnection({ host: '127.0.0.1', port: Number(mixedPort) });
    let done = false, hb = null;
    const finish = (closed) => {
      if (done) return;
      done = true;
      if (hb) clearInterval(hb);
      resolve({ aliveMs: Date.now() - t0, closed });
    };
    raw.on('connect', () => raw.write(`CONNECT ${HOST}:443 HTTP/1.1\r\nHost: ${HOST}:443\r\n\r\n`));
    raw.once('data', (d) => {
      if (!String(d).includes('200')) { raw.destroy(); return finish(true); }
      const t = tlsConnect({ socket: raw, servername: HOST, rejectUnauthorized: false }, () => {
        hb = setInterval(() => {
          if (t.destroyed) return;
          try { t.write(Buffer.from([0x17, 0x03, 0x03, 0x00, 0x01, 0x00])); } catch {}
        }, 8000);
        setTimeout(() => { t.destroy(); finish(false); }, idleMs);
      });
      t.on('error', () => finish(true));
      t.on('close', () => finish(true));
    });
    raw.on('error', () => finish(true));
    raw.on('close', () => finish(true));
  });
}

/** 枚举代理相关进程的 名字+命令行, 用于区分自己的内核与别人的客户端 */
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

function mihomoRunning() {
  return new Promise((resolve) => {
    execFile('tasklist', ['/fi', 'imagename eq mihomo.exe', '/fo', 'csv', '/nh'],
      { windowsHide: true }, (_e, out) => resolve(String(out ?? '').includes('mihomo')));
  });
}

function tailLines(path, n) {
  if (!existsSync(path)) return [];
  try {
    return readFileSync(path, 'utf8').split(/\r?\n/).slice(-n);
  } catch { return []; }
}

let child = null;
/** 启动阶段: idle | elevating | pending | running | failed */
let startState = { phase: 'idle', at: null, error: null };


/**
 * 重新生成 config.yaml 并让运行中的内核热重载。
 * mihomo 的 PUT /configs 会把新配置读进来并重建规则/代理组,
 * 已建立的连接不受影响, 也不需要管理员权限 —— 比"杀掉重启"好得多。
 */
async function reloadCore() {
  try {
    const s = loadSettings(SETTINGS);
    const { loadRuleSets } = await import('../dist/core/domain/rule-source.js');
    const { buildConfig } = await import('../dist/core/config/builder.js');
    const { configToYaml } = await import('../dist/core/runtime/mihomo.js');

    const sets = loadRuleSets(join(ROOT, 'rules', 'domains'));
    const cfg = buildConfig({
      mode: s.mode,
      sets,
      residential: s.residential,
      airportUrl: s.airportUrl,
      mixedPort: s.mixedPort,
      controllerPort: s.controllerPort,
      secret: s.secret || 'aiguard',
      homeRegion: s.homeRegion,
      tunEnabled: s.tunEnabled,
    });
    const target = join(process.env.APPDATA ?? '.', 'aiguard', 'mihomo');
    writeFileSync(join(target, 'config.yaml'), configToYaml(cfg), 'utf8');

    const body = JSON.stringify({ path: join(target, 'config.yaml').replace(/\\/g, '\\') });
    const res = await new Promise((resolve, reject) => {
      const req = httpRequest({
        host: '127.0.0.1',
        port: s.controllerPort,
        method: 'PUT',
        path: '/configs?force=true',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${s.secret || 'aiguard'}`,
          'content-length': Buffer.byteLength(body),
        },
        timeout: 15000,
      }, (r) => {
        let t = '';
        r.on('data', (d) => { t += d; });
        r.on('end', () => resolve({ status: r.statusCode, body: t }));
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('重载超时')); });
      req.write(body);
      req.end();
    });

    if (res.status !== 204 && res.status !== 200) {
      return { ok: false, error: `HTTP ${res.status} ${res.body}`.trim() };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message || String(e) };
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const send = (code, body, type = 'application/json') => {
    res.writeHead(code, { 'content-type': type + '; charset=utf-8' });
    res.end(typeof body === 'string' ? body : JSON.stringify(body));
  };

  try {
    if (url.pathname === '/') return send(200, HTML, 'text/html');

    if (url.pathname === '/api/status') {
      const s = loadSettings(SETTINGS);
      let exitIp = null, loc = null;
      try {
        const r = await fetchFn('https://www.cloudflare.com/cdn-cgi/trace');
        const body = await r.text();
        exitIp = /^ip=(.+)$/m.exec(body)?.[1]?.trim() ?? null;
        loc = /^loc=(.+)$/m.exec(body)?.[1]?.trim() ?? null;
      } catch { /* 代理没起来时拿不到, 正常 */ }
      return send(200, {
        running: await mihomoRunning(), mode: s.mode, tunEnabled: s.tunEnabled,
        mixedPort: s.mixedPort, exitIp, loc,
      });
    }

    if (url.pathname === '/api/config') {
      if (req.method === 'GET') return send(200, loadSettings(SETTINGS));
      let body = '';
      for await (const c of req) body += c;
      const patch = JSON.parse(body || '{}');
      const s = loadSettings(SETTINGS);
      if (patch.airportUrl !== undefined) s.airportUrl = patch.airportUrl;
      if (patch.residential) s.residential = { ...s.residential, ...patch.residential };
      saveSettings(SETTINGS, s);
      return send(200, { ok: true });
    }

    if (url.pathname === '/api/mode') {
      const m = url.searchParams.get('m');
      if (m !== 'strict' && m !== 'precise' && m !== 'global') {
        return send(400, 'mode 只能是 strict / precise / global');
      }
      const s = loadSettings(SETTINGS);
      const wasRunning = await mihomoRunning();
      s.mode = m;
      saveSettings(SETTINGS, s);

      // 模式写在规则里(MATCH 的落点不同), 改 settings 不会影响已在跑的内核。
      // 但**不需要重启进程**: mihomo 支持 PUT /configs 热重载, 不中断连接、
      // 也不需要管理员权限。之前用"提权重启"的方案在提权窗口里没生效,
      // 导致界面显示已切换、实际流量还走旧规则(踩过)。
      if (!wasRunning) {
        return send(200, { ok: true, restarted: false, note: '模式已保存, 内核未运行, 下次启动生效' });
      }

      const reloaded = await reloadCore();
      if (!reloaded.ok) {
        return send(500, {
          ok: false, restarted: false,
          error: `热重载失败: ${reloaded.error}。请手动重启内核。`,
        });
      }

      return send(200, {
        ok: true, restarted: false, reloaded: true,
        note: `已切到 ${{ strict: '严格', precise: '精确', global: '全局' }[m]} 模式并热重载, 连接未中断`,
      });
    }

    if (url.pathname === '/api/start') {
      if (await mihomoRunning()) return send(200, { ok: true, already: true });
      const s = loadSettings(SETTINGS);

      // TUN 需要管理员权限, 面板以普通权限运行拉不起来, 只能走 UAC 提权。
      // 关键: 不能 await UAC —— 用户可能十几秒后才点"是", 那会把 HTTP 响应
      // 一起挂住, 界面表现为请求超时(实测踩过)。所以立刻返回, 后台异步推进,
      // 结果由 /api/start-state 轮询给前端。
      if (s.tunEnabled) {
        if (startState.phase === 'elevating') {
          return send(200, { ok: true, phase: 'elevating', note: '正在等待 UAC 确认…' });
        }
        startState = { phase: 'elevating', at: Date.now(), error: null };

        const cmd = `$env:AIGUARD_ELEVATED='1'; & '${process.execPath}' '${join(ROOT, 'bin', 'start.js')}'`;
        execFile('powershell', ['-NoProfile', '-Command',
          `Start-Process powershell -Verb RunAs -ArgumentList '-NoExit','-NoProfile','-Command',"${cmd.replace(/"/g, '\\"')}" -WindowStyle Normal`,
        ], { windowsHide: true }, (e) => {
          startState = e
            ? { phase: 'failed', at: Date.now(), error: 'UAC 被取消或拒绝。请以管理员身份打开 PowerShell 后运行: node bin/start.js' }
            : { phase: 'pending', at: Date.now(), error: null };
        });

        return send(200, { ok: true, phase: 'elevating', note: '已请求提权, 请在 UAC 窗口点「是」' });
      }

      if (child && !child.killed) child = null;
      child = spawn(process.execPath, [join(ROOT, 'bin', 'start.js')], {
        cwd: ROOT, stdio: 'ignore', detached: true,
      });
      child.unref();
      return send(200, { ok: true, phase: 'starting' });
    }

    // 启动进度: 前端轮询, 直到内核起来或判定失败
    if (url.pathname === '/api/start-state') {
      const running = await mihomoRunning();
      if (running) startState = { phase: 'running', at: startState.at ?? Date.now(), error: null };
      // 提权窗口超时(60s 内没起内核)判失败, 避免前端永远转圈
      else if (startState.phase !== 'failed' && startState.at && Date.now() - startState.at > 60000) {
        startState = {
          phase: 'failed',
          at: startState.at,
          error: '60 秒内未检测到内核。请确认 UAC 已点「是」, 或手动以管理员身份运行 node bin/start.js',
        };
      }
      const s = loadSettings(SETTINGS);
      return send(200, { ...startState, running, mixedPort: s.mixedPort });
    }

    if (url.pathname === '/api/stop') {
      execFile('taskkill', ['/im', 'mihomo.exe', '/f'], { windowsHide: true }, () => {});
      startState = { phase: 'idle', at: Date.now(), error: null };
      return send(200, { ok: true });
    }

    if (url.pathname === '/api/logs') {
      return send(200, tailLines(LOG, Number(url.searchParams.get('n') ?? 80)));
    }

    if (url.pathname === '/api/patch') {
      const s = loadSettings(SETTINGS);
      const { loadRuleSets, } = await import('../dist/core/domain/rule-source.js');
      const sets = loadRuleSets(join(ROOT, 'rules', 'domains'));
      const domains = Object.values(sets).flat()
        .map((r) => r.split(',')[1])
        .filter(Boolean);
      const findings = analyzeLog(tailLines(LOG, 3000).join('\n'), domains);
      return send(200, findings);
    }

    if (url.pathname === '/api/doctor') {
      // 复用 bin/doctor.js 里的真实探测实现, 避免两套逻辑不一致
      const s = loadSettings(SETTINGS);
      const networkOk = await (async () => {
        try {
          const r = await fetchFn('https://www.cloudflare.com/cdn-cgi/trace');
          return r.ok;
        } catch { return false; }
      })();
      const webrtc = await stunProbe();
      // 住宅节点是 SOCKS5 的接入地址, 供应商可能给域名。拿域名去和出口 IP 比会恒定失败,
      // 所以只接受 IPv4 字面量 (与 desktop/service.mjs、bin/doctor.js 的写法一致)。
      const expectedIp = /^\d+\.\d+\.\d+\.\d+$/.test(s.residential.server || '')
        ? s.residential.server
        : '';
      const report = await runDoctor({
        fetchFn,
        expectedIp,
        expectedCountry: process.env.AIGUARD_EXPECTED_COUNTRY ?? 'US',
        hasIpv6: hasPublicIpv6(),
        ipv6Probe: async () => null,
        webrtcObserved: webrtc,
        networkOk,
        tunEnabled: s.tunEnabled,
        longConnProbe: longConnProbe(s.mixedPort, 15000),
        idleMs: 15000,
        processLister: listProcesses,
        readDnsServers,
        dnsHijackProbe,
        ipv6Snapshot: readIpv6Snapshot,
        ownPids: await pidsOnPorts([String(s.mixedPort), String(s.controllerPort)]),
      });
      // AI 线路四项(独享 IP / 断网保护 / Claude Code 线路 / Claude 看到的 IP),
      // 追加在原有 6 项之后。控制接口读不到时这些项是 unknown, 不是 fail。
      const aiRouteItems = await runAiRouteChecks({
        fetchFn,
        expectedIp,
        controllerGet: makeControllerGet(
          Number(process.env.AIGUARD_CTRL_PORT ?? s.controllerPort),
          process.env.AIGUARD_CTRL_SECRET ?? s.secret,
        ),
      });
      report.items.push(...aiRouteItems);
      return send(200, report.items);
    }

    send(404, { error: 'not found' });
  } catch (e) {
    send(500, { error: e.message });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`\n  AI Guard 控制面板已启动`);
  console.log(`  请在浏览器打开: http://127.0.0.1:${PORT}\n`);
  console.log(`  配置: ${SETTINGS}`);
  console.log(`  代理端口: ${PROXY}`);
  console.log(`  按 Ctrl+C 停止面板（不影响已启动的代理内核）\n`);
});
