import styles from './Skeleton.module.css';

export type SkeletonProps = {
  /** CSS 长度值（如 `'60%'`、`'12rem'`）。默认铺满可用宽度。 */
  readonly width?: string | undefined;
  /** CSS 长度值（如 `'1.5em'`）。默认一行文字的高度。 */
  readonly height?: string | undefined;
};

/**
 * 骨架块（《UI 页面规范》v0.11 §4.6，与 `LoadingState` 同模块）。
 *
 * ## 它为什么不算第四个状态组件
 *
 * 它不表达状态，只是一种**形状原语**：调用方用若干个它拼出与真实内容同形的
 * 轮廓，再放进 `LoadingState` 里。真正的状态语义（`role="status"`、
 * `aria-busy`、加载说明）全在 `LoadingState` 那一层。
 *
 * ## 为什么不做 `shape="paragraph" | "list"` 预设
 *
 * 预设引擎要覆盖多少种内容形状才够用，是个无法收敛的问题（标题多长？
 * 几行？有没有缩略图？），而每一档预设都是一段没人验证的分支。调用方用
 * 间距令牌在几行 JSX 里拼出来，比配置一个预设引擎更短也更准。
 * （同批次 2 拒绝 Badge 的 accent 变体的同一条理由。）
 *
 * ## 为什么只有一档圆角
 *
 * §4.6 冻结的是 `--radius-sm` 单一取值：骨架是文字行的占位，圆角档位不是
 * 它当前的变化维度。等出现真实的块状骨架消费者，再连同规范一起加档——
 * 不为「可能用上」预造第二个取值（同 Badge accent 的口径）。
 *
 * ## 尺寸走内联样式、圆角走令牌类
 *
 * 宽高是**布局量**，每个使用点都不同，内联传入是唯一不用给每个尺寸造令牌的做法；
 * 圆角是**设计取值**，在样式类里引用 §2.4 令牌——写成内联的
 * `borderRadius: '8px'` 会直接撞上纪律扫描（它也禁内联样式里的数字圆角）。
 */
export function Skeleton({ width, height }: SkeletonProps) {
  return (
    // `aria-hidden`：骨架是纯视觉占位，读屏用户由 LoadingState 的那句
    // 视觉隐藏说明来交代「正在加载」，不该再听一串空元素的停顿。
    <span
      className={styles.skeleton}
      aria-hidden="true"
      style={{ width: width ?? undefined, height: height ?? undefined }}
    />
  );
}
