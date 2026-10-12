/**
 * 登录页「星球黎明」背景的着色器源码（v0.30 登录页 hero 面）。
 *
 * 来源＝预览稿 `temp/login-preview.html`（需求方已验收的视觉准据）里跑通的那一份
 * 片元着色器，逐段原样保留，只做两件事：拆成带说明的常量、补每段的意图注释。
 *
 * ## 它画什么
 *
 * 一个正交全屏三角形 + 片元着色器，画三层东西：
 * 1. **星球**：屏幕下方的大圆（`d = length(p - uCenter) - uRadius`，<0 在星球内、
 *    >0 在太空侧）——内缘暮光（日出侧暖、背光侧微冷）+ 表面 fbm 微纹理 + 向下渐沉，
 *    保持剪影感；
 * 2. **日出大气**：以弧顶为方位的暖区（`sun = exp(-(p.x / 0.34)²)`）叠三层指数晕
 *    （紧致亮环 / 带 shimmer 的中晕 / 冷纱）+ 一条极细的地平线亮弧；
 * 3. **星空**（只画在暗色态）：采样网格 + 逐星位置抖动（破网格感）、幂律星等
 *    （多数暗星、极少亮星）、四档色温、近地平线更强的大气闪烁、亮星四向衍射星芒、
 *    银河带加密与薄雾，以及绕 `(0.35, 0.30)` 的极缓慢天移。
 *
 * ## 为什么单独成文件
 *
 * 与 LaserFlow 同例：着色器近两百行、只随「画面本身」演进；驱动逻辑（编译、
 * uniform 赋值、rAF、主题与尺寸响应）在 `LoginBackdrop.tsx` 里各自独立。调画面
 * 只动本文件，调时序与降级只动组件。
 *
 * ## 颜色纪律
 *
 * 颜色**全部**由驱动侧从令牌读出后经 uniform 传入（`uBg` / `uBody` / `uWarm` /
 * `uAtmo` / `uHot`），本文件里没有色值；星色与白热核那几处 `vec3` 常量是着色器
 * 内部的光学常量（星点色温、噪声抖动），不属设计令牌族。
 */

export const DAWN_VERTEX_SOURCE = `attribute vec2 aPos;
void main() {
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

export const DAWN_FRAGMENT_SOURCE = `precision highp float;
uniform vec2 uRes;
uniform float uTime;
uniform vec2 uCenter;
uniform float uRadius;
uniform vec3 uBg;
uniform vec3 uBody;
uniform vec3 uWarm;
uniform vec3 uAtmo;
uniform vec3 uHot;
uniform float uAdd;

float hash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}

float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = hash(i);
  float b = hash(i + vec2(1.0, 0.0));
  float c = hash(i + vec2(0.0, 1.0));
  float d = hash(i + vec2(1.0, 1.0));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

float fbm(vec2 p) {
  float v = 0.0;
  float a = 0.5;
  for (int i = 0; i < 5; i++) {
    v += a * noise(p);
    p *= 2.03;
    a *= 0.5;
  }
  return v;
}

void main() {
  vec2 frag = gl_FragCoord.xy;
  /* 归一化坐标：短边为 1，构图在任意视口下保持同比例 */
  vec2 p = (frag - 0.5 * uRes) / min(uRes.x, uRes.y);
  float t = uTime * 0.1;
  /* 有符号距离：<0 星球内 / >0 太空侧 */
  float d = length(p - uCenter) - uRadius;
  float above = max(d, 0.0);
  float below = max(-d, 0.0);
  /* 日出方位：暖色集中在弧顶正后方 ±0.34，两侧转冷 */
  float sun = exp(-pow(p.x / 0.34, 2.0));
  /* 入场：黎明渐亮（1.4s 内从 30% 升到全亮） */
  float gate = 0.30 + 0.70 * smoothstep(0.0, 1.4, uTime);
  float shimmer = 0.90 + 0.10 * fbm(vec2(p.x * 2.6, p.y * 2.6 + t * 0.35));
  float spaceMask = 1.0 - smoothstep(0.0, 0.004, below);

  /* ── 星空 ────────────────────────────────────────────────────────────
     幂律星等 + 色温四档 + 逐星相位大气闪烁（近地平线更强）+ 大尺度聚集
     （银河带加密）+ 极缓慢天移（截图看不出，看几秒才「活」）。 */
  float ang = uTime * 0.004;
  vec2 cp = p - vec2(0.35, 0.30);
  vec2 rp = vec2(cp.x * cos(ang) - cp.y * sin(ang), cp.x * sin(ang) + cp.y * cos(ang)) + vec2(0.35, 0.30);
  vec2 sp = rp * 40.0;
  vec2 ci = floor(sp);
  vec2 cf = fract(sp);
  /* 银河带：沿斜向的一条高斯带（星更密、另有薄雾） */
  float bandF = exp(-pow((p.y - 0.18 - p.x * 0.22) * 3.0, 2.0));
  float clump = (0.55 + 0.75 * fbm(p * 0.9 + 13.1)) * (1.0 + 1.3 * bandF);
  /* 存在性阈值：0.025 是「安静夜空」的星量（需求方两轮减星后的定稿） */
  float exists = step(hash(ci + 3.3), 0.025 * clump);
  /* 逐星位置抖动：不抖会露出规则网格 */
  vec2 oc = cf - 0.5 - (vec2(hash(ci + 11.3), hash(ci + 27.1)) - 0.5) * 0.8;
  float d2 = dot(oc, oc);
  float mag = pow(hash(ci + 5.9), 5.0);
  float rad = 0.050 + 0.095 * mag;
  float ph = hash(ci + 41.7) * 6.283;
  float lowAmp = mix(0.34, 0.12, smoothstep(0.0, 0.5, above));
  float scint = 1.0 - lowAmp * (0.5 + 0.5 * sin(uTime * 2.3 + ph) * sin(uTime * 4.7 + ph * 1.7));
  float sd = max(sqrt(d2), 0.0004);
  /* PSF 剖面（亮核 + 长尾柔晕）：比单一高斯更像真实星点 */
  float starCore = min(0.30 * pow(rad / sd, 2.6), 2.4);
  float spike = 0.0;
  if (mag > 0.75) {
    /* 极少数亮星：四向细衍射星芒 */
    spike = (exp(-abs(oc.x) * 3.5) * exp(-abs(oc.y) * 60.0) + exp(-abs(oc.y) * 3.5) * exp(-abs(oc.x) * 60.0)) * 0.28;
  }
  float bloom = exp(-d2 * 7.0) * 0.07 * mag;
  float starI = exists * (starCore * (0.30 + 0.85 * mag) + spike + bloom) * scint * gate
    * smoothstep(0.0, 0.04, above) * (0.35 + 0.65 * smoothstep(0.0, 0.55, above)) * spaceMask;
  float ct = hash(ci + 63.1);
  /* 色温分区：蓝白 72% / 纯白 18% / 微黄 6.5% / 橙 3.5% */
  vec3 tint = mix(mix(mix(vec3(0.80, 0.86, 1.0), vec3(1.0, 0.99, 0.95), step(0.72, ct)), vec3(1.0, 0.92, 0.78), step(0.90, ct)), vec3(1.0, 0.80, 0.64), step(0.965, ct));

  vec3 col = uBg;
  if (uAdd > 0.5) {
    /* ── 暗色态：星夜 ───────────────────────────────────────────────── */
    /* 高空更沉、近地平线提亮一档 */
    col *= 0.72 + 0.28 * exp(-above * 1.2);
    col += tint * starI;
    /* 银河带薄雾 */
    col += mix(uAtmo, uWarm, 0.12) * bandF * (0.5 + 0.5 * fbm(vec2(p.x * 2.0, p.y * 2.0))) * 0.018 * spaceMask * gate;
    /* 星球本体：表面微纹理（±30%）+ 向下渐沉 30%（剪影感） */
    float bodyMask = 1.0 - smoothstep(-0.004, 0.002, d);
    float surf = fbm(vec2(p.x * 2.6, p.y * 2.6 + t * 0.10));
    vec3 bodyCol = uBody * (1.0 - (1.0 - surf) * 0.30);
    bodyCol *= 1.0 - 0.30 * smoothstep(-0.10, -0.5, p.y);
    col = mix(col, bodyCol, bodyMask);
    /* 内缘暮光：日出侧暖、背光侧微冷 */
    col += mix(uAtmo * 0.5, uWarm, sun) * exp(-below * 15.0) * (0.10 + 0.40 * sun) * bodyMask;
    col += uAtmo * exp(-below * 6.0) * 0.045 * (1.0 - sun) * bodyMask;
    /* 大气三层：紧致亮环 / 中晕（带 shimmer）/ 冷纱 */
    float a1 = exp(-above * 60.0) * spaceMask;
    float a2 = exp(-above * 14.0) * spaceMask;
    float a3 = exp(-above * 3.4) * spaceMask;
    col += mix(uAtmo * 1.3, uHot, sun) * a1 * (0.12 + 0.42 * sun) * gate;
    col += mix(uAtmo, uWarm, sun) * a2 * (0.10 + 0.22 * sun) * shimmer * gate;
    col += uAtmo * a3 * 0.035 * gate;
    /* 地平线细化：一条极紧的亮弧 */
    col += mix(uAtmo * 1.3, uHot, sun) * exp(-abs(d) * 220.0) * (0.20 + 0.70 * sun) * gate;
  } else {
    /* ── 亮色态：昼【星球为浅灰盘、弧线为冷蓝，不画星】 ────────────────── */
    float bodyMask = 1.0 - smoothstep(-0.004, 0.002, d);
    float surf = fbm(vec2(p.x * 2.6, p.y * 2.6));
    vec3 bodyCol = uBody * (1.0 - (1.0 - surf) * 0.06);
    bodyCol *= 0.97 + 0.05 * exp(-below * 8.0);
    col = mix(col, bodyCol, bodyMask);
    float a1 = exp(-above * 60.0) * spaceMask;
    float a2 = exp(-above * 14.0) * spaceMask;
    float a3 = exp(-above * 3.4) * spaceMask;
    float k = a1 * (0.16 + 0.38 * sun) + a2 * (0.10 + 0.18 * sun) + a3 * 0.06 + exp(-abs(d) * 220.0) * (0.20 + 0.50 * sun);
    col = mix(col, mix(uAtmo, uWarm, sun), clamp(k, 0.0, 1.0) * 0.55);
  }
  /* 静态颗粒：抹掉大色块的色带（幅度随两态分档） */
  col += (hash(frag * 0.83) - 0.5) * (uAdd > 0.5 ? 0.010 : 0.005);
  gl_FragColor = vec4(col, 1.0);
}`;
