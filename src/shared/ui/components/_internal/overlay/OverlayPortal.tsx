'use client';

import { createPortal } from 'react-dom';
import type { MouseEvent, ReactNode } from 'react';

import styles from './OverlayPortal.module.css';
import type { OverlayPhase } from './use-delayed-unmount';

/**
 * 遮罩内部的对齐方式（浮层内部基建，批次 3b 新增；UI-003 加第三个落点）。
 *
 * 三档落点，**仍刻意不做成通用的"位次引擎"**：本项目模态浮层只有三种落点——
 * 居中（Modal / ConfirmDialog）、贴右（Drawer 详情编辑）、贴左（UI-003 的
 * 移动端导航抽屉）。§4.5 冻结 Drawer 时明确写过「原型那个左滑物是移动端导航
 * sidebar，归 UI-003 外壳」，`edge-left` 正是那个消费者到位。
 *
 * 加它而不是给 Drawer 加方向参数：落点是**遮罩的对齐方式**，属于这里；
 * 而 Drawer 组件的职责是"右侧详情编辑抽屉"，不该为导航抽屉负责。
 *
 * 三档的差异不只是对齐，还有**遮罩的时长**：居中浮层要「稳稳地出现」，
 * 用 `--duration-slow`；两个贴边抽屉都是位移，用 `--duration-base`——
 * 否则面板已经滑到位、遮罩还要再淡一段，收尾处会看出两截感。
 */
export type OverlayLayout = 'center' | 'edge' | 'edge-left';

export type OverlayPortalProps = {
  /** 是否留在 DOM 里（由 `useDelayedUnmount` 决定，退场动画播完才为 false）。 */
  readonly mounted: boolean;
  readonly phase: OverlayPhase;
  /** 面板落点。默认 `center`；Drawer 传 `edge`；移动端导航抽屉传 `edge-left`。 */
  readonly layout?: OverlayLayout | undefined;
  /** 点击遮罩**本身**（而非面板）时触发，语义是「关闭」。 */
  readonly onScrimClick: () => void;
  /** 面板。挂 `data-state` 与 `onTransitionEnd` 由调用方负责——见下方注释。 */
  readonly children: ReactNode;
};

/**
 * 浮层的挂载容器（浮层内部基建，批次 3a；批次 3b 加 `edge`，UI-003 加 `edge-left`）。
 *
 * ## 为什么挂到 `document.body`
 *
 * 浮层如果留在原来的 DOM 位置，会被祖先的 `overflow: hidden`、`transform`、
 * `filter` 裁掉或改变定位基准（`transform` 会把 `position: fixed` 的包含块
 * 变成那个祖先）——这类问题在「卡片里放个带变换的容器」时就会冒出来，
 * 而且现象是"弹窗跑到奇怪的位置"，很难一眼归因。挂到 body 一劳永逸。
 *
 * ## 为什么不在这一层接 `onTransitionEnd`
 *
 * 延迟卸载必须由**面板自己**的过渡结束来驱动，而面板是 `children`。
 * 如果把事件接在遮罩根上，`event.target !== event.currentTarget` 这条判据
 * （用来挡住子元素过渡的冒泡）会把面板的过渡也一并挡掉，元素就永远不卸载。
 * 所以事件归属调用方：面板上挂 `onTransitionEnd={handleTransitionEnd}`。
 *
 * ## 服务端守卫为什么不用 `useEffect + useState`
 *
 * 常见写法是 `useEffect(() => setIsClient(true), [])`，但那是**在 effect 里同步
 * setState**，会多一次级联渲染（React 的 `set-state-in-effect` 规则直接报错）。
 * 直接判 `typeof document === 'undefined'` 更简单，也更贴近这里的真实需求：
 * 服务端没有 `document`，`createPortal` 无处可挂。
 *
 * 代价是「初始就 open」的浮层会有水合不一致。这在 Livefil 里不会发生——
 * 浮层一律由用户交互打开，首屏不存在已经打开的弹窗。
 *
 * 本组件只负责「挂到 body」+「遮罩层」两件事。
 */
export function OverlayPortal({
  mounted,
  phase,
  layout = 'center',
  onScrimClick,
  children,
}: OverlayPortalProps) {
  if (typeof document === 'undefined' || !mounted) {
    return null;
  }

  function handleClick(event: MouseEvent<HTMLDivElement>): void {
    // 只有点在遮罩**本身**上才关闭。点在面板里再冒泡上来时
    // target 是面板内的元素，currentTarget 才是遮罩，两者不等。
    if (event.target === event.currentTarget) {
      onScrimClick();
    }
  }

  return createPortal(
    <div
      className={styles.root}
      // 遮罩没有语义角色（点击关闭属于"便利路径"，键盘用户走 ESC），
      // 但测试需要一个精确的落点来验证「点遮罩关闭 / 点面板不关闭」这条分界。
      // 用 data 属性而不是类名：CSS Modules 的类名带哈希，测试不该依赖它。
      data-overlay-scrim="true"
      data-state={phase}
      data-layout={layout}
      onClick={handleClick}
    >
      {children}
    </div>,
    document.body,
  );
}
