# AI Guard 离线应急解除

锁定规则持久保存在 Windows WFP 中。退出界面、关闭内核或重新启动软件不会主动解除规则。本工具不依赖互联网或 .NET 安装。

需要恢复普通网络时，先退出 AI Guard，避免仍在运行的保护 worker 再次安装规则。以管理员身份运行与 `aiguard-guard-filter.exe` 同目录的 `emergency-unlock.cmd`；也可在管理员 PowerShell 中执行：

```powershell
& 'C:\实际安装目录\resources\guard-filter\aiguard-guard-filter.exe' unlock
& 'C:\实际安装目录\resources\guard-filter\aiguard-guard-filter.exe' status
```

`unlock` 成功返回 `locked:false, complete:true, filterCount:0`，并验证本软件的 provider/sublayer 已不存在。它只删除 AI Guard 固定 GUID 的四条规则及其专属 provider/sublayer；其他软件规则不受影响。发现标识冲突时失败并保留规则。解除失败时，错误信息和退出码会明确提示，不得视为恢复成功。

这会停止整机网络保护，并非安全体检通过。该工具只处理 WFP 阻断；如果内核、TUN 或 DNS 尚未恢复，请使用界面的“退出保护并恢复普通网络”或正常退出内核。本工具不更改 DNS、网卡、路由、服务或其他防火墙配置。

开发验证：`--self-test` 仅检查内存布局和规则构造，不打开 WFP、不修改网络。管理员可单独运行 `--test-isolated`：它使用动态会话和精确匹配本工具自身的 app ID，测试 IPv4/IPv6 阻断与回环保留，结束或崩溃自动移除；不会匹配其他应用。IPv6 未配置等环境限制会导致该测试报错，不能将其算作通过。
