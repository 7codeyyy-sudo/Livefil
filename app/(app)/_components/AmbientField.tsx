/**
 * 环境层（UI-012，《UI 页面规范》v0.29 §3.4 环境层追加）。
 *
 * ## 两层都是**纯装饰**，不承载任何信息
 *
 * 两层都 `aria-hidden` + `pointer-events: none`，且都是静态绘制（零循环）：
 * - **噪声**：全站极淡颗粒（亮 `multiply` / 暗 `soft-light`），表达「材质」；
 * - **窗格光**：右上斜射的环境光（光斑 + 窗框缝 + 叶影）——层在内容之下
 *   （`--z-background`，与装饰背景同级），卡片有实底，光只在页面底色的空白区
 *   可见：物理上不可能压到任何文字。
 *
 * ## 为什么窗格光的「缝」用页面底色画
 *
 * `.window` 的三层叠加里，窗框缝与叶影是**用 `--color-bg-page` 把光遮掉**
 * 画出来的，而不是再加一层深色——这样两态自动换色（底色变了遮法跟着变），
 * 也不会引入「第二套颜色」。
 *
 * 本组件无状态、无交互，保持服务端组件（只输出两个固定图层）。
 */

import styles from './AmbientField.module.css';

export function AmbientField() {
  return (
    <>
      <div className={styles.noise} aria-hidden="true" />
      <div className={styles.dapple} aria-hidden="true">
        <span className={styles.window} />
        <span className={`${styles.leaf} ${styles.leaf1}`} />
        <span className={`${styles.leaf} ${styles.leaf2}`} />
        <span className={`${styles.leaf} ${styles.leaf3}`} />
      </div>
    </>
  );
}
