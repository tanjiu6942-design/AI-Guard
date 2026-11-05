import { it, expect } from 'vitest';
import { collectProtectionDiagnostics } from '../desktop/protection-diagnostics.mjs';
it('records useful group and guard state without credentials', async () => {
  const result = await collectProtectionDiagnostics({
    controller: async () => ({ proxies: { 'AI Guard 专用': { type: 'Fallback', now: 'residential', all: ['residential'], password: 'SECRET' } } }),
    guard: { status: async () => ({ locked: true, complete: true, filterCount: 4, secret: 'SECRET' }) },
  });
  expect(result.groups['AI Guard 专用'].now).toBe('residential');
  expect(result.guard.locked).toBe(true);
  expect(JSON.stringify(result)).not.toContain('SECRET');
});
