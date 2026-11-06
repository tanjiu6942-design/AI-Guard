import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.{ts,js}'],
    environment: 'node',
    /**
     * 单元测试里禁用启动前置门。
     *
     * `service.start` / `service.resumeProtection` 会调用 ensureNetworkReady()，
     * 那会向三个公网端点真的发 HTTP 请求（每个超时 6s）。在测试里跑真实网络
     * 既慢又不稳定 —— 实测使 desktop.test.js 的用例反复在 5s 上限上 flaky。
     *
     * 前置门自身的逻辑由 tests/preflight*.test.js 用注入的 fetchFn 覆盖，
     * 那条路径不依赖真实网络。
     */
    env: {
      AIGUARD_SKIP_PREFLIGHT: '1',
    },
  },
});
