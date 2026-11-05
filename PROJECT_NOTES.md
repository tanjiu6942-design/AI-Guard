# AI Guard 完整记录：推理过程、踩过的坑、结论

> 写于 2026-11-02
> 这份文档记录了这个项目从起点到现在的**全部推理链条**，包括我判断错的地方。
> 目的是让你（或未来的我）不用重走弯路。

---

## 一、项目起点

### 你最初的问题

ChatGPT 桌面版一直显示 `Reconnecting... waiting for network`，回复卡在「正在思考」。

你当时用的是早期方案 **早期实现**（example.com），订阅成本到期日 2026-11-07。

### 你的诉求

1. 控制成本（不想采购成本 早期实现）
2. 保留 Claude 的防封功能
3. **解决 ChatGPT 无法连接的问题**

---

## 二、诊断阶段（用 早期实现 时期）

### 关键发现 1：出口 IP 跳变

解析 早期实现 的 mihomo 日志，发现：

```
a.nel.cloudflare.com  →  13 次走 普通代理[机场 IP]
                        3 次走 早期实现 专用[住宅 IP]
```

**原因**：早期实现 的规则集（`chatgpt-core.yaml`）只覆盖：
- `chatgpt.com` / `openai.com` / `oaistatic.com` / `oaiusercontent.com` / `chat.com`

`a.nel.cloudflare.com`（Cloudflare 遥测域名）**不在其中**，于是：
1. UDP/443 被 QUIC 拦截规则 REJECT
2. 退回 TCP 后按域名匹配 → 落到 `MATCH` → 走机场 IP
3. 只有 `PROCESS-NAME,ChatGPT.exe` 命中时才走住宅 IP（这就是那 3 次）

**结论**：同一次会话内出口 IP 在住宅和机场之间跳变，这是风控模型眼中的典型异常特征。

### 关键发现 2：住宅 IP 无法从国内直连

实测：

| 方式 | 结果 |
|---|---|
| 绑定物理网卡源地址直连 `203.0.113.7:1080` | TCP 超时 12s |
| 经 TUN（经机场中转） | 握手 2ms 成功 |

**结论**：住宅 IP 必须经机场节点中转，这是硬约束，不是设计冗余。

### 关键发现 3：TUN 必须管理员权限

无提权启动 mihomo 时：

```
Start TUN listening error: configure tun interface: Access is denied.
```

---

## 三、开发阶段（AI Guard）

### 架构决策

| 决策 | 选择 | 理由 |
|---|---|---|
| 语言 | TypeScript + Node 20+ | 与 mihomo 配置生成、日志解析共享类型 |
| 界面 | 先 Tauri，后改浏览器 | 见「踩坑清单」第 1 条 |
| 内核 | mihomo v1.19.32 | 复用既有安装，不重新分发 |
| 提权 | UAC（`Start-Process -Verb RunAs`） | 不携带额外 elevate.exe |

### 16 个任务

1. 脚手架与类型定义
2. 规则源文件（8 个 YAML + fallback.json）
3. 规则装配（严格 / 精确模式）
4. 代理组与 fail-closed 守卫
5. DNS 策略与分片
6. 配置组装器
7. 日志分析与动态补丁
8. 设置读写
9. 出口一致性检测（核心回归项）
10. DNS / IPv6 / WebRTC / 长连接 / 冲突 五项检测
11. mihomo 运行时管理与 UAC 提权
12. 系统 DNS 接管
13. 端到端集成测试
14. Tauri GUI 骨架
15. Tauri Rust 后端与 IPC
16. README 与收尾

最终：**282 个用例（282 passed + 0 skipped）**

---

## 四、踩坑清单（按发现顺序）

### 坑 1：Tauri 窗口创建失败

**现象**：
```
thread 'main' panicked at tauri-2.12.5\src\app.rs:1444:11:
Failed to setup app: 拒绝访问。 (os error 5)
```

**排查过程**：
- 补 `capabilities/default.json` → 仍失败
- 补窗口 `label: main` → 仍失败
- 用 `Start-Process` 交互式启动 → 仍失败
- 确认 WebView2 已装（156.0.4314.56/.58 双版本共存）→ 驱动问题不在这里

**最终方案**：放弃 Tauri 窗口，改**本地 HTTP 服务 + 浏览器界面**（`bin/ui.js`）。
功能完全一致，不依赖 WebView2。

---

### 坑 2：体检器没走代理，测出来的数据全错

**现象**：体检报告「出口不一致」「DNS 泄漏」，但 curl 实测正常。

**原因**：Node 内置 `fetch` **不遵循 HTTP_PROXY 环境变量**，体检器直连网络，测到的是本机真实 IP。

**修复**：自己实现 HTTP CONNECT 代理（`proxiedFetch`），所有请求走 AI Guard 端口。

---

### 坑 3：探测目标选错，必然报错

**现象**：`api.ipify.org` 返回机场 IP，被判定为「出口不一致」。

**原因**：`ipify.org` / `1.1.1.1` 这类地址**不在 AI 规则集里**，命中 `MATCH` 走机场 IP。拿它们做探测目标，测出来必然不一致。

**修复**：探测目标必须是**规则覆盖范围内**的域名（`www.cloudflare.com` 等）。

---

### 坑 4：`cloudflare-dns.com` 的 301 重定向

**现象**：该站点「未响应」。

**原因**：它在根路径 `/` 返回 301，而 `/cdn-cgi/trace` 才返回 trace 数据。我的代码用 `host.includes('cloudflare.com')` 判断，但 `cloudflare-dns.com` **不含这个子串**，走了错误分支。

**修复**：每个探测目标显式声明 `path`。

---

### 坑 5：代理请求的慢响应被误判超时

**原因**：`tlsSock.setTimeout(12s)` 在收到数据后仍在计时。

**修复**：收到数据即 `setTimeout(0)` 取消空闲超时。

---

### 坑 6：STUN 端口没拦截（WebRTC 泄漏）

**原因**：`rules.ts` 只拦了 AI 域名的 QUIC，没拦 STUN 端口。

**修复**：加 `AND,((NETWORK,UDP),(DST-PORT,3478/5349/19302-19309)),REJECT`

---

### 坑 7：IPv6 DNS 没接管（真实的「中国DNS泄漏」）

**证据**（你的 ipcheck.ing 截图）：
```
2408:8001:2c2:3002::3   解析服务器归属地: China, Jinrongjie
61.163.252.70           解析服务器归属地: China, Zhengzhou
```

**原因**：`bin/start.js` 里写死了 `applyDns(dnsBackupPath, false)` —— **只接管 IPv4 DNS**，物理网卡的 IPv6 DNS 仍是运营商发的。

**修复**：
1. 探测本机是否有公网 IPv6，有则 `applyDns(path, true)`
2. 体检器改为**直接读网卡 DNS 配置**（权威），HTTP 出口对照降为补充

---

### 坑 8：IPv6 流量完全绕过代理

**发现方式**：把 IPv6 检测也改成读配置后，**立刻报出来**：
```
本机有公网 IPv6 (2408:8422:...) 但 TUN 网卡没有 IPv6 地址,
IPv6 流量完全绕过代理
```

**原因**：`builder.ts` 里 `ipv6: false` 硬编码。配置虽写了 `inet6-address`，但顶层 `ipv6=false` 时 mihomo **不会**为 TUN 建立 v6 地址和 `::/0` 路由。

**修复**：`ipv6` 与 `tunEnabled` 绑定。

---

### 坑 9：桌面版重连 —— QUIC 拦截范围错误（第一次修错方向）

**发现**：日志显示桌面版 18 个 UDP/443 请求全部走住宅 IP，0 次被 REJECT。

**第一次修复**（错）：把整个 AI 域名集都拿去拦 UDP/443
→ **导致 `challenges.cloudflare.com` 的 UDP 也被拦**，人机验证过不去，重连更严重。

**第二次修复**（仍错）：排除 `challenges` 后按域名白名单拦
→ `a.nel.cloudflare.com`、`update.googleapis.com`、`gstatic` 这些**动态查询的域名漏网**。

**第三次修复**（当前）：**无条件拦截所有 UDP/443**，只放行人机验证域名
```yaml
- AND,((NETWORK,UDP),(DST-PORT,443),(DOMAIN,challenges.cloudflare.com)),AI Guard 专用
- AND,((NETWORK,UDP),(DST-PORT,443)),REJECT
```

---

### 坑 10：`find-process-mode` 未设置，进程规则从未生效

**发现**：日志显示 `ProcessName` 命中 99 次，但出口走向全是错的。

**原因**：配置里没有 `find-process-mode`，mihomo **不开启进程识别**，所有 `PROCESS-NAME` 规则形同不存在。

**修复**：加 `find-process-mode: strict`。

**这个坑极隐蔽** —— 规则看起来配了，日志也显示"命中"了，但实际匹配逻辑根本没跑。

---

### 坑 11：端口冲突（排查绕弯的最大干扰源）

**真相**：
```
本机另一个代理程序 默认也用 7891（AI Guard 的默认端口）
另一代理进程 同时监听：1053、7891、12000
```

**后果**：谁先启动谁占住，另一个绑不上。mihomo 只打一行：
```
bind: Only one usage of each socket address
```
进程照常显示「运行中」，但**流量实际走的是别人的代理**。

**这是我十几轮排查走错方向的根源** —— 我以为在测 AI Guard，实际测的是 另一个代理程序。

**修复**：启动前用 `netstat + tasklist` 检测端口占用，被占则自动顺延并告知是谁占了。

---

### 坑 12：**蓝屏（BugCheck 0x50）—— 我造成的**

**证据**：
```
15:52  0x00000050 (PAGE_FAULT_IN_NONPAGED_AREA)
16:43  0x00000050 (崩溃地址末位相同)
蓝屏前 mtkwlex（MediaTek WiFi 驱动）密集报错 Id 1030-1040
```

**关键佐证**：你说「用 早期实现 时只是访问不了校园网官网，**没有蓝屏**」。

**根因**：我的 DNS 脚本
```powershell
Set-DnsClientServerAddress -InterfaceIndex X -ServerAddresses 198.18.0.2,fdfe:dcba:9876::2
```
**没带 `-AddressFamily`**，把 IPv4 和 IPv6 地址**混写进两个地址族**，形成畸形网卡配置。MediaTek MT7921 驱动处理这种状态变更时内存越界。

**早期实现 为什么不蓝屏**：它的脚本按地址族分开调用。

**修复**：按族分开，各带 `-AddressFamily`；不接管 IPv6 时主动清理残留。

---

### 坑 13：AI Guard 停止后 DNS 残留，校园网断网

**现象**：AI Guard 停止后，`www.edu.cn` 打不开，但百度能开。

**原因**：WLAN DNS 被留在 `198.18.0.2`（TUN 假 IP），但**没有进程监听 53 端口**，域名解析全挂。百度能开是因为浏览器缓存了 IP。

**触发条件**：内核被**强杀**时，`start.js` 里的 DNS 恢复代码根本跑不到。

**修复（已完成）**：`stop` 前主动 `sysdns.restore()`。

**修复（待做）**：加独立看守进程，主进程消失时自动恢复。

---

## 五、关于 ChatGPT 桌面版的最终结论

### 这是整个项目最大的认知修正

我前面 10 多轮都在「ChatGPT 桌面版重连」上排查，方向是**错的**。

### 真相

你截图里那个「ChatGPT 桌面版」，真实身份是：

```
C:\Program Files\WindowsApps\OpenAI.Codex_26.1027.3384.0_x64__2p2nqsd0c76g0\app\ChatGPT.exe
                                   ^^^^^ Codex
```

**它是 Codex**（OpenAI 的编程 Agent），不是普通的 ChatGPT 聊天客户端。

界面上的 `Work with Codex`、`Full access`、`GPT-6.1 Sol High` 都是 Codex 的特征。

### 为什么一直重连

你截图里的错误：
```
unexpected status 502 Bad Gateway
url: http://127.0.0.1:15721/v1/responses
```

- `127.0.0.1:15721` 是**本地服务**，不是 OpenAI 的地址
- 官方 ChatGPT 桌面版**不会**请求 `/v1/responses`（那是 API 路径）
- 该端口当前**无进程监听**

所以 Codex 在找一个已经消失的本地服务。

### 还有 HostCodex 这个第三方工具

```
NODE_EXTRA_CA_CERTS=%APPDATA%\HostCodex\certs\hostcodex-ca.crt
```

`HostCodex` 是一个 558 MB 的第三方 Codex 增强工具（用中间人证书劫持 HTTPS）。它**当前没有运行**，但环境变量还在，会干扰所有 Node/Electron 应用的 HTTPS 验证。

### 网络层完全正常（已实测）

| 测试 | 结果 |
|---|---|
| 另一个代理程序 访问 Google | 200 ✓ |
| 另一个代理程序 访问 chatgpt.com（带浏览器头） | 200 ✓ |
| 另一个代理程序 出口 IP | 142.249.36.195 (US) ✓ |
| 网页版 ChatGPT | 你确认正常 ✓ |

**裸 curl 访问 chatgpt.com 返回 403 + `Cf-Mitigated: challenge` 是 Cloudflare 的防机器人机制，任何 IP 都会触发，不是 IP 被封。**

### 结论

**Codex 连不上的问题，与 AI Guard 无关，也不该由 AI Guard 解决。**

它有自己的架构（Codex → 本地服务 → OpenAI），和浏览器走完全不同的路径。系统代理规则管不到它内部的本地调用。

---

### 坑 14：打包漏掉 `guard-filter`，实时保护一开就报 ENOENT

**现象**：重新打包后启动桌面端，界面弹红字：

```
Guard helper failed: spawn <安装目录>\resources\guard-filter\aiguard-guard-filter.exe ENOENT
```

**根因**：`electron-builder.yml` 的 `extraResources` 只配了 `vendor/mihomo`，
**漏了 `vendor/guard-filter`**（.NET 8 的 WFP 驱动辅助程序，实时保护/整机断流依赖它）。
而且我同步产物时只复制了 `app.asar` 和 `AI Guard.exe`，没有这个目录。

**影响**：只有「实时保护 / 整机断流」不可用；普通代理、十项体检、Claude 线路检测都不受影响。

**修复**：
1. `node scripts/build-guard-filter.mjs` 生成 `vendor/guard-filter/`（含 `--self-test` 自检，
   输出 `{"ok":true,"checkedLayers":4}`）
2. `electron-builder.yml` 增加 `vendor/guard-filter → guard-filter`
3. 重新打包并同步到 `AI Guard/resources/`

**教训**：打包配置的每一项 `extraResources` 都要对应一个运行时必需件。
少一个不会在编译期报错，只在用户点按钮时才炸。

---

### 坑 15：**受保护模式下，订阅被自家规则拦死**（最隐蔽的一个）

**现象**：开启实时保护后，界面同时报 5 项失败：

```
TUN 接管：TUN 网卡或 IPv4 接管路由失效
IPv6 防泄漏：公网 IPv6 存在，但隧道地址或优先路由失效
出口一致性：所有受保护公共探测端点均未响应
WebRTC 防泄漏：STUN 探测未取得结果，且网络状态未知
长连接稳定性：连接在 5.0s 时被断开
```

**根因（内核日志实证）**：

```
22:37:20.058  [TUN] Tun adapter listening at: Meta([198.18.0.1/30]), auto route: true
22:37:20.061  [TCP] mihomo --> sub.example.com:443 match Match using REJECT
22:37:20.061  initial proxy provider airport-sub error: ... EOF
22:37:30.058  dial AI Guard 专用 ... 203.0.113.7:1080 connect error: i/o timeout
```

受保护模式（`desktop/protected-config.mjs`）把 `MATCH,REJECT` 放在规则**首位**。
mihomo 规则自上而下、**首次匹配即生效**，`MATCH` 在首位会匹配一切 ——
于是**内核自己拉订阅、查 DNS 的流量也被自家规则拒掉**。

因果链：

```
订阅拉不到(EOF) → 机场 provider 为空 → 「AI Guard 前置」组为空
  → 住宅节点失去前置中转 → 住宅 SOCKS5 超时
  → 探测端点全无响应 → 5 项体检同时失败
```

**关键澄清**：这**不是**订阅坏了、也不是 Clash Verge 抢路由。浏览器能正常打开订阅，
因为浏览器走系统直连；内核拉订阅走规则匹配，被自己拒了。

**为什么之前没暴露**：此前验证都用**隔离端口 + `tunEnabled: false` + 无受保护规则**，
那条路径下 `MATCH` 走 `COMPATIBLE`（直连），订阅能拉到。
**真实桌面端开启 TUN + 实时保护才会触发** —— 这是我的测试覆盖盲区。

**修复（真实 mihomo 逐项实测确定）**：

| 层 | 改法 |
|---|---|
| provider | `airport-sub` 显式 `proxy: DIRECT` 拉取 |
| DNS | `default-nameserver` / `nameserver` / `proxy-server-nameserver` 全部改**明文 IP** |
| DNS | 订阅域名单独 `nameserver-policy` 指向直连明文 DNS |
| 规则 | 信源放行规则（订阅域名 + 公共 DNS IP）置于 `MATCH,REJECT` **之前** |
| 序列化 | `core/runtime/mihomo.ts` 原本不支持 provider 的 `proxy` 字段，补上 |

**为什么订阅不能走住宅 IP**（曾被要求，实测证明不可行）：

```
住宅 SOCKS5 203.0.113.7:1080 本机直连 → TIMEOUT
```

住宅 IP 必须经机场前置中转（`dialer-proxy: AI Guard 前置`），
而机场节点只能来自订阅 —— 走住宅 IP 会形成**循环依赖**。
订阅是「信源」，提供前置节点，只能直连拉取。
**AI 业务流量本身仍 100% 走住宅独享 IP，保护强度没有降低。**

**为什么 DNS 必须是明文 IP**：
`default-nameserver` 是内核解析 DNS 服务器地址本身的引导解析器，
若它也是 DoH 形式就自举失败（实测订阅拉取直接 `EOF`）。
另外 `nameserver` 原本是 `https://1.1.1.1/dns-query#普通代理`（带代理标签），
要先经机场节点才能解析 —— 同样循环依赖。
需要加密 DNS 的 AI 域名走 `nameserver-policy` 里的 `#AI Guard 专用`（经住宅 IP）。

**教训**：**「信源」流量（订阅、DNS）与「要保护的业务流量」必须分开对待**。
前者是后者的前提，用同一套规则保护它等于自己掐自己脖子。

---

### 坑 16：**整机断流死锁** —— 断流后「复检并恢复」永远失败

**现象**：进入「已断流」状态后，点「复检并恢复」没反应，一直失败。

**根因**：`desktop/protection.mjs` 的 `run()` 里：

```js
const abnormal = accepted.filter(x => x.state !== 'ok');   // ← unknown 也算异常
if (abnormal.some(x => x.critical || this.failures.has(x.key))) return this.trip(reason);
```

`unknown` 的语义是「**无法判断**」（探测端点不可达、上游拉不到），
但代码把它当成「检测到不安全」。第二轮任意一项 `unknown` 重复出现就 `trip()` 整机断流。

而断流后的复检**依赖同一个已经不可用的内核** → 永远 `unknown` → 永远断流。
**死锁。**

**修复**：

1. `unknown` 只提示、不单独触发断流；明确的 `fail`（检测到泄漏/接管失效）仍然断流
2. 恢复复检只有 `unknown` 时：**保持断流**（安全语义不变），但标记 `undetermined`
3. `undetermined` 状态下持续做完整复核，**链路自愈后自动解锁**，
   用户不必陷入「复检 → 又断流 → 再复检」的循环

**教训**：fail-closed 是对的，但要分清「确认不安全」和「无法确认」。
把两者混为一谈，系统就失去了自愈能力。

---

### 坑 17：**热重载后订阅域名从信源规则里消失**（我自己引入的）

**现象**：首次启动一切正常（探测 4/4 全通），但切换模式或改配置触发热重载后：

```
00:17:32  [TCP] --> cloudflare-dns.com:443 using AI Guard 专用[AI Guard · 独享 IP]   ← 启动后正常
00:18:08  Start initial configuration in progress                                    ← 热重载
00:18:08  [TCP] --> cloudflare-dns.com:443 match Match using REJECT                 ← 重载后被拒
```

**根因**：`desktop/worker.mjs` 的 `makeYaml` 里：

```js
cfg["proxy-providers"]["airport-sub"].url = JSON.stringify(s.airportUrl);
```

URL 被包成 `"https://..."`（带引号）再交给序列化器。而信源规则要从中提取订阅域名：

```js
buildSourceRules(cfg["proxy-providers"]?.["airport-sub"]?.url ?? "")
```

带引号的 URL 让 `new URL()` 解析失败 → `subscriptionHost()` 返回 `null` →
**信源规则只剩公共 DNS，订阅域名消失** → 订阅域名被自家 `MATCH,REJECT` 拒掉 →
探测端点全无响应 → 整机断流。

**为什么首次启动没事、热重载才坏**：
首次启动走 `worker.mjs` 的另一条路径，`cfg` 直接来自 `buildConfig`（URL 未加引号）；
热重载走 `updateConfig` → `makeYaml(next, blocked)`，URL 已经被加过引号。

**修复**（两处都改）：
1. `core/config/groups.ts` 的 `subscriptionHost()` 容忍带引号的 URL
2. `desktop/protected-config.mjs` 的 `buildProtectedYaml` 显式接收原始 `airportUrl` 参数，
   不再从已加引号的 `cfg` 里挖

**教训**：**序列化用的中间形态不能当语义数据用**。
`JSON.stringify` 加的引号是为了 YAML 转义, 拿它去提取域名就错了。
派生数据要走显式参数传, 而不是从"恰好经过序列化"的对象里反推。

---

## 六、当前软件状态

### 已实现且验证通过

| 功能 | 状态 |
|---|---|
| 出口一致性（严格模式） | ✓ 三个 Cloudflare 域名全部 `203.0.113.7` |
| IP 检测站显示住宅 IP | ✓ ippure.com 显示 4% 极度纯净 |
| 严格 / 精确 / 全局 三模式 | ✓ 热重载切换，不重启不中断 |
| DNS 防泄漏（IPv4 + IPv6） | ✓ 网卡 DNS 全部接管 |
| IPv6 防泄漏 | ✓ TUN 有 IPv6 地址，`::/0` 路由指向 Meta |
| WebRTC 防泄漏 | ✓ STUN 端口被 REJECT |
| 长连接稳定性 | ✓ 保持 31.5s 未断 |
| **原始 bug 修复** | ✓ `a.nel.cloudflare.com` 命中 `cloudflare.com` 兜底 |
| fail-closed | ✓ 守卫节点 `127.0.0.1:9`，绝不回落直连 |
| 端口冲突检测 | ✓ 被占自动顺延 |
| 日志落盘 | ✓ `%APPDATA%\aiguard\mihomo\mihomo.log` |
| 独享 IP 检测 | ✓ 出口 `203.0.113.7` = 住宅独享 IP |
| 断网保护检测 | ✓ `AI Guard 专用` 是 Fallback 组且含「未就绪(阻断)」节点 |
| Claude Code 线路检测 | ✓ 规则与运行时连接链都走 `AI Guard 专用 → AI Guard · 独享 IP` |
| Claude 看到的 IP 检测 | ✓ `claude.ai/cdn-cgi/trace` 返回 `ip=203.0.113.7` |
| 受保护模式订阅拉取 | ✓ `airport-sub` 走 `proxy: DIRECT`，信源规则在 `MATCH,REJECT` 之前 |
| 受保护模式出口一致性 | ✓ 真实内核实测 46 个机场节点 + 出口 `203.0.113.7` + 4/4 项 ok |
| 热重载后信源规则保持 | ✓ 启动与热重载两阶段均实测 4/4 项 ok |
| 断流死锁修复 | ✓ `unknown` 不再触发断流；原因不明时保持断流并周期复核自愈 |
| 桌面端打包完整性 | ✓ `guard-filter` 已进 `extraResources`，实时保护可用 |
| 测试 | ✓ 346 个用例（345 passed + 1 skipped，e2e 条件不满足时跳过） |
| 规则集完整度 | ✓ 10 个规则集，100% 覆盖 早期实现（含 Gemini / Google 支付） |

### 未完成 / 已知限制

| 项 | 说明 |
|---|---|
| 蓝屏修复未验证 | 需要再启一次 TUN 才能确认，但怕再崩 |
| DNS 强杀恢复 | 依赖进程正常退出，需加看守进程 |
| GUI 的 `exitIp` | 一度为 `null`，后来已修（读 settings 真实值） |
| Codex 连通性 | 与本项目无关，详见第五节 |
| 只支持 Windows | 依赖 PowerShell / netsh / tasklist |
| 订阅与公共 DNS 走直连 | 信源流量必须直连（见坑 15），**AI 业务流量仍全部走住宅独享 IP** |
| 断流后自愈依赖内核存活 | 内核若已退出，需点「退出保护并恢复普通网络」而非「复检并恢复」 |

### 你的实际使用建议

1. **网页版 ChatGPT / Claude** → 走 AI Guard 住宅 IP，已验证正常
2. **Codex** → 与 AI Guard 无关，需要单独解决（检查 HostCodex 和 15721 服务）
3. **另一个代理程序** → 不要和 AI Guard 同时开（端口会冲突，虽然现在会自动顺延）

---

## 七、关键教训（给未来的自己）

1. **先确认「测的是不是同一个东西」**。端口冲突让我在错误的前提上排查了十几轮。

2. **裸 curl 不能用来判断 IP 是否被封**。Cloudflare 对无浏览器特征的请求一律 403 challenge，这跟 IP 信誉无关。

3. **诊断要「测配置」而不只是「测结果」**。DNS 和 IPv6 两项改成读网卡配置后，立刻抓出了旧检测器漏掉的真问题。

4. **「日志显示命中」不等于「规则生效」**。`find-process-mode` 缺失时，`ProcessName` 明明在日志里，实际匹配逻辑根本没跑。

5. **修改系统网络配置必须按地址族分开**。混写会导致驱动崩溃（0x50 蓝屏）。

6. **用户的观察是最有价值的线索**。「网页能用、桌面版不能用」「早期实现 时不蓝屏」这两句话，各自直接砍掉了一半的排查空间。

7. **「信源」流量与「要保护的业务流量」必须分开**。订阅提供前置节点，前置节点又必须经住宅 IP 出海 —— 用同一套规则保护信源，等于自己掐自己脖子（坑 15）。

8. **fail-closed 要分清「确认不安全」与「无法确认」**。把 `unknown` 当成 `fail` 会让系统失去自愈能力，最终陷入断流死锁（坑 16）。

9. **测试环境必须复现真实运行形态**。隔离端口 + `tunEnabled: false` + 无受保护规则测出来的「全绿」，在真实桌面端（TUN + 实时保护）下完全不成立（坑 15）。

10. **序列化用的中间形态不能当语义数据用**。`JSON.stringify` 加的引号是为了 YAML 转义, 拿它去提取订阅域名就错了 —— 派生数据要走显式参数传（坑 17）。

11. **首次通过不等于热重载后也通过**。模式切换、配置更新都会重新生成配置, 两条路径要分别验证（坑 17）。

---

## 附录：项目结构

```
aiguard/
├── core/                    纯 TypeScript 逻辑，可独立测试
│   ├── config/
│   │   ├── types.ts         类型定义
│   │   ├── constants.ts     G_AI / G_PROXY / CHAIN_TIMEOUT 等
│   │   ├── rules.ts         规则装配（严格/精确/全局 + QUIC + STUN）
│   │   ├── groups.ts        代理组 + fail-closed 守卫 + 信源放行规则
│   │   ├── dns.ts           DNS 策略 + nameserver-policy 分片
│   │   └── builder.ts       配置组装
│   ├── domain/
│   │   ├── rule-source.ts   读取 rules/ 目录
│   │   └── patcher.ts       日志分析 → 补丁建议
│   ├── runtime/
│   │   ├── mihomo.ts        configToYaml / findMihomo / ensureGeodata
│   │   ├── elevate.ts       UAC 提权
│   │   └── sysdns.ts        网卡 DNS 接管 / 恢复（按地址族）
│   ├── doctor/              十项体检（ai-route.ts / ai-route-report.ts 为 AI 线路四项）
│   └── settings.ts          配置读写（容错）
├── rules/domains/*.yaml     10 个域名规则集 + fallback.json
├── bin/
│   ├── start.js             启动内核（端口检测/提权/geodata/DNS）
│   ├── ui.js                浏览器控制面板
│   ├── doctor.js            CLI 体检
│   ├── set-mode.js          切换模式
│   └── logs.js / patch.js
├── desktop/                  Electron 桌面端
│   ├── main.cjs             主进程 / 托盘 / IPC
│   ├── worker.mjs           提权 worker（持有随机化的 controllerSecret）
│   ├── worker-client.mjs    命名管道客户端
│   ├── service.mjs          业务门面（doctor / saveSettings / …）
│   ├── protection.mjs       断流状态机（unknown 不触发断流 + 自愈复核）
│   ├── protected-config.mjs 受保护配置（信源规则在 MATCH,REJECT 之前）
│   ├── health.mjs           周期检测（local 5s / exit 15s / full 60s）
│   └── smoke.mjs            Electron 冒烟脚本
├── native/GuardFilter/       .NET 8 WFP 驱动（整机断流）
├── scripts/
│   ├── build-guard-filter.mjs   构建并自检 guard-filter
│   ├── prepare-desktop.mjs      暂存 vendor/mihomo
│   └── desktop-smoke.cjs        真机冒烟 + 崩溃回收
├── tests/                   282 个用例
├── gui/                     Electron 前端（src/App.tsx 为实际界面）
└── README.md
```

### 打包产物清单

```
release/win-unpacked/AI Guard.exe          免安装目录（需保留整个目录）
release/AI-Guard-Setup-0.1.0-x64.exe        NSIS 安装包
release/SHA256SUMS.txt                      校验和
AI Guard/                                   本地可直接双击运行的目录
  ├── AI Guard.exe
  └── resources/
      ├── app.asar                          应用代码
      ├── mihomo/                           内核 + geodata + manifest
      ├── guard-filter/                     WFP 辅助程序（实时保护必需）
      └── elevate.exe                       UAC 提权
```

> `guard-filter/` 曾经在 `extraResources` 里漏配，导致实时保护一开就报
> `spawn ... aiguard-guard-filter.exe ENOENT`（见坑 14）。
