; 安装时创建「AI Guard 紧急解除网络锁定」快捷方式（开始菜单 + 桌面）。
;
; 存在的理由: 2026-11-06 的事故中, WFP 持久规则把整机网络锁死,
; 应急脚本 emergency-unlock.cmd 其实一直躺在安装目录里, 但用户不知道,
; 最终只能还原系统。救命的入口必须出现在用户能找到的地方。
;
; 本文件通过 electron-builder 的 nsis.include 注入, 由
; installSection.nsh / uninstaller.nsh 的 !ifmacrodef 自动调用。
;
; 脚本自身会请求管理员权限(见 emergency-unlock.cmd 的自提权段),
; 所以这里不需要 elevated 快捷方式标志。

!macro customInstall
  CreateShortCut "$SMPROGRAMS\AI Guard 紧急解除网络锁定.lnk" "$INSTDIR\resources\guard-filter\emergency-unlock.cmd" "" "$INSTDIR\resources\guard-filter\emergency-unlock.cmd" 0
  CreateShortCut "$DESKTOP\AI Guard 紧急解除网络锁定.lnk" "$INSTDIR\resources\guard-filter\emergency-unlock.cmd" "" "$INSTDIR\resources\guard-filter\emergency-unlock.cmd" 0
!macroend

!macro customUnInstall
  Delete "$SMPROGRAMS\AI Guard 紧急解除网络锁定.lnk"
  Delete "$DESKTOP\AI Guard 紧急解除网络锁定.lnk"
!macroend
