'use client';

import { useAsyncQuery } from '@/shared/ui/components';

import { fetchProfile } from './identity-api';

/**
 * 读当前用户的 `aiEnabled`（《UI 页面规范》§5 E 的唯一判定源）。
 *
 * ## 返回 `boolean | null`
 *
 * `null` 表示**还没读出来**（`/me` 加载中或取数失败）。各 AI 入口据此**不渲染**：
 * §5 E 写死「`ai_enabled=false` 时全部 AI 入口隐藏不渲染」，而把"还不知道"当成
 * `false` 渲染，会在首帧把入口藏起来再冒出来（闪烁），也会在 `/me` 失败时
 * 谎称"用户关了 AI"。判定源是 `GET /me` 的 `UserDto.aiEnabled`（与设置页分区 5
 * 同一字段，两层分工见 §5 C4）。
 *
 * ## 为什么不缓存
 *
 * 取数原语明确不缓存（§4.7），多入口各读一次是既有口径；`/me` 是极轻的读，
 * 且开关一旦在设置页改动，下次进入页面即随新渲染生效（§5 E 第 4 条）。
 */
export function useAiEnabled(): boolean | null {
  const profile = useAsyncQuery({ queryKey: ['me'], queryFn: fetchProfile });
  return profile.state.status === 'success' ? profile.state.data.data.aiEnabled : null;
}
