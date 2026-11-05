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

### 坑 18：校园网 Web 认证死锁 —— 未认证前盲目接管导致认证页打不开

**现象**：在需要 Web 门户认证的校园网（AYXY）下，一启动 AI Guard 电脑就彻底断网，学生认证登录页无法访问，也不弹窗。

**排查**：
查日志发现该网络下「触发断流」为 0 次，说明根本不是断流保护误触发，而是代理链路从第一秒起就没建立。
启动流程按顺序执行了：
1. `WorkerProtection.prepare()`：调用 `guard.lock()` 加载 WFP 规则，除内核自身外阻断全机所有进程出网。
2. `KernelSession.start()`：启动 TUN 接管系统默认路由。
3. `applyDns()`：把物理网卡 DNS 强行改为 `198.18.0.2`（Fake-IP）。
而此时校园网尚未完成学号密码认证，外网连接全被网关阻断 —— 内核自己拉不到订阅、连不上住宅 IP；用户想打开浏览器访问认证网页，请求又被 DNS Fake-IP + TUN 路由 + WFP 拦截，陷入“没认证就不能上网，不上网就无法认证”的绝对死锁。

**修复**：
增加启动前置门（Preflight Gate，`desktop/preflight.mjs`）。在提权与接管网络之前，先用裸 socket / 直连探测网络可用性（探测 Windows NCSI、MIUI 等端点）。
- 明确检测到被 302 重定向到校园网认证页时，**坚决拒绝启动**，并在界面提示用户“检测到校园网认证，请先认证再启动”，同时提取出认证地址展示给用户。
- 拒绝启动期间不改动系统网卡 DNS、不启用 TUN 路由、不装载 WFP 防火墙规则。

**教训**：**安全软件必须假设物理网络环境可能处于未认证的“半连通状态”**。在获得合法出网凭据前，任何强行接管网络的行为都会将自己和用户锁死在没有出口的死局中。

---

### 坑 19：校园网 DNS 防篡改审计与体检器误判断流

**现象**：校园网认证通过后启动 AI Guard，或者退出时 DNS 恢复为静态 IP，校园网提示“DNS已被修改”并切断外网；体检器报 `DNS 配置偏离隧道地址：WLAN: 172.28.251.14` 并触发整机断流。

**排查**：
1. 高校校园网网关（如锐捷、华为、深信服）开启了合规检测，严格要求终端网卡的主 DNS 必须是 DHCP 下发的校园内网 DNS（`172.28.251.14`），一旦网卡静态配置变更为 `198.18.0.2` 或其他外网 IP，网关立刻断开网络会话。
2. 原系统为了防 DNS 泄漏强行调用 `Set-DnsClientServerAddress` 修改物理网卡；而实际上 Mihomo TUN 拥有内核级的 `'dns-hijack': ['any:53']`，即使物理网卡保持校园网 DHCP，所有 53 端口查询也都会在出网卡前被 TUN 截获伪造 Fake-IP，根本不需要也不应该改动物理网卡配置。
3. `desktop/health.mjs` 体检器写死了“物理网卡必须为 198.18.0.2”，导致免改网卡时被体检器自相矛盾地误判为 fail 并触发整机断流。

**修复**：
1. 增加「修改物理网卡 DNS」开关（`takeoverDns: false`），校园网环境下彻底禁止修改物理网卡，网卡保持正统的 DHCP 下发状态。
2. 修复 `desktop/health.mjs` 的判定逻辑，当用户选择免改网卡时，只要 TUN 处于接管状态，DNS 项直接判通过（`ok`）。
3. 增加 `buildCleanupResidualDnsScript` 保底清理逻辑，任何时候退出或启动时主动清理物理网卡上的 `198.18.0.2` 残留并恢复 DHCP。

**教训**：**流量劫持应当在虚拟驱动/数据包层完成，而非粗暴修改操作系统的物理网卡配置**。物理网卡的网络参数是与局域网基础设施协商的凭证，强行破坏凭证必然遭到网关的对抗。

---

### 坑 20：多网卡与复合网关下内核出口网卡识别为空导致 `<invalid>` 盲连断流

**现象**：在校园网下，即使 DNS 正常，所有外部端点（Cloudflare trace、长连接）在启动约 10 秒后精确报出 `dial tcp 203.0.113.7:1080: i/o timeout`，日志出现大量 `[TUN] Auto detect interface for ... get empty name. return '<invalid>' to avoid loopback`。

**排查**：
1. 校园网网关为 `10.232.0.1`，机器上同时存在断开的以太网物理网卡和 VirtualBox 虚拟网卡。Windows 底层路由表的查询返回了空接口名。
2. Mihomo 内核在 `auto-detect-interface: true` 遇到解析异常时，为了防止回环（loopback），把默认出口网卡名字直接赋成了字符串 `"<invalid>"`。
3. 内核所有发往机场节点或外网的 socket 在绑定到 `<invalid>` 时彻底失去出网能力，所有代理握手全部静默超时。

**修复**：在桌面管理进程中通过 Windows 底层路由表主动识别出唯一的有效物理默认路由网卡（`WLAN`），并在下发给内核的配置顶层显式注入 **`interface-name: WLAN`**，同时关闭不可靠的 `auto-detect-interface`。内核启动即精准绑定物理出口，彻底消除 `<invalid>` 故障。

**教训**：**跨平台核心（Go）对 Windows 复杂网络栈的“自动推导”绝不可全信**。当存在多网卡、虚拟网卡和特殊子网网关时，上层管理进程应当基于明确的系统 API 测量出唯一确定解并显式配置，而不是依赖内核的黑盒猜测。

---

### 坑 21：私有运行环境导致本地机场订阅缓存丢失

**现象**：校园网阻断了订阅域名 `sub.example.com` 的直连，每次启动时因 `airport-sub` 初始拉取返回 `EOF`，前置节点数归零，独享住宅节点退化为直接裸连超时。

**排查**：为了隔离提权环境，程序在 `C:\ProgramData\AI Guard\protected-kernel\...\runtime-<guid>` 创建全新运行目录，但未将 `%APPDATA%` 中已缓存的 `proxies/airport.yaml` 和 `cache.db` 拷入该隔离目录。导致订阅网址一旦无法访问，本地缓存又丢失，前置代理池直接枯竭。

**修复**：内核启动前自动将 AppData 中的离线节点缓存注入私有运行目录，退出时自动回写。即使订阅拉取失败，也能无缝使用已有的 46 个节点建立前置隧道。

**教训**：**隔离沙箱不能丢掉持久化运行状态**。为了提权和防盗取而创建的随机沙箱目录，必须显式做好对上一次已知良好状态的资产预置。

---

### 坑 22：国内 DoH 被分流规则误送进美国住宅链路，引发 SOCKS5 隧道拥塞与反复断流

**现象**：连接成功后频繁出现反复断流，提示：
`出口一致性：所有受保护公共探测端点均未响应（...: [TLS] Client network socket disconnected before secure TLS connection was established）；长连接稳定性：连接在 5.0s 时被断开`

**排查**：
查内核日志发现底层瞬间堆积了数十条：
`[TCP] dial AI Guard 专用 (match Domain/doh.pub) ... --> doh.pub:443 error: context deadline exceeded`
原来在 `core/config/rules.ts` 中，`DOH_DOMAINS` 列表中包含了国内公共 DoH 服务器（`doh.pub` 腾讯、`dns.alidns.com` 阿里、`doh.360.cn` 360），并且全部硬编码分流到了 `AI Guard 专用`（走美国独享住宅 IP）。
而国内解析策略（`geosite:cn`）配置了 `doh.pub`。当电脑发起大量国内应用域名解析时，数十个高频 DoH 请求被强行送往美国住宅 IP 访问腾讯国内服务器，腾讯对境外来源施加了限速与丢包，导致请求大量超时（`context deadline exceeded`）。
单个住宅 SOCKS5 通道被几十个超时的 DoH 请求瞬间打满阻塞，触发了 SOCKS5 代理服务端强制重置（RST），导致并发进行的 Cloudflare 出口探测与长连接在 TLS 握手阶段就被底层强拔网线（`socket disconnected before secure TLS connection was established`），进而误触发断流保护。

**修复**：
1. 从 `DOH_DOMAINS` 中剥离国内 DoH 域名（`doh.pub`、`dns.alidns.com`、`doh.360.cn`），在规则表中明确声明为 `DIRECT` 直连：
   ```ts
   const DOMESTIC_DOH = ['DOMAIN,doh.pub', 'DOMAIN,dns.alidns.com', 'DOMAIN,doh.360.cn'];
   for (const r of DOMESTIC_DOH) aiRules.push(`${r},DIRECT`);
   ```
2. 只有海外公共 DoH（`1.1.1.1`、`dns.google`、`cloudflare-dns.com` 等）才走住宅专用组防泄漏。
3. 国内域名 DoH 解析直接在本地 15ms 内秒级直连响应，彻底解除海外住宅代理的并发拥塞。

**教训**：**境内基础设施域名绝对不能反向送往境外出口**。DNS 服务器本身的流量如果走错出口，会把高频的底层信令直接变成阻塞代理通道的雪崩源头。

---

### 坑 23：反复误断流的真根因 —— 前置节点抖动 + 探针超时过紧 + 自测抢占住宅通道

**现象**：修复 DoH 后仍然「特别频繁」地反复断流，报错固定为：
`出口一致性：所有受保护公共探测端点均未响应（...[TLS] Client network socket disconnected before secure TLS connection was established）；长连接稳定性：连接在 5.0s 时被断开`

**排查（三条独立证据）**：

1. **压测证明瓶颈是"连接被重置"而非"速度慢"**：对住宅链路做并发压测，3/8/16 并发**全部成功**，但 16 并发时每个连接耗时 10.1 秒（3 并发仅 3.9 秒）。说明住宅 SOCKS5 跨境通道吞吐有限，并发一高就排队到 10 秒级。
2. **断流诊断日志显示前置节点在抖**：同一分钟内 `AI Guard 前置 now` 从「普通代理」变成「香港S01」，`AI Guard 自动选择` 从「香港S07」变成「新加坡S03」。前置节点一换，住宅节点的 `dialer-proxy` 就要重建底层链路，**在途的 TLS 握手被直接掐断** —— 这正好产生 `socket disconnected before secure TLS connection was established`。
3. **自测自己在抢通道**：full 检测含一条 30 秒长连接 + 3 个出口 trace，全部走住宅链路，固定 60 秒一次 —— 等于这条跨境通道有一半时间被自测占着；exit 检测 15 秒一次 ×3 并发 = 每分钟 12 条自测连接，而业务流量每分钟才 30 条左右。

**修复（四条）**：

1. **探针超时 12s/10s → 25s**（`desktop/worker-protection.mjs`）：给跨境排队留足余量，避免"正在排队"被误判成"链路断开"。
2. **前置组不再依赖会自动切换的「普通代理」**（`core/config/groups.ts`）：撤回上一轮加的 `proxies: [G_PROXY]`。住宅出口只有一个，前置只需要一个稳定可用节点，fallback 取第一个可用即最稳；让它跟着 url-test 抖，等于每次换节点都掐断住宅链路。
3. **自测自适应降频**（`desktop/protection.mjs`）：链路健康时 full 60s→180s、exit 15s→45s，一旦出现异常立即回到高频（60s/15s）以便尽快确认。健康时就把通道让给业务流量。
4. **全绿通过后重置 `everLocked`**：否则断过一次之后 `everLocked` 永久为 true，系统此后"一碰就锁"，越来越敏感。

**教训**：

- **判定层要严，测量层要准**。曾试图放宽 unknown 的判定阈值（连续 3 轮才锁）来止血，但那会破坏 `source-bypass` 契约 —— 只要阻断探测端点就能让出口一致性永远 unknown，形成 fail-open。**正确做法是修测量（超时、抖动、抢占），而不是放松判定**。
- **安全客户端的自测流量必须计入成本**。长连接探测占一条跨境通道 30 秒，等于拿业务带宽换安全感；健康时必须降频。
- **代理链的每一跳都要求稳定**。前置节点是住宅出口的"地基"，地基随便换，上层连接必然被掀翻。

**追加修复（探针自身的并发争抢）**：

三个出口探针（`cloudflare-dns.com` / `www.cloudflare.com` / `challenges.cloudflare.com`）原本是**并发**打进同一条住宅隧道的。隧道吞吐有限时三路互相抢通道，一起卡到超时，于是"全部无响应"——报出的正是 `socket disconnected before secure TLS connection was established`。这不是链路断了，是**测量方式自己制造了拥塞**。

改为：**并发首探 → 失败者串行补探一次**。首轮并发保证正常情况最快拿到结果；失败时不并发重试（那只会加剧拥塞），而是一次只占一个连接串行补探，排队压力立刻下降。补探后仍失败才如实报 `unknown`。

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
| 启动前置门（Preflight） | ✓ 启动前裸探测 Captive Portal，未认证拒绝接管避免死锁（坑 18） |
| 校园网免改网卡模式 | ✓ `takeoverDns: false` 保持物理网卡 DHCP，由 TUN 内核透明劫持，避免被学校网关断网（坑 19） |
| 物理出口网卡精准绑定 | ✓ 动态探测物理默认网卡并注入 `interface-name: WLAN`，消除多网卡下 `<invalid>` 盲连超时（坑 20） |
| 离线节点缓存预注入 | ✓ 将 AppData 节点缓存拷入隔离私有运行目录，校园网阻断订阅拉取时依然有 46 个节点可用（坑 21） |
| 国内 DoH 纯净直连 | ✓ `doh.pub` 等国内 DNS 走 `DIRECT`，彻底消除 SOCKS5 隧道拥塞断开（坑 22） |
| 前置节点稳定不抖 | ✓ 前置组不再跟随 url-test 自动切换，杜绝住宅 dialer-proxy 重建掐断 TLS（坑 23） |
| 探针超时抗排队 | ✓ 跨境排队实测可达 10s，探针超时放宽到 25s，不再误判为断开（坑 23） |
| 自测自适应降频 | ✓ 健康时 full 180s / exit 45s，异常时回到 60s / 15s，把通道让给业务流量（坑 23） |
| 异常断流自动复联自愈 | ✓ 后台自动复检重试，外网或代理自愈后自动解除断流（无需每次手动点击） |
| Claude 专项连接即显 | ✓ 首次连接成功后后台静默触发检测，1~2 秒内自动呈现真实通过结果 |
| 测试 | ✓ 369 个用例（368 passed + 1 skipped，e2e 条件不满足时跳过） |
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

12. **安全客户端不能在“未认证的网络”上盲目接管**。未拿到上网凭证前修改 DNS、抓走路由、锁定防火墙，只会把用户推进无法打开登录页的绝对死锁（坑 18）。

13. **局域网接入凭据（网卡参数）与流量劫持层级必须解耦**。物理网卡的 DNS 是跟局域网网关通信的凭据，粗暴篡改会触发合规审计；流量劫持应当在虚拟驱动/数据包层透明完成（坑 19）。

14. **跨平台核心的黑盒自动探测不能全信**。多网卡环境下自动探测失败会导致出口失效为 `<invalid>`，必须在上层用明确的系统 API 探测并显式注入（坑 20）。

15. **境内基础设施域名绝不能反向送往境外出口**。国内 DoH 如果被粗暴丢进海外住宅链路，海量超时的国内解析会瞬间冲垮跨境 SOCKS5 代理隧道（坑 22）。

16. **判定层要严，测量层要准**。怀疑误报时先修测量（超时、抖动、资源抢占），不要靠放宽判定阈值止血 —— 放宽 unknown 会直接换来 fail-open（坑 23）。

17. **安全客户端的自测流量本身就是成本**。一条 30 秒长连接探测就占掉一条跨境通道，固定高频自测等于拿业务带宽换安全感（坑 23）。

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
