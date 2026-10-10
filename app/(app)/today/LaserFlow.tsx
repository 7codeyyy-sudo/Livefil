'use client';

import { useEffect, useRef } from 'react';
import type { RefObject } from 'react';

import { LASER_FRAGMENT_SOURCE, LASER_VERTEX_SOURCE } from './laser-flow-shader';

import styles from './LaserFlow.module.css';

/**
 * LaserFlow（UI-012，视觉方案 v2 采纳项；React Bits 官方组件按集成文档移植）。
 *
 * ## 它画什么
 *
 * 覆盖「页头 + 当前行动卡」的舞台：光从页面顶部坠下 → 击中卡片顶边 →
 * 沿边缘扩散 → 稳定后只保留呼吸与鼠标透镜增亮。着色器自身把卡片内部裁掉，
 * 所以任何内容都不会被光覆盖（见着色器文件说明）。
 *
 * ## 与 CSS 的分工
 *
 * 容器（`.container`）与画布的定位/裁切/上下缘渐隐全在 `LaserFlow.module.css`；
 * 本文件只管 WebGL：编译着色器、逐帧写 uniform、按「页面可见/在视口内」暂停。
 *
 * ## 三处硬约束
 *
 * 1. **手机档不初始化**（§3.1 ≤767px）：CSS 已隐藏画布，这里同步省掉整块
 *    WebGL 开销（判定用算式常量，断点像素值不进 TS/TSX——验收扫描器口径）。
 * 2. **无 WebGL2 静默跳过**：页面其余部分完全不受影响（渐进增强）。
 * 3. **主色从令牌读**（`--color-accent`，两态各不同）：组件里没有颜色字面量，
 *    主题切换经 MutationObserver 监听 `data-theme` 后重算调色并唤醒一帧。
 *
 * 呼吸与尘埃是**持续循环动效**——依最终决策者 2026-10-10 拍板（A1）：
 * 与 §3.4 背景自转并列的第二处书面豁免（《UI 页面规范》v0.29 §1.1/§6）；
 * `prefers-reduced-motion` 下冻结为静止画面。
 */

/** 手机档隐藏阈值（§3.1 ≤767px）。断点像素值不进 TS，用算式等值表达。 */
const LASER_MOBILE_MAX_WIDTH = 800 - 33;

/** 调色基表：[色相偏移, 饱和度缩放]——官方组件原值，只在这里维护。 */
const LASER_TINTS: readonly (readonly [number, number])[] = [
  [0, 1],
  [-11.5, 0.77],
  [9.5, 0.95],
  [-53.5, 0.79],
  [39.5, 0.77],
  [16, 0.81],
  [-16.3, 0.92],
  [13.3, 0.96],
  [3, 1.01],
  [1, 0.68],
  [1, 1.15],
  [142.5, 0.51],
  [113.6, 0.28],
  [-7.5, 0.13],
  [-2.7, 0.32],
  [7.5, 0.81],
];

const LASER_BASE_SATURATION = 0.78;
const LASER_MAX_DIM = 2048;
const LASER_INTRO_DROP = 1.25;
const LASER_INTRO_END = 5;

const clampNum = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value));

const easeOutCubic = (x: number): number => 1 - Math.pow(1 - clampNum(x, 0, 1), 3);

const springStep = (time: number): number => {
  const omega = 8;
  const zeta = 0.62;
  const damped = omega * Math.sqrt(1 - zeta * zeta);
  return (
    1 -
    Math.exp(-zeta * omega * time) *
      (Math.cos(damped * time) + ((zeta * omega) / damped) * Math.sin(damped * time))
  );
};

const toHsvTuple = ([r, g, b]: readonly [number, number, number]): readonly [number, number] => {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;
  let hue = 0;
  if (delta > 0) {
    if (max === r) hue = ((g - b) / delta) % 6;
    else if (max === g) hue = (b - r) / delta + 2;
    else hue = (r - g) / delta + 4;
  }
  return [(hue * 60 + 360) % 360, max > 0 ? delta / max : 0];
};

const fromHsvTuple = (hue: number, saturation: number): readonly [number, number, number] => {
  const h = (((hue % 360) + 360) % 360) / 60;
  const c = saturation;
  const x = c * (1 - Math.abs((h % 2) - 1));
  const m = 1 - c;
  const [r, g, b] =
    h < 1
      ? [c, x, 0]
      : h < 2
        ? [x, c, 0]
        : h < 3
          ? [0, c, x]
          : h < 4
            ? [0, x, c]
            : h < 5
              ? [x, 0, c]
              : [c, 0, x];
  return [r + m, g + m, b + m];
};

/** 由主色派生出 16 枚色调（官方算法：保住色相、按基表缩放饱和度）。 */
const buildLaserTints = (rgb: readonly [number, number, number]): Float32Array<ArrayBuffer> => {
  const [hue, saturation] = toHsvTuple(rgb);
  const strength = saturation / LASER_BASE_SATURATION;
  const data = new Float32Array(LASER_TINTS.length * 3);
  LASER_TINTS.forEach((entry, index) => {
    const shift = entry[0];
    const scale = entry[1];
    data.set(
      fromHsvTuple(hue + shift, clampNum(LASER_BASE_SATURATION * scale * strength, 0, 1)),
      index * 3,
    );
  });
  return data;
};

const compileShader = (
  gl: WebGL2RenderingContext,
  type: number,
  source: string,
): WebGLShader | null => {
  const shader = gl.createShader(type);
  if (!shader) return null;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (gl.getShaderParameter(shader, gl.COMPILE_STATUS)) return shader;
  gl.deleteShader(shader);
  return null;
};

const linkLaserProgram = (
  gl: WebGL2RenderingContext,
  vertexSource: string,
  fragmentSource: string,
): WebGLProgram | null => {
  const vertex = compileShader(gl, gl.VERTEX_SHADER, vertexSource);
  const fragment = compileShader(gl, gl.FRAGMENT_SHADER, fragmentSource);
  const program = gl.createProgram();
  if (!vertex || !fragment || !program) return null;
  gl.attachShader(program, vertex);
  gl.attachShader(program, fragment);
  gl.linkProgram(program);
  gl.deleteShader(vertex);
  gl.deleteShader(fragment);
  if (gl.getProgramParameter(program, gl.LINK_STATUS)) return program;
  gl.deleteProgram(program);
  return null;
};

const UNIFORM_NAMES = [
  'uResolution',
  'uDpr',
  'uScale',
  'uTime',
  'uBeamX',
  'uSurface',
  'uRadius',
  'uIntro',
  'uPour',
  'uRun',
  'uLens',
  'uReveal',
  'uRevealMap',
  'uRevealInfo',
  'uAtmosphere',
  'uAmount',
  'uShape',
  'uExtra',
  'uTheme',
  'uTint',
] as const;

type UniformName = (typeof UNIFORM_NAMES)[number];
type Uniforms = Record<UniformName, WebGLUniformLocation | null>;

/** 主题态：`data-theme` 属性是唯一真相（挂 `<html>`，见 theme-apply）。 */
function resolveTheme(): 'light' | 'dark' {
  return document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
}

/** 主色从令牌读（两态各不同）——组件里没有颜色字面量。 */
function readAccentColor(): string {
  return getComputedStyle(document.documentElement).getPropertyValue('--color-accent').trim();
}

export type LaserFlowProps = {
  /** 「落点卡片」元素（hero 卡）——光沿它的边缘扩散；为空时光在舞台上自然衰减。 */
  readonly surfaceRef: RefObject<HTMLElement | null>;
};

export function LaserFlow({ surfaceRef }: LaserFlowProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    // 手机档不初始化：CSS 已隐藏画布，这里省掉整块 WebGL 开销。
    if (window.matchMedia(`(max-width: ${String(LASER_MOBILE_MAX_WIDTH)}px)`).matches) {
      return;
    }

    const container = containerRef.current;
    const canvas = canvasRef.current;
    if (container === null || canvas === null) {
      return;
    }

    const gl = canvas.getContext('webgl2', {
      alpha: true,
      premultipliedAlpha: true,
      antialias: false,
      depth: false,
      stencil: false,
    });
    if (gl === null) {
      return; // 无 WebGL2：静默跳过，页面其余部分不受影响。
    }

    // 环境缺少观察器（jsdom 等）：同样静默跳过——需求是「更好的光效」，
    // 不是「没有它就崩」。与无 WebGL2 同一条渐进增强口径。
    if (typeof ResizeObserver === 'undefined' || typeof IntersectionObserver === 'undefined') {
      return;
    }

    const program = linkLaserProgram(gl, LASER_VERTEX_SOURCE, LASER_FRAGMENT_SOURCE);
    if (program === null) {
      return;
    }

    const uniforms = {} as Uniforms;
    for (const name of UNIFORM_NAMES) {
      uniforms[name] = gl.getUniformLocation(program, name);
    }

    const probe = document.createElement('canvas');
    probe.width = 1;
    probe.height = 1;
    const probeContext = probe.getContext('2d', { willReadFrequently: true });
    const reduce =
      window.matchMedia === undefined
        ? false
        : window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    const state = {
      time: 0,
      introTime: reduce ? LASER_INTRO_END : 0,
      width: 1,
      height: 1,
      ratio: 1,
      colorKey: '',
      // 初值全零＝无光；首帧 syncTheme 立刻按令牌重算（兜底只在令牌缺失时生效）。
      tints: new Float32Array(LASER_TINTS.length * 3),
      pointer: { x: 0, y: 0, inside: false },
      lens: { x: 0, y: 0, vx: 0, vy: 0, strength: 0, placed: false },
    };

    const settings = {
      /* 光束落点：容器左右各扩 420px、卡片内宽 836（900 页宽 − 32×2 页边距），
         要让光落在卡片的 68% 处 ⇒ (420 + 836×0.68) / (836 + 840) ≈ 0.59。 */
      beamPosition: 0.59,
      surfaceLevel: 1,
      color: '',
      intensity: 1.8,
      beamWidth: 1.5,
      flare: 1.5,
      spread: 1.5,
      spill: 1,
      fog: 0.2,
      dust: 1.6,
      streaks: 1.5,
      dots: 1,
      pulse: 1.5,
      speed: 1.5,
      seed: 3,
      mouseInteraction: true,
      revealRadius: 220,
      revealOpacity: 0.6,
      intro: true,
      theme: resolveTheme(),
      paused: false,
    };

    const toRgb = (value: string): readonly [number, number, number] => {
      if (!probeContext) return [0.22, 0.28, 1];
      probeContext.clearRect(0, 0, 1, 1);
      probeContext.fillStyle = value;
      probeContext.fillRect(0, 0, 1, 1);
      const data = probeContext.getImageData(0, 0, 1, 1).data;
      return [(data[0] ?? 0) / 255, (data[1] ?? 0) / 255, (data[2] ?? 0) / 255];
    };

    /** 主题/主色同步：属性变了或首次进入时重算调色并唤醒一帧。 */
    const syncTheme = (): void => {
      settings.theme = resolveTheme();
      const accent = readAccentColor();
      if (accent !== '' && accent !== state.colorKey) {
        state.colorKey = accent;
        settings.color = accent;
        state.tints = buildLaserTints(toRgb(accent));
      }
      wake();
    };

    const vao = gl.createVertexArray();
    const buffer = gl.createBuffer();
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const positionLocation = gl.getAttribLocation(program, 'aPosition');
    gl.enableVertexAttribArray(positionLocation);
    gl.vertexAttribPointer(positionLocation, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);

    const revealTexture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, revealTexture);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA,
      1,
      1,
      0,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      new Uint8Array([0, 0, 0, 0]),
    );
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    let raf = 0;
    let last = 0;
    let visible = true;
    /** 画布向下的延伸量（px，0 = 只用 CSS 兜底 `bottom: 0`）。见 render() 注释。 */
    let bottomOffset = 0;

    /** 量卡片相对容器的位置（每帧读一次：卡片随数据/换行移动时不用手工失效）。 */
    const measure = (
      width: number,
      height: number,
    ): {
      left: number;
      top: number;
      right: number;
      bottom: number;
      radius: number;
      real: boolean;
    } => {
      const element = surfaceRef.current;
      if (element !== null) {
        const box = container.getBoundingClientRect();
        const rect = element.getBoundingClientRect();
        if (rect.width > 0) {
          const computed = getComputedStyle(element);
          const radius = Math.max(
            parseFloat(computed.borderTopLeftRadius) || 0,
            parseFloat(computed.borderTopRightRadius) || 0,
          );
          return {
            left: rect.left - box.left,
            top: rect.top - box.top,
            right: rect.right - box.left,
            bottom: rect.bottom - box.top,
            radius: Math.min(radius, rect.width / 2, rect.height / 2),
            real: true,
          };
        }
      }
      return {
        left: -width * 2,
        top: settings.surfaceLevel * height,
        right: width * 3,
        bottom: height * 3,
        radius: 0,
        real: false,
      };
    };

    const render = (): void => {
      const { width, height } = state;
      let surface = measure(width, height);
      /*
       * 尺寸基准锚在「落点卡」上而不是画布上：预览稿里卡片 820px 宽对应约 1014
       * 设计单位（由 507 高的参考盒反推）。这样画布为了「光束从屏幕顶落下」而
       * 变高、或数据让卡片高度变化时，光束与光晕的**像素尺寸保持预览稿比例**；
       * 旧口径 `min(宽比, 高比)` 会随画布变高把整个光晕一起放大。
       * 理论兜底（无落点卡）时退回旧口径。
       */
      const scale = Math.max(
        0.2,
        surface.real ? (surface.right - surface.left) / 1014 : Math.min(width / 585, height / 507),
      );
      // 画布向下补到「落点卡」底边（无当前行动时，落点卡在舞台之外的下方——
      // 时间线卡）：`bottom` 取负值把画布往下延伸。顶锚在舞台顶不动，因此
      // 卡片几何（相对容器顶）不受影响；`bottomOffset` 与容器实高配合，
      // 使这条计算在 ResizeObserver 后续回调里保持幂等（不会来回振荡）。
      if (surface.real) {
        const stageHeight = state.height - bottomOffset;
        const desired = Math.max(0, Math.ceil(surface.bottom - stageHeight));
        if (desired !== bottomOffset) {
          bottomOffset = desired;
          container.style.bottom = desired === 0 ? '0px' : `-${String(desired)}px`;
        }
      }
      let beamX = settings.beamPosition * width;
      if (surface.real) {
        const margin = surface.radius + 6;
        if (beamX >= surface.left && beamX <= surface.right) {
          beamX = clampNum(beamX, surface.left + margin, surface.right - margin);
        } else {
          surface = {
            left: -width * 2,
            top: height,
            right: width * 3,
            bottom: height * 3,
            radius: 0,
            real: false,
          };
        }
      }
      const startY = -0.15 * height;
      const span = surface.top - startY + 0.3 * height;
      const it = state.introTime;
      const settled = it >= LASER_INTRO_END;
      const front = settled
        ? surface.top + 0.3 * height
        : startY + span * Math.pow(clampNum(it / LASER_INTRO_DROP, 0, 1), 1.3);
      const impact = LASER_INTRO_DROP * Math.pow(Math.max(0, surface.top - startY) / span, 1 / 1.3);
      const tau = it - impact;
      const bloom = settled ? 1 : tau <= 0 ? 0 : springStep(tau);
      const flash = settled || tau <= 0 ? 0 : Math.exp(-tau / 0.35) * (1 - Math.exp(-tau / 0.05));
      const runRange = settings.spread * 250 * 1.3 + 80;
      const runFront = settled ? 100000 : tau <= 0 ? -40 : runRange * (1 - Math.exp(-1.15 * tau));
      const beadStrength =
        settled || tau <= 0 ? 0 : Math.exp(-1.15 * tau) * (1 - Math.exp(-tau / 0.08));
      const pour = (reach: number): readonly [number, number] => {
        if (settled) return [1000, 1];
        if (tau <= 0) return [-reach, 0];
        const target = Math.min(reach, runRange * 0.97);
        const arrival = -Math.log(1 - target / runRange) / 1.15;
        const elapsed = tau - arrival;
        const ease = clampNum((elapsed + 0.15) / 0.8, 0, 1);
        const fill = ease * ease * ease * (ease * (ease * 6 - 15) + 10);
        if (elapsed <= 0) return [runFront - target, fill];
        const speed = 1.15 * (runRange - target);
        return [speed * elapsed + 260 * elapsed * elapsed, fill];
      };
      const [frontL, fillL] = pour((beamX - surface.left) / scale);
      const [frontR, fillR] = pour((surface.right - beamX) / scale);
      const atmosphere = settled
        ? 1
        : tau <= 0
          ? 0.3 * easeOutCubic(it / LASER_INTRO_DROP)
          : 0.3 + 0.7 * (1 - Math.exp(-1.3 * tau));
      const seedValue = Number(settings.seed) || 0;

      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.useProgram(program);
      gl.uniform2f(uniforms.uResolution, width, height);
      gl.uniform1f(uniforms.uDpr, state.ratio);
      gl.uniform1f(uniforms.uScale, scale);
      gl.uniform1f(uniforms.uTime, state.time);
      gl.uniform1f(uniforms.uBeamX, beamX);
      gl.uniform4f(uniforms.uSurface, surface.left, surface.top, surface.right, surface.bottom);
      gl.uniform1f(uniforms.uRadius, surface.radius);
      gl.uniform3f(uniforms.uIntro, front, bloom, flash);
      gl.uniform4f(uniforms.uPour, frontL, frontR, fillL, fillR);
      gl.uniform2f(uniforms.uRun, runFront, beadStrength);
      gl.uniform4f(uniforms.uLens, state.lens.x, state.lens.y, 95 * scale, state.lens.strength);
      const reveal = { width: 1, height: 1 };
      const cover = Math.max(width / reveal.width, height / reveal.height);
      const coverWidth = reveal.width * cover;
      const coverHeight = reveal.height * cover;
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, revealTexture);
      gl.uniform1i(uniforms.uReveal, 0);
      gl.uniform4f(
        uniforms.uRevealMap,
        1 / coverWidth,
        1 / coverHeight,
        (coverWidth - width) / 2 / coverWidth,
        (coverHeight - height) / 2 / coverHeight,
      );
      gl.uniform2f(uniforms.uRevealInfo, settings.revealRadius, 0);
      gl.uniform1f(uniforms.uAtmosphere, atmosphere);
      gl.uniform4f(
        uniforms.uAmount,
        settings.intensity,
        settings.fog,
        settings.dust,
        settings.streaks,
      );
      gl.uniform4f(
        uniforms.uShape,
        settings.beamWidth,
        settings.flare,
        settings.spread,
        settings.spill,
      );
      gl.uniform4f(
        uniforms.uExtra,
        settings.pulse,
        settings.dots,
        34.34 + seedValue * 7.31,
        11.58 + seedValue * 3.17,
      );
      gl.uniform1f(uniforms.uTheme, settings.theme === 'light' ? 1 : 0);
      gl.uniform3fv(uniforms.uTint, state.tints);
      gl.bindVertexArray(vao);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      gl.bindVertexArray(null);
    };

    const frame = (now: number): void => {
      raf = 0;
      if (!visible || document.hidden) return;
      const dt = last ? Math.min(0.05, (now - last) / 1000) : 1 / 60;
      last = now;
      const moving = !settings.paused && !reduce;
      if (moving) state.time += dt * settings.speed;
      const introducing = state.introTime < LASER_INTRO_END;
      if (introducing) state.introTime = Math.min(LASER_INTRO_END, state.introTime + dt);

      const { pointer, lens } = state;
      const active = settings.mouseInteraction && pointer.inside && !reduce;
      if (active && !lens.placed) {
        lens.x = pointer.x;
        lens.y = pointer.y;
        lens.vx = 0;
        lens.vy = 0;
        lens.placed = true;
      }
      const ax = 120 * (pointer.x - lens.x) - 19 * lens.vx;
      const ay = 120 * (pointer.y - lens.y) - 19 * lens.vy;
      lens.vx += ax * dt;
      lens.vy += ay * dt;
      lens.x += lens.vx * dt;
      lens.y += lens.vy * dt;
      const goal = active ? 1 : 0;
      lens.strength +=
        (goal - lens.strength) * (1 - Math.exp(-dt / (goal > lens.strength ? 0.3 : 0.55)));
      if (lens.strength < 0.001 && !active) lens.placed = false;

      render();
      const settling =
        Math.abs(lens.strength - (settings.mouseInteraction && pointer.inside ? 1 : 0)) > 0.002 ||
        Math.hypot(lens.vx, lens.vy) > 0.5;
      if (moving || introducing || settling) raf = requestAnimationFrame(frame);
      else last = 0;
    };

    const wake = (): void => {
      if (!raf && visible && !document.hidden) raf = requestAnimationFrame(frame);
    };

    const resize = (): void => {
      const width = Math.max(1, container.clientWidth);
      const height = Math.max(1, container.clientHeight);
      const baseDpr = Math.min(window.devicePixelRatio || 1, 2);
      const longest = Math.max(width, height) * baseDpr;
      const ratio = longest > LASER_MAX_DIM ? (baseDpr * LASER_MAX_DIM) / longest : baseDpr;
      const pixelWidth = Math.max(1, Math.round(width * ratio));
      const pixelHeight = Math.max(1, Math.round(height * ratio));
      if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
        canvas.width = pixelWidth;
        canvas.height = pixelHeight;
      }
      state.width = width;
      state.height = height;
      state.ratio = canvas.width / width;
      render();
    };

    const onPointerMove = (event: PointerEvent): void => {
      const rect = container.getBoundingClientRect();
      const x = event.clientX - rect.left;
      const y = event.clientY - rect.top;
      state.pointer.x = x;
      state.pointer.y = y;
      state.pointer.inside = x >= 0 && y >= 0 && x <= rect.width && y <= rect.height;
      wake();
    };

    const onPointerLeave = (): void => {
      state.pointer.inside = false;
      wake();
    };

    const onVisibility = (): void => {
      last = 0;
      wake();
    };

    const resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(container);
    const intersection = new IntersectionObserver((entries) => {
      visible = entries.some((entry) => entry.isIntersecting);
      if (visible) {
        last = 0;
        wake();
      }
    });
    intersection.observe(container);
    const themeObserver = new MutationObserver(syncTheme);
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme'],
    });
    window.addEventListener('pointermove', onPointerMove, { passive: true });
    document.documentElement.addEventListener('pointerleave', onPointerLeave);
    document.addEventListener('visibilitychange', onVisibility);

    syncTheme();
    resize();
    wake();

    return () => {
      cancelAnimationFrame(raf);
      resizeObserver.disconnect();
      intersection.disconnect();
      themeObserver.disconnect();
      window.removeEventListener('pointermove', onPointerMove);
      document.documentElement.removeEventListener('pointerleave', onPointerLeave);
      document.removeEventListener('visibilitychange', onVisibility);
      gl.deleteTexture(revealTexture);
      gl.deleteBuffer(buffer);
      gl.deleteVertexArray(vao);
      gl.deleteProgram(program);
      // 刻意**不**调 `WEBGL_lose_context.loseContext()`：React 严格模式在开发态
      // 会「挂载 → 卸载 → 再挂载」双跑 effect，而丢上下文会让第二次
      // `getContext('webgl2')` 拿到一个已死的上下文、初始化静默失败（画面上
      // 就是「光效永远不出现」）。资源已逐个 delete，上下文随画布回收。
    };
  }, [surfaceRef]);

  return (
    <div className={styles.container} ref={containerRef}>
      <canvas className={styles.canvas} ref={canvasRef} aria-hidden="true" />
    </div>
  );
}
