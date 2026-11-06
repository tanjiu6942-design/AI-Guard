/**
 * 启动前置门：确认这台机器此刻真的能上外网。
 *
 * 为什么需要它 —— 校园网 / 酒店网这类「先连上、再用网页认证」的网络里，
 * AI Guard 的启动流程会制造一个用户自己解不开的死锁：
 *
 *   1. protection.prepare() 装 WFP 规则，除内核外全部阻断
 *   2. TUN 用 auto-route 接管默认路由
 *   3. 物理网卡 DNS 被改成 198.18.0.2，解析走 fake-ip
 *   4. 可此时校园网尚未认证 —— 内核自己也出不去
 *      （订阅要 DIRECT 拉取、住宅链路要经机场前置，一样不通）
 *   5. 于是认证页打不开 ⇒ 无法认证 ⇒ 永远出不去
 *
 * 实测该网络下「触发断流」为 0 次：不是保护误触发，是链路从源头就没建立。
 *
 * 所以：只在一个「已经能正常出网」的网络上启动。未认证时既不碰 DNS、
 * 也不开 TUN、也不装 WFP —— 死锁从结构上消失。
 *
 * 判定刻意保守：只有**明确看到门户**或**三个独立端点全部无响应**时才拦。
 * 证据模棱两可一律放行 —— 误拦会让一个本来正常的网络完全无法使用，
 * 比漏拦更糟。
 */

/** 三个独立端点覆盖不同厂商的判定约定。全部走 80 端口 —— 门户正是在这一层拦截。 */
export const PROBES = [
  {
    name: "Windows NCSI",
    url: "http://www.msftconnecttest.com/connecttest.txt",
    ok: (status, body) => status === 200 && /Microsoft Connect Test/i.test(body),
  },
  {
    name: "MIUI",
    url: "http://connect.rom.miui.com/generate_204",
    ok: (status) => status === 204,
  },
  {
    name: "Baidu",
    url: "http://www.baidu.com/robots.txt",
    ok: (status, body) => status === 200 && /User-agent/i.test(body),
  },
];

/** 登录页的典型特征。命中即认定被拦到了门户。 */
const PORTAL_BODY = /<form|type=["\x27]?password|login|portal|\bsso\b|认证/i;

const SKIP_ENV = "AIGUARD_SKIP_PREFLIGHT";

function isHttp(url) {
  return typeof url === "string" && /^https?:\/\//i.test(url);
}

/**
 * 探测单个端点。
 *
 * 只发 HTTP、redirect: manual —— 跟着 302 走会把门户登录页取回来当成
 * 「200 成功」，正好把要判定的现象抹掉。
 */
export async function probeOne(probe, { fetchFn = fetch, timeoutMs = 6000 } = {}) {
  try {
    const res = await fetchFn(probe.url, {
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
      headers: { "User-Agent": "Mozilla/5.0 AI-Guard-Preflight" },
    });
    const status = res.status;
    const location = res.headers.get("location") || "";
    const redirected = status >= 300 && status < 400;
    const body = redirected ? "" : (await res.text()).slice(0, 600);
    if (!redirected && probe.ok(status, body)) return { name: probe.name, verdict: "ok", status };
    if (redirected) return { name: probe.name, verdict: "portal", status, location };
    if (PORTAL_BODY.test(body)) return { name: probe.name, verdict: "portal", status, location };
    return { name: probe.name, verdict: "unexpected", status };
  } catch (e) {
    const reason = e?.name === "TimeoutError" ? timeoutMs + "ms 超时" : (e?.cause?.code || e?.message || String(e));
    return { name: probe.name, verdict: "unreachable", error: reason };
  }
}

/** 从探测结果里挑出最像认证地址的那个：必须 http(s)，且不是探测端点自己。 */
export function pickPortalUrl(results) {
  const probeHosts = new Set(PROBES.map((p) => {
    try { return new URL(p.url).host.toLowerCase(); } catch { return ""; }
  }));
  for (const r of results) {
    if (!r.location || !isHttp(r.location)) continue;
    try {
      if (!probeHosts.has(new URL(r.location).host.toLowerCase())) return r.location;
    } catch { /* 忽略非法 URL */ }
  }
  return null;
}

/** 纯函数：把探测结果归类成放行/拦截。便于单测，不依赖网络。 */
export function classify(results, { selfLocked = false } = {}) {
  /**
   * 已知本机被 AI Guard 自己的 WFP 规则锁着时，必须放行。
   *
   * 否则形成无解死锁：三个探测端点全部不可达（因为规则把除内核外的一切挡死了）
   * → 判 NO_NETWORK 拒绝启动 → 而解除规则只能靠内核/worker 活着时执行。
   * 实测(2026-11-06)用户被彻底锁死，最后只能还原系统。
   *
   * 这条前置门要防的是「外部网络还没准备好」，不是「我们自己的规则把网掐了」。
   * 后者应当先让 worker 起来把它解开 —— 而它自己的探测走受保护探测端口，不需要裸网。
   */
  if (selfLocked) {
    return { ok: true, code: null, portalUrl: null, results, selfLockedBypass: true };
  }
  const portal = results.find((r) => r.verdict === "portal");
  if (portal) {
    return { ok: false, code: "CAPTIVE_PORTAL", portalUrl: pickPortalUrl(results), results };
  }
  if (results.length > 0 && results.every((r) => r.verdict === "unreachable")) {
    return { ok: false, code: "NO_NETWORK", portalUrl: null, results };
  }
  return { ok: true, code: null, portalUrl: null, results };
}

export async function checkNetworkReady(opts = {}) {
  const results = await Promise.all(PROBES.map((probe) => probeOne(probe, opts)));
  return classify(results, { selfLocked: opts.selfLocked === true });
}

const SKIP_HINT = "（若确认网络本来就正常，可设置环境变量 " + SKIP_ENV + "=1 后重启软件跳过本检查。）";

/** 把拦截结果转成给用户看的话。这句话会直接出现在界面顶部的提示条里。 */
export function describeBlocker(result) {
  const lines = [];
  if (result.selfLockedBypass) {
    // 这里返回的是"说明"而不是"拦截语": 调用方拿到自锁放行时用它提示用户。
    lines.push("检测到本软件上次留下的整机断流规则仍在生效。");
    lines.push("");
    lines.push("本次启动会先解除该规则再接管网络；否则会形成「要解锁必须先出网、");
    lines.push("要出网必须先解锁」的死锁。");
    return lines.join("\n");
  }
  if (result.code === "CAPTIVE_PORTAL") {
    lines.push("当前网络需要网页认证且尚未完成，已拒绝启动。");
    lines.push("");
    lines.push("未认证时启动会接管 DNS、TUN 路由和系统防火墙；校园网/酒店网关会把所有流量拦到登录页，");
    lines.push("一旦接管，登录页就打不开了。请先完成认证，再点启动。");
    if (result.portalUrl) {
      lines.push("");
      lines.push("认证地址：" + result.portalUrl);
    }
  } else if (result.code === "NO_NETWORK") {
    lines.push("当前网络没有任何可用的外网出口（" + PROBES.length + " 个探测端点全部无响应），已拒绝启动。");
    lines.push("");
    lines.push("请先确认网线或 Wi-Fi 已连接、以及是否需要完成网页认证。");
  } else {
    lines.push("启动前网络检查未通过，已拒绝启动。");
  }
  lines.push("");
  lines.push(SKIP_HINT);
  return lines.join("\n");
}

/**
 * 服务层入口：通过就静默返回，不通过就抛一条可直接展示的错误。
 * 在 worker 启动（会触发 UAC 提权）之前调用，避免「提权完才告诉你不行」。
 */
export async function ensureNetworkReady(opts = {}) {
  if (process.env[SKIP_ENV] === "1") return null;
  const result = await checkNetworkReady(opts);
  if (!result.ok) throw new Error(describeBlocker(result));
  return result;
}
