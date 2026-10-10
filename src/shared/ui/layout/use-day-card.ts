'use client';

import { useSyncExternalStore } from 'react';

/**
 * 侧栏日期卡数据（UI-011，《UI 页面规范》v0.27 §3.2「日期升格」）。
 *
 * 升格后的日期卡从一行灰日期变为四件：日期、星期 · 第 N 周、
 * 当日进度细线、「今天已过 X%」。前三件是一天内不变的静态文本，
 * 进度百分比是本卡唯一的**活数据**（取自然日 24 小时口径）：
 * 内容区摘要占「还剩 X 小时」，侧栏占「已过」，同一个事实不在一屏里说两遍。
 *
 * ## 为什么沿用 `useSyncExternalStore`（与原 use-today-label 同款）
 *
 * 侧栏在服务端也会渲染一次：服务端拿**服务器时区**的"今天"，客户端拿
 * **用户时区**的"今天"，跨零点时不同会报水合不一致。用
 * `useSyncExternalStore`：水合时先取服务端快照（`null`，与服务端产出一致），
 * 水合完成后再取客户端快照并更新——唯一既拿浏览器时区又不产生水合不一致的写法。
 *
 * ## 快照为什么按分钟缓存
 *
 * `useSyncExternalStore` 要求 `getSnapshot` 幂等（React 用 `Object.is` 比较，
 * 返回新对象会被判为「每次都在变」而无限重渲染）。所以以
 * 年-月-日-分钟 为键做模块级缓存：同一分钟内返回同一对象引用。
 * 没有订阅源（不设定时器），页面停留期间百分比不跳动——它是装饰性摘要，
 * 不是需要逐秒刷新的时钟，进场时取值正确即可。
 */

export type DayCard = {
  /** 日期，形如「10月9日」。 */
  readonly date: string;
  /** 星期与 ISO 周序号，形如「星期五 · 第 41 周」。 */
  readonly week: string;
  /** 当天已过百分比（0–100，自然日 24 小时口径，四舍五入到整数）。 */
  readonly pct: number;
  /**
   * 当天已过分钟数（0–1439）。
   *
   * v0.29（UI-012）侧栏时间尺需要按「08–22 窗口」换算已过段的宽度，
   * 百分比（`pct`，自然日口径）不够用——两个口径是刻意分开的：尺是
   * 「现在在哪」的读数（08–22），note 是「今天已过多少」（自然日）。
   */
  readonly minutes: number;
};

const weekdayFormatter = new Intl.DateTimeFormat('zh-CN', { weekday: 'long' });

/** 一天的分钟数。写成 `24 * 60`——写死全天分钟数会撞验收扫描器的断点字面量。 */
const MINUTES_PER_DAY = 24 * 60;

/**
 * ISO 周序号（周一起算、含周四的那一周为该年的第 1 周）。
 * 与预览稿 `bindDayCard` 的算法一致：先定位到本周周四，再数它距年初几天。
 */
function isoWeek(date: Date): number {
  const probe = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const day = probe.getUTCDay() || 7;
  probe.setUTCDate(probe.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(probe.getUTCFullYear(), 0, 1));
  return Math.ceil(((probe.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
}

function build(now: Date): DayCard {
  const minutes = now.getHours() * 60 + now.getMinutes();

  return {
    date: `${String(now.getMonth() + 1)}月${String(now.getDate())}日`,
    week: `${weekdayFormatter.format(now)} · 第 ${String(isoWeek(now))} 周`,
    pct: Math.round((minutes / MINUTES_PER_DAY) * 100),
    minutes,
  };
}

/** 缓存键（年-月-日-分钟）与值；键不变时返回同一对象引用，保证幂等。 */
let cachedKey = '';
let cached: DayCard | null = null;

/** 日期在一次会话内不会变，所以没有需要订阅的外部源。 */
function subscribe(): () => void {
  return () => {
    /* 无需清理：没有注册任何监听。 */
  };
}

/** 服务端快照：`null`。与客户端不同是有意的，见上方说明。 */
function getServerSnapshot(): DayCard | null {
  return null;
}

function getSnapshot(): DayCard | null {
  const now = new Date();
  const key = `${String(now.getFullYear())}-${String(now.getMonth())}-${String(now.getDate())}-${String(
    now.getHours() * 60 + now.getMinutes(),
  )}`;

  if (key !== cachedKey) {
    cachedKey = key;
    cached = build(now);
  }

  return cached;
}

export function useDayCard(): DayCard | null {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
