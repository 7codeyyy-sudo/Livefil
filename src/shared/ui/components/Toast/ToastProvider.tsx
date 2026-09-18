'use client';

import { useCallback, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';

import { Toast } from './Toast';
import { ToastRegion } from './ToastRegion';
import { ToastContext } from './toast-context';
import type { ToastApi, ToastOptions, ToastRecord, ToastVariant } from './toast-context';

/**
 * 同时可见的提示条数上限（§4.5 冻结：底部居中堆叠、同时最多 3 条）。
 */
const MAX_VISIBLE = 3;

/**
 * 把新条并入队列。
 *
 * ## 满 3 条时淘汰谁
 *
 * 只淘汰**可自动关闭**的条里最老的那条（数组头部即最早）。错误态常驻条
 * **永不因新条被淘汰**——它的存在本身就是在履行 NFR-REL-002（失败必须明确
 * 提示），被一条新来的普通提示挤掉，等于把失败吞掉了。
 *
 * ## 一个规范没有覆盖的边缘
 *
 * 3 个槽**全被常驻错误占满**时，可淘汰集合是空的，于是新来的一律丢弃
 * （包括新的错误条）。这里选择"丢新的"而不是"挤掉最老的错误"，是为了与
 * 「常驻条永不因新条被淘汰」这条更强的规则保持一致；代价是新失败暂时
 * 没有提示。真出现这种连番失败的场景（例如断网时连续三次保存失败），
 * 应由调用方在业务层合并成一条，而不是靠提示通道堆叠。
 */
function appendRecord(list: readonly ToastRecord[], record: ToastRecord): readonly ToastRecord[] {
  if (list.length < MAX_VISIBLE) {
    return [...list, record];
  }

  const evictableIndex = list.findIndex((item) => item.variant !== 'danger');
  if (evictableIndex === -1) {
    return list;
  }

  const next = [...list];
  next.splice(evictableIndex, 1);
  return [...next, record];
}

export type ToastProviderProps = {
  readonly children: ReactNode;
};

/**
 * 全局提示通道（UI-002 批次 3b）。
 *
 * ## 为什么是 Provider + `useToast()`，而不是模块级单例
 *
 * 单例（`toast.show()` 直接可用）唯一不可替代的价值是**从非 React 代码**
 * 里调用（请求拦截器、store）。当前 `src/shared` 下不存在这样的调用方，
 * 而代价是一份模块级的可变注册表：测试之间要手动重置、忘了挂载容器就会
 * 静默丢失提示、以及 SSR 下的跨请求串味。等真出现非 React 调用方，
 * 在 Provider 之下再挂一个 emitter 适配即可，不必现在为它铺路。
 *
 * ## 挂在根布局
 *
 * `app/layout.tsx` 里包一层，使整个应用共享同一条通道与同一个队列——
 * 「最多 3 条」才是在**全站范围**内成立的上限，而不是每个页面各自 3 条。
 */
export function ToastProvider({ children }: ToastProviderProps) {
  const [toasts, setToasts] = useState<readonly ToastRecord[]>([]);
  const sequence = useRef(0);

  /**
   * 请求关闭（幂等）：置为退场中。
   *
   * 真正的摘除发生在退场动画播完之后（由 `remove` 完成）——若在这里直接删，
   * 元素会被 React 当场卸载，退场动画一帧都播不出来。
   */
  const dismiss = useCallback((id: string) => {
    setToasts((prev) => prev.map((item) => (item.id === id ? { ...item, closing: true } : item)));
  }, []);

  const remove = useCallback((id: string) => {
    setToasts((prev) => prev.filter((item) => item.id !== id));
  }, []);

  const push = useCallback(
    (message: string, variant: ToastVariant, options: ToastOptions | undefined) => {
      // 在 `setState` 之外生成 id：调用方需要拿到返回值。
      // 计数而不是随机串——测试可以据此断言先后顺序，日志里也更好读。
      sequence.current += 1;
      const id = `toast-${String(sequence.current)}`;

      setToasts((prev) =>
        appendRecord(prev, {
          id,
          message,
          variant,
          action: options?.action,
          closing: false,
        }),
      );

      return id;
    },
    [],
  );

  /**
   * 命令面。四个成员都是稳定引用，所以这个对象本身也稳定——
   * 否则每次队列变化都会让所有 `useToast()` 的消费者重渲染。
   */
  const api = useMemo<ToastApi>(
    () => ({
      show: (message, options) => push(message, options?.variant ?? 'info', options),
      // `success` / `error` 固定变体，传入的 `variant` 会被忽略——两个便捷方法
      // 的意义就是"不用记变体名"，允许覆盖只会让调用点又出现字符串。
      success: (message, options) => push(message, 'success', options),
      error: (message, options) => push(message, 'danger', options),
      dismiss,
    }),
    [push, dismiss],
  );

  return (
    <ToastContext.Provider value={api}>
      {children}
      <ToastRegion>
        {toasts.map((item) => (
          <Toast key={item.id} record={item} onDismiss={dismiss} onExited={remove} />
        ))}
      </ToastRegion>
    </ToastContext.Provider>
  );
}
