import { describe, it, expect } from 'vitest';
import type { Mode } from '../core/config/types';

describe('脚手架', () => {
  it('类型定义可导入', () => {
    const mode: Mode = 'strict';
    expect(mode).toBe('strict');
  });
});
