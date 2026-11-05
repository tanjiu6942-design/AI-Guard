import { configToYaml } from "../dist/core/runtime/mihomo.js";
import { buildSourceRules } from "../dist/core/config/groups.js";

/** Keep the authenticated health inbound independent of ordinary business rules. */
export function buildProtectedYaml(cfg, { probePort, probeSecret, businessBlocked, airportUrl }) {
  if (!Number.isInteger(probePort) || probePort < 1 || probePort > 65535)
    throw Error("Invalid health probe port");
  if (probePort === cfg["mixed-port"])
    throw Error("Health probe port must differ from the business mixed port");
  if (typeof probeSecret !== "string" || probeSecret.length === 0)
    throw Error("Health probe secret is required");

  // 信源放行规则必须排在 MATCH,REJECT **之前**。
  //
  // 受保护模式用 MATCH,REJECT 把业务流量全关掉, 但内核自己拉订阅、查 DNS 的流量
  // 同样会走规则匹配 —— mihomo 规则自上而下、首次匹配即生效, MATCH 在首位会匹配
  // 一切, 排在它后面的规则永远轮不到, 于是自家规则把自家订阅拒死:
  //   订阅拉不到(EOF) -> 机场前置组为空 -> 住宅节点失去前置 -> 住宅链路超时
  // 实测踩过这个坑, 最终表现为 5 项体检失败 + 整机断流, 且断流后复检依赖同一个
  // 不可用的前置, 陷入死锁。信源(订阅域名 + 公共 DNS)直连不影响 AI 业务流量保护。
  // 订阅域名从 airportUrl 取(未加引号的原始值)。
  // 不能从 cfg["proxy-providers"]["airport-sub"].url 取: desktop/worker.mjs 的
  // makeYaml 会先 JSON.stringify 用户填的 URL 再交给序列化器, 那个值带引号,
  // new URL() 解析会失败 -> 热重载时信源规则丢掉订阅域名 ->
  // 订阅域名被自家 MATCH,REJECT 拒掉 -> 探测端点全无响应 -> 整机断流。
  const sourceRules = buildSourceRules(airportUrl ?? cfg["proxy-providers"]?.["airport-sub"]?.url ?? "");

  const yaml = configToYaml({
    ...cfg,
    // A MATCH rejection only has authority in rule mode.
    mode: businessBlocked ? "rule" : cfg.mode,
    rules: businessBlocked ? [...sourceRules, "MATCH,REJECT", ...cfg.rules] : cfg.rules,
  });
  return yaml + [
    "listeners:",
    '  - name: "aiguard-health"',
    "    type: mixed",
    "    listen: 127.0.0.1",
    `    port: ${probePort}`,
    "    udp: false",
    "    users:",
    "      - username: aiguard-health",
    `        password: ${JSON.stringify(probeSecret)}`,
    '    proxy: "AI Guard 专用"',
    "",
  ].join("\n");
}
