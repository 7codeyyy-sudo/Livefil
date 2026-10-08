'use client';

import { usePathname } from 'next/navigation';
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { Button } from '@/shared/ui/components';

import { tourEyebrow, tourPageKeyForPath, tourStepsForPage } from '../_lib/guide/tour-steps';

import { useGuideTourContext } from './GuideTourProvider';
import styles from './GuideTourLayer.module.css';

/**
 * 全屏新手导览层
 * （《UI 页面规范》v0.25「新手引导形态升版补节」，AI-007）。
 *
 * ## 它做什么
 *
 * 分页触发的逐页签导览：当前页签**首次落到成功态**（首枚锚点出现在 DOM）后
 * 自动开启本页导览；逐步高亮锚点（单个高亮框挖空 + 巨型 `box-shadow` 暗化四周 +
 * SVG 箭头 + 标注卡）；「我知道了」推进、本页走完即记该页「已看过」；「跳过引导」
 * 或 `Esc` 一次性终止整个导览（§ C）。
 *
 * ## 为什么经 `createPortal` 挂 `document.body`
 *
 * 与既有 `OverlayPortal` 同一条理由（脱离祖先的 `overflow`/`transform` 层叠
 * 上下文），但**没有复用 `OverlayPortal`**：它自带 `--z-scrim` 遮罩底色与
 * `position: fixed` 根节点，会（a）与「单个高亮框承载挖空、四周由巨型
 * `box-shadow` 暗化」形成**双重暗化**，（b）把内部层级关进一个 `z-index: 100`
 * 的层叠上下文里，使 § D 冻结的 `--z-guide`（250，须高于 Modal/Drawer 200）失效。
 * 这里直接渲染自带的 root（`z-index: var(--z-guide)`），层级要求才成立。
 *
 * ## 水合安全
 *
 * 挂载前（`activeIndex === null`）与 SSR 一律返回 `null`——进度只在浏览器读、
 * 导览只由客户端交互 / 观察器开启，首帧树形两端一致。
 *
 * ## 判定落在这里，而不是 Provider
 *
 * § A「分页触发口径」把判定定义为「本页首枚锚点是否出现」。它需要读 DOM 与
 * `usePathname`，只属于这一层；Provider 只持状态与动作（见 `GuideTourProvider`）。
 */

/* ------------------------------------------------------------------ */
/* 几何：移植自形态原型 v5.3（去掉了「避让固定底栏安全区」——本产品移动端 */
/* 导航是左抽屉 `MobileNavDrawer`，没有固定底栏，§ D 冻结「无需避让」）   */
/* ------------------------------------------------------------------ */

type Box = {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
};

type Point = { readonly x: number; readonly y: number };

type Viewport = { readonly width: number; readonly height: number };

type Placement = 'right' | 'left' | 'bottom' | 'top';

/** 高亮框相对目标外扩的量；越界时夹回视口内（§ D：外扩量归实现披露）。 */
const SPOTLIGHT_PADDING = 6;
/** 卡片与高亮框之间的**净距**上限，同时也是箭头可用的最大长度。 */
const CARD_GAP = 56;
/** 箭头尖端与高亮框边缘之间的间隙。 */
const ARROW_TIP_GAP = 10;
/** 箭头起点与卡片边缘之间的间隙。 */
const ARROW_TAIL_GAP = 4;
/** 视口内边距下限。 */
const VIEWPORT_MARGIN = 12;
/** 净距可退让的档位：空间不够时逐档收窄，宁可箭头短一点也别压住高亮区。 */
const CARD_GAPS: readonly number[] = [CARD_GAP, 40, 28];
/** 短于此长度的箭头不画（避免出现戳在边上的小短线）。 */
const MIN_ARROW_LENGTH = 14;
/** 高亮框裁短后的高度下限。 */
const MIN_SPOTLIGHT_HEIGHT = 120;

/** 箭头 `marker` 的 id（层内唯一实例，用静态值——`useId` 含冒号对 `url(#…)` 不友好）。 */
const ARROW_MARKER_ID = 'guide-tour-arrow-head';

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max));
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function boxCenter(box: Box): Point {
  return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
}

/** 从矩形中心朝 `target` 作射线，返回与矩形边界的交点。 */
function boundaryPoint(box: Box, target: Point): Point {
  const center = boxCenter(box);
  const dx = target.x - center.x;
  const dy = target.y - center.y;
  if (dx === 0 && dy === 0) {
    return center;
  }

  const halfWidth = Math.max(box.width / 2, 1);
  const halfHeight = Math.max(box.height / 2, 1);
  const scale = 1 / Math.max(Math.abs(dx) / halfWidth, Math.abs(dy) / halfHeight);
  return { x: center.x + dx * scale, y: center.y + dy * scale };
}

/** 从 `from` 朝 `to` 走 `distance`（不超过两点间距）。 */
function moveToward(from: Point, to: Point, distance: number): Point {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const length = Math.hypot(dx, dy);
  if (length === 0) {
    return from;
  }
  const step = Math.min(distance, length);
  return { x: from.x + (dx / length) * step, y: from.y + (dy / length) * step };
}

/** 二次贝塞尔：弧高随长度增长但有上限，方向固定（观感统一）。 */
function curvePath(tail: Point, tip: Point): string {
  const dx = tip.x - tail.x;
  const dy = tip.y - tail.y;
  const distance = Math.hypot(dx, dy);
  const bow = Math.min(distance * 0.18, 20);
  const control = {
    x: (tail.x + tip.x) / 2 + (-dy / distance) * bow,
    y: (tail.y + tip.y) / 2 + (dx / distance) * bow,
  };
  return `M ${round(tail.x)} ${round(tail.y)} Q ${round(control.x)} ${round(control.y)} ${round(tip.x)} ${round(tip.y)}`;
}

/** 量出高亮框（目标外扩后夹回视口内）。 */
function measureSpotlight(target: Element, viewport: Viewport): Box {
  const rect = target.getBoundingClientRect();
  const left = clamp(
    rect.left - SPOTLIGHT_PADDING,
    VIEWPORT_MARGIN,
    viewport.width - VIEWPORT_MARGIN,
  );
  const top = clamp(
    rect.top - SPOTLIGHT_PADDING,
    VIEWPORT_MARGIN,
    viewport.height - VIEWPORT_MARGIN,
  );
  const right = clamp(
    rect.right + SPOTLIGHT_PADDING,
    VIEWPORT_MARGIN,
    viewport.width - VIEWPORT_MARGIN,
  );
  const bottom = clamp(
    rect.bottom + SPOTLIGHT_PADDING,
    VIEWPORT_MARGIN,
    viewport.height - VIEWPORT_MARGIN,
  );
  return { left, top, width: Math.max(right - left, 0), height: Math.max(bottom - top, 0) };
}

/** 净距档位：低于「能画出可见箭头的最小净距」的档位直接剔除。 */
function gapCandidates(): readonly number[] {
  const minimum = ARROW_TIP_GAP + ARROW_TAIL_GAP + MIN_ARROW_LENGTH;
  return CARD_GAPS.filter((gap) => gap >= minimum);
}

/** 依次试 右 → 左 → 下 → 上，返回第一个放得下卡片的方向；都放不下返回 `null`。 */
function firstFitting(spot: Box, need: Box, gap: number, viewport: Viewport): Placement | null {
  if (spot.left + spot.width + gap + need.width <= viewport.width - VIEWPORT_MARGIN) {
    return 'right';
  }
  if (spot.left - gap - need.width >= VIEWPORT_MARGIN) {
    return 'left';
  }
  if (spot.top + spot.height + gap + need.height <= viewport.height - VIEWPORT_MARGIN) {
    return 'bottom';
  }
  if (spot.top - gap - need.height >= VIEWPORT_MARGIN) {
    return 'top';
  }
  return null;
}

/** 先按净距上限试摆，放不下再逐档收窄；真的一侧都放不下返回 `null`。 */
function choosePlacement(
  spot: Box,
  need: Box,
  viewport: Viewport,
): { readonly placement: Placement; readonly gap: number } | null {
  for (const gap of gapCandidates()) {
    const placement = firstFitting(spot, need, gap, viewport);
    if (placement !== null) {
      return { placement, gap };
    }
  }
  return null;
}

/** 按 `placement` 算出卡片矩形（夹回视口内）。 */
function cardBox(spot: Box, placement: Placement, gap: number, need: Box, viewport: Viewport): Box {
  let left: number;
  let top: number;

  if (placement === 'right') {
    left = spot.left + spot.width + gap;
    top = spot.top + spot.height / 2 - need.height / 2;
  } else if (placement === 'left') {
    left = spot.left - gap - need.width;
    top = spot.top + spot.height / 2 - need.height / 2;
  } else if (placement === 'top') {
    left = spot.left + spot.width / 2 - need.width / 2;
    top = spot.top - gap - need.height;
  } else {
    left = spot.left + spot.width / 2 - need.width / 2;
    top = spot.top + spot.height + gap;
  }

  return {
    left: clamp(left, VIEWPORT_MARGIN, viewport.width - need.width - VIEWPORT_MARGIN),
    top: clamp(top, VIEWPORT_MARGIN, viewport.height - need.height - VIEWPORT_MARGIN),
    width: need.width,
    height: need.height,
  };
}

/**
 * 目标太高、卡片在它上下都放不下时把高亮框**从底边裁短**（不压扁卡片，
 * 保住完整文案与箭头长度）。高亮只表示「这次讲的是这一块」，少圈一截看不出来。
 */
function trimSpotlight(spot: Box, cardHeight: number, viewport: Viewport): Box {
  const maxHeight = viewport.height - VIEWPORT_MARGIN * 2 - cardHeight - CARD_GAP - spot.top;
  return { ...spot, height: Math.max(Math.min(spot.height, maxHeight), MIN_SPOTLIGHT_HEIGHT) };
}

/** 卡片中心 → 高亮框中心连线上取一段带弧度的箭头；太短则不画。 */
function arrowPath(spot: Box, card: Box): string {
  if (spot.width === 0 || spot.height === 0) {
    return '';
  }

  const spotCenter = boxCenter(spot);
  const cardCenter = boxCenter(card);
  const tip = moveToward(boundaryPoint(spot, cardCenter), cardCenter, ARROW_TIP_GAP);
  const tail = moveToward(boundaryPoint(card, spotCenter), spotCenter, ARROW_TAIL_GAP);
  const distance = Math.hypot(tip.x - tail.x, tip.y - tail.y);
  return distance < MIN_ARROW_LENGTH ? '' : curvePath(tail, tip);
}

/** 把矩形写到元素的内联定位/尺寸上。 */
function applyBox(element: HTMLElement, box: Box): void {
  element.style.left = `${String(box.left)}px`;
  element.style.top = `${String(box.top)}px`;
  element.style.width = `${String(box.width)}px`;
  element.style.height = `${String(box.height)}px`;
}

/** 只写卡片位置：宽度由 CSS 定，高度随内容自适应。 */
function applyCardPosition(element: HTMLElement, box: Box): void {
  element.style.left = `${String(box.left)}px`;
  element.style.top = `${String(box.top)}px`;
}

/* ------------------------------------------------------------------ */
/* 组件                                                                */
/* ------------------------------------------------------------------ */

export function GuideTourLayer() {
  const pathname = usePathname();
  const page = tourPageKeyForPath(pathname);
  const { state, reopenRequest, markSeen, skipAll } = useGuideTourContext();

  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  // 供观察器 / 事件回调读到的「最新是否已打开」：不在渲染期写 ref（React 编译器
  // 规则禁止），改由 effect 在提交后同步，避免把 activeIndex 塞进它们的依赖里
  // 反复重装观察器。
  const activeIndexRef = useRef<number | null>(null);

  const cardRef = useRef<HTMLDivElement>(null);
  const spotlightRef = useRef<HTMLDivElement>(null);
  const arrowRef = useRef<SVGPathElement>(null);

  const titleId = useId();
  const textId = useId();

  const pageSteps = useMemo(() => (page === null ? [] : tourStepsForPage(page)), [page]);

  useEffect(() => {
    activeIndexRef.current = activeIndex;
  }, [activeIndex]);

  /**
   * 从 `from` 起找到第一个**锚点存在**的步；都不存在时返回 `pageSteps.length`。
   * 锚点缺失即跳过（§ B），不渲染卡片、不计数、不报错。
   */
  const resolveIndex = useCallback(
    (from: number): number => {
      let index = from;
      while (index < pageSteps.length) {
        const step = pageSteps[index];
        if (step !== undefined && document.querySelector(`[data-tour="${step.anchor}"]`) !== null) {
          return index;
        }
        index += 1;
      }
      return pageSteps.length;
    },
    [pageSteps],
  );

  const finishPage = useCallback(() => {
    setActiveIndex(null);
    if (page !== null) {
      markSeen(page);
    }
  }, [page, markSeen]);

  const advance = useCallback(() => {
    const current = activeIndexRef.current;
    if (current === null) {
      return;
    }
    const next = resolveIndex(current + 1);
    if (next >= pageSteps.length) {
      finishPage();
      return;
    }
    setActiveIndex(next);
  }, [resolveIndex, pageSteps.length, finishPage]);

  const skip = useCallback(() => {
    setActiveIndex(null);
    skipAll();
  }, [skipAll]);

  // 分页触发：本页未看过、且首枚锚点出现（观察器 / 首帧）时自动开启本页导览。
  useEffect(() => {
    if (page === null || state === null) {
      return;
    }
    if (state.skipped || state.seen[page] === true) {
      return;
    }
    if (pageSteps.length === 0) {
      return;
    }

    function tryStart(): void {
      if (activeIndexRef.current !== null) {
        return;
      }
      const start = resolveIndex(0);
      // 首枚锚点还没出现：不开，等观察器下一轮（页面成功态后锚点即到位）。
      if (start >= pageSteps.length) {
        return;
      }
      setActiveIndex(start);
    }

    const frame = requestAnimationFrame(tryStart);
    const observer = new MutationObserver(tryStart);
    observer.observe(document.body, { childList: true, subtree: true });
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [page, state, pageSteps.length, resolveIndex]);

  // 帮助 Drawer 的「重新查看」：只认当前所在页的请求（§ C：重开本页导览）。
  useEffect(() => {
    if (reopenRequest === null || page === null) {
      return;
    }
    const frame = requestAnimationFrame(() => {
      if (reopenRequest.page !== page) {
        return;
      }
      const start = resolveIndex(0);
      if (start >= pageSteps.length) {
        return;
      }
      setActiveIndex(start);
    });
    return () => {
      cancelAnimationFrame(frame);
    };
  }, [reopenRequest, page, pageSteps.length, resolveIndex]);

  // `Esc` ＝跳过引导（§ C，与全局口径同效）。
  useEffect(() => {
    if (activeIndex === null) {
      return;
    }
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === 'Escape') {
        skip();
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [activeIndex, skip]);

  // 摆位与画箭头：目标进入视口 → 量位置 → 摆卡片 / 高亮框 → 画箭头。
  useEffect(() => {
    if (activeIndex === null) {
      return;
    }
    const step = pageSteps[activeIndex];
    if (step === undefined) {
      return;
    }

    const target = document.querySelector<HTMLElement>(`[data-tour="${step.anchor}"]`);
    if (target === null) {
      // 锚点在这次渲染后消失（条件渲染变化）：跳过该步。
      const handle = window.setTimeout(() => {
        advance();
      }, 0);
      return () => {
        window.clearTimeout(handle);
      };
    }

    target.scrollIntoView({ block: 'nearest', inline: 'nearest' });

    // 收窄后的非空别名：`layout` 是闭包，TypeScript 不保留外部变量的收窄结果。
    const anchor: Element = target;

    function layout(): void {
      const card = cardRef.current;
      const spotlight = spotlightRef.current;
      const arrow = arrowRef.current;
      if (card === null || spotlight === null || arrow === null) {
        return;
      }

      const viewport: Viewport = { width: window.innerWidth, height: window.innerHeight };
      const need: Box = {
        left: 0,
        top: 0,
        width: card.offsetWidth,
        height: card.offsetHeight,
      };

      let spot = measureSpotlight(anchor, viewport);
      applyBox(spotlight, spot);

      const choice = choosePlacement(spot, need, viewport);
      if (choice === null) {
        // 目标太高，四方都放不下完整卡片：裁短高亮框再摆。
        spot = trimSpotlight(spot, need.height, viewport);
        applyBox(spotlight, spot);
        const retry = choosePlacement(spot, need, viewport);
        if (retry === null) {
          const fallback = cardBox(spot, 'bottom', VIEWPORT_MARGIN, need, viewport);
          applyCardPosition(card, fallback);
          arrow.setAttribute('d', '');
          return;
        }
        const box = cardBox(spot, retry.placement, retry.gap, need, viewport);
        applyCardPosition(card, box);
        arrow.setAttribute('d', arrowPath(spot, box));
        return;
      }

      const box = cardBox(spot, choice.placement, choice.gap, need, viewport);
      applyCardPosition(card, box);
      arrow.setAttribute('d', arrowPath(spot, box));
    }

    const frame = requestAnimationFrame(() => {
      // 摆好位再显形：否则首帧会看到卡片停在内联初值处（视口左上角）闪一下。
      if (cardRef.current !== null) {
        cardRef.current.style.visibility = 'visible';
      }
      if (spotlightRef.current !== null) {
        spotlightRef.current.style.visibility = 'visible';
      }
      layout();
    });

    window.addEventListener('resize', layout);
    window.addEventListener('scroll', layout, { passive: true });
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('resize', layout);
      window.removeEventListener('scroll', layout);
    };
  }, [activeIndex, pageSteps, advance]);

  if (activeIndex === null || page === null) {
    return null;
  }
  const step = pageSteps[activeIndex];
  if (step === undefined || typeof document === 'undefined') {
    return null;
  }

  return createPortal(
    <div className={styles.root} data-variant="guide-tour">
      <div ref={spotlightRef} className={styles.spotlight} aria-hidden="true" />

      {/* 箭头是替换元素：只写 `inset: 0` 会落回固有尺寸 300×150 并被 UA 默认
          `overflow: hidden` 整条裁掉，必须显式给宽高（§ D 实现披露项）。 */}
      <svg className={styles.arrow} aria-hidden="true" width="100%" height="100%">
        <defs>
          <marker
            id={ARROW_MARKER_ID}
            viewBox="0 0 12 12"
            refX="9"
            refY="6"
            markerWidth="7"
            markerHeight="7"
            orient="auto"
          >
            <path className={styles.arrowHead} d="M 1 1.6 L 11 6 L 1 10.4 Z" />
          </marker>
        </defs>
        <path
          ref={arrowRef}
          className={styles.arrowLine}
          d=""
          markerEnd={`url(#${ARROW_MARKER_ID})`}
        />
      </svg>

      <div
        ref={cardRef}
        className={styles.card}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={textId}
      >
        <div className={styles.body}>
          <p className={styles.eyebrow}>{tourEyebrow(page, activeIndex + 1)}</p>
          <h2 id={titleId} className={styles.title}>
            {step.title}
          </h2>
          <p id={textId} className={styles.text}>
            {step.text}
          </p>
        </div>

        <div className={styles.footer}>
          <Button variant="ghost" onClick={skip}>
            跳过引导
          </Button>
          <Button variant="primary" onClick={advance}>
            我知道了
          </Button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
