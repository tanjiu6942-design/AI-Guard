import { useState } from "react";

/**
 * 应用内使用指南。
 *
 * 为什么要做在软件里而不是只有 README：
 * 这个工具的操作顺序有硬性要求（先关实时保护再启动、内核运行时配置不可改、
 * 应急解锁入口在哪），而用户遇到问题时往往已经进不去 GitHub 了。
 * 说明书必须和软件在一起。
 *
 * 内容以「按使用顺序」组织，而不是按功能罗列 —— 用户是来做事的。
 */

type Section = { id: string; title: string; body: React.ReactNode };

const H = ({ children }: { children: React.ReactNode }) => (
  <h4 className="guide-h4">{children}</h4>
);
const P = ({ children }: { children: React.ReactNode }) => (
  <p className="guide-p">{children}</p>
);
const Steps = ({ items }: { items: React.ReactNode[] }) => (
  <ol className="guide-steps">
    {items.map((t, i) => (
      <li key={i}>{t}</li>
    ))}
  </ol>
);
const Warn = ({ children }: { children: React.ReactNode }) => (
  <div className="guide-warn">
    <strong>注意</strong>
    <div>{children}</div>
  </div>
);
const Tip = ({ children }: { children: React.ReactNode }) => (
  <div className="guide-tip">
    <strong>说明</strong>
    <div>{children}</div>
  </div>
);

const SECTIONS: Section[] = [
  {
    id: "start",
    title: "第一次使用：按这个顺序走",
    body: (
      <>
        <P>
          这个软件的作用是让 ChatGPT / Claude / Gemini 看到的出口 IP
          始终是<b>同一个住宅 IP</b>，避免因为 IP 跳变被判定为异常。
          第一次配置请严格按下面的顺序，顺序错了会出问题。
        </P>
        <H>第一步：填写连接配置</H>
        <Steps
          items={[
            <>打开左侧「连接配置」。</>,
            <>
              填「机场订阅 URL」—— 这是你购买的中转服务提供的订阅链接，
              通常以 <code>https://</code> 开头。
            </>,
            <>
              填「住宅代理主机 / SOCKS5 端口 / 用户名 / 密码」——
              这是你购买的独享住宅 IP 凭据。
              <b>主机请填 IP 地址，不要填域名</b>，否则后面的「独享 IP」检测无法核对。
            </>,
            <>
              保持「本地代理端口」和「内核控制端口」默认值即可。
              如果提示端口被占用，再改成别的数字（如 7899 / 9099）。
            </>,
            <>点最下方的「保存」，确认出现「配置已保存」提示。</>,
          ]}
        />
        <Warn>
          只有看到「配置已保存」才算成功。如果弹出红色错误提示，
          说明这次修改<b>没有写入</b>，界面会自动恢复成保存前的样子。
        </Warn>

        <H>第二步：先关掉实时保护，启动内核</H>
        <P>
          「连接配置」页下半部分有「本机网络与内核」一栏，其中第一项是
          <b>实时保护</b>。第一次使用请先把它<b>关掉</b>。
        </P>
        <Steps
          items={[
            <>关掉「实时保护」，点「保存」。</>,
            <>回到「连接概览」，点「启动内核」。</>,
            <>系统会弹出 UAC 管理员授权窗口，点「是」。</>,
            <>等待界面显示「正常保护」或「内核运行中」。</>,
          ]}
        />
        <Tip>
          为什么先关实时保护？实时保护会在启动时立刻接管整机网络。
          如果配置有误导致体检不通过，网络会被锁住。先把链路跑通、
          体检确认无误后再开启，风险小得多。
        </Tip>

        <H>第三步：跑一次网络体检</H>
        <Steps
          items={[
            <>内核启动后，打开左侧「网络体检」。</>,
            <>点「运行体检」或「运行完整体检」。</>,
            <>
              等待 30–60 秒。十项检测会逐项显示「通过 / 失败 / 注意 / 未知」。
            </>,
          ]}
        />
        <P>
          <b>「未知」不等于失败</b>。「未知」表示这次探测拿不到结果
          （端点暂时不可达），而「失败」才是真的检测到问题。
          只有「失败」才需要处理。
        </P>

        <H>第四步：全绿后再开启实时保护</H>
        <Steps
          items={[
            <>确认体检没有「失败」项。</>,
            <>回到「连接概览」，点「停止内核」。</>,
            <>打开「连接配置」，把「实时保护」打开，点「保存」。</>,
            <>回到概览，再次「启动内核」。</>,
          ]}
        />
        <Tip>
          实时保护开启后，后台会每隔 15–180 秒自动检测一次。
          一旦发现出口 IP 偏离或 DNS 泄漏，会自动锁定整机外网保护你的真实 IP。
          锁定后需要手动复检通过才会恢复。
        </Tip>
      </>
    ),
  },
  {
    id: "pages",
    title: "四个页面分别做什么",
    body: (
      <>
        <H>连接概览</H>
        <P>
          主控台。这里显示当前状态、出口 IP、代理端口，以及最重要的
          <b>启动 / 停止内核</b>按钮。实时保护运行时，这里还会显示保护状态卡片。
        </P>
        <P>
          下方还有「普通代理节点」（切换机场节点）、「Windows 时区」
          （把系统时区改成住宅 IP 所在地）、「分流模式」（三选一）。
        </P>

        <H>连接配置</H>
        <P>
          填写订阅地址和住宅代理凭据。这里分两张卡片：
          「上游连接」填订阅与住宅参数；「本机网络与内核」控制四个开关：
        </P>
        <ul className="guide-list">
          <li>
            <b>实时保护</b>——后台周期检测 + 异常自动断流。推荐全绿后开启。
          </li>
          <li>
            <b>TUN 模式</b>——接管系统流量与 DNS。开实时保护时会强制开启。
          </li>
          <li>
            <b>修改物理网卡 DNS</b>——把网卡 DNS 改成隧道地址。
            <b>校园网、酒店网请关闭</b>，这类网络有 DNS 防篡改检测，改了会被断网。
          </li>
          <li>
            <b>异常断流后自动复联</b>——网络波动导致断流后，后台自动重试恢复。
          </li>
        </ul>
        <Warn>
          内核运行或实时保护开启时，整个表单会被锁定（灰色不可点）。
          这不是故障 —— 请先停止内核或退出保护，才能修改配置。
        </Warn>

        <H>网络体检</H>
        <P>
          手动运行十项检测。检查出口一致性、DNS 泄漏、IPv6 泄漏、WebRTC 泄漏、
          长连接稳定性、代理冲突，以及独享 IP、断网保护、Claude Code 线路、
          Claude 看到的 IP。
        </P>
        <P>
          体检需要内核在运行。结果只反映点击那一刻的状态，
          不是实时监控 —— 实时监控由「实时保护」负责。
        </P>

        <H>日志与规则</H>
        <P>
          查看内核日志、扫描规则补丁建议。排查问题时这里最有用：
          能看到每个域名到底走了哪条规则、哪个出口。
        </P>
      </>
    ),
  },
  {
    id: "modes",
    title: "三种分流模式怎么选",
    body: (
      <>
        <P>
          在「连接概览」的「分流模式」里切换。模式切换是热重载，
          不需要重启内核，但保护异常或锁定期间无法切换。
        </P>
        <ul className="guide-list">
          <li>
            <b>严格</b>（默认）——AI 主域名 + Cloudflare 全家桶走独享 IP，
            其余海外流量走机场，国内直连。出口一致性绝对保证，流量消耗较高。
          </li>
          <li>
            <b>精确</b>——和严格模式唯一的区别是「非 AI、非 Cloudflare 的海外流量」
            走机场。更省流量，但如果遇到未收录进规则的新域名，可能走错出口。
          </li>
          <li>
            <b>全局</b>——除内网和国内站点外，所有流量都走独享 IP。
            出口最统一，但流量消耗最大，看视频下载都算独享 IP 流量。
          </li>
        </ul>
        <Tip>
          三种模式都已经包含 Cloudflare 兜底规则（<code>cloudflare.com</code> /
          <code>cloudflare-dns.com</code>）。这条兜底很关键 ——
          漏掉它会导致 Cloudflare 遥测域名走机场 IP，ChatGPT 界面会反复显示
          「Reconnecting」。
        </Tip>
      </>
    ),
  },
  {
    id: "trouble",
    title: "出问题了怎么办",
    body: (
      <>
        <H>最严重：WiFi 能连但完全没网，重启电脑也没用</H>
        <P>
          这是实时保护的安全规则被留在了系统里。系统的内核级防火墙规则
          会阻断「除内核以外所有程序」的网络，如果内核先退出了而规则还在，
          整台机器就上不了网。
        </P>
        <Steps
          items={[
            <>
              在<b>桌面</b>找到「<b>AI Guard 紧急解除网络锁定</b>」快捷方式，双击。
              如果桌面没有，去开始菜单找。
            </>,
            <>系统会弹出 UAC，点「是」。</>,
            <>黑窗口会显示当前状态、执行解除、清理残留 DNS。</>,
            <>看到「完成。现在可以正常上网了」即成功。</>,
          ]}
        />
        <Warn>
          这个工具只删除 AI Guard 自己的四条防火墙规则，
          <b>不会影响其他软件</b>，也不改网卡和路由。
          如果找不到快捷方式，安装目录下的
          <code>resources\guard-filter\emergency-unlock.cmd</code> 是同一个脚本。
        </Warn>

        <H>界面显示「已断流」</H>
        <P>
          说明检测到了真实问题（出口 IP 跳变或 DNS 泄漏），系统主动锁网保护你。
          处理方式：
        </P>
        <Steps
          items={[
            <>先检查你的机场订阅和住宅代理是否正常（可以用其他设备验证）。</>,
            <>网络恢复后，点「复检并恢复」。检测全部通过才会解除锁定。</>,
            <>
              如果一直无法恢复，点「退出保护并恢复普通网络」——
              这会停止保护并解除锁定，让你先能上网。
            </>,
          ]}
        />

        <H>提示「请先停止内核，再修改连接配置」</H>
        <P>
          内核运行或实时保护开启时不能改配置。先回概览点「停止内核」，
          或退出保护，表单解锁后再修改。
        </P>

        <H>「独享 IP」显示「未知」</H>
        <P>
          「未知」表示无法核对，通常有两种原因：一是「住宅代理主机」填了域名而不是
          IP（域名无法与出口 IP 比对）；二是这次探测没拿到出口 IP。
          只要它显示「通过」且详情里是你配置的 IP，就说明出口正确。
        </P>

        <H>校园网 / 酒店网：一开保护就整个没网</H>
        <P>
          这类网络需要先做网页认证。软件启动前会做一次预检，
          未认证时会拒绝启动并提示认证地址。请先完成网页认证再启动。
        </P>
        <P>
          另外请务必关闭「修改物理网卡 DNS」——
          校园网网关会审计 DNS 篡改，改了会直接断你的网。
          关闭后 TUN 仍会在内核层劫持 DNS，防泄漏能力不受影响。
        </P>

        <H>体检提示「有中国 DNS 暴露」</H>
        <P>
          如果你在国内，泄漏检测站几乎一定会显示中国 DNS ——
          因为国内域名本来就要用国内 DNS 解析。关键是
          <b>不应出现你本地运营商的明文 DNS</b>。
          AI 域名的解析全程走住宅加密 DNS，防封能力不受影响。
        </P>
      </>
    ),
  },
  {
    id: "safety",
    title: "安全边界：这个软件能做什么、不能做什么",
    body: (
      <>
        <H>能做到</H>
        <ul className="guide-list">
          <li>保证 AI 服务看到的出口 IP 单一且为你配置的住宅 IP</li>
          <li>检测 DNS / IPv6 / WebRTC 泄漏</li>
          <li>住宅 IP 失效时阻断连接，绝不回落直连暴露真实 IP</li>
          <li>出口 IP 偏离时自动断流保护</li>
        </ul>

        <H>做不到</H>
        <ul className="guide-list">
          <li>
            不能保证账号绝对不被风控 —— 它只解决「网络指纹一致性」这一个维度
          </li>
          <li>
            不能替代浏览器指纹、行为模式等其他风控因素
          </li>
          <li>
            「DNS 上游策略」检测的是配置是否正确，浏览器实际解析出口
            仍需用泄漏检测站外部复核
          </li>
          <li>
            周期检测存在间隙，不是无间断防护
          </li>
        </ul>

        <Warn>
          实时保护会修改系统网络配置（TUN 网卡、路由、可选 DNS）。
          请勿与其他 VPN / TUN 客户端同时运行，两个 TUN 会互相冲突。
          退出程序请用托盘「退出」或界面的停止按钮，不要直接强杀进程。
        </Warn>

        <H>关于隐私</H>
        <P>
          所有配置（订阅地址、住宅代理凭据）只保存在本机
          <code>%APPDATA%\aiguard\settings.json</code>，不会上传到任何服务器。
          软件本身不收集任何使用数据。
        </P>
      </>
    ),
  },
];

export default function Guide() {
  const [open, setOpen] = useState<string>(SECTIONS[0].id);

  return (
    <>
      <section className="card">
        <div className="section-heading">
          <div>
            <h2>使用指南</h2>
            <p className="hint">
              按使用顺序整理。遇到问题先看「出问题了怎么办」。
            </p>
          </div>
        </div>
        <p className="hint">
          本指南与软件版本同步更新。更详细的背景与踩坑记录见项目文档
          PROJECT_NOTES.md。
        </p>
      </section>

      {SECTIONS.map((s) => {
        const expanded = open === s.id;
        return (
          <section className="card guide-section" key={s.id}>
            <button
              type="button"
              className="guide-toggle"
              aria-expanded={expanded}
              onClick={() => setOpen(expanded ? "" : s.id)}
            >
              <span>{s.title}</span>
              <span className="guide-caret">{expanded ? "收起" : "展开"}</span>
            </button>
            {expanded && <div className="guide-body">{s.body}</div>}
          </section>
        );
      })}
    </>
  );
}
