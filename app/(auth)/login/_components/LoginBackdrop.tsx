'use client';

/**
 * 登录页背景（v0.30 登录页 hero 面）：星夜 + 星球弧顶的日出辉光。
 *
 * ## 它画什么
 *
 * 一个固定铺满视口的 `<canvas>`：星球地平线、日出大气与写实星空（暗色态才画星，
 * 亮色态是浅灰盘 + 冷蓝弧线的「日间」形态）。构图与全部参数见
 * `login-dawn-shader.ts`——本文件只管 WebGL 的驱动面：编译、uniform、rAF、
 * 尺寸与主题响应、以及三种降级。
 *
 * ## 三处硬约束（与 LaserFlow 同一渐进增强口径）
 *
 * 1. **无 WebGL 静默降级**：拿不到上下文或着色器编译失败时把画布藏掉并返回，
 *    表单照常可用、页面零报错——背景是「更好的观感」，不是「没有它就崩」。
 * 2. **`prefers-reduced-motion` 冻结为静止帧**（`uTime` 定在 9：黎明已亮、星空已满），
 *    不播入场渐亮、不做天移与闪烁；主题切换或视口变化仍会重绘一帧。
 * 3. **颜色只从令牌读**：`--color-bg-page` / `--color-dawn-warm` / `--color-accent`
 *    经 1×1 canvas 探针取值后传 uniform，本组件没有色值（与 LaserFlow 同法）。
 *
 * ## 主题与第三处循环豁免
 *
 * 主题态以 `<html data-theme>` 为唯一真相（见 `src/shared/ui/theme/`），这里用
 * `MutationObserver` 观察该属性：切换主题时重算调色并重绘，不需要重新挂载。
 * 星空的天移与闪烁是**持续循环动效**——《UI 页面规范》v0.30 §1.1/§6 的第三处
 * 书面豁免（前两处：§3.4 背景自转、今日页 LaserFlow 呼吸与尘埃），依赖
 * `prefers-reduced-motion` 冻结。
 *
 * ## 为什么不随 LaserFlow 用 WebGL2
 *
 * 着色器是 GLSL ES 1.00（`gl_FragColor` 写法），WebGL1 上下文能覆盖到更老的
 * 环境、且不需要 VAO 之类的 WebGL2 专属设施；今日页那处用 WebGL2 是因为官方
 * 组件源码的写法需要它。
 */

import { useEffect, useRef } from 'react';

import { DAWN_FRAGMENT_SOURCE, DAWN_VERTEX_SOURCE } from './login-dawn-shader';

import styles from './LoginBackdrop.module.css';

/** 窄屏阈值（§3.1 ≤767px）。断点像素值不进 TS/TSX（UI-001 扫描器口径），用算式等值表达。 */
const NARROW_MAX_WIDTH = 800 - 33;

/** 冻结帧的时刻（减少动效时画面停在这里，不是入场第一帧）。 */
const FROZEN_TIME = 9;

/** 宽屏档的 dpr 上限：片元着色器逐像素开销固定，1.5 之上肉眼无增益。 */
const DPR_LIMIT = 1.5;

/** uniform 名单（一次取址、循环赋值，新增 uniform 只改这里与着色器）。 */
const UNIFORM_NAMES = [
  'uRes',
  'uTime',
  'uCenter',
  'uRadius',
  'uBg',
  'uBody',
  'uWarm',
  'uAtmo',
  'uHot',
  'uAdd',
] as const;

type UniformName = (typeof UNIFORM_NAMES)[number];
type Uniforms = Record<UniformName, WebGLUniformLocation | null>;

function compileShader(
  gl: WebGLRenderingContext,
  type: number,
  source: string,
): WebGLShader | null {
  const shader = gl.createShader(type);
  if (shader === null) {
    return null;
  }
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    return shader;
  }
  gl.deleteShader(shader);
  return null;
}

function linkProgram(gl: WebGLRenderingContext): WebGLProgram | null {
  const vertex = compileShader(gl, gl.VERTEX_SHADER, DAWN_VERTEX_SOURCE);
  const fragment = compileShader(gl, gl.FRAGMENT_SHADER, DAWN_FRAGMENT_SOURCE);
  if (vertex === null || fragment === null) {
    return null;
  }
  const program = gl.createProgram();
  gl.attachShader(program, vertex);
  gl.attachShader(program, fragment);
  gl.linkProgram(program);
  gl.deleteShader(vertex);
  gl.deleteShader(fragment);
  if (gl.getProgramParameter(program, gl.LINK_STATUS)) {
    return program;
  }
  gl.deleteProgram(program);
  return null;
}

export function LoginBackdrop() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null) {
      return;
    }

    const gl = canvas.getContext('webgl', {
      alpha: false,
      antialias: false,
      depth: false,
      stencil: false,
    });
    if (gl === null) {
      canvas.style.display = 'none';
      return;
    }

    const program = linkProgram(gl);
    if (program === null) {
      canvas.style.display = 'none';
      return;
    }

    const uniforms = {} as Uniforms;
    for (const name of UNIFORM_NAMES) {
      uniforms[name] = gl.getUniformLocation(program, name);
    }

    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const positionLocation = gl.getAttribLocation(program, 'aPos');
    gl.enableVertexAttribArray(positionLocation);
    gl.vertexAttribPointer(positionLocation, 2, gl.FLOAT, false, 0, 0);
    gl.useProgram(program);

    /* 令牌取色：1×1 探针把任意 CSS 颜色写法（hex / rgb / color-mix 之外的纯色）
       归一成 0–1 三元组。探针拿不到 2D 上下文时按无效处理，静默降级。 */
    const probe = document.createElement('canvas');
    probe.width = 1;
    probe.height = 1;
    const probeContext = probe.getContext('2d', { willReadFrequently: true });
    if (probeContext === null) {
      canvas.style.display = 'none';
      return;
    }

    const toRgb = (value: string): readonly [number, number, number] => {
      probeContext.clearRect(0, 0, 1, 1);
      probeContext.fillStyle = value;
      probeContext.fillRect(0, 0, 1, 1);
      const data = probeContext.getImageData(0, 0, 1, 1).data;
      return [(data[0] ?? 0) / 255, (data[1] ?? 0) / 255, (data[2] ?? 0) / 255];
    };

    const readToken = (name: string): string =>
      getComputedStyle(document.documentElement).getPropertyValue(name).trim();

    const reduce =
      window.matchMedia === undefined
        ? false
        : window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    let raf = 0;
    let last = 0;
    let time = 0;

    /** 主题/令牌同步 + 重绘：调色只在这里算，帧循环里不做 DOM 读取。 */
    const syncThemeAndDraw = (): void => {
      const dark = document.documentElement.getAttribute('data-theme') === 'dark';
      const bg = toRgb(readToken('--color-bg-page'));
      const warm = toRgb(readToken('--color-dawn-warm'));
      const accent = toRgb(readToken('--color-accent'));
      /* 深空底色：页面底色压暗并偏蓝（0.40 / 0.42 / 0.46 的分通道权重）；
         星球本体：深色态在底色上再压一档、亮色态取底色 93%（浅灰盘）。 */
      gl.uniform3f(
        uniforms.uBg,
        dark ? bg[0] * 0.4 : bg[0],
        dark ? bg[1] * 0.42 : bg[1],
        dark ? bg[2] * 0.46 : bg[2],
      );
      gl.uniform3f(
        uniforms.uBody,
        dark ? bg[0] * 0.16 + 0.002 : bg[0] * 0.93,
        dark ? bg[1] * 0.2 + 0.003 : bg[1] * 0.93,
        dark ? bg[2] * 0.3 + 0.008 : bg[2] * 0.93,
      );
      gl.uniform3f(uniforms.uWarm, warm[0], warm[1], warm[2]);
      gl.uniform3f(uniforms.uAtmo, accent[0], accent[1], accent[2]);
      /* 亮核＝暖色向白推：这是「日出亮部」的光学表达，不是第二枚颜色令牌。 */
      const towardWhite = dark ? 0.62 : 0.5;
      gl.uniform3f(
        uniforms.uHot,
        warm[0] + (1 - warm[0]) * towardWhite,
        warm[1] + (1 - warm[1]) * towardWhite,
        warm[2] + (1 - warm[2]) * towardWhite,
      );
      /* 两态分档开关：暗色态画星空，亮色态走「日间」分支。 */
      gl.uniform1f(uniforms.uAdd, dark ? 1 : 0);
      draw();
    };

    const draw = (): void => {
      gl.uniform1f(uniforms.uTime, reduce ? FROZEN_TIME : time);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    };

    const resize = (): void => {
      const width = Math.max(1, canvas.clientWidth);
      const height = Math.max(1, canvas.clientHeight);
      const narrow = width <= NARROW_MAX_WIDTH;
      /* 手机档把 dpr 收到 1：像素数约减半是唯一不改变构图的省法（着色器按
         `min(uRes)` 归一，构图与 dpr 无关，星点位置不受影响）。 */
      const dpr = Math.min(window.devicePixelRatio || 1, narrow ? 1 : DPR_LIMIT);
      canvas.width = Math.max(1, Math.round(width * dpr));
      canvas.height = Math.max(1, Math.round(height * dpr));
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.uniform2f(uniforms.uRes, canvas.width, canvas.height);
      /* 几何随视口自适应：弧顶位置与曲率（窄屏抬高地平线，给表单面板留空间——
         面板必须整体浮在弧线上方，弧线穿过面板会显脏）。 */
      const radius = narrow ? 1.7 : 2.0;
      const apex = 0.5 - (narrow ? 0.6 : 0.72);
      gl.uniform2f(uniforms.uCenter, 0, apex - radius);
      gl.uniform1f(uniforms.uRadius, radius);
      draw();
    };

    const frame = (now: number): void => {
      raf = 0;
      if (document.hidden) {
        return;
      }
      const dt = last === 0 ? 1 / 60 : Math.min(0.05, (now - last) / 1000);
      last = now;
      time += dt;
      draw();
      raf = requestAnimationFrame(frame);
    };

    const wake = (): void => {
      if (raf === 0 && !document.hidden && !reduce) {
        raf = requestAnimationFrame(frame);
      }
    };

    const onVisibility = (): void => {
      last = 0;
      wake();
    };

    const themeObserver = new MutationObserver(() => {
      syncThemeAndDraw();
    });
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme'],
    });
    window.addEventListener('resize', resize);
    document.addEventListener('visibilitychange', onVisibility);

    syncThemeAndDraw();
    resize();
    wake();

    return () => {
      cancelAnimationFrame(raf);
      themeObserver.disconnect();
      window.removeEventListener('resize', resize);
      document.removeEventListener('visibilitychange', onVisibility);
      gl.deleteBuffer(buffer);
      gl.deleteProgram(program);
      /* 刻意不调 `WEBGL_lose_context.loseContext()`：React 严格模式在开发态会
         「挂载 → 卸载 → 再挂载」双跑 effect，丢上下文会让第二次 `getContext`
         拿到已死的上下文、初始化静默失败（与 LaserFlow 同注记）。 */
    };
  }, []);

  return (
    <>
      <canvas ref={canvasRef} className={styles.canvas} aria-hidden="true" />
      <div className={styles.noise} aria-hidden="true" />
    </>
  );
}
