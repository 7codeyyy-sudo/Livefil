'use client';

import { useSyncExternalStore } from 'react';

import { BackgroundField } from '@/shared/ui/layout/BackgroundField/BackgroundField';

import {
  getAppearanceServerSnapshot,
  getAppearanceSnapshot,
  subscribeAppearance,
} from '../_lib/appearance/appearance-store';

/**
 * 全站装饰性背景的挂载容器（UI-009）。
 *
 * ## 为什么读偏好的容器要在应用层，而不是组件自己读
 *
 * `BackgroundField` 住在 `src/shared/**`，而共享层**不得反向依赖应用层**（依赖
 * 规则）。偏好存在应用层的 `appearance-store` 里，因此由这个应用层容器读偏好、
 * 把纯展示的 `BackgroundField` 作为叶子渲染——与同步横幅、帮助抽屉的做法一致。
 *
 * ## 快照为 `null` 时不渲染
 *
 * 服务端没有 `localStorage`，`getAppearanceServerSnapshot` 恒返回 `null`；
 * 客户端水合后才会拿到真实档位。`null` 即"还没水合"，此时**整块不渲染**，
 * 避免在服务端与客户端画出不同几何造成水合不匹配。默认档是 `tesseract`，
 * 因此正常情况下背景会在水合后立即出现。
 */
export function BackgroundFieldContainer() {
  const choice = useSyncExternalStore(
    subscribeAppearance,
    getAppearanceSnapshot,
    getAppearanceServerSnapshot,
  );

  if (choice === null) {
    return null;
  }

  return <BackgroundField choice={choice} />;
}
