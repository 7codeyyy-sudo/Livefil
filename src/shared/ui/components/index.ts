/**
 * 共享 UI 组件统一出口（UI-002）。
 *
 * 只导出组件与它们的公开类型——不导出内部样式模块或辅助函数，
 * 避免调用方依赖实现细节。
 *
 * 分批交付：批次 1 是表单原子（Button / IconButton / Input / Select / Textarea），
 * 批次 2 是展板与导航（Badge / Progress / Tabs），
 * 后续批次会把状态与浮层组件追加到这里。
 */
export { Badge } from './Badge/Badge';
export type { BadgeProps, BadgeVariant } from './Badge/Badge';
export { Button } from './Button/Button';
export type { ButtonProps, ButtonVariant } from './Button/Button';
export { IconButton } from './IconButton/IconButton';
export type { IconButtonProps } from './IconButton/IconButton';
export { Input } from './Input/Input';
export type { InputProps } from './Input/Input';
export { Progress } from './Progress/Progress';
export type { ProgressProps } from './Progress/Progress';
export { Select } from './Select/Select';
export type { SelectProps } from './Select/Select';
export { Tabs } from './Tabs/Tabs';
export type { TabItem, TabsProps } from './Tabs/Tabs';
export { Textarea } from './Textarea/Textarea';
export type { TextareaProps } from './Textarea/Textarea';
