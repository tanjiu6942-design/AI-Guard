#!/usr/bin/env node
/**
 * 只读网络诊断：定位「校园网 / 需认证网络下 AI Guard 不可用」断在哪一环。
 *
 * 不做任何修改：不改 DNS、不动路由、不启停内核、不碰 WFP。
 *
 * 注意：必须先完全退出 AI Guard 再运行。
 * AI Guard 接管网络时 DNS 被换成 fake-ip、路由被 TUN 抓走，
 * 此时所有「能不能连通」的测量都是内核伪造的应答，没有诊断价值。
 * 脚本会自己检测这种情况并明确标注，不会拿假数据给结论。
 *
 * 用法：node scripts/diagnose-network.mjs
 */

import { connect } from "node:net";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { networkInterfaces } from "node:os";
import { getServers, promises as dns } from "node:dns";

const APPDATA = process.env.APPDATA ?? "";
const DATA_DIR = join(APPDATA, "aiguard");
const SETTINGS = join(DATA_DIR, "settings.json");
const DNS_BACKUP = join(DATA_DIR, "mihomo", "desktop-dns-backup.json");

const TUN_DNS = "198.18.0.2";
const TUN_DNS6 = "fdfe:dcba:9876::2";

const say = (s = "") => console.log(s);
const pad = (s, n) => String(s).padEnd(n);

function loadSettings() {
  try { return JSON.parse(readFileSync(SETTINGS, "utf8")); } catch { return null; }
}
function hostOf(url) {
  try { return new URL(url).hostname; } catch { return null; }
}

const VIRTUAL = /VirtualBox|Hyper-V|VMware|Loopback|vEthernet|Tailscale|WireGuard|TAP|Meta/i;

function inspectLocalState() {
  const resolvers = getServers();
  const hijacked = resolvers.some((s) => s === TUN_DNS || s === TUN_DNS6);
  const adapters = Object.entries(networkInterfaces())
    .filter(([name, addrs]) => !VIRTUAL.test(name) && addrs?.some((a) => a.family === "IPv4" && !a.internal))
    .map(([name, addrs]) => name + "=" + addrs.filter((a) => a.family === "IPv4" && !a.internal).map((a) => a.address).join(","));
  return {
    resolvers,
    hijacked,
    adapters,
    dnsBackupLeft: existsSync(DNS_BACKUP),
    settings: loadSettings(),
  };
}

/**
 * captive portal 探测。
 *
 * 已认证时各厂商端点会返回一个「只有真能出网才拿得到」的固定响应；
 * 拿到 3xx 或登录页 HTML，就说明中间有人把你拦到门户了。
 * 只看 TCP 能否 connect 会把门户返回的 302 误判成「网络是通的」。
 *
 * Apple 端点在国内常被墙，只作参考，不参与判定。
 */
const CAPTIVE = [
  { name: "Windows NCSI", url: "http://www.msftconnecttest.com/connecttest.txt", weight: "primary",
    ok: (s, b) => s === 200 && /Microsoft Connect Test/i.test(b) },
  { name: "MIUI", url: "http://connect.rom.miui.com/generate_204", weight: "primary",
    ok: (s) => s === 204 },
  { name: "Apple", url: "http://captive.apple.com/hotspot-detect.html", weight: "reference",
    ok: (s, b) => s === 200 && /Success/i.test(b) },
];

async function probeCaptive({ url, ok }) {
  try {
    const r = await fetch(url, {
      redirect: "manual",
      signal: AbortSignal.timeout(6000),
      headers: { "User-Agent": "Mozilla/5.0 AI-Guard-Doctor" },
    });
    const location = r.headers.get("location") ?? "";
    const body = r.status >= 300 && r.status < 400 ? "" : (await r.text()).slice(0, 400);
    if (ok(r.status, body)) return { verdict: "已认证", status: r.status, location };
    if (r.status >= 300 && r.status < 400) return { verdict: "需认证（重定向到门户）", status: r.status, location };
    if (/<form|password|login|portal|sso/i.test(body)) return { verdict: "需认证（返回登录页）", status: r.status, location };
    return { verdict: "异常响应", status: r.status, location };
  } catch (e) {
    return { verdict: "无响应", error: e.name === "TimeoutError" ? "6s 超时" : (e.cause?.code ?? e.message) };
  }
}

function tcpProbe(host, port, timeout = 6000) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const sock = connect({ host, port });
    const done = (r) => { sock.destroy(); resolve(Object.assign({}, r, { ms: Date.now() - t0 })); };
    sock.setTimeout(timeout);
    sock.once("connect", () => done({ ok: true }));
    sock.once("timeout", () => done({ ok: false, error: timeout + "ms 超时" }));
    sock.once("error", (e) => done({ ok: false, error: e.code ?? e.message }));
  });
}

say("=== AI Guard 网络诊断（只读） ===");
say("时间：" + new Date().toISOString());
say();

const local = inspectLocalState();
const settings = local.settings;

say("--- 本机状态 ---");
say("DNS 服务器   : " + (local.resolvers.join(", ") || "（空）"));
say("在线网卡     : " + (local.adapters.join(" | ") || "（无）"));
say("DNS 备份文件 : " + (local.dnsBackupLeft ? "存在（AI Guard 正在保护，或上次未正常恢复）" : "无"));
if (settings) say("分流模式     : " + settings.mode + "   TUN: " + settings.tunEnabled + "   实时保护: " + (settings.realtimeProtection !== false));
say();

if (local.hijacked) {
  say("!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!");
  say("  DNS 仍在指向 AI Guard 隧道（198.18.0.2）。");
  say("  下面的连通性结果全部经过隧道，不代表校园网真实状态。");
  say("  请先在托盘「退出程序」→「退出保护并退出」，再重新运行。");
  say("!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!");
  say();
}

say("--- 认证状态（直连，绕过系统代理） ---");
const portalResults = [];
for (const c of CAPTIVE) {
  const r = await probeCaptive(c);
  portalResults.push(Object.assign({ name: c.name, weight: c.weight }, r));
  say(pad(c.name, 14) + " " + pad(r.verdict, 26) + " " + (r.status ?? "") + " " +
      (r.location ? "-> " + String(r.location).slice(0, 80) : "") +
      (r.error ? " " + r.error : "") +
      (c.weight === "reference" ? "  (参考项)" : ""));
}
const portalUrl = portalResults.map((r) => r.location).find((l) => l && /^https?:/i.test(l)) ?? null;
say();

const primary = portalResults.filter((r) => r.weight === "primary");
const authenticated = primary.every((r) => r.verdict === "已认证");
const needPortal = primary.some((r) => String(r.verdict).startsWith("需认证"));
const noNetwork = primary.every((r) => r.verdict === "无响应");
const tainted = local.hijacked;

say("--- 信源与出口可达性 ---");
if (settings?.airportUrl) {
  const subHost = hostOf(settings.airportUrl);
  if (subHost) {
    let resolved = "解析失败";
    try { resolved = (await dns.resolve4(subHost)).join(", "); } catch (e) { resolved = e.code ?? e.message; }
    const fake = String(resolved).split(".")[0] === "198" && String(resolved).split(".")[1] === "18";
    say("订阅域名     : " + subHost);
    say("  DNS 解析   : " + resolved + (fake ? "   <- fake-ip，非真实地址" : ""));
    const tcp = await tcpProbe(subHost, 443);
    say("  TCP 443    : " + (tcp.ok ? "通 " + tcp.ms + "ms" : "不通（" + tcp.error + "）") + (fake || tainted ? "   <- 经隧道，不可信" : ""));
  }
} else {
  say("订阅域名     : （配置里没有 airportUrl）");
}
if (settings?.residential?.server) {
  const server = settings.residential.server;
  const port = Number(settings.residential.port) || 1080;
  const tcp = await tcpProbe(server, port, 12000);
  say("住宅 SOCKS5  : " + server + ":" + port + "  " +
      (tcp.ok ? "直连可通 " + tcp.ms + "ms" : "直连不通（" + tcp.error + "）") +
      (tainted ? "   <- 经隧道，不可信" : ""));
  if (!tcp.ok) say("                （直连不通是预期的：住宅 IP 必须经机场前置中转）");
}
say();

say("--- 结论 ---");
if (tainted) {
  say("无法判定：AI Guard 仍在接管网络。请完全退出后重新运行本脚本。");
} else if (authenticated) {
  say("网络已认证，可正常出网。若 AI Guard 仍不可用，问题在订阅拉取或住宅链路，不在认证。");
} else if (needPortal) {
  say(">> 当前网络需要网页认证，且尚未完成。");
  say("   此状态下开启 AI Guard 会改 DNS / 接管路由 / 装载 WFP 规则，认证页将无法打开。");
  say("   请先完成认证，再启动 AI Guard。");
  if (portalUrl) say("   认证地址：" + portalUrl);
} else if (noNetwork) {
  say("主要探测端点全部无响应：当前没有可用出口。先确认网络已连接、是否需要先认证。");
} else {
  say("探测结果不一致，可能处于认证中途或存在透明代理。请看上面的逐项结果。");
}
say();
say("=== 机器可读结果（便于回帖） ===");
console.log(JSON.stringify({
  at: new Date().toISOString(),
  tainted,
  local: { resolvers: local.resolvers, dnsBackupLeft: local.dnsBackupLeft, adapters: local.adapters },
  captive: portalResults,
  portalUrl,
  verdict: tainted ? "无法判定（隧道接管中）" : authenticated ? "已认证" : needPortal ? "需认证" : noNetwork ? "无网络" : "不一致",
}, null, 2));
