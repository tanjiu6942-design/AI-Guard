import { execFile } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { isAbsolute } from 'node:path';

// The helper owns WFP identity and persistence; no local cache can prove a lock.
export class WindowsGuard {
  constructor({ executable, dataDir, timeout = 15000, elevation = undefined }) {
    const command = Array.isArray(executable) ? executable : [executable];
    if (!command[0] || !isAbsolute(command[0])) throw new Error('Guard helper requires an absolute executable path');
    if (!dataDir || !isAbsolute(dataDir)) throw new Error('Guard helper requires an absolute data directory');
    this.command = command;
    this.dataDir = dataDir;
    this.timeout = timeout;
    /**
     * 提权器: (exe, args) => Promise<exitCode>。
     *
     * 为什么需要它 —— guard-filter 的写操作(lock/unlock/check)要求管理员权限
     * (native/GuardFilter/Program.cs 的 RequireAdministrator), 而桌面主进程是
     * asInvoker 启动的(electron-builder.yml)。实测普通权限下:
     *   status -> exit 0
     *   unlock -> exit 1, "Administrator elevation is required..."
     *
     * 所以「worker 已退出时由主进程自己解除锁定」必须走 UAC,
     * 直接 execFile 在生产环境永远是失败的。
     * 传 null 表示本路径不支持提权(测试/无 GUI 环境)。
     */
    this.elevation = elevation;
    /** 变更类操作需要提权; status 不需要。 */
    this.mutatingRequiresElevation = true;
  }

  async invoke(args, input) {
    await mkdir(this.dataDir, { recursive: true });
    return new Promise((resolve, reject) => {
      let stdinError;
      const child = execFile(this.command[0], [...this.command.slice(1), ...args], {
        cwd: this.dataDir, windowsHide: true, timeout: this.timeout,
        maxBuffer: 256 * 1024, encoding: 'utf8', shell: false,
      }, (error, stdout, stderr) => {
        if (error) {
          let message = String(stderr || stdout || error.message).trim();
          try { message = JSON.parse(message).error || message; } catch {}
          const failure = new Error(error.killed ? `Guard helper timeout (${this.timeout}ms)` : `Guard helper failed: ${message}`);
          failure.cause = error;
          return reject(failure);
        }
        if (stdinError) return reject(new Error(`Guard helper stdin failed: ${stdinError.message}`));
        try {
          const value = JSON.parse(stdout.trim());
          if (!value || typeof value.locked !== 'boolean') throw new Error('missing locked boolean');
          if (value.error) throw new Error(value.error);
          resolve(value);
        } catch (failure) {
          reject(new Error(`Invalid guard helper response: ${failure.message}`));
        }
      });
      child.stdin?.on('error', (error) => { stdinError = error; });
      child.stdin?.end(input, 'utf8');
    });
  }

  async status() {
    const value = await this.invoke(['status']);
    if (value.complete === false && !value.locked) throw new Error('Incomplete guard state cannot be unlocked');
    return value;
  }

  async check() {
    const value = await this.invoke(['check']);
    if (value.available !== true) throw new Error('Windows WFP filtering is unavailable');
    return value;
  }

  async stageKernel(sourcePath) {
    if (typeof sourcePath !== 'string' || !isAbsolute(sourcePath) || sourcePath.includes('\0')) {
      throw new Error('Kernel staging requires an absolute executable path');
    }
    const value = await this.invoke(['stage-kernel', '--source', sourcePath]);
    if (typeof value.kernelPath !== 'string' || !isAbsolute(value.kernelPath) || value.kernelPath.includes('\0')) {
      throw new Error('Invalid protected kernel path returned by guard helper');
    }
    return value.kernelPath;
  }

  async prepareRuntime(kernelPath) {
    if (typeof kernelPath !== 'string' || !isAbsolute(kernelPath) || kernelPath.includes('\0')) {
      throw new Error('Private runtime requires an absolute kernel path');
    }
    const value = await this.invoke(['prepare-runtime', '--kernel', kernelPath]);
    if (typeof value.runtimeDir !== 'string' || !isAbsolute(value.runtimeDir) || value.runtimeDir.includes('\0')) {
      throw new Error('Invalid private runtime path returned by guard helper');
    }
    return value.runtimeDir;
  }

  async writeConfig(runtimeDir, name, content) {
    if (typeof runtimeDir !== 'string' || !isAbsolute(runtimeDir) || runtimeDir.includes('\0')) {
      throw new Error('Private configuration requires an absolute runtime path');
    }
    if (typeof name !== 'string' || !/^desktop-[A-Za-z0-9_-]{1,80}\.yaml$/.test(name)) {
      throw new Error('Invalid private configuration name');
    }
    if (typeof content !== 'string' || Buffer.byteLength(content, 'utf8') > 16 * 1024 * 1024) {
      throw new Error('Private configuration must be UTF-8 text no larger than 16 MiB');
    }
    const value = await this.invoke(['write-config', '--runtime', runtimeDir, '--name', name], content);
    if (typeof value.path !== 'string' || !isAbsolute(value.path) || value.path.includes('\0')) {
      throw new Error('Invalid private configuration path returned by guard helper');
    }
    return value.path;
  }

  async lock(kernelPath) {
    if (typeof kernelPath !== 'string' || !isAbsolute(kernelPath) || kernelPath.includes('\0')) {
      throw new Error('Kernel exception requires an absolute executable path');
    }
    await this.invoke(['lock', '--allow-app', kernelPath]);
    const value = await this.status();
    if (!value.locked || value.complete !== true) throw new Error('Guard lock did not install the complete filter set');
    return value;
  }

  async unlock() {
    await this.invoke(['unlock']);
    const value = await this.status();
    if (value.locked || value.complete === false) throw new Error('Guard unlock left filters installed or incomplete');
    return value;
  }

  /**
   * 经 UAC 解除锁定 —— 主进程(非提权)在 worker 已退出时的唯一可用路径。
   *
   * 与 unlock() 的区别只有一点: 命令通过提权器发出。
   * 校验仍然是读真实状态(非提权即可), 所以"以为解了其实没解"依然会被抓住。
   */
  async unlockEscalated() {
    if (typeof this.elevation !== 'function') {
      throw new Error('需要管理员权限解除系统断流，但当前环境无法请求提权');
    }
    // 提权器可能返回 { code, output } 或直接返回数字；失败时抛出的异常
    // 里带有 helper 的真实错误信息。
    let result;
    try {
      result = await this.elevation(this.command[0], [...this.command.slice(1), 'unlock']);
    } catch (e) {
      // 提权器已经带了 helper 的真实原因（如"状态不完整"），直接透出，
      // 不要用笼统的"防火墙错误"覆盖掉。
      throw e;
    }
    const code = typeof result === 'number' ? result : (result?.code ?? 0);
    if (code !== 0) throw new Error(`解除系统断流失败（提权进程退出码 ${code}）`);
    const value = await this.status();
    if (value.locked || value.complete === false) {
      // 状态不完整时把 helper 说的具体原因带出来，
      // 而不是只说"没解干净"让用户无从下手。
      const detail = value.errors?.length ? `：${value.errors.join('；')}` : '';
      throw new Error(`Guard unlock left filters installed or incomplete${detail}`);
    }
    return value;
  }
}
