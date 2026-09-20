'use client';

/**
 * 设置页的两个有状态行为（IAM-002，《UI 页面规范》v0.16 §5）。
 *
 * 放在一个文件里而不是各自一个：它们都是"设置页的交互纪律"——一个管保存
 * （进行中、错误、防重复提交），一个管离开（脏页确认）。两者共享同一份
 * 错误文案映射，分开会让那段映射要么重复、要么被塞进一个语义不明的公共文件。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';

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

export type UnsavedChangesGuard = {
  /** 是否正在等待用户确认离开。 */
  readonly pendingLeave: boolean;
  readonly confirmLeave: () => void;
  readonly cancelLeave: () => void;
};

/**
 * 脏页离开守卫（§5「有未保存修改的分区给出标记；路由离开脏页须确认」）。
 *
 * ## 两条路径都要挡，因为浏览器把它们分成两件事
 *
 * - **硬导航**（刷新、关标签、输入新地址）只能走 `beforeunload`，浏览器会弹它
 *   自己的确认框——**文案与外观不可定制**，这是浏览器的安全约束，不是偷懒。
 * - **站内导航**（点侧栏、点品牌链接）不会触发 `beforeunload`，必须自己拦点击。
 *   拦截点选在 `document` 的**捕获阶段**：外壳里的导航项没有、也不该有"通知
 *   设置页"的职责，让设置页去监听全局点击，比让每个导航项都学会"问一下当前页
 *   能不能走"要简单得多，也不会给导航组件引入一个它不需要的耦合。
 *
 * 拦下之后由调用方渲染一个 `ConfirmDialog`——复用组件库已有的确认弹窗，
 * 而不是 `window.confirm`：后者会阻塞主线程、样式不可控，且在自动化测试里
 * 需要额外的对话框处理。
 */
export function useUnsavedChangesGuard(isDirty: boolean): UnsavedChangesGuard {
  const router = useRouter();
  const [pendingHref, setPendingHref] = useState<string | null>(null);

  // 用 ref 读脏状态：点击监听只注册一次（它要长期存在），而 `isDirty` 每次
  // 渲染都在变。把它放进依赖会反复解绑/重绑全局监听，还可能漏掉两次绑定之间的点击。
  const isDirtyRef = useRef(isDirty);
  useEffect(() => {
    isDirtyRef.current = isDirty;
  }, [isDirty]);

  useEffect(() => {
    if (!isDirty) {
      return;
    }

    const handleBeforeUnload = (event: BeforeUnloadEvent): void => {
      // 现代浏览器忽略自定义文案，只认"是否 preventDefault"。
      event.preventDefault();
    };

    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => {
      window.removeEventListener('beforeunload', handleBeforeUnload);
    };
  }, [isDirty]);

  useEffect(() => {
    const handleClick = (event: MouseEvent): void => {
      if (!isDirtyRef.current || event.defaultPrevented) {
        return;
      }
      // 带修饰键的点击、中键、"在新标签打开"都不是"离开当前页"，放行。
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
        return;
      }

      const anchor = event.target instanceof Element ? event.target.closest('a[href]') : null;
      if (!(anchor instanceof HTMLAnchorElement) || anchor.target !== '') {
        return;
      }

      const rawHref = anchor.getAttribute('href');
      if (rawHref === null || rawHref.startsWith('#')) {
        return;
      }

      const destination = new URL(anchor.href, window.location.href);
      // 外站链接与"跳回本页同一个地址"都不算导航离开，交给浏览器按原样处理。
      if (destination.origin !== window.location.origin) {
        return;
      }
      if (
        destination.pathname === window.location.pathname &&
        destination.search === window.location.search
      ) {
        return;
      }

      event.preventDefault();
      setPendingHref(`${destination.pathname}${destination.search}`);
    };

    document.addEventListener('click', handleClick, true);
    return () => {
      document.removeEventListener('click', handleClick, true);
    };
  }, []);

  const confirmLeave = useCallback((): void => {
    setPendingHref((href) => {
      if (href !== null) {
        router.push(href);
      }
      return null;
    });
  }, [router]);

  const cancelLeave = useCallback((): void => {
    setPendingHref(null);
  }, []);

  return { pendingLeave: pendingHref !== null, confirmLeave, cancelLeave };
}
