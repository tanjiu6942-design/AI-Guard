import type { CheckResult } from './types.js';

/** 一个进程的最小信息: 名字 + 可选标识(命令行或 PID) */
export interface ProcInfo {
  name: string;
  cmd?: string;
  pid?: number;
}

export type ProcessLister = () => Promise<ProcInfo[]>;

const OTHER_TUN = /clash|mihomo|v2ray|xray|sing-?box|hysteria|tuic|wireguard|openvpn|surge|quantumult/i;

/**
 * 代理冲突检测。
 *
 * 必须排除 AI Guard 自己启动的 mihomo —— 它同样叫 mihomo.exe,
 * 不排除的话每次体检都会把自己报成"冲突"(曾经的 bug)。
 *
 * 不能靠命令行排除: 内核以管理员权限运行, 普通权限查询 Win32_Process
 * 的 CommandLine 会返回空(Windows 权限隔离, 实测如此)。
 * 所以改由调用方传入 ownPids —— 通过监听端口反查得到, 不需要提权。
 */
export async function checkConflict(
  list: ProcessLister,
  ownPids: number[] = [],
): Promise<CheckResult> {
  try {
    const procs = await list();
    const ownSet = new Set(ownPids);
    const candidates = procs.filter((p) => OTHER_TUN.test(p.name));

    const isOwn = (p: ProcInfo) => p.pid !== undefined && ownSet.has(p.pid);
    const others = candidates.filter((p) => !isOwn(p));
    const own = candidates.filter(isOwn);

    if (others.length === 0) {
      return {
        key: 'conflict',
        title: '代理冲突',
        state: 'ok',
        detail: own.length
          ? '未检测到其他代理客户端 (仅 AI Guard 自身内核在运行)'
          : '未检测到其他代理客户端',
      };
    }

    const names = [...new Set(others.map((p) => p.name))];
    return {
      key: 'conflict',
      title: '代理冲突',
      state: 'warn',
      detail: `检测到 ${names.join('、')} 在运行, 流量会先经过它`,
    };
  } catch {
    return {
      key: 'conflict',
      title: '代理冲突',
      state: 'unknown',
      detail: '无法枚举进程',
    };
  }
}
