import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

// 组件测试统一在用例结束后卸载，避免上一个用例的 DOM 被下一个用例查到
afterEach(() => {
  cleanup();
});
