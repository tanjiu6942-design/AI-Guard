const MODES = new Set(["strict", "precise", "global"]);
export function validateSettings(value) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw Error("配置格式错误");
  const {
    mode,
    airportUrl,
    residential: r,
    mixedPort,
    controllerPort,
    tunEnabled,
    mihomoPath,
    homeRegion,
    secret,
    realtimeProtection = true,
    takeoverDns = true,
    autoReconnect = true,
  } = value;
  if (!MODES.has(mode)) throw Error("请选择严格、精确或全局模式");
  for (const [name, port] of [
    ["代理端口", mixedPort],
    ["控制端口", controllerPort],
  ]) {
    if (!Number.isInteger(port) || port < 1 || port > 65535)
      throw Error(`${name}应为 1–65535`);
  }
  if (mixedPort === controllerPort) throw Error("代理端口和控制端口不能相同");
  if (typeof tunEnabled !== "boolean") throw Error("TUN 开关格式错误");
  if (typeof realtimeProtection !== 'boolean') throw Error('实时保护开关格式错误');
  if (typeof takeoverDns !== 'boolean') throw Error('修改网卡 DNS 开关格式错误');
  if (typeof autoReconnect !== 'boolean') throw Error('自动复联开关格式错误');
  for (const v of [airportUrl, mihomoPath, homeRegion, secret])
    if (typeof v !== "string") throw Error("配置字段格式错误");
  if (airportUrl) {
    let url;
    try {
      url = new URL(airportUrl);
    } catch {
      throw Error("订阅地址格式错误");
    }
    if (!["http:", "https:"].includes(url.protocol))
      throw Error("订阅地址必须使用 HTTP 或 HTTPS");
  }
  if (
    !r ||
    typeof r.server !== "string" ||
    typeof r.username !== "string" ||
    typeof r.password !== "string"
  )
    throw Error("住宅代理格式错误");
  if (!Number.isInteger(r.port) || r.port < 0 || r.port > 65535)
    throw Error("住宅代理端口应为 1–65535");
  if (r.server && /[\s\r\n]/.test(r.server))
    throw Error("住宅代理主机不能包含空格");
  return {
    mode,
    airportUrl,
    residential: { ...r },
    mixedPort,
    controllerPort,
    tunEnabled,
    realtimeProtection,
    takeoverDns,
    autoReconnect,
    mihomoPath,
    homeRegion,
    secret,
  };
}

export function requireConnection(s) {
  validateSettings(s);
  if (
    !s.airportUrl ||
    !s.residential.server ||
    s.residential.port < 1 ||
    !s.residential.username ||
    !s.residential.password
  ) {
    throw Error("请先在配置页填写订阅地址和完整的住宅 SOCKS5 参数");
  }
  if (s.realtimeProtection !== false && !s.tunEnabled)
    throw Error('实时保护需要开启 TUN 模式，请在连接配置中启用');
}
