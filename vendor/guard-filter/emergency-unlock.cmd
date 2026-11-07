@echo off
setlocal
chcp 65001 >nul
rem ============================================================
rem  AI Guard 紧急解除整机网络锁定
rem
rem  什么时候用:
rem    软件异常退出后, WiFi / 有线网"已连接但无法上网",
rem    蓝牙网络共享也建不起来, 重启电脑依然如此。
rem
rem  为什么会这样:
rem    AI Guard 的实时保护用 Windows WFP(内核态防火墙)规则,
rem    阻断"除内核以外所有应用"的出站流量, 且规则是持久化的。
rem    一旦内核先退出、规则却还在, 整台机器就没有任何程序能上网。
rem
rem  这个脚本只做一件事:
rem    删掉 AI Guard 自己那 4 条固定 GUID 的规则及其专属 provider/sublayer。
rem    不会碰其他软件的防火墙规则, 不改网卡, 不改 DNS(除清理本软件残留值)。
rem
rem  必须管理员权限运行 —— 脚本会自己请求提权。
rem ============================================================

rem ---- 自提权: 没有管理员权限时用 UAC 重新启动自己 ----
net session >nul 2>&1
if errorlevel 1 (
  echo 正在请求管理员权限...
  powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs" >nul 2>&1
  if errorlevel 1 (
    echo.
    echo [失败] 未能获得管理员权限。
    echo 请右键这个文件, 选择"以管理员身份运行"。
    pause
  )
  exit /b 0
)

set "HELPER=%~dp0aiguard-guard-filter.exe"
if not exist "%HELPER%" (
  echo [失败] 找不到 %HELPER%
  echo 请确认 AI Guard 安装目录未被移动或删除。
  pause
  exit /b 1
)

echo.
echo [1/3] 当前锁定状态:
"%HELPER%" status
echo.

echo [2/3] 正在解除 AI Guard 网络锁定...
"%HELPER%" unlock
if errorlevel 1 (
  echo.
  echo [失败] 解除失败, 请把上面的错误信息发给开发者。
  echo 规则未被删除, 系统状态保持不变。
  pause
  exit /b 1
)

echo.
echo [3/3] 清理本软件残留的 DNS 设置...
powershell.exe -NoProfile -Command ^
  "Get-NetAdapter | Where-Object { $_.Status -eq 'Up' -and $_.InterfaceDescription -notmatch 'Meta|Mihomo|Clash|TUN|TAP|WireGuard|Loopback|Hyper-V|VMware|VirtualBox|Bluetooth' } | ForEach-Object { $i=$_.ifIndex; $all=Get-DnsClientServerAddress -InterfaceIndex $i -ErrorAction SilentlyContinue; if (@($all.ServerAddresses) -contains '198.18.0.2' -or @($all.ServerAddresses) -contains 'fdfe:dcba:9876::2') { Set-DnsClientServerAddress -InterfaceIndex $i -ResetServerAddresses } }; Clear-DnsClientCache"

echo.
echo ============================================================
echo  完成。现在可以正常上网了。
echo.
echo  建议:
echo    - 打开 AI Guard, 确认界面不再显示"已断流"。
echo    - 若要重新开启实时保护, 请先确认网络体检全部通过。
echo ============================================================
echo.
"%HELPER%" status
pause
