/**
 * 全站装饰性背景（UI-009）的**纯数学层**。
 *
 * 这里没有任何 React 与 DOM：几何的顶点/棱构造、两级透视投影、凸包、深度→浓度
 * 映射，以及点击特效（涟漪 / 时停 / 四维剪切）的参数与包络，全部是「拿到数字、
 * 吐出数字」的函数。渲染（建 SVG 元素、逐帧写属性）在 `BackgroundField.tsx`。
 *
 * 这样拆是为了让「几何到底对不对」能脱离浏览器被单测：投影管线与四款几何的
 * 顶点数、棱数都可直接断言，不必先起一个 SVG。
 *
 * 所有参数值照搬已定稿的独立预览（`temp/background-preview.html`），改动前请先
 * 回看那一份——它是这套几何的权威参考。
 */

/** 四维空间里的一个点：`[x, y, z, w]`。 */
export type Point4 = readonly [number, number, number, number];

/** 一次投影所需的视图参数（中心、抬升、半径、地面高度）。 */
export type ViewConfig = {
  readonly cx: number;
  readonly cy: number;
  readonly lift: number;
  readonly radius: number;
  readonly ground: number;
};

/** 投影结果：屏幕坐标、地面落点与「离观察者多近」的深度。可被逐帧就地改写。 */
export type ProjectedPoint = {
  x: number;
  y: number;
  groundX: number;
  groundY: number;
  depth: number;
};

/** 点击涟漪：波半径（viewBox 单位）与波心。 */
export type Ripple = {
  r: number;
  x: number;
  y: number;
  /** 回收半径（生成时按落点算好，见 `rippleReach`）：`r` 超过它就整道回收。 */
  reach: number;
  /** 波前是否已触到几何（首次由 `ripplePoints` 置位）。时停据此延后到波抵达时。 */
  landed: boolean;
};

/** 四维剪切事件：落点 + 年龄（帧），寿命到点自行消失。 */
export type ShearEvent = {
  x: number;
  y: number;
  age: number;
  life: number;
};

/** 一条棱：两端顶点在顶点数组里的下标。 */
export type Edge = readonly [number, number];

export const clamp01 = (value: number): number => Math.max(0, Math.min(1, value));

/* ══ 共用投影管线 ══════════════════════════════════════════════════════════
   绕 XW、YZ 两个**互相垂直的四维平面**旋转（三维里绕「轴」转，四维里绕「平面」
   转）→ 按 w 透视到三维（k4）→ 再按 z 透视到二维（k3）。depth = k4·k3 就是
   「该点最终离观察者多近」，近处实、远处淡全靠它。ground* 是把点沿光源方向投到
   地面上的落点，只有带影子的几何用。

   shear 是**四维剪切**（可选）：把旋转后的 w 再叠上 s·x，即 w' = w + s·x。它保
   体积，但是「斜切」不是「缩放」——shear 是逐点给的一串 s（由调用方按「离落点
   多远」算好），所以它逐点改写 k4 那层透视，画面读成「被拧斜」。 */
const D4 = 4;
const D3 = 8;

export function projectPoints(
  points: readonly Point4[],
  angleA: number,
  angleB: number,
  view: ViewConfig,
  lightX = 0,
  lightZ = 0,
  shear: readonly number[] | null = null,
): ProjectedPoint[] {
  const ca = Math.cos(angleA);
  const sa = Math.sin(angleA);
  const cb = Math.cos(angleB);
  const sb = Math.sin(angleB);
  const liftAmount = view.lift || 0;
  const ground = view.ground || 0;
  return points.map(([x, y, z, w], index) => {
    const x1 = x * ca - w * sa;
    const w1 = x * sa + w * ca + (shear === null ? 0 : (shear[index] ?? 0) * x1);
    const y1 = y * cb - z * sb;
    const z1 = y * sb + z * cb;
    const k4 = D4 / (D4 - w1);
    const px = x1 * k4;
    const pz = z1 * k4;
    const k3 = D3 / (D3 - pz);
    const groundK3 = D3 / (D3 - (pz + lightZ));
    return {
      x: view.cx + px * k3 * view.radius,
      y: view.cy - (y1 * k4 + liftAmount) * k3 * view.radius,
      groundX: view.cx + (px + lightX) * groundK3 * view.radius,
      groundY: view.cy - ground * groundK3 * view.radius,
      depth: k4 * k3,
    };
  });
}

const DEPTH_PROBE: ViewConfig = { cx: 0, cy: 0, lift: 0, radius: 1, ground: 0 };

/* 深度区间在初始化时**实测**（扫角度取极值），不写死常数：四个对象的高维半径
   各不相同（超立方体顶点模长 2、24-cell 是 √2、环面与 Hopf 都在单位球面上），
   一套常数不可能通用。 */
function measureDepth(
  points: readonly Point4[],
  samples: number,
  stride = 1,
): { min: number; max: number } {
  let min = Infinity;
  let max = -Infinity;
  const probe = stride > 1 ? points.filter((_, index) => index % stride === 0) : points;
  for (let a = 0; a < samples; a += 1) {
    for (let b = 0; b < samples; b += 1) {
      const projected = projectPoints(
        probe,
        (a / samples) * 6.2832,
        (b / samples) * 6.2832,
        DEPTH_PROBE,
      );
      for (const point of projected) {
        if (point.depth < min) min = point.depth;
        if (point.depth > max) max = point.depth;
      }
    }
  }
  return { min, max };
}

const ratioOf =
  ({ min, max }: { min: number; max: number }) =>
  (depth: number): number =>
    clamp01((depth - min) / (max - min));

/* 按「这一帧的实际包络」整块等比收拢，任何角度下都收在 1000×1000 里。为什么不
   逐条线收：Clifford 与 Hopf 是几十条线拼成的一张网，逐条各收各的会把网撕开。 */
export function fitAll(points: ProjectedPoint[], cx: number, cy: number): void {
  let right = 0;
  let left = 0;
  let up = 0;
  let down = 0;
  for (const point of points) {
    right = Math.max(right, point.x - cx, point.groundX - cx);
    left = Math.max(left, cx - point.x, cx - point.groundX);
    up = Math.max(up, cy - point.y, cy - point.groundY);
    down = Math.max(down, point.y - cy, point.groundY - cy);
  }
  const fit = Math.min(
    1,
    right > 0 ? 499 / right : 1,
    left > 0 ? 499 / left : 1,
    up > 0 ? (cy - 1) / up : 1,
    down > 0 ? (999 - cy) / down : 1,
  );
  if (fit >= 1) return;
  for (const point of points) {
    point.x = cx + (point.x - cx) * fit;
    point.y = cy + (point.y - cy) * fit;
    point.groundX = cx + (point.groundX - cx) * fit;
    point.groundY = cy + (point.groundY - cy) * fit;
  }
}

type Flat = { x: number; y: number };

/** Andrew 单调链求凸包（逆时针）：地面落点的外包轮廓就是影子。 */
export function convexHull(points: readonly Flat[]): Flat[] {
  if (points.length < 3) return [...points];
  const sorted = [...points].sort((a, b) => a.x - b.x || a.y - b.y);
  const cross = (o: Flat, a: Flat, b: Flat): number =>
    (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const chain = (list: readonly Flat[]): Flat[] => {
    const stack: Flat[] = [];
    for (const point of list) {
      while (stack.length >= 2) {
        const o = stack[stack.length - 2];
        const a = stack[stack.length - 1];
        if (o === undefined || a === undefined || cross(o, a, point) > 0) break;
        stack.pop();
      }
      stack.push(point);
    }
    stack.pop();
    return stack;
  };
  return chain(sorted).concat(chain([...sorted].reverse()));
}

export function toPolylineString(points: readonly ProjectedPoint[]): string {
  let out = '';
  for (const point of points) out += `${point.x.toFixed(1)},${point.y.toFixed(1)} `;
  return out;
}

/* ══ 一 · 超立方体（tesseract）· 线框款 ═══════════════════════════════════
   16 个顶点 = 四个坐标各自取 ±1 的全部组合；棱 = 恰好一个坐标不同的点对，共 32
   条。旋转发生在两个互相垂直的四维平面上——三维里绕「轴」转，四维里绕「平面」转。 */
function buildTesseractVertices(): readonly Point4[] {
  const vertices: Point4[] = [];
  for (let i = 0; i < 16; i += 1) {
    vertices.push([i & 1 ? 1 : -1, i & 2 ? 1 : -1, i & 4 ? 1 : -1, i & 8 ? 1 : -1]);
  }
  return vertices;
}

function buildTesseractEdges(vertices: readonly Point4[]): readonly Edge[] {
  const edges: Edge[] = [];
  for (let i = 0; i < vertices.length; i += 1) {
    for (let j = i + 1; j < vertices.length; j += 1) {
      const a = vertices[i];
      const b = vertices[j];
      if (a === undefined || b === undefined) continue;
      let diff = 0;
      for (let k = 0; k < 4; k += 1) if (a[k] !== b[k]) diff += 1;
      if (diff === 1) edges.push([i, j]);
    }
  }
  return edges;
}

export const CUBE4: readonly Point4[] = buildTesseractVertices();
export const TESSERACT_EDGES: readonly Edge[] = buildTesseractEdges(CUBE4);

/* 中心 500 / 地面 -0.8 一起定：物体沿三维 Y 抬起之后正好悬在地面上方，整块构图
   收在右下角；半径与抬升量按「全角度扫描后不甩出 1000×1000」反推。 */
export const TESSERACT_VIEW: ViewConfig = {
  cx: 500,
  cy: 770,
  lift: 1.8,
  radius: 150,
  ground: -0.8,
};

/** 超立方体（线框款）的浓度参数表——字段含义见各自的注释。 */
export type TesseractStyle = {
  /** 虚拟光源随指针的位移幅度。 */
  readonly light: number;
  /** 软影（凸包）的浓度。 */
  readonly hull: number;
  /** 柱线的浓度。 */
  readonly pillar: number;
  /** 棱的 [基础值, 随深度增量]。 */
  readonly edge: readonly [number, number];
  /** 棱宽的 [基础值, 随深度增量]。 */
  readonly edgeWidth: readonly [number, number];
  /** 顶点的 [基础值, 随深度增量]。 */
  readonly node: readonly [number, number];
  /** 顶点半径的 [基础值, 随深度增量]。 */
  readonly nodeRadius: readonly [number, number];
  /** 最近顶点外环的 [起始深度, 浓度]。 */
  readonly halo: readonly [number, number];
};

export const TESSERACT_STYLE: TesseractStyle = {
  light: 0.75,
  hull: 0.72,
  pillar: 0.5,
  edge: [0.15, 0.7],
  edgeWidth: [1.2, 1.6],
  node: [0.12, 0.78],
  nodeRadius: [1.8, 2.6],
  halo: [0.6, 0.3],
};

/* depth = k4·k3 的区间由全角度扫描取得（预览里写死为这两个值）。 */
export const tesseractDepthRatio = ratioOf({ min: 0.653, max: 2.129 });

/* ══ 二 · 正二十四胞体（24-cell）═════════════════════════════════════════
   24 个顶点 = (±1, ±1, 0, 0) 的全部排列（C(4,2)×4 = 24），即 D₄ 根系的 24 个根；
   棱 = 欧氏距离恰好 √2 的点对，共 96 条。它是四维里唯一**没有三维对应物**的正多胞体。 */
function buildCell24Vertices(): readonly Point4[] {
  const vertices: Point4[] = [];
  for (let a = 0; a < 4; a += 1) {
    for (let b = a + 1; b < 4; b += 1) {
      for (const sa of [-1, 1]) {
        for (const sb of [-1, 1]) {
          const coords: [number, number, number, number] = [0, 0, 0, 0];
          coords[a] = sa;
          coords[b] = sb;
          vertices.push(coords);
        }
      }
    }
  }
  return vertices;
}

function buildCell24Edges(vertices: readonly Point4[]): readonly Edge[] {
  const edges: Edge[] = [];
  for (let i = 0; i < vertices.length; i += 1) {
    for (let j = i + 1; j < vertices.length; j += 1) {
      const a = vertices[i];
      const b = vertices[j];
      if (a === undefined || b === undefined) continue;
      let squared = 0;
      for (let k = 0; k < 4; k += 1) {
        const delta = (a[k] ?? 0) - (b[k] ?? 0);
        squared += delta * delta;
      }
      if (squared === 2) edges.push([i, j]);
    }
  }
  return edges;
}

export const CELL24: readonly Point4[] = buildCell24Vertices();
export const CELL24_EDGES: readonly Edge[] = buildCell24Edges(CELL24);

/* 顶点模长只有 √2（超立方体是 2），所以半径要给得比它大一截才同等体量。 */
export const CELL_VIEW: ViewConfig = { cx: 500, cy: 770, lift: 1.8, radius: 192, ground: -0.8 };
export const CELL_LIGHT = 0.75;
export const cellDepthRatio = ratioOf(measureDepth(CELL24, 36));

/* ══ 三 · Clifford 环面 ══════════════════════════════════════════════════
   S¹ × S¹ ⊂ S³，参数化 (cos u, sin u, cos v, sin v)/√2：它是四维球面上唯一**平坦**
   的环面（高斯曲率处处为 0，三维里做不到）。两组母线互相环绕，投影后就是那张著名
   的「方环面」经纬网。 */
const CLIFFORD_N = 16;
const CLIFFORD_SAMPLES = 64;
const CLIFFORD_R = 1 / Math.SQRT2;

function buildCliffordLines(): readonly (readonly Point4[])[] {
  const lines: Point4[][] = [];
  for (let k = 0; k < CLIFFORD_N; k += 1) {
    // u 族：固定 v，u 绕一整圈。
    const cv = Math.cos((k / CLIFFORD_N) * 6.2832) * CLIFFORD_R;
    const sv = Math.sin((k / CLIFFORD_N) * 6.2832) * CLIFFORD_R;
    const line: Point4[] = [];
    for (let s = 0; s <= CLIFFORD_SAMPLES; s += 1) {
      const u = (s / CLIFFORD_SAMPLES) * 6.2832;
      line.push([Math.cos(u) * CLIFFORD_R, Math.sin(u) * CLIFFORD_R, cv, sv]);
    }
    lines.push(line);
  }
  for (let k = 0; k < CLIFFORD_N; k += 1) {
    // v 族：固定 u，v 绕一整圈。
    const cu = Math.cos((k / CLIFFORD_N) * 6.2832) * CLIFFORD_R;
    const su = Math.sin((k / CLIFFORD_N) * 6.2832) * CLIFFORD_R;
    const line: Point4[] = [];
    for (let s = 0; s <= CLIFFORD_SAMPLES; s += 1) {
      const v = (s / CLIFFORD_SAMPLES) * 6.2832;
      line.push([cu, su, Math.cos(v) * CLIFFORD_R, Math.sin(v) * CLIFFORD_R]);
    }
    lines.push(line);
  }
  return lines;
}

export const CLIFFORD_LINES: readonly (readonly Point4[])[] = buildCliffordLines();
/** u 族母线的条数：`index < CLIFFORD_FAMILY_COUNT` 属 u 族（画得更淡）。 */
export const CLIFFORD_FAMILY_COUNT = CLIFFORD_N;

/* 所有点都在单位球面上，投影尺度很小（|坐标| ≤ 1/√2），半径要给大。 */
export const CLIFFORD_VIEW: ViewConfig = { cx: 500, cy: 630, lift: 0, radius: 300, ground: 0 };
export const cliffordDepthRatio = ratioOf(measureDepth(CLIFFORD_LINES[0] ?? [], 40, 8));

/* ══ 四 · Hopf 纤维丛 ═════════════════════════════════════════════════════
   Hopf 映射 S³ → S²：把四维球面切成**一族大圆**（纤维），任取两条恰好相扣一次。
   构造：z₁ = cos(θ/2)·e^{i(φ/2+ψ)}、z₂ = sin(θ/2)·e^{i(ψ−φ/2)}，(z₁, z₂) 在单位
   S³ 上，ψ 绕一圈就是一条纤维；基点在 S² 上用 Fibonacci 球均布（黄金角螺旋）。 */
const HOPF_N = 18;
const HOPF_SAMPLES = 60;
const HOPF_GOLDEN = Math.PI * (3 - Math.sqrt(5));

function buildHopfLines(): readonly (readonly Point4[])[] {
  const lines: Point4[][] = [];
  for (let i = 0; i < HOPF_N; i += 1) {
    const baseZ = 1 - (2 * (i + 0.5)) / HOPF_N;
    const basePhi = i * HOPF_GOLDEN;
    const halfTheta = Math.acos(baseZ) / 2;
    const halfPhi = basePhi / 2;
    const cosHalf = Math.cos(halfTheta);
    const sinHalf = Math.sin(halfTheta);
    const line: Point4[] = [];
    for (let s = 0; s <= HOPF_SAMPLES; s += 1) {
      const psi = (s / HOPF_SAMPLES) * 6.2832;
      line.push([
        cosHalf * Math.cos(halfPhi + psi),
        cosHalf * Math.sin(halfPhi + psi),
        sinHalf * Math.cos(psi - halfPhi),
        sinHalf * Math.sin(psi - halfPhi),
      ]);
    }
    lines.push(line);
  }
  return lines;
}

export const HOPF_LINES: readonly (readonly Point4[])[] = buildHopfLines();
export const HOPF_VIEW: ViewConfig = { cx: 500, cy: 620, lift: 0, radius: 300, ground: 0 };
export const hopfDepthRatio = ratioOf(measureDepth(HOPF_LINES[0] ?? [], 40, 6));

/* ══ 点击涟漪（ripple）═══════════════════════════════════════════════════
   从落点发出一个半径匀速外扩的环形波前，扫过几何之后消失。波前经过哪个顶点，
   哪个顶点就被沿「远离落点」的方向推一下（高斯波包，推完自己归位）。波可以**多道
   同时存在**：点一下发一道，前一道还没走完就能再发一道，互不重置——这是波的叠加。

   波**不被截断**：回收半径不是写死的常数，而是「波心 → 1000×1000 画布最远角」再加一个
   波尾。写死半径的毛病在它与落点无关——点得离几何远（如点在左侧空白，波心换算到
   viewBox 外，到几何可达 1250~1700 单位）时，波会在扫到几何之前就被删掉，远处点击读到
   的就是「等一下才抖、抖一下立刻没了」。几何经 `fitAll` 后恒在画布内，所以按画布量距
   一定扫得到整个几何。 */
const RIPPLE_SPEED = 16; /* 每帧外扩 16 单位 */
const RIPPLE_BAND = 80; /* 波包宽度：宽了像整体鼓一下，窄了像闪烁 */
const RIPPLE_TAIL = 2.5; /* 波尾宽度（单位：个波包）；波包在此处已衰减到可忽略 */
const RIPPLE_PUSH = 16; /* 峰值位移（viewBox 单位） */

/** 一道波的回收半径：波心到画布最远角的距离 + 一个波尾。生成时按落点算好随波携带。 */
export function rippleReach(x: number, y: number): number {
  const dx = Math.max(x, 1000 - x);
  const dy = Math.max(y, 1000 - y);
  return Math.hypot(dx, dy) + RIPPLE_TAIL * RIPPLE_BAND;
}

/** 每道波前各自匀速外扩，走满就各自消失（不是周期性重复——它必须有尽头）。 */
export function advanceRipples(ripples: Ripple[]): void {
  for (const ripple of ripples) ripple.r += RIPPLE_SPEED;
  // 倒着遍历才好 splice：正着删会跳掉下一个。
  for (let i = ripples.length - 1; i >= 0; i -= 1) {
    const ripple = ripples[i];
    if (ripple !== undefined && ripple.r > ripple.reach) ripples.splice(i, 1);
  }
}

/* 把投影好的一批点过一遍**所有活跃波前**：就地改 x / y，并回一份每点的强度 0..1。
   两道波前同时罩住一个点时，位移与强度都累加，最后强度夹到 1。 */
export function ripplePoints(points: ProjectedPoint[], ripples: Ripple[]): number[] {
  if (ripples.length === 0) return points.map(() => 0);
  return points.map((point) => {
    let boost = 0;
    for (const ripple of ripples) {
      const dx = point.x - ripple.x;
      const dy = point.y - ripple.y;
      const d = Math.hypot(dx, dy) || 1e-6;
      const u = (d - ripple.r) / RIPPLE_BAND;
      if (u < -RIPPLE_TAIL || u > RIPPLE_TAIL) continue;
      /* u ≤ 0 = 波前**已触到**这个点（再往后走就是推得最狠的峰）。任意一点首次触到
         就置 `landed`，供「时停」等波真的打到几何时才触发。 */
      if (u <= 0) ripple.landed = true;
      const packet = Math.exp(-u * u); /* 高斯波包：波前两侧对称衰减 */
      const ux = dx / d;
      const uy = dy / d;
      /* 位移幅度按「这点朝外还有多少余地」收：用**余量**而不是事后夹取。夹取会把
         越界点硬按回边上、波扫到画布边缘会出现一道假直线；收幅度则是「推不动就不
         推」，边缘处波自然淡下去。余量按当前位置算，两道叠加也不会把点推出画布。 */
      const roomX = ux > 0 ? (999 - point.x) / ux : ux < 0 ? (1 - point.x) / ux : Infinity;
      const roomY = uy > 0 ? (999 - point.y) / uy : uy < 0 ? (1 - point.y) / uy : Infinity;
      const push = Math.max(0, Math.min(RIPPLE_PUSH * packet, roomX, roomY));
      point.x += ux * push;
      point.y += uy * push;
      boost += packet;
    }
    return boost > 1 ? 1 : boost;
  });
}

/** 提亮：把基准浓度朝 1 抬 weight 那么多，weight 就是波包强度。 */
export const lift = (base: number, weight: number): number => base + (1 - base) * weight;

/* ══ 点击 · 四维剪切 ══════════════════════════════════════════════════════
   剪切是最典型的**保持体积不变**的线性变换：w' = w + s·x。它跟缩放不一样——缩放是
   「一起长大」，剪切是「一半推出去、一半缩回来」，体积不变、网格被斜切。s 按「离
   落点多远」衰减，只有落点附近被斜切。投影前不知道落点屏幕位置，所以走两趟：
   先空投一次拿到屏幕位置，算出每点该剪多少，再重投第二次。 */
export const SHEAR_LIFE = 54; /* 寿命（帧）≈ 0.9s */
const SHEAR_AMP = 0.35; /* 峰值剪切量 */
const SHEAR_RADIUS = 220;

/* 时间包络：0 → 1 → 0，两端**恰好为零**，所以效果生成与消失时都不「啪」地跳一下。 */
const envelope = (age: number, life: number): number => {
  const t = age / life;
  return 0.5 - 0.5 * Math.cos(6.2832 * t);
};

/* 高斯衰减：离得越远作用越小。写成乘法不用 Math.pow。 */
const falloff = (d: number, radius: number): number => Math.exp((-d * d) / (radius * radius));

/** 剪切事件只老一岁；寿命到点自行移除。 */
export function ageShears(shears: ShearEvent[]): void {
  for (const event of shears) event.age += 1;
  for (let i = shears.length - 1; i >= 0; i -= 1) {
    const event = shears[i];
    if (event !== undefined && event.age >= event.life) shears.splice(i, 1);
  }
}

/** 逐点的剪切量；没有活跃剪切时返回 `null`（调用方据此省掉第二趟投影）。 */
export function shearField(
  points: readonly ProjectedPoint[],
  shears: readonly ShearEvent[],
): number[] | null {
  if (shears.length === 0) return null;
  let any = false;
  const field = points.map((point) => {
    let amount = 0;
    for (const shear of shears) {
      const d = Math.hypot(point.x - shear.x, point.y - shear.y);
      amount += SHEAR_AMP * envelope(shear.age, shear.life) * falloff(d, SHEAR_RADIUS);
    }
    if (amount !== 0) any = true;
    return amount;
  });
  return any ? field : null;
}

/* ══ 点击 · 时停 ══════════════════════════════════════════════════════════
   点一下让**自转**急停：保持若干帧完全不转，再平滑缓回。它只改自转的时间轴，涟漪照
   常推进，于是画面读成「物体定住、波在上面扫过去」。指针联动**不**参与时停——手还
   在动、物体却完全不理你，更像卡住而不是时停。 */
export const STOP_HOLD = 12; /* 急停保持（帧）≈ 0.2s */
/** 自转从急停缓回时每帧的衰减率（越小缓得越久）。 */
export const STOP_RECOVER = 0.06;
/** 自转被时停压住的程度：1 = 完全静止。 */
export const STOP_SUPPRESS = 0.97;

/** 「按下到抬起位移不超过它」才算一次「点一下」——超过就是拖选/滑动，不触发。 */
export const CLICK_SLOP = 4;
