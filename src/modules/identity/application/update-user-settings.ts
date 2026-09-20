/**
 * 更新用户设置（IAM-002，《详细设计说明书》§4.7）。
 *
 * ## 为什么跨字段校验在这里而不是在 Zod schema 里
 *
 * `aiEnabled=true` 要求 `aiDataConsent=true`——但补丁可能只带 `aiEnabled`，
 * 而同意状态的现状在库里。schema 只能看见补丁，看不见现状；要在 schema 里做这条
 * 校验，就得把"用户当前设置"塞进 Zod 上下文，那会让一个纯校验器依赖数据库。
 * 所以：**字段级规则归 schema，跨字段规则归用例**（读完现状再判定）。
 *
 * ## 审计只记事件类型，不记内容
 *
 * `AuditEvent` 的结构里根本没有"改了哪些字段"的位置（SRS §6.7 只要求事件类型、
 * 结果、时间、匿名用户标识与版本）。这不是巧合——设置里包含 AI 数据同意这类
 * 隐私相关项，把变更明细写进审计日志等于把它们复制到另一份长期留存的数据里。
 */
import { NotFoundError, ValidationError } from '@/shared/errors/app-error.ts';
import { toAnonymousUserId } from '@/shared/telemetry/anonymous-user-id.ts';
import type { AuditLogger } from '@/shared/telemetry/audit-event.ts';

import type { UserRepository } from '../domain/user-repository.ts';
import type { User, UserSettingsPatch } from '../domain/user.ts';
import type { UpdateUserSettingsRequest } from './user-settings-schema.ts';

export interface UpdateUserSettingsDependencies {
  readonly users: UserRepository;
  readonly audit: AuditLogger;
}

/**
 * 判断补丁里是否**显式**包含某个键。
 *
 * 不能用 `??` 或真值判断：把安静时段清空（显式传 `null`）与"不改这一项"
 * 是两件事，`patch.quietHoursStart ?? current` 会把前者当成后者——用户点了
 * "关闭安静时段"，服务端却把它恢复成原值。
 */
function isProvided(patch: UserSettingsPatch, key: keyof UserSettingsPatch): boolean {
  return key in patch;
}

/** 校验合并后的 AI 开关与同意状态。 */
function assertAiConsent(current: User, patch: UserSettingsPatch): void {
  const enabled = isProvided(patch, 'aiEnabled')
    ? patch.aiEnabled === true
    : current.settings.aiEnabled;
  const consented = isProvided(patch, 'aiDataConsent')
    ? patch.aiDataConsent === true
    : current.settings.aiDataConsent;

  if (enabled && !consented) {
    throw new ValidationError('开启 AI 前需要先同意数据发送', {
      fields: { aiDataConsent: '开启 AI 时必须同时同意数据发送' },
    });
  }
}

/** 校验合并后的安静时段。 */
function assertQuietHours(current: User, patch: UserSettingsPatch): void {
  const start = isProvided(patch, 'quietHoursStart')
    ? patch.quietHoursStart
    : current.settings.quietHoursStart;
  const end = isProvided(patch, 'quietHoursEnd')
    ? patch.quietHoursEnd
    : current.settings.quietHoursEnd;

  const hasStart = start !== null && start !== undefined;
  const hasEnd = end !== null && end !== undefined;

  if (hasStart !== hasEnd) {
    throw new ValidationError('安静时段的开始与结束需要同时设置或同时清空', {
      fields: { quietHoursStart: '开始与结束需要成对', quietHoursEnd: '开始与结束需要成对' },
    });
  }

  // 起止相同无法区分"零长度"与"整天"，两种解释都说得通——与其猜，不如拒绝。
  if (hasStart && hasEnd && start === end) {
    throw new ValidationError('安静时段的开始与结束不能相同');
  }
}

export class UpdateUserSettingsUseCase {
  readonly #users: UserRepository;
  readonly #audit: AuditLogger;

  constructor(dependencies: UpdateUserSettingsDependencies) {
    this.#users = dependencies.users;
    this.#audit = dependencies.audit;
  }

  /**
   * @param userId 当前会话用户。
   * @param request 已通过字段级校验的请求体（含 `version`）。
   * @param requestId 用于把审计事件与请求日志关联。
   * @returns 更新后的完整用户（含自增后的 `version`）。
   * @throws {NotFoundError} 用户不存在。
   * @throws {ValidationError} 跨字段约束不满足。
   * @throws {ConflictError} `version` 与库中不符（由仓储抛出）。
   */
  async execute(
    userId: string,
    request: UpdateUserSettingsRequest,
    requestId?: string,
  ): Promise<User> {
    const current = await this.#users.findById(userId);
    if (current === null) {
      throw new NotFoundError('用户不存在');
    }

    const { version, ...patch } = request;

    assertAiConsent(current, patch);
    assertQuietHours(current, patch);

    const updated = await this.#users.updateSettings(userId, patch, version);

    this.#audit.record({
      type: 'DATA_UPDATED',
      outcome: 'succeeded',
      anonymousUserId: toAnonymousUserId(userId),
      ...(requestId === undefined ? {} : { requestId }),
    });

    return updated;
  }
}
