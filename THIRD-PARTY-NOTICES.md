# 第三方组件说明

本项目自身代码以 [MIT](LICENSE) 许可发布。运行时使用或随包分发以下第三方组件，
它们各自遵循其原始许可证。

## 随包分发的组件

### mihomo — GNU GPL v3

- 项目：https://github.com/MetaCubeX/mihomo
- 许可证：GNU General Public License v3.0
- 本项目的使用方式：作为**独立可执行程序**随包分发（`resources/mihomo/mihomo.exe`），
  本项目通过其 HTTP 控制接口调用，不链接、不修改其源码。
- 完整许可证文本随包提供：`resources/mihomo/LICENSE-mihomo.txt`

### meta-rules-dat（geodata 数据）— GPL-3.0

- 项目：https://github.com/MetaCubeX/meta-rules-dat
- 许可证：GNU General Public License v3.0
- 文件：`Country.mmdb` / `geoip.dat` / `geosite.dat`

## 构建与运行依赖

| 组件 | 许可证 | 用途 |
|---|---|---|
| Electron | MIT | 桌面运行时 |
| React | MIT | 界面 |
| TypeScript | Apache-2.0 | 编译 |
| Vite | MIT | 界面构建 |
| Vitest | MIT | 测试 |

## 说明

本项目自身代码不包含上述组件的源码。上述组件按各自许可证的要求分发，
本项目对其的调用方式（独立进程 + 控制接口）不构成衍生作品。

如需重新分发本项目的构建产物，请同时遵守 mihomo 与 meta-rules-dat 的 GPL-3.0 条款。
