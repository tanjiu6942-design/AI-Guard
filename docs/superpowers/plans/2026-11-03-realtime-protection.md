# 实时保护实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 后台持续检测，异常提示并锁定整机联网，手动完整复检通过后恢复。
**Architecture:** 权限 worker 管理监测状态机和 Windows WFP 阻断；业务与复检使用独立回环端口。界面通过 IPC 获取保护状态，主进程负责通知。
**Tech Stack:** Electron/Node、React/TypeScript、.NET 8 自包含 Windows WFP 辅助程序、Vitest。
**Spec:** `docs/superpowers/specs/2026-11-03-realtime-protection-design.md`

## Global Constraints

- 保留当前已连接实例；不对真实网络触发整机断流测试。
- 整机阻断包括 IPv4/IPv6，保留回环与 IPC；业务代理在锁定时拒绝请求。
- 锁定持久化，失败不能宣称成功；只有完整复检通过或用户明确退出保护才能解锁。
- 无 Git 仓库，直接使用当前目录，不创建提交或工作树。

## Task 1：Windows 阻断适配器

Files: `native/GuardFilter/*`, `desktop/firewall.mjs`, `scripts/build-guard-filter.mjs`, `tests/firewall.test.js`。
Interface: `WindowsGuard({executable,dataDir}).status() -> {locked:boolean}`, `.lock(kernelPath)`, `.unlock()`；调用失败抛错。原生辅助程序命令为 `status`、`lock --allow-app <kernelPath>`、`unlock`，标准输出 JSON。

- [ ] 先写适配器回归测试，用可执行夹具验证参数传递、错误、状态和规则所有权，不修改系统规则。
- [ ] 实现 WFP 专属 provider/sublayer、持久 IPv4/IPv6 block 过滤，条件排除回环和明确指定的内核 app ID。事务保证成对安装和移除，查询必须与规则一致。
- [ ] 自包含编译并验证只读 status；提供显式离线 unlock 工具。真实安装过滤测试只使用回环保留且受限于一个隔离应用的测试模式。

## Task 2：监测状态机与探针

Files: `desktop/protection.mjs`, `desktop/health.mjs`, `desktop/probes.mjs`, `tests/protection.test.js`, `tests/health.test.js`。
Interface: `ProtectionMonitor({check,lock,unlock,notify,now,schedule,cancel})`；`.start()`, `.tick(kind)`, `.resume()`, `.trip(reason)`, `.shutdown()`, `.snapshot()`。`check(kind)` 返回检查项目数组，非 ok 项包含 `critical` 标志。snapshot 包括 phase/reason/checkedAt/fullCheckedAt/lockedAt/items。

- [ ] 失败测试覆盖启动检查、立即锁定、瞬态重试、串行、人工恢复、失败保留锁定和锁定执行错误。
- [ ] 实现状态机，周期 5/15/60 秒；检查有期限，未完成不可标为成功。
- [ ] 复用纯诊断函数，使用受保护公共端点与实际出口基准；Windows 采集错误必须抛错，不能返回空数组伪装通过。

## Task 3：内核、IPC 和保护生命周期

Files: `desktop/worker.mjs`, `desktop/worker-client.mjs`, `desktop/service.mjs`, `desktop/preload.cjs`, `desktop/main.cjs`, `tests/desktop.test.js`, `tests/fixtures/*`。
Interface: worker event `{event:'protection',value:snapshot}`；RPC `protectionStatus`, `resumeProtection`, `releaseProtection`。start settings 增加可选 `realtimeProtection:boolean`，正式默认 true，测试显式 false。

- [ ] 先测试事件传递、锁定下禁止模式切换和普通停止、明确退出保护路径。
- [ ] 生成第二个仅供探针的回环 inbound；普通 inbound 锁定时 REJECT，probe inbound 始终按正常规则出站；切换策略后关闭旧连接。
- [ ] 初始先拒绝业务，完整健康检查通过再打开。异常时先安装系统阻断，再拒绝并关闭业务连接；任何阶段错误保留锁定。
- [ ] 管道断开和内核退出在保护运行时触发锁定并保留规则；显式退出保护执行本软件规则清理和 DNS 恢复。重启读取锁定状态并保留。
- [ ] 主进程显示通知和托盘状态，resume 只在全部通过后解除；通知不可用仍显示本地错误。

## Task 4：界面、打包和交付验证

Files: `gui/src/App.tsx`, `gui/src/ipc.ts`, `gui/src/styles.css`, `desktop/smoke.mjs`, `electron-builder.yml`, `package.json`, `README.md`。

- [ ] 界面显示实时阶段、最后检查时间、锁定原因和复检恢复；停止/退出锁定不能静默解锁。
- [ ] 打包前编译 native helper，extraResources 携带辅助程序和应急工具；版本更新为 0.2.0。
- [ ] 运行 `npm test`、`npm run desktop:dist`、隔离 `desktop:smoke`；核对包内模块。
- [ ] 请求独立代码复核并修复重要问题，记录真实系统断流尚未验收的范围；交付新安装包。
