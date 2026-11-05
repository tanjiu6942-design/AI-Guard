import type { CheckResult } from './types.js';

/**
 * WebRTC 防泄漏判定。
 *
 * WebRTC 走 UDP 打洞, 完全绕过 HTTP 代理, 代理层拦不住——只能靠内核规则
 * REJECT 掉 STUN 端口 (3478/5349/19302-19309)。
 *
 * 所以 "STUN 探测不到" 有两种含义:
 *   (a) UDP 被规则拦了 → 浏览器拿不到真实 IP → 这是**防护生效**, 判 ok
 *   (b) 网络本身不通 → 无法判断 → 判 unknown
 *
 * 单看 STUN 结果分不清 (a) 和 (b), 需要调用方告知网络是否通 (networkOk)。
 * 网络通 + STUN 不通 = 被拦住了 = ok。
 */
export async function checkWebrtc(
  observedIp: string | null,
  expectedIp: string,
  networkOk = false,
  tunEnabled = false,
): Promise<CheckResult> {
  if (!observedIp) {
    if (networkOk) {
      return {
        key: 'webrtc',
        title: 'WebRTC 防泄漏',
        state: 'ok',
        detail: '本次 STUN 探测未返回公网地址，联网探测正常；浏览器其他 WebRTC 路径仍需单独验证',
      };
    }
    return {
      key: 'webrtc',
      title: 'WebRTC 防泄漏',
      state: 'unknown',
      detail: 'STUN 探测未取得结果, 且网络状态未知, 无法判断',
    };
  }
  if (expectedIp && observedIp === expectedIp) {
    return {
      key: 'webrtc',
      title: 'WebRTC 防泄漏',
      state: 'ok',
      detail: `WebRTC 看到的也是你的独享 IP ${observedIp}`,
    };
  }
  // 非 TUN 模式下 STUN 的 UDP 包不经过代理端口, 规则拦不住, 泄漏是必然的。
  // 这不是配置错误, 而是架构限制 —— 如实告知, 并明确指出解法是开 TUN。
  return {
    key: 'webrtc',
    title: 'WebRTC 防泄漏',
    state: 'fail',
    detail: tunEnabled
      ? `WebRTC 看到 ${observedIp}, 不是你的独享 IP。TUN 已开但 STUN 未被拦, 检查规则是否生效`
      : `WebRTC 看到 ${observedIp}。当前未开 TUN, UDP 直发不经过代理, 规则拦不住 —— 开 TUN 模式后才能拦截`,
  };
}
