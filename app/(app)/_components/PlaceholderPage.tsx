import { PageHeading } from './PageHeading';

import styles from './PlaceholderPage.module.css';

export type PlaceholderPageProps = {
  /** 页面标题，同时用于文档标题（各页的 `metadata`）。 */
  readonly title: string;
  /** 一句归属说明：这个页面由哪个任务交付。 */
  readonly note: string;
};

/**
 * 占位页正文（UI-003；UI-004 起标题改由 `PageHeading` 承担）。
 *
 * ## 为什么只写「建设中」而不放示例数据
 *
 * §3.2 的要求：占位页**明示「建设中」、不伪造内容**。摆一份假的任务列表看起来
 * 很完整，但它会被当成已实现的功能——而这正是"占位页"最不该造成的误会。
 *
 * ## 为什么不用 `EmptyState`
 *
 * 看起来它是"空状态"，但 `EmptyState` 的语义是**数据为空**（"还没有任务，
 * 去新建一个"）。这里的真相是"这个页面还没做"。UI-004 把五个页面改成了真实
 * 状态页（数据真的为空），而 `settings` 仍在"还没做"这一档——它没有对应的
 * 数据域，也没有纳入 UI-004 的六条场景，所以继续用本组件。
 */
export function PlaceholderPage({ title, note }: PlaceholderPageProps) {
  return (
    <>
      <PageHeading>{title}</PageHeading>
      <p className={styles.status}>建设中</p>
      <p className={styles.note}>{note}</p>
    </>
  );
}
