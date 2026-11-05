# Windows 桌面版验收记录

日期：2026-11-03。实现：Electron 45.2.1、Electron Builder 26.18.0、mihomo v1.19.32，Windows x64。

## 自动化与构建

- `npm run typecheck`：核心 TypeScript 类型检查通过。
- `npx tsc --project gui/tsconfig.json`：全部 React 源文件类型检查通过。
- `AIGUARD_MIHOMO_PATH=vendor/mihomo/mihomo.exe npm test`：112 项全部通过，包括真实 mihomo 配置校验；无跳过项。PowerShell 使用 `$env:AIGUARD_MIHOMO_PATH` 设置变量。
- `npm run desktop:dist`：生成 NSIS 安装包和 `release/win-unpacked`，不包含个人配置、订阅缓存、运行日志或 node_modules。
- 打包后的 `AI Guard.exe` 执行真实 UI smoke：12 项检查通过，覆盖 preload IPC、沙箱、三模式入口、表单修改保存、刷新读回、无效配置拒绝、体检前置条件、日志/扫描、关闭到托盘、内核启动前校验，以及随包内核启动/热重载/停止。
- 打包后的 UI 进程被强杀：独立 worker 清理自身 mihomo 子进程，测试通过。

真实内核测试全部使用回环地址上的订阅 fixture 和不可连接的本机代理节点，不建立实际住宅链路，不开启 TUN，不修改网卡 DNS。测试配置目录位于系统临时目录，不覆盖日常配置。

## 已修正的验收问题

- 继承的 ELECTRON_RUN_AS_NODE 环境变量导致开发启动进入 Node 模式：启动器显式移除该变量。
- 旧 ICO 只有 16×16：安装器使用现有的 256×256 PNG 生成 Windows 图标。
- 启动过程中停止、连续停止和旧管道 close 事件污染新会话：增加取消和会话所有权检查，覆盖真实命名管道回归测试。
- CONNECT/TLS 握手未完成时体检无限等待：增加全程连接超时与资源清理测试。
- 遗留 DNS 备份恢复需要管理员权限：即使新的设置关闭 TUN，残留备份也触发 UAC。
- 断连与恢复失败交错导致 worker 残留：清理完成状态与退出 promise 分开管理。
- 打包后 app.asar 不能作为子进程 cwd：显式使用物理 resources 目录，打包产物 smoke 回归通过。

## 界面

保留原深色界面，分成概览、配置、体检与日志；检查了实际 Electron 截图与配置读写交互。使用按钮反馈、导航指示移动、内容进入动画，并支持减少动态效果。代码经过独立审查；视觉由主实现者自检，没有独立视觉评分。

## 验证边界

- 未在本机开启真实 TUN 或变更物理网卡 DNS；UAC、真实 TUN 接管、DNS 恢复和既往网卡驱动蓝屏问题仍需实机验收。
- 独立 worker 自身被强杀或系统断电时，不能保证即时恢复 DNS；残留备份留到下一次启动恢复。正常退出和 UI 单独被强杀的清理路径已实现。
- 未配置代码签名证书。安装器已构建；未在本机执行安装/卸载，以免覆盖用户的安装状态和快捷方式。
- 未验证公网住宅链路的连通性；不把回环测试当作真实代理质量验收。

## 使用

安装 `release/AI-Guard-Setup-0.1.0-x64.exe`，或保留整个 `release/win-unpacked` 目录后运行其中的 `AI Guard.exe`。首次启动不自动启动内核。现有 `%APPDATA%/aiguard/settings.json` 继续使用。

最终打包 smoke：12 项通过；打包 UI 强杀清理通过。界面预览：`docs/desktop-preview.png`。
