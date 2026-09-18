'use client';

import { createContext, useContext } from 'react';

/**
 * 提示的语义变体（§4.5，v0.8 冻结）。
 *
 * 只三种，**刻意不做 warning**：v0.8 文本只冻结了「普通 / 成功 / 错误」，
 * 而当前没有任何消费者需要「警告」。按令牌体系一贯的「需要才落」，
 * 多一个变体就是多一条没人验证的渲染分支与图标。
 */
export type ToastVariant = 'info' | 'success' | 'danger';

/**
 * 提示上的操作（如「撤销」）。
 *
 * 组件只提供**槽位**，不内置任何业务逻辑：撤销什么、能不能撤销、撤销失败
 * 怎么办，全都是调用方的语义（§4.5 明说「随真实消费者接线」）。
 */
export type ToastAction = {
  readonly label: string;
  readonly onClick: () => void;
};

export type ToastOptions = {
  /** 语义变体，默认 `info`。 */
  readonly variant?: ToastVariant | undefined;
  readonly action?: ToastAction | undefined;
};

/**
 * `useToast()` 的命令面。
 *
 * 三个 `show/success/error` 都返回本条提示的 id，可直接交给 `dismiss`。
 */
export type ToastApi = {
  readonly show: (message: string, options?: ToastOptions) => string;
  /** 成功态：`role="status"`，5 秒自动关闭（带操作则 8 秒）。 */
  readonly success: (message: string, options?: ToastOptions) => string;
  /** 错误态：`role="alert"`，**常驻不自动关闭**（NFR-REL-002），只能手动关或代码 `dismiss`。 */
  readonly error: (message: string, options?: ToastOptions) => string;
  readonly dismiss: (id: string) => void;
};

/**
 * 队列里的一条提示（**内部类型，不从组件出口导出**）。
 */
export type ToastRecord = {
  readonly id: string;
  readonly message: string;
  readonly variant: ToastVariant;
  readonly action: ToastAction | undefined;
  /**
   * 已请求关闭、正在播退场。
   *
   * 这一位必须放在**队列侧**，不能只做单条组件的本地 state：关闭有两个来源
   * （用户点 ×、代码调 `dismiss(id)`），而自动关闭也可能在退场途中撞上 `dismiss`。
   * 放在队列里，两条路径自然汇成一处，也不必给「重复关闭」写专门判断。
   */
  readonly closing: boolean;
};

export const ToastContext = createContext<ToastApi | null>(null);

/**
 * 取用提示通道。
 *
 * 未挂 Provider 时**直接抛错**，而不是静默降级成一个空实现：静默的话，
 * 一次「保存成功」的提示会凭空消失，而它往往正是用户确认操作已生效的唯一
 * 反馈——比在开发期崩掉更难查。
 */
export function useToast(): ToastApi {
  const api = useContext(ToastContext);
  if (api === null) {
    throw new Error('useToast() 必须在 <ToastProvider> 内使用：请在根布局挂上它。');
  }
  return api;
}
