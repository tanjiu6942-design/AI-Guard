import type { CheckResult, FetchFn } from './types.js';
import {
  checkClaudeCodeRoute,
  checkClaudeIp,
  checkExclusiveIp,
  checkKillSwitch,
  probeTraceIp,
  type ConnectionSnapshot,
  type RuleSnapshot,
} from './ai-route.js';

/**
 * mihomo 控制接口的最小读取能力。
 *
 * 注入一个"取 JSON"的函数, 而不是把 HTTP 客户端塞进 core:
 *   - CLI 侧用 node:http 直连 127.0.0.1
 *   - 桌面端在提权 worker 内部用带密钥的 fetch
 * 两边的认证方式完全不同, 但"取某个路径的 JSON"这件事是共的。
 */
export type ControllerGet = (path: string) => Promise<unknown>;

/**
 * 出口 IP 探测端点: 选用在 strict / precise / global 三种模式下都归属
 * "AI Guard 专用"组的 cloudflare-dns.com 公开 trace (不带任何账号凭据)。
 * 注意 www.cloudflare.com 在 precise 模式下不含兜底规则、会走机场前置节点。
 */
const EXIT_TRACE_URL = 'https://cloudflare-dns.com/cdn-cgi/trace';

export interface AiRouteReportOptions {
  /** 经 AI Guard 自身代理发出的请求 */
  fetchFn: FetchFn;
  /** 旧调用方的预期出口 IP；住宅 SOCKS 网关不等于出口，应用应设置 expectedEgressIp */
  expectedIp: string;
  /** 已知的真实住宅出口预期；null 表示未知。省略时兼容旧 expectedIp。 */
  expectedEgressIp?: string | null;
  /** 读取 mihomo 控制接口; 不提供则相关检测项判 unknown */
  controllerGet?: ControllerGet;
  /** 代理组名, 缺省 'AI Guard 专用' */
  aiGroup?: string;
  /** 独享 IP 节点名, 缺省 'AI Guard · 独享 IP' */
  residentialName?: string;
  /** 调用方已经知道出口 IP 时传入, 省一次探测 */
  exitIp?: string | null;
}

interface GroupPayload {
  type?: string;
  all?: string[];
}
interface ProviderPayload {
  proxies?: Array<{ name?: string }>;
}
interface RulesPayload {
  rules?: RuleSnapshot[];
}
interface ConnectionsPayload {
  connections?: Array<{
    metadata?: { process?: string; host?: string };
    chains?: string[];
  }>;
}

/**
 * 控制接口取数失败要能和"取到了但内容不对"区分开。
 *
 * 这两种情况在下面的检测里结论完全相反:
 *   - 读不到规则 -> 无法判断 -> unknown (可能只是控制器没起来)
 *   - 读到了规则但里面没有 claude.exe -> 确实漏配 -> fail
 * 混为一谈会把"内核没运行"报成"Claude Code 线路漏配", 是误导性的失败。
 */
async function readJson<T>(get: ControllerGet, path: string): Promise<T | null> {
  try {
    return (await get(path)) as T;
  } catch {
    return null;
  }
}

function unknownItem(key: string, title: string, detail: string): CheckResult {
  return { key, title, state: 'unknown', detail };
}

/**
 * 跑"AI 线路"这一组检测。
 *
 * 和 exit-consistency 等检测不同, 这四项里有三项要看内核的**实际状态**
 * (代理组类型、阻断节点、运行时连接链), 所以必须读控制接口。
 * 而控制接口在桌面端受保护时只有提权 worker 知道密钥 —— 于是这里只接收
 * 一个抽象的取数函数, 由调用方决定从哪儿读。
 *
 * 返回顺序固定: 独享 IP / 断网保护 / Claude Code 线路 / Claude 看到的 IP。
 */
export async function runAiRouteChecks(
  opts: AiRouteReportOptions,
): Promise<CheckResult[]> {
  const aiGroup = opts.aiGroup ?? 'AI Guard 专用';
  const residentialName = opts.residentialName ?? 'AI Guard · 独享 IP';

  // 出口 IP: 调用方已知就用它的, 否则自己探一次
  const exitIp =
    opts.exitIp !== undefined
      ? opts.exitIp
      : await probeTraceIp(opts.fetchFn, EXIT_TRACE_URL);

  let group: GroupPayload | null = null;
  let guard: ProviderPayload | null = null;
  let rules: RuleSnapshot[] = [];
  let connections: ConnectionSnapshot[] | null = null;
  let rulesRead = false;
  let groupRead = false;
  let guardRead = false;

  if (opts.controllerGet) {
    const [g, b, r, c] = await Promise.all([
      readJson<GroupPayload>(
        opts.controllerGet,
        `/proxies/${encodeURIComponent(aiGroup)}`,
      ),
      readJson<ProviderPayload>(
        opts.controllerGet,
        '/providers/proxies/guard-block',
      ),
      readJson<RulesPayload>(opts.controllerGet, '/rules'),
      readJson<ConnectionsPayload>(opts.controllerGet, '/connections'),
    ]);
    group = g;
    guard = b;
    rulesRead = Array.isArray(r?.rules);
    groupRead = g !== null;
    guardRead = b !== null;
    rules = rulesRead ? r!.rules! : [];
    connections = Array.isArray(c?.connections)
      ? c.connections.map((x) => ({
        process: x.metadata?.process,
        host: x.metadata?.host,
        chains: x.chains,
      })) : null;
  }

  // ── 断网保护 ──
  // 组和阻断节点都读到了, 才让 core 去做判定; 读不到就如实说读不到。
  const guardNodeNames = (guard?.proxies ?? [])
    .map((p) => p.name)
    .filter((n): n is string => typeof n === 'string');
  let killswitch: CheckResult;
  if (!groupRead) {
    killswitch = unknownItem(
      'killswitch',
      '断网保护',
      '无法读取内核代理组状态',
    );
  } else if (!guardRead) {
    killswitch = unknownItem(
      'killswitch',
      '断网保护',
      '无法读取内核阻断节点状态',
    );
  } else {
    killswitch = checkKillSwitch({
      groupType: group?.type ?? null,
      groupMembers: group?.all ?? null,
      guardNodeNames,
      aiGroup,
    });
  }

  // ── Claude Code 线路 ──
  // 规则没读到就不能说"漏配了规则" —— 那是 unknown, 不是 fail。
  const claudeCode: CheckResult = rulesRead
    ? checkClaudeCodeRoute({ rules, connections, aiGroup, residentialName })
    : unknownItem(
        'claude-code',
        'Claude Code 线路',
        '无法读取内核规则，无法核对 Claude Code 线路',
      );

  // 独享性需要独立预期，不能拿同次观测值与自身比较后宣称验证通过。
  const expectedEgressIp = opts.expectedEgressIp === undefined
    ? opts.expectedIp
    : (opts.expectedEgressIp ?? '');
  const exclusive = opts.expectedEgressIp === null
    ? unknownItem('exclusive', '独享 IP', exitIp
        ? `住宅出口为 ${exitIp}；未提供真实出口预期，无法核对独享性（SOCKS 接入地址不等于出口）`
        : '未能获取住宅出口 IP，无法核对独享性')
    : checkExclusiveIp(exitIp, expectedEgressIp);

  return [
    exclusive,
    killswitch,
    claudeCode,
    await checkClaudeIp(opts.fetchFn, exitIp ?? ''),
  ];
}
