/**
 * Vitest 集成测试的全局初始化（FND-003）。
 *
 * 只被 `integration` project 引用（见 `vitest.config.ts`）：`unit` project 跑纯逻辑，
 * 不需要 DOM，也不该被这些浏览器断言污染。
 */
import '@testing-library/jest-dom/vitest';

import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

// 每个用例结束后卸载已渲染的组件树。
// React Testing Library 的自动清理依赖全局 `afterEach`（即 Vitest 的 globals 模式）；
// 本项目刻意不开启 globals——显式注册让「渲染出来的东西需要被清理」这件事在代码里可见，
// 而不是依赖一个隐式开关。
afterEach(() => {
  cleanup();
});
