@echo off
setlocal
chcp 65001 >nul
rem ============================================================
rem  清理 AI Guard 0.1.0 的注册表残留
rem
rem  背景: 你还原系统前装过 AI Guard 0.1.0, 安装目录 <安装目录>
rem  已被删除, 但 HKLM 的卸载登记还在。它的 UninstallString 指向一个
rem  不存在的 exe, 属于"幽灵已安装项", 会干扰后续安装/排查。
rem
rem  只删这一条注册表项, 不碰其他任何东西。
rem ============================================================

net session >nul 2>&1
if errorlevel 1 (
  echo 正在请求管理员权限...
  powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs" >nul 2>&1
  exit /b 0
)

set "KEY=HKLM\Software\Microsoft\Windows\CurrentVersion\Uninstall\6f79e4bf-edee-57fc-b54e-50797b940284"

echo.
echo [检查] 卸载程序是否存在...
if exist "<安装目录>\Uninstall AI Guard.exe" (
  echo [拒绝] 卸载程序仍然存在, 说明这是有效安装, 不应删除。
  echo        请改用控制面板正常卸载。
  pause
  exit /b 1
)

echo [执行] 删除残留注册表项...
reg delete "%KEY%" /f
if errorlevel 1 (
  echo [失败] 删除失败。
  pause
  exit /b 1
)

echo.
echo [验证] 再查一次...
reg query "%KEY%" >nul 2>&1
if errorlevel 1 (
  echo [完成] 残留已清除。
) else (
  echo [异常] 该项仍然存在。
)

echo.
echo ============================================================
echo  完成。
echo ============================================================
pause
