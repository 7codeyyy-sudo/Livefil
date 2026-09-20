/**
 * 共享 UI 组件统一出口（UI-002）。
 *
 * 只导出组件与它们的公开类型——不导出内部样式模块或辅助函数，
 * 避免调用方依赖实现细节。
 *
 * 分批交付：批次 1 是表单原子（Button / IconButton / Input / Select / Textarea），
 * 批次 2 是展板与导航（Badge / Progress / Tabs），
 * 批次 3a 是模态浮层（Modal / ConfirmDialog），批次 3b 是抽屉与全局提示通道
 * （Drawer / ToastProvider / useToast），批次 4 是页面状态
 * （EmptyState / LoadingState + Skeleton / ErrorState），UI-004 是异步取数
 * （AsyncState / useAsyncQuery）与离线提示（OfflineBanner / useOnlineStatus）。
 *
 * **浮层基建（`_internal/overlay`）刻意不出现在这里**：它是这几个组件共用的
 * 实现细节，不是对外 API（§2.4 明确「不对外导出通用浮层框架」）。
 *
 * **`Toast` 单条与 `ToastRecord` 也不出现在这里**：单条由 `ToastProvider` 依据
 * 自己的队列渲染，`ToastRecord` 里有 `closing` 这类队列内部状态。对外只开
 * 「唤起一条提示」的入口（`useToast`），不开「手工拼一条并塞进队列」的口子。
 */
export { Badge } from './Badge/Badge';
export type { BadgeProps, BadgeVariant } from './Badge/Badge';
export { Button } from './Button/Button';
export type { ButtonProps, ButtonVariant } from './Button/Button';
export { ConfirmDialog } from './ConfirmDialog/ConfirmDialog';
export type { ConfirmDialogProps } from './ConfirmDialog/ConfirmDialog';
export { Drawer } from './Drawer/Drawer';
export type { DrawerProps } from './Drawer/Drawer';
export { EmptyState } from './EmptyState/EmptyState';
export type { EmptyStateProps } from './EmptyState/EmptyState';
export { ErrorState } from './ErrorState/ErrorState';
export type { ErrorStateProps } from './ErrorState/ErrorState';
export { IconButton } from './IconButton/IconButton';
export type { IconButtonProps } from './IconButton/IconButton';
export { Input } from './Input/Input';
export type { InputProps } from './Input/Input';
export { LoadingState } from './LoadingState/LoadingState';
export type { LoadingStateProps } from './LoadingState/LoadingState';
export { Modal } from './Modal/Modal';
export type { ModalProps } from './Modal/Modal';
export { Progress } from './Progress/Progress';
export type { ProgressProps } from './Progress/Progress';
export { Select } from './Select/Select';
export type { SelectProps } from './Select/Select';
export { Skeleton } from './LoadingState/Skeleton';
export type { SkeletonProps } from './LoadingState/Skeleton';
export { Tabs } from './Tabs/Tabs';
export type { TabItem, TabsProps } from './Tabs/Tabs';
export { Textarea } from './Textarea/Textarea';
export type { TextareaProps } from './Textarea/Textarea';
export { ToastProvider } from './Toast/ToastProvider';
export type { ToastProviderProps } from './Toast/ToastProvider';
export { useToast } from './Toast/toast-context';
export type { ToastAction, ToastApi, ToastOptions, ToastVariant } from './Toast/toast-context';
export { AsyncState } from './AsyncState/AsyncState';
export type { AsyncStateProps } from './AsyncState/AsyncState';
export { OfflineBanner } from './AsyncState/OfflineBanner';
export { useAsyncQuery } from './AsyncState/use-async-query';
export type {
  AsyncQueryState,
  UseAsyncQueryOptions,
  UseAsyncQueryResult,
} from './AsyncState/use-async-query';
export { useOnlineStatus } from './AsyncState/use-online-status';
