import { execFile } from 'node:child_process';

/**
 * 以管理员身份再跑一次 guard-filter 的命令，返回退出码。
 *
 * 为什么需要它 —— desktop/main.cjs 是以 asInvoker 启动的
 * (electron-builder.yml 的 requestedExecutionLevel)，
 * 而 guard-filter 的写操作明确要求管理员权限
 * (native/GuardFilter/Program.cs: `if (!status) RequireAdministrator()`)。
 *
 * 实测：
 *   guard-filter.exe status            -> exit 0（无需提权）
 *   guard-filter.exe unlock（普通权限） -> exit 1
 *     "Administrator elevation is required for kernel staging, WFP check, lock, unlock..."
 *
 * 所以「worker 已退出后由主进程自己解除整机断流」必须走 UAC，
 * 直接 execFile 在生产环境永远是失败的 —— 这正是 2026-11-06 事故里
 * 用户反复点"退出保护"都无效、最终只能还原系统的深层原因。
 *
 * 用 Start-Process -Verb RunAs：UAC 由系统弹出，用户拒绝时返回非 0。
 * 与 worker 启动（worker-client.mjs）保持同一套提权方式，不额外携带 elevate.exe。
 *
 * 错误处理刻意简单：**不把 PowerShell 的原始错误文本往界面上倒**。
 * -EncodedCommand 失败时 PowerShell 会输出 CLIXML（一堆 XML），
 * 里面还夹着脚本原文和本地代码页乱码，对用户毫无意义还容易吓到人。
 * 这里只用退出码区分「UAC 被拒」与「提权后命令本身失败」最后交给调用方回读真实状态。
 */

/** 提权失败的统一文案。调用方随后会回读真实锁态，所以不需要更细的分型。 */
export const ELEVATION_DENIED = '未获得管理员授权（UAC 被取消，或管理员权限被拒绝），系统断流未解除';

export function elevateGuardCommand(executable, args, { timeout = 120000 } = {}) {
  return new Promise((resolve, reject) => {
    const psQuote = (s) => `'${s.replace(/'/g, "''")}'`;
    const argList = args.map(psQuote).join(',');
    // 捕获失败而不是 Write-Error: 后者的输出会被包成 CLIXML 塞进 stderr。
    const script =
      `$ErrorActionPreference = 'Stop'; ` +
      `try { $p = Start-Process -FilePath ${psQuote(executable)} -ArgumentList ${argList} ` +
      `-Verb RunAs -WindowStyle Hidden -PassThru -Wait -ErrorAction Stop; exit $p.ExitCode } ` +
      `catch { exit 1 }`;
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
      { windowsHide: true, timeout },
      (error) => {
        if (error) {
          // 用户点了 UAC 的"否"、或提权进程非 0 退出，都会到这里。
          reject(Error(ELEVATION_DENIED));
          return;
        }
        resolve(0);
      },
    );
  });
}
