import styles from './Progress.module.css';

export type ProgressProps = {
  /**
   * 完成百分比，取值范围 **0–100**。
   *
   * 越界不是「夹紧一下就好」：静默纠正会把上游的计算错误藏起来——
   * 用户实际完成 60% 却看到 100%，而这种「看起来正常」的缺陷最难被发现。
   * 因此这里显式抛错，让错误在开发期暴露。
   */
  readonly value: number;
  /**
   * 无障碍名称——**必填**。
   *
   * 进度条没有可见文字，缺了它读屏用户只会听到「进度条」。设成必填是
   * 唯一能保证它不被漏掉的做法（同 IconButton 的 `label`）。
   */
  readonly label: string;
  /**
   * 是否同时把百分比显示成可见文字。
   *
   * §5 要求「不把进度条做成唯一的成功反馈」，所以使用场景里通常还有文字说明；
   * 这个开关是给「只有进度条、没有配套文字」的位置用的。
   */
  readonly showValue?: boolean | undefined;
};

/** 进度条的取值范围。抽成常量而不是散写，避免三处数字漂移。 */
const MIN_VALUE = 0;
const MAX_VALUE = 100;

/**
 * 进度条（《UI 页面规范》§2.4 的「进度」语义色消费者）。
 *
 * 刻意不带 `'use client'`：它没有任何交互，可以在服务端渲染的页面里直接使用。
 *
 * 为什么不用原生 `<progress>`：它的内部结构由浏览器绘制，跨浏览器无法统一
 * 成原型已验收的 6px 细线形态（Safari 与 Chrome 的 `::-webkit-progress-*`
 * 支持差异很大）。这里用 `role="progressbar"` 表达同样的语义，同时保留
 * 对视觉的完全控制——无障碍树上的结果是一致的。
 */
export function Progress({ value, label, showValue = false }: ProgressProps) {
  if (!Number.isFinite(value) || value < MIN_VALUE || value > MAX_VALUE) {
    throw new RangeError(
      `Progress 的 value 必须是 ${String(MIN_VALUE)}–${String(MAX_VALUE)} 之间的有限数，收到 ${String(value)}`,
    );
  }

  // 显示值与朗读值保持同一个数：`aria-valuenow` 报 58.33 而屏幕上写 58
  // 会让「读屏听 58.33 / 同事说 58%」对不上。
  const percent = Math.round(value);

  return (
    <div className={styles.wrapper}>
      <div
        className={styles.track}
        role="progressbar"
        aria-label={label}
        aria-valuenow={percent}
        aria-valuemin={MIN_VALUE}
        aria-valuemax={MAX_VALUE}
      >
        {/* 宽度是运行期数据，无法用 CSS 静态表达，只能内联。
            它不是「写死的取值」，因此不违反令牌纪律（扫描器只拦颜色/圆角/字号）。 */}
        <span className={styles.fill} style={{ width: `${String(percent)}%` }} />
      </div>
      {showValue ? <span className={styles.value}>{percent}%</span> : null}
    </div>
  );
}
