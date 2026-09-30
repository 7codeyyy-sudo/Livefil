'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useRef } from 'react';

import { GuideBar } from '@/shared/ui/components';

import { evaluateGuide, GUIDE_STEPS, TOTAL_GUIDE_STEPS } from '../_lib/guide/guide-steps';

import { useGuideContext } from './GuideProvider';

/**
 * 引导条容器（《UI 页面规范》v0.22 §5 A，AI-001）。
 *
 * ## 它落在今日页，且只落在今日页
 *
 * §5 A 的入口时机是「本地模式首启、无完成标记、进入 `/today`」。所以核对（要发
 * 请求的那部分）只在这里发生：外壳每页都挂着 `GuideProvider`，若由它去核对，
 * 用户每换一个页面都会打一轮接口。
 *
 * ## 核对时点：挂载一轮 + 页面重新可见一轮，**不轮询**
 *
 * §5 A 冻结「挂载跑一轮；`visibilitychange` hidden→visible 再跑一轮；不轮询、
 * 不自动定时重复请求」。用户去别的页面做完一件事再回来，靠的是重新挂载；把应用
 * 切到后台再切回来，靠的是 `visibilitychange`。两者都不需要计时器。
 *
 * ## 失败安全
 *
 * 判定失败**不抛页面错误**（见 `evaluateGuide`）：这一轮不推进，引导条原样停在
 * 当前步；用户下次进来再判一次。ABORTED 的那一轮连写回都不做。
 */
export function GuideBarContainer() {
  const router = useRouter();
  const { state, visible, advance, dismiss } = useGuideContext();

  // 核对用的进度快照。用 ref 而不是把 `state.step` 放进 effect 依赖：那样每推进
  // 一步都会重跑一轮请求，与"两轮核对"的冻结口径不符（真正的轮询）。
  const stepRef = useRef(0);
  useEffect(() => {
    stepRef.current = state?.step ?? 0;
  }, [state]);

  const advanceRef = useRef(advance);
  useEffect(() => {
    advanceRef.current = advance;
  }, [advance]);

  useEffect(() => {
    // 不可见（已跳过 / 已完成 / 尚未读出）时不核对：省掉一轮必然无用的请求。
    if (!visible) {
      return;
    }

    const controller = new AbortController();

    function check(): void {
      void evaluateGuide(stepRef.current, controller.signal).then((step) => {
        // 中止之后的结果一律丢弃：那是上一轮或已卸载组件的结论。
        if (!controller.signal.aborted) {
          advanceRef.current(step);
        }
      });
    }

    check();

    function onVisibilityChange(): void {
      if (document.visibilityState === 'visible') {
        check();
      }
    }

    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      controller.abort();
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [visible]);

  if (state === null || !visible) {
    return null;
  }

  // `visible` 已排除 `completed`，所以下标一定落在四步之内；仍做一次收拢，
  // 免得本地被手工改成越界值时整页崩掉（`GuideState` 是不可信输入）。
  const stepIndex = Math.min(state.step, TOTAL_GUIDE_STEPS - 1);
  const definition = GUIDE_STEPS[stepIndex];
  if (definition === undefined) {
    return null;
  }

  return (
    <GuideBar
      stepNumber={stepIndex + 1}
      totalSteps={TOTAL_GUIDE_STEPS}
      cardText={definition.cardText}
      actionLabel={definition.actionLabel}
      onAction={() => {
        // 主操作只导航、不关引导：用户去把这件事做完，回到今日页时判定自然推进。
        router.push(definition.href);
      }}
      onSkip={dismiss}
      onClose={dismiss}
    />
  );
}
