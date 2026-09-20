import styles from './PlaceholderPage.module.css';

export type PlaceholderPageProps = {
  /** 页面标题，同时用于文档标题（各页的 `metadata`）。 */
  readonly title: string;
  /** 一句归属说明：这个页面由哪个任务交付。 */
  readonly note: string;
};

/**
 * 占位页正文（UI-003）。
 *
 * ## 为什么单独抽一个组件
 *
 * 六个占位页的差别只有标题与那句说明。把它写六遍，等于把「页标题该用哪一档
 * 字号、说明该用什么颜色」这套判断复制成六份，任何一份改了另外五份就漂移。
 *
 * ## 为什么只写「建设中」而不放示例数据
 *
 * v0.12 §3.2 的要求：占位页**明示「建设中」、不伪造内容**。摆一份假的任务
 * 列表看起来很完整，但它会被当成已实现的功能——而这正是"占位页"最不该
 * 造成的误会。
 *
 * ## 为什么不用 `EmptyState`
 *
 * 看起来它是"空状态"，但 `EmptyState` 的语义是**数据为空**（"还没有任务，
 * 去新建一个"）。这里的真相是"这个页面还没做"。用空状态组件会同时在语义与
 * 视觉上把两件事说成一件，而且「状态组件接进页面」本身就是 UI-004 的范围。
 */
export function PlaceholderPage({ title, note }: PlaceholderPageProps) {
  return (
    <>
      <h1 className={styles.title}>{title}</h1>
      <p className={styles.status}>建设中</p>
      <p className={styles.note}>{note}</p>
    </>
  );
}
