# AI Guard

[![CI](https://github.com/tanjiu6942-design/AI-Guard/actions/workflows/ci.yml/badge.svg)](https://github.com/tanjiu6942-design/AI-Guard/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
![Platform](https://img.shields.io/badge/platform-Windows%2010%20%7C%2011%20x64-blue)

ChatGPT / Claude / Gemini 防封工具。保证主流 AI 服务（OpenAI / Anthropic / Google）看到的出口 IP 单一一致，并提供 DNS / IPv6 / WebRTC / 长连接四类泄漏检测。

> **使用前必读**：本软件会修改系统网络配置（TUN 网卡、路由、可选 DNS），
> 并可能通过 Windows 内核级防火墙（WFP）锁定网络。启动实时保护前请先读
> [安全须知](#安全须知)。
>
> **出问题先看** [出问题怎么办](#出问题怎么办)。最严重的情况是
> 「WiFi 能连但完全没网」——桌面上的**「AI Guard 紧急解除网络锁定」**
> 快捷方式可自救，不必重装系统。

**目录**

- [这个工具解决什么问题](#这个工具解决什么问题)
- [Windows 桌面版（推荐）](#windows-桌面版推荐)
- [安全须知](#安全须知)
- [出问题怎么办](#出问题怎么办)
- [架构](#架构)
- [开发](#开发)
- [贡献](#贡献)

## Windows 桌面版（推荐）

当前版本 0.3.2。安装包不入库（`release/` 已列入 `.gitignore`），用 `npm run desktop:dist` 生成。连接概览可切换普通代理节点、识别住宅出口时区并手动应用到 Windows，支持恢复原时区。网络体检固定展示 Claude Code 线路与 Claude 看到的 IP，点击完整体检更新专项结果。普通节点的延迟来自内核已有测量记录。Claude 无活跃连接或站点拒绝探测时显示待验证。时区位置来自 IP 定位服务，可通过下拉框人工调整。

桌面版使用 Electron，支持 Windows 10 / 11 x64。安装包自带运行时、mihomo 和 geodata；无需安装 Node.js、打开浏览器或启动 9123 控制面板。

1. 运行 `npm run desktop:dist` 生成 `release/AI-Guard-Setup-<version>-x64.exe` 后安装；开发期可直接 `npm run desktop` 起窗口。
2. 在「连接配置」填写机场订阅和住宅 SOCKS5，保存后回到概览启动内核。
3. TUN 默认关闭；启用后启动时请求 UAC 管理员授权。不要与其他 TUN 客户端并行运行。
4. 窗口关闭后驻留系统托盘；使用托盘「退出」停止本软件的内核并清理 DNS。

桌面界面提供三种分流模式及热重载、连接配置、十项网络体检、日志与规则扫描。通过受限进程通信调用本地核心，不依赖浏览器控制面板。

> **启动顺序建议**：先在「本地代理模式」（不开实时保护）下启动内核，跑一次「网络体检」确认十项都通过，再开启实时保护。体检不通过时开启实时保护会导致整机断流且无法自行恢复。

### 常见问题

| 现象 | 原因与处理 |
|---|---|
| **WiFi 能连但完全无法上网，蓝牙网络共享也建不起来，重启电脑无效** | 实时保护的 WFP 规则（持久化，绑定 BFE）在阻断"除内核外所有应用"。若内核异常退出而规则残留，整机就没有任何程序能上网。**以管理员身份运行安装目录下的 `resources/guard-filter/emergency-unlock.cmd`**（安装时会创建「AI Guard 紧急解除网络锁定」桌面与开始菜单快捷方式，脚本会自己请求 UAC）。它只删本软件那 4 条固定 GUID 规则并清理残留 DNS，不碰其他软件规则。详见 `PROJECT_NOTES.md` 坑 26。 |
| `Guard helper failed: spawn ...aiguard-guard-filter.exe ENOENT` | 安装包缺 `resources/guard-filter/`（实时保护的 WFP 辅助程序）。重新运行 `npm run desktop:pack` 并同步整个 `resources/` 目录；`guard-filter` 需与 `mihomo/` 同级。 |
| 界面显示「已断流」，点「复检并恢复」一直失败 | 内核已退出时复检必然失败。改点 **「退出保护并恢复普通网络」** 清理断流状态，然后重新启动内核。 |
| 开机即报 5 项体检失败（TUN 接管 / 出口一致性 / WebRTC / 长连接同时失败） | 多为内核未能拉取机场订阅导致（见 `PROJECT_NOTES.md` 坑 15）。检查 `%APPDATA%\aiguard\mihomo\desktop.log` 里是否有 `airport-sub ... EOF` 或 `provider airport-sub error`。 |
| 体检显示「未知」 | 表示**无法判断**（探测端点不可达），不是「检测到不安全」。此时不会触发断流；链路恢复后自动复检通过。 |
| 订阅打不开但浏览器正常 | 订阅与公共 DNS 走直连（信源流量必须直连才能启动内核），AI 业务流量仍全部走住宅独享 IP。 |
| `ipcheck.ing` 显示「有中国 DNS 暴露」，列出阿里/腾讯的 IP | 国内域名（`geosite:cn`）走加密 DoH（`223.5.5.5` / `doh.pub`）解析。**这是预期行为**：只要用国内解析器，泄漏检测就一定会显示中国 DNS。关键在于**不再显示你本地运营商的 DNS**（校园网=移动、热点=联通），说明查询没被明文交给 ISP。**AI 域名的防封不受影响** —— 它们全程走住宅加密 DNS。若想让中国 DNS 彻底消失，需把国内域名也送去住宅链路，代价是国内站点按海外 CDN 解析、明显变慢，且会加重跨境隧道负载导致断流，不建议。 |
| 断流后界面提示「正在锁定状态下完整复检」 | 这是**自动复联**机制在工作：网络波动触发断流后，后台会自动周期复检，网络恢复即自动解除断流。可在「连接配置」中关闭「异常断流后自动复联」回到纯手动模式。 |
| 校园网 / 酒店网：一开保护就整个没网，连认证页都打不开 | 这类网络要先做网页认证。现在启动前会做一次裸网络预检，**未认证时直接拒绝启动**并在界面提示认证地址，不接管 DNS、不改路由、不装防火墙规则。确认网络正常却被误拦时，设 `AIGUARD_SKIP_PREFLIGHT=1` 后重启软件跳过检查。 |
| 校园网提示「DNS已被修改」或启动后报「DNS配置偏离隧道地址并断流」 | 校园网网关开启了 DNS 防篡改审计。请在「连接配置」中关闭 **“修改物理网卡 DNS”** 开关。关闭后物理网卡保持校园网官方 DHCP 下发，TUN 仍会在内核底层通过 `dns-hijack: any:53` 透明劫持域名解析，防泄漏能力完全一致，且不会触发学校网关切断网络。 |
| 住宅 IP 检测报 `fail` | `residential.server` 应填住宅 IP（不是域名）。填域名时该项会判为「未知」而非失败。 |

沿用 `%APPDATA%\aiguard\settings.json`，不会覆盖现有个人配置。内核路径留空使用随包内核。桌面版日志为 `%APPDATA%\aiguard\mihomo\desktop.log`，DNS 备份为 `desktop-dns-backup.json`，与 CLI 的备份分开。

桌面进程被强杀时，独立 worker 通过管道断连停止自己的内核并恢复 DNS；如果 worker 本身也被强杀或系统断电，只能在下次启动时从残留备份恢复。残留备份恢复也会请求 UAC。恢复失败保留备份并报告错误。

### 开发与打包

```powershell
npm ci
npm --prefix gui ci
npm run desktop                 # 编译并启动独立窗口
npm run desktop:smoke           # 隔离配置目录，验证真实桌面交互

# 首次构建：指定已有 mihomo；其同目录应有三件套 geodata
$env:AIGUARD_MIHOMO_PATH = 'D:\path\to\mihomo.exe'
npm run desktop:dist            # 编译、暂存资源、生成 NSIS 安装包

# 对打包产物验证真实内核启停；订阅和节点均为本机测试服务，TUN 关闭
node scripts/desktop-smoke.cjs 'release/win-unpacked/AI Guard.exe' --aiguard-smoke-kernel
node scripts/desktop-smoke.cjs 'release/win-unpacked/AI Guard.exe' --aiguard-smoke-kernel --aiguard-smoke-crash
```

构建只复制 mihomo/geodata/许可证，不复制个人设置、订阅缓存或日志。暂存文件的版本和 SHA-256 记录于 `vendor/mihomo/manifest.json`。安装包未配置代码签名证书；发布前可通过 Electron Builder 的签名环境变量配置证书。

自动化验证不操作真实 TUN 或网卡 DNS；UAC 和物理网卡驱动上的 DNS 接管/恢复需实机验收。

## 这个工具解决什么问题

AI 服务（尤其 Claude）的风控会检查网络指纹一致性。如果同一次会话里，出口 IP 在住宅 IP 和机场 IP 之间跳变，会被判定为异常。

**真实案例**（本工具诞生的原因）：早期方案把 `chatgpt.com` / `claude.ai` 正确导向住宅 IP，但漏掉了 Cloudflare 的遥测域名 `a.nel.cloudflare.com`——它不在规则集里，于是回落到兜底规则走了机场 IP。实测比例 **13 次走机场、3 次走住宅**。结果是 ChatGPT 界面反复显示 `Reconnecting... waiting for network`，回复卡在「正在思考」。

AI Guard 的三种模式（`strict` 默认 / `precise` / `global`）都堵住了这个洞：

| | 严格模式（默认） | 精确模式 | 全局模式 |
|---|---|---|---|
| AI 主域名 | 走独享 IP | 走独享 IP | 走独享 IP |
| Cloudflare 全家桶 | **走独享 IP**（含 `a.nel.*`） | **走独享 IP**（同一套兜底） | 走独享 IP |
| 其他海外流量 | 走机场 | 走机场 | 走独享 IP |
| 国内站点 | 直连 | 直连 | 直连（`GEOSITE,cn`） |
| 出口一致性 | 绝对保证 | 依赖规则集完整度 | 绝对保证（国内站点除外） |
| 流量消耗 | 较高 | 较低 | 最高 |

> 精确模式与严格模式现在的差别只剩「非 AI、非 Cloudflare 的海外流量走机场」。
> `cloudflare.com` / `cloudflare-dns.com` 兜底两种模式都有——精确模式缺它时会重现
> `a.nel.cloudflare.com` 走机场的原始 bug（见 `PROJECT_NOTES.md` 坑 25）。

### 覆盖的 AI 服务与生态链路（10/10 完整覆盖）

* **ChatGPT / OpenAI**：`chatgpt.com`、`openai.com`、`chat.com`、`oaistatic.com`、`oaiusercontent.com` 全覆盖。
* **Claude / Anthropic**：`claude.ai`、`anthropic.com`、`clau.de`、`claudeusercontent.com` 以及 DataDog / Intercom 关联打点。
* **Google Gemini & AI Studio**：`gemini.google.com`、`aistudio.google.com`、`makersuite.google.com`、Gemini 介绍页及模型 API 端点。
* **第三方登录鉴权**：Apple ID（`appleid.apple.com`）、Google OAuth（`accounts.google.com`）、Microsoft Live / Azure AD。
* **支付与订阅保护**：Stripe 信用卡绑卡收银台、Google One / Google Pay 订阅。
* **Cloudflare 全家桶防跳变**：严格 / 精确模式下均强制将 Cloudflare 遥测（`a.nel.cloudflare.com` 等）与人机验证盾锁定在独享住宅出口。精确模式若缺这条兜底，遥测会走机场 IP，出口一跳变 ChatGPT 界面就无限重连。
* **DoH 防泄漏**：5 个公共 DNS IP（`1.1.1.1` / `1.0.0.1` / `8.8.8.8` / `8.8.4.4` / `9.9.9.9`）与 14 条常见 DoH 域名（`dns.google`、`cloudflare-dns.com`、`one.one.one.one`、`dns.quad9.net`、`dns.nextdns.io`、`doh.opendns.com`、`dns.adguard-dns.com` 等）全部收进住宅组，防止浏览器通过 443 端口绕过 53 端口劫持泄露真实解析。
* **DNS 分流与隐私**：AI / 海外域名走住宅加密 DoH（`1.1.1.1`）；国内域名走国内加密 DoH（`223.5.5.5` / `doh.pub`），ISP 只能看到加密流量、看不到具体访问的国内站点。
* **纯净度检测站**：内置 `rules/domains/ip-check.yaml` 的 48 条规则（47 个不同站点，含一条重复），查 IP 时一律显示住宅节点。

## 前置条件

1. **mihomo** v1.19.32 — 放 `%APPDATA%\aiguard\mihomo\mihomo.exe`，或在 `settings.json` 的 `mihomoPath` 字段填绝对路径
2. **机场订阅** — 提供前置中转节点。**住宅 IP 从国内无法直连**（实测：绑物理网卡源地址 TCP 超时 12s，走 TUN 则 2ms 通），必须经此中转
3. **住宅 SOCKS5** — 你的独享 IP 凭据
4. **geodata 三件套** — `Country.mmdb` / `geoip.dat` / `geosite.dat`。程序会自动从 mihomo 同目录或 早期实现 安装目录复制；都没有则 mihomo 会联网下载（国内可能失败）

## 快速开始

```bash
cd aiguard

# 1. 装依赖
npm install

# 2. 填配置
cp config/settings.example.json "$APPDATA/aiguard/settings.json"
# 编辑该文件，填入机场订阅地址、住宅 IP 凭据、mihomo 路径

# 3. 跑测试
npm test

# 4. 启动（默认 tunEnabled: false，先不动系统网络）
node bin/start.js

# 5. 体检
node bin/doctor.js
```

`bin/*.js` 首次运行会自动把 `core/`（TypeScript）编译到 `dist/`，无需手动 `tsc`。

## 浏览器控制面板（兼容入口）

```bash
node bin/ui.js
# 浏览器打开 http://127.0.0.1:9123
```

界面提供：内核启停、出口 IP 与模式实时状态、严格/精确/全局切换、十项体检、
规则补丁扫描、配置在线编辑、内核日志。

> 旧 Tauri 实现曾遇到窗口创建「拒绝访问」，根因未确认。当前桌面入口已迁移到 Electron，`gui/src-tauri/` 作为历史参考保留。

## 体检器

```bash
node bin/doctor.js                          # 人类可读
node bin/doctor.js --json                   # 给 GUI 用
AIGUARD_EXPECTED_IP=203.0.113.7 node bin/doctor.js   # 校验出口是否为预期 IP
```

十项检测：

| 检测项 | 判定逻辑 |
|---|---|
| 出口一致性 | 并发请求 `www.cloudflare.com` / `challenges.cloudflare.com` / `cloudflare-dns.com` 的 `/cdn-cgi/trace`，三者 IP 必须相同。**刻意不探测 `claude.ai` / `chatgpt.com`**：不向用户的线上账号环境发请求，且这三个端点都在 Cloudflare 兜底规则内，测出来才有意义 |
| DNS 泄漏 | 三层判定：① 读物理网卡 DNS 是否为隧道地址 `198.18.0.2`；② 未接管时探测 TUN 的 `dns-hijack`（向公网 DNS 查 AI 域名，返回 fake-ip 即安全）；③ 都不可用时才退回 HTTP 出口 `loc=` 与预期国家对照 |
| IPv6 防泄漏 | 权威层读系统配置：有公网 IPv6 时必须存在 Meta 的 v6 地址且 `::/0` 路由指向 TUN；STUN 结果只作佐证 |
| WebRTC 防泄漏 | STUN 探测（UDP 打洞，不走 HTTP 代理）：探不到且网络正常 = 被规则拦住 → 通过；探到非独享 IP → 失败（未开 TUN 时属架构限制） |
| 长连接稳定性 | 经代理对 `www.cloudflare.com:443` 建 TLS 后发心跳，30s 窗口（按 0.8 时序误差取 24s）不断即通过 |
| 代理冲突 | 扫描是否有其他 TUN 客户端在跑 |
| 独享 IP | 探测到的出口 IP 必须等于配置的住宅独享 IP |
| 断网保护 | 「AI Guard 专用」组必须是 Fallback 且含阻断节点，住宅 IP 失效时流量被阻断而非回落直连 |
| Claude Code 线路 | 内核规则与运行时连接链都必须把 Claude 流量导向「AI Guard 专用 → 独享 IP」 |
| Claude 看到的 IP | 从 `claude.ai` 侧看到的出口 IP 必须与独享 IP 一致 |

后四项是「AI 线路」检测，需要读取内核控制接口（代理组、阻断节点、规则、运行时连接链），
在桌面端由提权 worker 计算——实时保护开启时控制接口的密钥只在 worker 手里。
它们只做手动体检，不进入周期监控：依赖 claude.ai 的外部可达性和进程瞬时状态，
拿来做断流判据会在第二轮就误触发整机断流。

「十项」指的是 **CLI / 非实时保护** 路径（`bin/doctor.js`：6 项常规 + 4 项 AI 线路）。
实时保护开着时项数不同，以代码为准：

| 路径 | 项数 | 组成 |
|---|---|---|
| `bin/doctor.js` / 未开实时保护 | 10 | `runDoctor` 6 项 + AI 线路 4 项 |
| 实时保护 · 周期 local（15s） | 6 | tun / dns / ipv6 / conflict / dns-policy / kernel |
| 实时保护 · 周期 exit（15→45s） | 1 | exit |
| 实时保护 · 周期 full（60→180s） | 9 | local 6 项 + exit / webrtc / long |
| 实时保护 · 手动完整体检 | 13 | full 9 项 + AI 线路 4 项 |

## 切换模式

```bash
node bin/set-mode.js strict    # 严格
node bin/set-mode.js precise   # 精确
```

CLI 的 `set-mode.js` 只接受 `strict` / `precise`；`global` 要在桌面界面或浏览器面板切换
（那两条路径是热重载），或直接改 `settings.json` 的 `mode` 字段。
CLI 改的是 `settings.json`，重启内核后生效。

## 验证清单

启动后逐项确认（`bin/doctor.js` 会全部覆盖）：

1. `bin/doctor.js` 的出口一致性通过（探测端点是 `www.cloudflare.com` / `challenges.cloudflare.com` / `cloudflare-dns.com`）；想人工复核可在浏览器打开 `claude.ai/cdn-cgi/trace` 与 `chatgpt.com/cdn-cgi/trace`，两处 `ip=` 应与独享 IP 相同
2. `a.nel.cloudflare.com` 出口与上述一致 ← **核心回归项**
3. mihomo 日志中 AI 域名不出现 `match Match using 普通代理`
4. ChatGPT 桌面版连续对话 10 分钟无 `Reconnecting`
5. 断开住宅 IP → AI 网站应**连接失败**，而非回落直连
6. 强杀主进程（`AI Guard.exe`，worker 仍在）→ 管道断开，worker 停止自己的内核并恢复网卡 DNS；若 worker 也被强杀或断电，则下次启动时从 `desktop-dns-backup.json` 恢复（需 UAC）

## 从 早期实现 迁移

1. 早期实现 到期前，保持它运行
2. 本工具先以 `tunEnabled: false` 并行验证（不开 TUN，不抢路由）
3. `bin/doctor.js` 全绿后，退出 早期实现
4. 把 `tunEnabled` 改为 `true`，重启本工具

> **两个 TUN 不能共存**。切换时必须先完全退出 早期实现。

## 架构

```
core/            纯 TypeScript 逻辑，可独立测试，不依赖 GUI
  config/        配置生成（代理组、DNS、规则、组装器）
  domain/        规则源读取、日志分析与动态补丁
  runtime/       mihomo 进程、UAC 提权、系统 DNS 接管、geodata 投放
  doctor/        十项体检
desktop/         Electron 主进程、IPC、内核 worker 与网络探测
gui/             React 桌面界面（src-tauri 保留历史实现）
rules/           域名规则源（YAML，单一事实来源）
bin/             CLI 入口
```

**设计原则：fail-closed**。独享 IP 不可用时，「AI Guard 专用」组只剩守卫节点（`127.0.0.1:9`，discard 端口），连接必然失败——**绝不回落直连暴露真实 IP**。这是整个工具的底线。

## 已知限制

- **仅支持 Windows**（依赖 PowerShell 改 DNS、`Get-CimInstance Win32_Process` 枚举进程）
- **住宅 IP 必须经机场中转**（国内无法直连，实测确认）
- **规则以文件维护**，无图形化编辑器
- 长连接探测需发心跳：纯空闲隧道会被 mihomo 的 idle-timeout 在约 16s 关闭，那是内核行为不是链路故障
- 单个 DNS key 超过 800 字符时无法再分片（实际域名 ≤253 字符，不会触发）

## 开发

```bash
npm test           # 编译 core 后运行全部用例
npm run typecheck  # tsc --noEmit
```

`e2e-config.test.ts` 会调用真实 mihomo 做配置语法校验。`findMihomo()` 只查
`%APPDATA%\aiguard\mihomo\`、`%LOCALAPPDATA%\Programs\早期实现\resources\`、
`%LOCALAPPDATA%\Programs\aiguard\` 三处，**不查仓库内的 `vendor/mihomo/`**，
所以本地想跑这条用例要显式指定：

```powershell
$env:AIGUARD_MIHOMO_PATH = '<仓库路径>\vendor\mihomo\mihomo.exe'
npx vitest run tests/e2e-config.test.ts
```

都不提供时该用例跳过（不判失败）。

## 安全须知

### 它会修改什么

| 项目 | 说明 | 可恢复 |
|---|---|---|
| TUN 虚拟网卡 | 名称为 `Meta`，接管系统流量与 DNS | 停止内核即移除 |
| 默认路由 | 指向 TUN 的 `198.18.0.2` | 停止内核即恢复 |
| 物理网卡 DNS | 改为 `198.18.0.2`（**可关闭**，校园网请关闭） | 停止时从备份恢复 |
| WFP 防火墙规则 | 4 条内核级规则，**持久化、重启不消失** | 需显式解锁 |

> **WFP 规则是唯一需要特别留意的项**。它的作用是「除内核外禁止一切出站」，
> 用来在检测到泄漏时立刻锁死真实 IP。代价是：如果内核先退出而规则残留，
> 整机就没有任何程序能上网。装软件时会在**桌面和开始菜单**创建
> 「AI Guard 紧急解除网络锁定」快捷方式专治这种情况。

### 不要做的事

- **不要与其他 VPN / TUN 客户端同时运行**。两个 TUN 会互相抢路由，症状是全网中断。
- **不要直接强杀进程**。请用托盘「退出」或界面的停止按钮，让清理流程跑完。
- **校园网 / 酒店网请关闭「修改物理网卡 DNS」**。这类网关有 DNS 防篡改审计，
  改了会被直接断网。关闭后 TUN 仍在内核层劫持 DNS，防泄漏能力不变。

### 它能做什么、不能做什么

**能**：保证 AI 服务看到的出口 IP 单一且为你配置的住宅 IP；检测 DNS / IPv6 /
WebRTC 泄漏；住宅 IP 失效时阻断连接而非回落直连；出口偏离时自动断流。

**不能**：不保证账号绝对不被风控（只解决网络指纹一致性这一个维度）；
不替代浏览器指纹与行为模式；「DNS 上游策略」检测的是配置正确性，
浏览器实际解析出口仍需用泄漏检测站外部复核；周期检测存在间隙，不是无间断防护。

### 隐私

所有配置（订阅地址、住宅代理凭据）只保存在本机
`%APPDATA%\aiguard\settings.json`，不上传到任何服务器。软件不收集使用数据。

## 出问题怎么办

详细的故障处置在**应用内「05 使用指南」页**，那里和软件一起更新。常见几条：

| 现象 | 处理 |
|---|---|
| **WiFi 能连但完全没网，重启电脑无效** | 双击桌面「AI Guard 紧急解除网络锁定」（会自己弹 UAC）。或运行安装目录下 `resources\guard-filter\emergency-unlock.cmd`。它只删本软件 4 条规则，不影响其他软件。 |
| 界面显示「已断流」 | 说明检测到真实问题并主动锁网。检查机场与住宅代理 → 点「复检并恢复」。一直不能恢复就点「退出保护并恢复普通网络」。 |
| 提示「请先停止内核，再修改连接配置」 | 内核运行或保护开启时表单被锁定，属预期行为。先停止内核。 |
| 「独享 IP」显示「未知」 | 「未知」= 无法核对，不是失败。常见原因是「住宅代理主机」填了域名而非 IP。 |
| 一开保护整个没网（校园网） | 先完成网页认证（启动前会预检并提示）；并关闭「修改物理网卡 DNS」。 |
| 泄漏站点报「有中国 DNS 暴露」 | 国内域名本就使用国内 DNS，属预期。关键是**不应出现本地运营商的明文 DNS**。AI 域名全程走住宅加密 DNS，防封不受影响。 |

## 贡献

欢迎 issue 与 PR。提交前请确认：

```bash
npm run typecheck      # 类型检查
npm test               # 全部用例（需先 npm run build）
```

测试是**先写失败用例再改代码**的（TDD），新增行为请附带能证明它有效的测试。
`PROJECT_NOTES.md` 记录了开发过程中踩过的 26 个坑及其根因，
改动相关模块前建议先读对应小节——其中若干「看起来多余」的代码正是为了修这些坑。

## 许可证

[MIT](LICENSE)。第三方组件（mihomo / geodata）遵循各自的 GPL 许可证，
详见 LICENSE 末尾说明。
