// 所有模块共享的常量。放在独立文件避免 groups.ts ↔ rules.ts 互相导入。
export const G_AI = 'AI Guard 专用';
export const G_PROXY = '普通代理';
export const G_FRONT = 'AI Guard 前置';
export const G_AUTO = 'AI Guard 自动选择';

export const TEST_URL = 'https://www.gstatic.com/generate_204';
// 前置握手 + SOCKS5 认证 + TLS 三段, 跨洋约 2 秒; 5 秒会在晚高峰误判不可用
export const CHAIN_TIMEOUT = 10000;
