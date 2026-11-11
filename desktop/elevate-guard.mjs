import { execFile } from 'node:child_process';
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * 以管理员身份再跑一次 guard-filter 的命令，并带回它的输出。
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
 * 所以「worker 已退出后由主进程自己解除整机断流」必须走 UAC。
 *
 * ── 三个坑，都是实测踩出来的 ──
 *
 * 1. `Start-Process` 的 `-RedirectStandardOutput` 与 `-Verb RunAs` **互斥**：
 *      Start-Process : 参数集“AmbiguousParameterSet”不能解析参数...
 *    这正是 2026-11-11 用户点「一键修复网络」只看到一句含糊"防火墙"错误的
 *    直接原因 —— 提权命令自己就报参数错误，而它的输出我们看不到。
 *
 * 2. `Start-Process -Verb RunAs` 启动的是**全新会话**，不继承父进程环境变量，
 *    也不把管道接回来 —— 提权进程的 stdout/stderr 拿不到。
 *
 * 3. 提权时必须用 `-File <script.ps1>` 启动，不能用 `-EncodedCommand`：
 *    后者在 `-Verb RunAs` 下参数传递行为不同，实测拿不到退出码也拿不到输出。
 *
 * 解决办法：生成一个**自包含的临时 .ps1**（路径与参数全部内联写死），
 * 用 `-File` 提权运行它，脚本内部用 PowerShell 的 `*>` 把输出写进临时文件，
 * 结束后再读回该文件。实测可行。
 */

/** 提权失败的统一文案。调用方随后会回读真实状态，所以不需要更细的分型。 */
export const ELEVATION_DENIED = '未获得管理员授权（UAC 被取消，或管理员权限被拒绝），系统断流未解除';

/** helper 自己报的错（与权限无关），例如状态不完整、校验失败。 */
export const GUARD_FAILED = '系统防火墙规则解除失败';

const psQuote = (s) => `'${String(s).replace(/'/g, "''")}'`;

/** 拼出一个自包含的提权脚本内容：执行命令并把输出写入 outFile。 */
function buildElevatedScript(executable, args, outFile) {
  const argList = args.map(psQuote).join(',');
  return [
    `$out = ${psQuote(outFile)}`,
    // 用 Out-File -Encoding utf8 而不是 `*>`：
    // `*>` 重定向默认写 UTF-16LE，每个字符后带 \u0000，Node 读出来全是空字符。
    `& ${psQuote(executable)} ${argList} 2>&1 | Out-File -FilePath $out -Encoding utf8`,
    `exit $LASTEXITCODE`,
  ].join('\r\n');
}

export function elevateGuardCommand(executable, args, { timeout = 120000 } = {}) {
  return new Promise((resolve, reject) => {
    const token = randomBytes(6).toString('hex');
    const base = join(tmpdir(), `aiguard-elevate-${token}`);
    const outFile = `${base}.out`;
    const scriptFile = `${base}.ps1`;

    try {
      // 用 ASCII 编码：脚本内容全是 ASCII 路径与参数，避开 BOM 带来的解析问题。
      writeFileSync(scriptFile, buildElevatedScript(executable, args, outFile), 'ascii');
    } catch (e) {
      reject(Error(`无法创建提权脚本：${e.message}`));
      return;
    }

    // 提权运行脚本（必须用 -File，不能用 -EncodedCommand）。
    // 脚本自己负责把输出写进 outFile。
    const launcher =
      `$ErrorActionPreference = 'Stop'; ` +
      `try { $p = Start-Process -FilePath 'powershell.exe' ` +
      `-ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File',${psQuote(scriptFile)} ` +
      `-Verb RunAs -WindowStyle Hidden -PassThru -Wait -ErrorAction Stop; exit $p.ExitCode } ` +
      `catch { exit 1 }`;

    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(launcher, 'utf16le').toString('base64')],
      { windowsHide: true, timeout },
      (error) => {
        // 读回 helper 的输出（无论成功失败都要读）
        let output = '';
        // 兼容 UTF-8 与 UTF-16LE：提权脚本可能用不同的重定向方式写文件。
        const read = (p) => {
          try {
            const raw = readFileSync(p);
            if (raw.length >= 2 && raw[0] === 0xff && raw[1] === 0xfe) {
              return raw.subarray(2).toString('utf16le');
            }
            let text = raw.toString('utf8');
            // UTF-16LE 无 BOM 时每个字符后带 \u0000
            if (text.includes('\u0000')) text = text.replace(/\u0000/g, '');
            return text;
          } catch { return ''; }
        };
        output = (read(outFile) + ' ' + read(outFile + '.err')).trim();
        for (const f of [outFile, outFile + '.err', scriptFile]) {
          try { unlinkSync(f); } catch { /* 忽略 */ }
        }

        // 提取 helper 的错误信息
        const m = output.match(/"error"\s*:\s*"([^"]+)"/);
        const guardMessage = m ? m[1] : '';

        if (error) {
          // 用户点了 UAC 的"否"、或提权进程非 0 退出，都会到这里。
          const failure = new Error(
            guardMessage ? `${GUARD_FAILED}：${guardMessage}` : ELEVATION_DENIED,
          );
          failure.guardOutput = output;
          failure.elevationDenied = !guardMessage;
          reject(failure);
          return;
        }
        // 退出码为 0 但输出里带错误 —— helper 自己认为失败了
        if (guardMessage) {
          const failure = new Error(`${GUARD_FAILED}：${guardMessage}`);
          failure.guardOutput = output;
          reject(failure);
          return;
        }
        resolve({ code: 0, output });
      },
    );
  });
}
