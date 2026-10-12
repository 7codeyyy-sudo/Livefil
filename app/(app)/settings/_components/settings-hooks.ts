'use client';

/**
 * 设置页的保存行为（IAM-002，《UI 页面规范》v0.16 §5 → PM-20261012-008 两栏化）。
 *
 * ## 为什么只剩一件事
 *
 * 原先这里与保存并列的还有第二个 hook——离开守卫（`beforeunload` 系统框 +
 * document 捕获阶段拦截站内导航点击 + 自绘确认弹窗）。两栏化后它**整体移除**：
 * 单页 8 分区结构下它制造了实测的「连环弹窗」（提案问题 3），而两栏化把
 * 草稿状态升到布局级 Provider 后，栏间切换本身已不再丢数据（`SettingsForm`
 * 文件头有完整口径）——未保存态只在栏内以「未保存」徽章提示即可。
 *
 * 保存纪律（进行中、错误、防重复提交）与离开语义无关，原样保留。
 */
import { useCallback, useRef, useState } from 'react';

import { ApiRequestError } from '../../_lib/api-client';

export type SaveAction = {
  /** 保存进行中：按钮进入 `loading` 并禁用。 */
  readonly saving: boolean;
  /** 上一次保存的失败原因；成功或再次保存时清空。 */
  readonly error: string | null;
  /** 执行一次保存。重复调用（前一次未结束）会被直接忽略。 */
  readonly run: (task: () => Promise<void>) => Promise<void>;
};

/**
 * 保存动作的状态机。
 *
 * ## 为什么在这里再挡一次重复提交
 *
 * `Button` 的 `loading` 已经会让按钮禁用，但那只覆盖"通过这个按钮触发"的路径。
 * 真正可靠的做法是在**动作本身**上挡：无论调用方是谁、无论按钮状态有没有及时
 * 更新，同一时刻只允许一次保存在飞。设置是幂等的 PATCH，但重复提交仍会制造
 * 无意义的版本自增，并让乐观并发在用户自己手里"冲突"。
 *
 * ## 为什么 409 要单独给文案
 *
 * 409 不是"保存失败"，而是"你手上的版本已经过时了"——用户再点一百次保存都不会
 * 成功。服务端的 message 说的是数据层面的话，界面需要一句能指导下一步动作的话。
 */
export function useSaveAction(): SaveAction {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);

  const run = useCallback(async (task: () => Promise<void>): Promise<void> => {
    if (inFlight.current) {
      return;
    }
    inFlight.current = true;
    setSaving(true);
    setError(null);

    try {
      await task();
    } catch (cause) {
      setError(toSaveErrorMessage(cause));
    } finally {
      inFlight.current = false;
      setSaving(false);
    }
  }, []);

  return { saving, error, run };
}

/** 保存失败的文案映射。 */
export function toSaveErrorMessage(cause: unknown): string {
  if (cause instanceof ApiRequestError && cause.status === 409) {
    return '这组设置已在别处被修改。请重新加载页面后再保存。';
  }
  return cause instanceof Error ? cause.message : '保存失败，请重试。';
}
