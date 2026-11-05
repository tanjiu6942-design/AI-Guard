import { spawn } from 'node:child_process';

/**
 * 通过 UAC 提权启动命令。
 * 用 PowerShell 的 Start-Process -Verb RunAs, 避免携带额外的 elevate.exe。
 */
export function elevate(command: string, args: string[]): Promise<number> {
  return new Promise((resolve, reject) => {
    const argList = args.map((a) => `'${a.replace(/'/g, "''")}'`).join(',');
    const ps = `Start-Process -FilePath '${command.replace(/'/g, "''")}' -ArgumentList ${argList} -Verb RunAs -PassThru | Select-Object -ExpandProperty Id`;

    const child = spawn('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], {
      windowsHide: true,
    });

    let out = '';
    child.stdout.on('data', (d) => { out += String(d); });
    child.on('error', reject);
    child.on('close', (code) => {
      const pid = Number(out.trim());
      if (code !== 0 || !Number.isInteger(pid)) {
        reject(new Error('提权失败或用户取消 UAC'));
        return;
      }
      resolve(pid);
    });
  });
}
