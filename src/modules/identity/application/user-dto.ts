/**
 * 用户相关的对外 DTO（IAM-001 / IAM-002，《接口文档》§GET /me）。
 *
 * 领域实体把设置收在 `settings` 子对象里（因为它是一个整体），而接口契约是**展平**的
 * ——`locale`、`timezone`… 与 `id`、`mode` 平级。这一层就负责这个形状差异。
 *
 * 为什么显式手写映射而不是展开运算符：展开会把领域里将来新增的字段**自动泄露**到
 * 接口上。对外契约应当是"我们决定公开什么"，而不是"领域里恰好有什么"。
 *
 * ## 为什么在 application 而不是 presentation
 *
 * 映射要读领域实体，而《依赖边界规则》禁止表现层引用领域层（「表现层不得越过应用层
 * 访问领域与基础设施」）。《详细设计》§4.3 也把「转换 DTO」列为应用服务的职责——它
 * 才是页面与领域之间的唯一通道。所以 DTO 类型与映射函数都落在这里。
 */
import type { User } from '../domain/user.ts';

/** `GET /me` 与 `PATCH /me` 的响应体中的 `data`。 */
export interface UserDto {
  readonly id: string;
  readonly mode: string;
  readonly displayName: string | null;
  readonly locale: string;
  readonly timezone: string;
  readonly currencyCode: string;
  readonly weekStartsOn: number;
  readonly defaultTaskDurationMinutes: number | null;
  readonly defaultBufferMinutes: number | null;
  readonly aiEnabled: boolean;
  readonly aiDataConsent: boolean;
  readonly reminderEnabled: boolean;
  readonly quietHoursStart: string | null;
  readonly quietHoursEnd: string | null;
  /** 乐观并发版本；客户端改动设置时必须原样回传。 */
  readonly version: number;
}

export function toUserDto(user: User): UserDto {
  return {
    id: user.id,
    mode: user.mode,
    displayName: user.displayName,
    locale: user.settings.locale,
    timezone: user.settings.timezone,
    currencyCode: user.settings.currencyCode,
    weekStartsOn: user.settings.weekStartsOn,
    defaultTaskDurationMinutes: user.settings.defaultTaskDurationMinutes,
    defaultBufferMinutes: user.settings.defaultBufferMinutes,
    aiEnabled: user.settings.aiEnabled,
    aiDataConsent: user.settings.aiDataConsent,
    reminderEnabled: user.settings.reminderEnabled,
    quietHoursStart: user.settings.quietHoursStart,
    quietHoursEnd: user.settings.quietHoursEnd,
    version: user.version,
  };
}
