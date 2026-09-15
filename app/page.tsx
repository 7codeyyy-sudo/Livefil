import { clientEnv } from '@/shared/validation/env.client';

/**
 * 占位首页。
 *
 * 本页面唯一的作用是证明 Next.js App Router 与路径别名 `@/*` 可正常工作，
 * 并作为 `dev` / `build` / `start` 验收的探针。
 *
 * 视觉令牌、布局与业务页面分别属于 UI-001 至 UI-007，本任务刻意不实现任何样式与业务。
 */
export default function HomePage() {
  return (
    <main>
      <h1>{clientEnv.appName}</h1>
      <p>工程骨架已就绪（FND-001）。业务页面将在 UI-001 至 UI-007 中实现。</p>
    </main>
  );
}
