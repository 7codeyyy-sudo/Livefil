'use client';

import { useEffect, useRef } from 'react';

import type { BackgroundChoice } from './BackgroundField.types';
import {
  advanceRipples,
  ageShears,
  CELL24,
  CELL24_EDGES,
  CELL_LIGHT,
  CELL_VIEW,
  cellDepthRatio,
  clamp01,
  CLIFFORD_FAMILY_COUNT,
  CLIFFORD_LINES,
  CLIFFORD_VIEW,
  cliffordDepthRatio,
  CLICK_SLOP,
  convexHull,
  CUBE4,
  fitAll,
  HOPF_LINES,
  HOPF_VIEW,
  hopfDepthRatio,
  lift,
  projectPoints,
  ripplePoints,
  rippleReach,
  SHEAR_LIFE,
  shearField,
  STOP_HOLD,
  STOP_RECOVER,
  STOP_SUPPRESS,
  TESSERACT_EDGES,
  TESSERACT_STYLE,
  TESSERACT_VIEW,
  tesseractDepthRatio,
  toPolylineString,
} from './background-scenes';
import type { Ripple, ShearEvent } from './background-scenes';
import styles from './BackgroundField.module.css';

/** 只有这一个 prop：几何档位由应用层（读 `localStorage` 的容器）决定。 */
export type BackgroundFieldProps = {
  readonly choice: BackgroundChoice;
};

const SVG_NS = 'http://www.w3.org/2000/svg';
/** 指针联动只在「有真指针」的设备上开：触屏上没有悬停可言。 */
const HOVER_QUERY = '(hover: hover) and (pointer: fine)';
const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';

/**
 * 逐帧动画的**可变状态**。
 *
 * 放在 ref 里而不是 React state：这些值每帧都变，走 `setState` 会把 60fps 的
 * 帧循环变成 60 次重渲染。放在一起还让「切几何时哪些该延续、哪些该重置」一目
 * 了然——`spin`（自转角）与指针位置跨几何延续，`reveal`（入场淡入）在每次切换
 * 时归零。
 */
type AnimationState = {
  spin: number;
  lastFrame: number;
  freeze: number;
  stopHold: number;
  targetX: number;
  targetY: number;
  currentX: number;
  currentY: number;
  reveal: number;
  ripples: Ripple[];
  shears: ShearEvent[];
  pressed: boolean;
  moved: boolean;
  downX: number;
  downY: number;
};

/** 指针初始落在偏右下（0.6 / 0.62），与几何的构图方向一致。 */
function createInitialState(): AnimationState {
  const initialX = window.innerWidth * 0.6;
  const initialY = window.innerHeight * 0.62;
  return {
    spin: 0,
    lastFrame: 0,
    freeze: 0,
    stopHold: 0,
    targetX: initialX,
    targetY: initialY,
    currentX: initialX,
    currentY: initialY,
    reveal: 0,
    ripples: [],
    shears: [],
    pressed: false,
    moved: false,
    downX: 0,
    downY: 0,
  };
}

function createSvgElement(
  name: string,
  attrs?: Readonly<Record<string, string | undefined>>,
): SVGElement {
  const node = document.createElementNS(SVG_NS, name);
  if (attrs !== undefined) {
    for (const key of Object.keys(attrs)) {
      node.setAttribute(key, attrs[key] ?? '');
    }
  }
  return node;
}

/** 批量建同一形状的元素并挂到 svg 下，返回按顺序的引用（逐帧写属性用）。 */
function appendElements(
  svg: SVGSVGElement,
  name: string,
  count: number,
  attrs: Readonly<Record<string, string | undefined>> = {},
): SVGElement[] {
  return Array.from({ length: count }, () => {
    const node = createSvgElement(name, attrs);
    svg.appendChild(node);
    return node;
  });
}

/* 两层影子（本影 + 半影）：单层模糊总像贴纸，真实光照下影子是本影加半影。两者
   共用同一条凸包轮廓，只是模糊半径与浓度不同。filter 的 id 必须全局唯一，所以每
   个几何各带一个前缀。 */
function appendShadow(svg: SVGSVGElement, prefix: string): { soft: SVGElement; core: SVGElement } {
  const defs = createSvgElement('defs');
  const specs: readonly (readonly [string, string, readonly [string, string, string, string]])[] = [
    ['core', '2.5', ['-20%', '-55%', '140%', '210%']],
    ['soft', '9', ['-30%', '-70%', '160%', '240%']],
  ];
  for (const [suffix, blur, spread] of specs) {
    // 滤镜区域要比图形大一圈，否则模糊会被自己裁掉一圈边。
    const filter = createSvgElement('filter', {
      id: `${prefix}-${suffix}`,
      x: spread[0],
      y: spread[1],
      width: spread[2],
      height: spread[3],
    });
    filter.appendChild(createSvgElement('feGaussianBlur', { stdDeviation: blur }));
    defs.appendChild(filter);
  }
  svg.appendChild(defs);

  const soft = createSvgElement('polygon', {
    class: styles.hullSoft,
    'fill-opacity': '0',
    filter: `url(#${prefix}-soft)`,
  });
  svg.appendChild(soft);
  const core = createSvgElement('polygon', {
    class: styles.hullCore,
    'fill-opacity': '0',
    filter: `url(#${prefix}-core)`,
  });
  svg.appendChild(core);
  return { soft, core };
}

type SceneRenderer = (spin: number, pointerX: number, pointerY: number) => void;

/* ── 超立方体 · 线框款（16 顶点 32 棱，带地面投影与柱线）───────────────────
   图层顺序 = 绘制顺序：影子 → 柱线 → 棱 → 节点 → 外环，先落地的先建元素，这样线
   自然压在影子上面。 */
function createTesseractScene(svg: SVGSVGElement, state: AnimationState): SceneRenderer {
  const shadow = appendShadow(svg, 'tet');
  const pillars = appendElements(svg, 'line', CUBE4.length, {
    class: styles.pillar,
    'stroke-opacity': '0.5',
  });
  const lines = appendElements(svg, 'line', TESSERACT_EDGES.length, {
    'stroke-opacity': '0.3',
    'stroke-width': '1.5',
  });
  const nodes = appendElements(svg, 'circle', CUBE4.length, { r: '3', 'fill-opacity': '0.5' });
  const halos = appendElements(svg, 'circle', CUBE4.length, {
    class: styles.halo,
    r: '6',
    'stroke-opacity': '0',
  });

  return (spin, pointerX, pointerY) => {
    // 指针直接映射两个四维平面的转角，另叠一层很慢的自转；同一组 nx / ny 兼作
    // 虚拟光源的方向，所以指针是「转动物体 + 移动光源」两件事。
    const angleXW = 0.86 + spin * 0.00021 + pointerX * 1.15;
    const angleYZ = 0.42 + spin * 0.00015 + pointerY * 1.15;
    const lightX = pointerX * TESSERACT_STYLE.light;
    const lightZ = pointerY * TESSERACT_STYLE.light;

    // 四维剪切要走两趟：先空投拿到屏幕位置，再按「离落点多远」逐点剪、重投第二次。
    let points = projectPoints(CUBE4, angleXW, angleYZ, TESSERACT_VIEW, lightX, lightZ);
    const shear = shearField(points, state.shears);
    if (shear !== null) {
      points = projectPoints(CUBE4, angleXW, angleYZ, TESSERACT_VIEW, lightX, lightZ, shear);
    }
    fitAll(points, TESSERACT_VIEW.cx, TESSERACT_VIEW.cy);
    const boosts = ripplePoints(points, state.ripples);

    // 影子：轮廓每帧重算，物体转影子跟着变；半影与本体共用这一条轮廓。
    if (TESSERACT_STYLE.hull > 0) {
      const hull = convexHull(points.map((point) => ({ x: point.groundX, y: point.groundY })));
      const outline = hull.map((point) => `${point.x.toFixed(1)},${point.y.toFixed(1)}`).join(' ');
      shadow.soft.setAttribute('points', outline);
      shadow.core.setAttribute('points', outline);
      shadow.soft.setAttribute('fill-opacity', TESSERACT_STYLE.hull.toFixed(3));
      shadow.core.setAttribute('fill-opacity', (TESSERACT_STYLE.hull * 0.45).toFixed(3));
    } else {
      shadow.soft.setAttribute('points', '');
      shadow.core.setAttribute('points', '');
    }

    // 柱线把「物体」和「地面」连起来——物体才「立」得住，而不是飘着。
    points.forEach((point, index) => {
      const pillar = pillars[index];
      if (pillar === undefined) return;
      pillar.setAttribute('x1', point.x.toFixed(1));
      pillar.setAttribute('y1', point.y.toFixed(1));
      pillar.setAttribute('x2', point.groundX.toFixed(1));
      pillar.setAttribute('y2', point.groundY.toFixed(1));
      pillar.setAttribute('stroke-opacity', String(TESSERACT_STYLE.pillar));
    });

    TESSERACT_EDGES.forEach(([i, j], index) => {
      const a = points[i];
      const b = points[j];
      const line = lines[index];
      if (a === undefined || b === undefined || line === undefined) return;
      const ratio = tesseractDepthRatio((a.depth + b.depth) / 2);
      const boost = ((boosts[i] ?? 0) + (boosts[j] ?? 0)) / 2;
      line.setAttribute('x1', a.x.toFixed(1));
      line.setAttribute('y1', a.y.toFixed(1));
      line.setAttribute('x2', b.x.toFixed(1));
      line.setAttribute('y2', b.y.toFixed(1));
      line.setAttribute(
        'stroke-opacity',
        lift(TESSERACT_STYLE.edge[0] + ratio * TESSERACT_STYLE.edge[1], boost * 0.9).toFixed(3),
      );
      // 近粗远细：单靠透明度分不出前后，粗细才分得出。
      line.setAttribute(
        'stroke-width',
        (TESSERACT_STYLE.edgeWidth[0] + ratio * TESSERACT_STYLE.edgeWidth[1] + boost * 0.9).toFixed(
          2,
        ),
      );
    });

    // 半径与填充都随深度走：最近的那几个顶点接近实心，最远的只是个小点。
    points.forEach((point, index) => {
      const ratio = tesseractDepthRatio(point.depth);
      const boost = boosts[index] ?? 0;
      const x = point.x.toFixed(1);
      const y = point.y.toFixed(1);
      const radius =
        TESSERACT_STYLE.nodeRadius[0] + ratio * TESSERACT_STYLE.nodeRadius[1] + boost * 1.6;

      const dot = nodes[index];
      if (dot !== undefined) {
        dot.setAttribute('cx', x);
        dot.setAttribute('cy', y);
        dot.setAttribute('r', radius.toFixed(2));
        dot.setAttribute(
          'fill-opacity',
          lift(TESSERACT_STYLE.node[0] + ratio * TESSERACT_STYLE.node[1], boost * 0.85).toFixed(3),
        );
      }

      const halo = halos[index];
      if (halo !== undefined) {
        const from = TESSERACT_STYLE.halo[0];
        halo.setAttribute('cx', x);
        halo.setAttribute('cy', y);
        halo.setAttribute('r', (radius + 3.2 + boost * 2).toFixed(2));
        halo.setAttribute(
          'stroke-opacity',
          lift(clamp01((ratio - from) / (1 - from)) * TESSERACT_STYLE.halo[1], boost).toFixed(3),
        );
      }
    });
  };
}

/* ── 正二十四胞体（24 顶点 96 棱）─────────────────────────────────────────
   96 条棱本来就密，所以线压得比超立方体淡、粗细差别也更小——密的东西一浓就糊成
   一块，反而看不出结构。 */
function createCell24Scene(svg: SVGSVGElement, state: AnimationState): SceneRenderer {
  const shadow = appendShadow(svg, 'cell');
  const lines = appendElements(svg, 'line', CELL24_EDGES.length, { 'stroke-opacity': '0' });
  const dots = appendElements(svg, 'circle', CELL24.length, { r: '2' });
  const halos = appendElements(svg, 'circle', CELL24.length, { class: styles.halo, r: '2' });

  return (spin, pointerX, pointerY) => {
    const angleA = 0.72 + spin * 0.00017 + pointerX * 1.05;
    const angleB = 0.28 + spin * 0.00012 + pointerY * 1.05;

    let points = projectPoints(
      CELL24,
      angleA,
      angleB,
      CELL_VIEW,
      pointerX * CELL_LIGHT,
      pointerY * CELL_LIGHT,
    );
    const shear = shearField(points, state.shears);
    if (shear !== null) {
      points = projectPoints(
        CELL24,
        angleA,
        angleB,
        CELL_VIEW,
        pointerX * CELL_LIGHT,
        pointerY * CELL_LIGHT,
        shear,
      );
    }
    fitAll(points, CELL_VIEW.cx, CELL_VIEW.cy);
    const boosts = ripplePoints(points, state.ripples);

    const hull = convexHull(points.map((point) => ({ x: point.groundX, y: point.groundY })));
    const outline = hull.map((point) => `${point.x.toFixed(1)},${point.y.toFixed(1)}`).join(' ');
    shadow.soft.setAttribute('points', outline);
    shadow.core.setAttribute('points', outline);
    shadow.soft.setAttribute('fill-opacity', '0.5');
    shadow.core.setAttribute('fill-opacity', '0.22');

    CELL24_EDGES.forEach(([i, j], index) => {
      const a = points[i];
      const b = points[j];
      const line = lines[index];
      if (a === undefined || b === undefined || line === undefined) return;
      const ratio = cellDepthRatio((a.depth + b.depth) / 2);
      const boost = ((boosts[i] ?? 0) + (boosts[j] ?? 0)) / 2;
      line.setAttribute('x1', a.x.toFixed(1));
      line.setAttribute('y1', a.y.toFixed(1));
      line.setAttribute('x2', b.x.toFixed(1));
      line.setAttribute('y2', b.y.toFixed(1));
      line.setAttribute('stroke-opacity', lift(0.05 + ratio * 0.42, boost * 0.9).toFixed(3));
      line.setAttribute('stroke-width', (0.7 + ratio * 0.5 + boost * 0.9).toFixed(2));
    });

    points.forEach((point, index) => {
      const ratio = cellDepthRatio(point.depth);
      const boost = boosts[index] ?? 0;
      const x = point.x.toFixed(1);
      const y = point.y.toFixed(1);
      const radius = 1.5 + ratio * 1.1 + boost * 1.6;

      const dot = dots[index];
      if (dot !== undefined) {
        dot.setAttribute('cx', x);
        dot.setAttribute('cy', y);
        dot.setAttribute('r', radius.toFixed(2));
        dot.setAttribute('fill-opacity', lift(0.1 + ratio * 0.62, boost * 0.85).toFixed(3));
      }

      const halo = halos[index];
      if (halo !== undefined) {
        halo.setAttribute('cx', x);
        halo.setAttribute('cy', y);
        halo.setAttribute('r', (radius + 3).toFixed(2));
        halo.setAttribute(
          'stroke-opacity',
          lift(clamp01((ratio - 0.62) / 0.38) * 0.3, boost).toFixed(3),
        );
      }
    });
  };
}

/* ── Clifford 环面（经/纬两族母线）───────────────────────────────────────
   先把整张网的点全部投出来、统一做一次 fit，再逐条母线上波前——fit 是全局的，
   逐条各收各的会把网撕开。经纬网只位移、不提亮：一条母线整体共用一个浓度，提亮会
   变成整条闪，反而看不出波前。两族给不同底色（u 族更淡），叠加后读成「互相穿过」
   的经纬网，而不是一团线。 */
function createCliffordScene(svg: SVGSVGElement, state: AnimationState): SceneRenderer {
  const polys = appendElements(svg, 'polyline', CLIFFORD_LINES.length, { 'stroke-opacity': '0' });

  return (spin, pointerX, pointerY) => {
    // 只转 XW / YZ 两个平面会把这个环面「整体搬运」而看不出形变，所以角度幅度给得
    // 大一些，让它确实被拧动——四维里两个平面的转角是独立的。
    const angleA = 0.5 + spin * 0.00015 + pointerX * 1.0;
    const angleB = 0.9 + spin * 0.0001 + pointerY * 1.0;

    let nets = CLIFFORD_LINES.map((line) =>
      projectPoints(line, angleA, angleB, CLIFFORD_VIEW, 0, 0),
    );
    // 四维剪切：整张网空投一次，再按离落点远近逐点剪一次、按母线长度切片重投。
    const shear = shearField(nets.flat(), state.shears);
    if (shear !== null) {
      let at = 0;
      nets = CLIFFORD_LINES.map((line) => {
        const slice = shear.slice(at, at + line.length);
        at += line.length;
        return projectPoints(line, angleA, angleB, CLIFFORD_VIEW, 0, 0, slice);
      });
    }
    fitAll(nets.flat(), CLIFFORD_VIEW.cx, CLIFFORD_VIEW.cy);

    nets.forEach((points, index) => {
      ripplePoints(points, state.ripples);
      let total = 0;
      for (const point of points) total += point.depth;
      const ratio = cliffordDepthRatio(total / points.length);
      const family = index < CLIFFORD_FAMILY_COUNT ? 0.7 : 1;
      const polyline = polys[index];
      if (polyline === undefined) return;
      polyline.setAttribute('points', toPolylineString(points));
      polyline.setAttribute('stroke-opacity', ((0.1 + ratio * 0.42) * family).toFixed(3));
      polyline.setAttribute('stroke-width', (0.7 + ratio * 0.55).toFixed(2));
    });
  };
}

/* ── Hopf 纤维丛（一族互相套扣的大圆）────────────────────────────────────
   与 Clifford 同一套做法。一条纤维给一个**整体浓度**（而不是逐段变淡）：这样每条
   环都干净利落，交叠处才读得出「谁穿过谁」，也不会被透明度切碎。 */
function createHopfScene(svg: SVGSVGElement, state: AnimationState): SceneRenderer {
  const polys = appendElements(svg, 'polyline', HOPF_LINES.length, { 'stroke-opacity': '0' });

  return (spin, pointerX, pointerY) => {
    const angleA = 0.35 + spin * 0.00013 + pointerX * 0.95;
    const angleB = 0.8 + spin * 0.0001 + pointerY * 0.95;

    let nets = HOPF_LINES.map((line) => projectPoints(line, angleA, angleB, HOPF_VIEW, 0, 0));
    const shear = shearField(nets.flat(), state.shears);
    if (shear !== null) {
      let at = 0;
      nets = HOPF_LINES.map((line) => {
        const slice = shear.slice(at, at + line.length);
        at += line.length;
        return projectPoints(line, angleA, angleB, HOPF_VIEW, 0, 0, slice);
      });
    }
    fitAll(nets.flat(), HOPF_VIEW.cx, HOPF_VIEW.cy);

    nets.forEach((points, index) => {
      ripplePoints(points, state.ripples);
      let total = 0;
      for (const point of points) total += point.depth;
      const ratio = hopfDepthRatio(total / points.length);
      const polyline = polys[index];
      if (polyline === undefined) return;
      polyline.setAttribute('points', toPolylineString(points));
      polyline.setAttribute('stroke-opacity', (0.12 + ratio * 0.5).toFixed(3));
      polyline.setAttribute('stroke-width', (0.75 + ratio * 0.6).toFixed(2));
    });
  };
}

/** 按档位建好元素并返回该档的逐帧绘制函数（`none` 在建之前就被挡下）。 */
function createScene(
  choice: BackgroundChoice,
  svg: SVGSVGElement,
  state: AnimationState,
): SceneRenderer {
  switch (choice) {
    case 'tesseract':
      return createTesseractScene(svg, state);
    case 'cell24':
      return createCell24Scene(svg, state);
    case 'clifford':
      return createCliffordScene(svg, state);
    case 'hopf':
      return createHopfScene(svg, state);
    case 'none':
    default:
      return () => undefined;
  }
}

/**
 * 全站装饰性背景（UI-009）。
 *
 * ## 为什么是纯展示组件
 *
 * 「当前选哪一款」由应用层读 `localStorage` 决定后以 prop 传入。共享层
 * （`src/shared/ui/**`）不允许依赖 `app/**`，所以这里既不读存储也不知道偏好存哪。
 *
 * ## 为什么逐帧直接写 DOM，而不是每帧重渲染
 *
 * 一张网最多上百条线、每条几十个点，60fps 下每帧造一棵 React 树既昂贵又没必要。
 * 几何与数学在 `background-scenes.ts`（可单测），这里只负责：按档位建一次元素、
 * 在 `requestAnimationFrame` 循环里就地改属性、卸装时全部回收。
 *
 * ## 生命周期
 *
 * 页面不可见（`document.hidden`）时**暂停** rAF，重新可见再恢复——后台标签页没有
 * 必要继续算投影。卸载时 `cancelAnimationFrame` 并解绑所有监听。减少动效
 * （`prefers-reduced-motion: reduce`）时只停掉自转，几何与指针联动保留：禁的是
 * 「无意义的持续旋转」，不是禁一切运动。
 */
export function BackgroundField({ choice }: BackgroundFieldProps) {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const stateRef = useRef<AnimationState | null>(null);

  useEffect(() => {
    if (choice === 'none') return;
    const root = svgRef.current;
    if (root === null) return;
    // 显式标注为非空：`svg` 会被下面的闭包（rAF 循环）捕获，而 TS 在闭包里不会
    // 保留对 `svgRef.current` 的收窄，标注后才能安全地在闭包里使用。
    const svg: SVGSVGElement = root;

    // 换档时整棵子树重建；动画状态（自转 / 指针）跨档延续，只有入场淡入归零。
    svg.replaceChildren();
    const state = stateRef.current ?? createInitialState();
    stateRef.current = state;
    state.reveal = 0;

    /* 已经触发过时停的波（每道波只停一次）。用 WeakSet 而不是给 Ripple 加一个 UI
       字段：`landed` 是几何量（波有没有触到），「触发过没有」才是这里的账。 */
    const stopped = new WeakSet<Ripple>();

    const canHover = window.matchMedia(HOVER_QUERY).matches;
    const reduceMotion = window.matchMedia(REDUCED_MOTION_QUERY).matches;
    if (reduceMotion) state.reveal = 1;

    const draw = createScene(choice, svg, state);

    /* 客户端坐标 → viewBox 坐标。`.scene` 是右下角一块（宽 80%、高 90%），viewBox
       0..1000 按 meet 等比缩放且 xMaxYMax 对齐，缩放挤出的空档留在左上，所以这两个
       偏移必须算进去，否则波心会整体偏。 */
    function toSceneUnits(clientX: number, clientY: number): [number, number] {
      const boxW = window.innerWidth * 0.8;
      const boxH = window.innerHeight * 0.9;
      const scale = Math.min(boxW, boxH) / 1000;
      const left = window.innerWidth - boxW + (boxW - 1000 * scale);
      const top = window.innerHeight - boxH + (boxH - 1000 * scale);
      return [(clientX - left) / scale, (clientY - top) / scale];
    }

    function drawFrame(time: number): void {
      const dt = state.lastFrame === 0 ? 0 : Math.min(time - state.lastFrame, 50);
      state.lastFrame = time;

      // 时停：保持期内自转一点不走，之后缓回。
      if (state.stopHold > 0) state.stopHold -= 1;
      else state.freeze += (0 - state.freeze) * STOP_RECOVER;
      if (!reduceMotion) state.spin += dt * (1 - state.freeze * STOP_SUPPRESS);

      state.currentX += (state.targetX - state.currentX) * 0.1;
      state.currentY += (state.targetY - state.currentY) * 0.1;
      const pointerX = Math.max(-1, Math.min(1, (state.currentX / window.innerWidth) * 2 - 1));
      const pointerY = Math.max(-1, Math.min(1, (state.currentY / window.innerHeight) * 2 - 1));

      // 每道波前各自匀速外扩、各自走满就消失；剪切事件各老一岁。
      advanceRipples(state.ripples);
      ageShears(state.shears);
      state.reveal += (1 - state.reveal) * 0.12;

      draw(state.spin, pointerX, pointerY);

      /* 时停**不跟点击同帧触发**，而是等波前真的触到几何（`landed`）再急停。否则
         点得远时物体会先孤立地「卡一下」，等一两秒波到了才开始抖——两件事被时间
         拆开，读起来像卡顿而不是一次冲击。每道波只触发一次，所以连点仍各停各的。 */
      for (const ripple of state.ripples) {
        if (ripple.landed && !stopped.has(ripple)) {
          stopped.add(ripple);
          state.freeze = 1;
          state.stopHold = STOP_HOLD;
        }
      }

      // 淡入做在 SVG 这一层（一次 style 写入），比逐个元素乘系数干净得多。
      svg.style.opacity = state.reveal.toFixed(3);
    }

    let rafId = 0;
    function loop(time: number): void {
      rafId = window.requestAnimationFrame(loop);
      drawFrame(time);
    }
    function start(): void {
      if (rafId !== 0) return;
      state.lastFrame = 0; // 重新起步：别让暂停的那段时间被算成一帧巨大的 dt。
      rafId = window.requestAnimationFrame(loop);
    }
    function stop(): void {
      if (rafId === 0) return;
      window.cancelAnimationFrame(rafId);
      rafId = 0;
    }
    function onVisibilityChange(): void {
      if (document.hidden) stop();
      else start();
    }

    /* 按下与抬起之间位移很小才算「点一下」，这样拖选文本、滑动页面都不会误触发。
       不 preventDefault、不拦滚轮，背景层本身也 `pointer-events: none`。 */
    function onPointerMove(event: PointerEvent): void {
      if (canHover) {
        state.targetX = event.clientX;
        state.targetY = event.clientY;
      }
      if (!state.pressed) return;
      if (
        !state.moved &&
        Math.hypot(event.clientX - state.downX, event.clientY - state.downY) > CLICK_SLOP
      ) {
        state.moved = true;
      }
    }

    function onPointerDown(event: PointerEvent): void {
      if (event.button !== 0) return;
      state.pressed = true;
      state.moved = false;
      state.downX = event.clientX;
      state.downY = event.clientY;
    }

    /* 一次「点」同时触发三件事：涟漪（可连点、多道叠加）、时停（自转急停后缓回）、
       四维剪切（两趟投影的保体积线性变换）。三者互不重叠：涟漪是空间上的径向波、
       时停是时间轴、剪切是四维里的线性变换。**时停不在这里立刻执行**——它挂在涟漪
       上，等波前触到几何时才起步（见 `drawFrame`），免得远处一点先孤立地卡一下。 */
    function onPointerUp(event: PointerEvent): void {
      if (event.button === 0 && state.pressed && !state.moved) {
        const [bx, by] = toSceneUnits(state.downX, state.downY);
        state.ripples.push({ r: 0, x: bx, y: by, reach: rippleReach(bx, by), landed: false });
        state.shears.push({ x: bx, y: by, age: 0, life: SHEAR_LIFE });
      }
      state.pressed = false;
      state.moved = false;
    }

    function endPress(): void {
      state.pressed = false;
      state.moved = false;
    }

    /* 背景参与（UI-011 §6.1）：滚动时几何缓移，让装饰层与内容读起来在同一空间。
       减少动态效果时装饰层完全不动——滚动照常，只是背景不参与（预览稿 §五 同口径）。 */
    function onScroll(): void {
      const offset = Math.min(48, window.scrollY * 0.08);
      svg.style.transform = `translateY(${offset.toFixed(1)}px)`;
    }
    const parallaxOn = !reduceMotion;
    if (parallaxOn) {
      window.addEventListener('scroll', onScroll, { passive: true });
      onScroll();
    }

    if (!document.hidden) start();
    document.addEventListener('visibilitychange', onVisibilityChange);
    window.addEventListener('pointermove', onPointerMove, { passive: true });
    window.addEventListener('pointerdown', onPointerDown, { passive: true });
    window.addEventListener('pointerup', onPointerUp, { passive: true });
    window.addEventListener('pointercancel', endPress, { passive: true });
    window.addEventListener('blur', endPress);

    return () => {
      stop();
      if (parallaxOn) window.removeEventListener('scroll', onScroll);
      document.removeEventListener('visibilitychange', onVisibilityChange);
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('pointerup', onPointerUp);
      window.removeEventListener('pointercancel', endPress);
      window.removeEventListener('blur', endPress);
    };
  }, [choice]);

  if (choice === 'none') return null;

  return (
    <div className={styles.field} aria-hidden="true">
      <svg
        ref={svgRef}
        className={styles.scene}
        viewBox="0 0 1000 1000"
        preserveAspectRatio="xMaxYMax meet"
      />
    </div>
  );
}
