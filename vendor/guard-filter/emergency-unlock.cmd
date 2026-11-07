@echo off
setlocal EnableExtensions
chcp 65001 >nul 2>&1
title AI Guard 紧急解除网络锁定
color 0F

rem ============================================================
rem  AI Guard 紧急解除整机网络锁定
rem
rem  什么时候用:
rem    装完 AI Guard 后, WiFi / 有线网络"已连接但无法上网",
rem    打开任何网站都失败, 怀疑被 AI Guard 的 WFP 过滤规则拦住。
rem
rem  为什么安全:
rem    AI Guard 的实时保护用 Windows WFP(内核层防火墙)规则,
rem    阻断"除内网以外所有外网"的出口流量, 而不是改网卡配置。
rem    一旦规则拦截了普通进程, 连浏览器也很容易遭殃, 用户自己无法
rem    上网排查。
rem
rem  这个脚本只做一件事:
rem    只删除 AI Guard 自己那 4 项固定 GUID 的规则及子层 provider/sublayer。
rem    不会改动其他软件的防火墙规则, 不改网卡, 不改 DNS(脚本会顺手
rem    清理残留的 198.18.0.2 / fdfe:dcba:9876::2 这两条 DNS)。
rem ============================================================

echo ============================================================
echo   AI Guard 紧急解除网络锁定
echo ============================================================
echo.

rem ---- 自己提权: 没有管理员权限时用 UAC 重新启动自己 ----
fltmc >nul 2>&1
if errorlevel 1 (
  echo 正在请求管理员权限...
  powershell -NoProfile -ExecutionPolicy Bypass -Command "Start-Process -FilePath '%~f0' -Verb RunAs" >nul 2>&1
  if errorlevel 1 (
    echo.
    echo [失败] 未能获得管理员权限。
    echo 请右键这个文件, 选择"以管理员身份运行"。
    echo.
    pause
  )
  exit /b 0
)

set "HELPER=%~dp0aiguard-guard-filter.exe"
if not exist "%HELPER%" (
  echo [失败] 找不到解除工具:
  echo        %HELPER%
  echo.
  echo 这个脚本必须和 aiguard-guard-filter.exe 放在同一个文件夹里。
  echo 现在这个 U 盘上只有脚本, 没有那个 exe, 所以即使修好也无法解锁。
  echo.
  echo 请从 AI Guard 的安装目录或官方修复包中把下面这个文件
  echo   aiguard-guard-filter.exe
  echo 复制到本脚本旁边, 然后再运行一次。
  echo.
  echo 若暂时拿不到该文件, 可先手动关掉 AI Guard 的"实时保护"开关,
  echo 或卸载 AI Guard 后重启电脑, 网络即可恢复。
  echo.
  pause
  exit /b 1
)

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
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='SilentlyContinue'; Get-NetAdapter | Where-Object { $_.Status -eq 'Up' -and $_.InterfaceDescription -notmatch 'Meta|Mihomo|Clash|TUN|TAP|WireGuard|Loopback|Hyper-V|VMware|VirtualBox|Bluetooth' } | ForEach-Object { $i=$_.ifIndex; $all=Get-DnsClientServerAddress -InterfaceIndex $i -ErrorAction SilentlyContinue; if (@($all.ServerAddresses) -contains '198.18.0.2' -or @($all.ServerAddresses) -contains 'fdfe:dcba:9876::2') { Set-DnsClientServerAddress -InterfaceIndex $i -ResetServerAddresses } }; Clear-DnsClientCache"
echo DNS 清理完成。
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
echo.
pause
