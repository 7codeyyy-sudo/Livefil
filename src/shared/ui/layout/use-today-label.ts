'use client';

import { useSyncExternalStore } from 'react';

/**
 * 侧栏顶部的「今天是」文案（UI-003）。
 *
 * ## 为什么不能直接 `new Date()`
 *
 * 侧栏在服务端也会渲染一次。服务端拿的是**服务器时区**的"今天"，
 * 客户端拿的是**用户时区**的"今天"——两者跨零点时会不同，React 会把这种
 * 差异报成水合不一致；更糟的是静默的那种：内容对得上、但日期是错的。
 *
 * 所以这里用 `useSyncExternalStore`：React 在**水合时先取服务端快照**
 * （空串，与服务端产出一致），水合完成后再取客户端快照并更新。
 * 这是唯一既能拿到浏览器时区、又不产生水合不一致的写法——
 * 相比之下 `useState(() => new Date())` 在首帧就会两边不一致，
 * 而 `useEffect` 里 `setState` 会撞 React 19 的 `set-state-in-effect`。
 *
 * ## 时区来源
 *
 * 现在用**浏览器时区**，它本身就是用户所在时区。等 IAM 引入用户档案
 * （Phase 2）后若要以档案里的时区为准，只需把格式化器换成带
 * `timeZone` 选项的版本，本文件的三个快照函数不用动。
 *
 * ## 为什么快照函数写在模块作用域
 *
 * `useSyncExternalStore` 要求 `subscribe` 与 `getSnapshot` 是稳定引用；
 * 写成内联箭头函数会每次渲染都重新订阅。
 */

const formatter = new Intl.DateTimeFormat('zh-CN', {
  weekday: 'long',
  month: 'numeric',
  day: 'numeric',
});

/** 日期在一次会话内不会变，所以没有需要订阅的外部源。 */
function subscribe(): () => void {
  return () => {
    /* 无需清理：没有注册任何监听。 */
  };
}

/** 服务端快照：空串。与客户端快照不同是有意的，见上方说明。 */
function getServerSnapshot(): string {
  return '';
}

/**
 * 客户端快照：形如「星期二，9月15日」。
 *
 * 用 `formatToParts` 自行拼接而不是取 `format()` 的默认顺序：中文下默认是
 * 「9月15日星期二」，而原型的顺序是星期在前。返回值是字符串，因此同一渲染
 * 周期内多次调用结果恒等，满足 `getSnapshot` 的幂等要求。
 */
function getSnapshot(): string {
  const parts = formatter.formatToParts(new Date());
  const weekday = parts.find((part) => part.type === 'weekday')?.value ?? '';
  const month = parts.find((part) => part.type === 'month')?.value ?? '';
  const day = parts.find((part) => part.type === 'day')?.value ?? '';

  return `${weekday}，${month}月${day}日`;
}

export function useTodayLabel(): string {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
