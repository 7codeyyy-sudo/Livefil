/**
 * AI 草稿确认 / 取消用例（AI-004/005/006，《接口文档》§11、RD-20260929-006 §1.3）。
 *
 * ## 确认**必须**走既有业务用例，不新开写库路径
 *
 * §11 明文「确认后调用普通任务/行动用例写入正式数据」。任务、时间块、开销各有
 * 自己的既有用例（含归属校验、审计事件、来源标记），AI 确认只做**编排**：
 * 它不直接调仓储、不自己写库，否则同一份业务规则会出现第二条可能漂移的实现。
 *
 * ## 顺序：先占用草稿、再写业务实体（本实现自选，非契约原文）
 *
 * §11 只写「确认后调用普通任务/行动用例写入正式数据」，**未规定**草稿状态迁移与
 * 业务写入是否落同一事务。本实现选择**非同一事务**的顺序：先条件占用草稿
 * （pending → confirmed），再写业务实体，写入失败则回滚占用（confirmed → pending）。
 *
 * 之所以不追求「同一事务」：既有业务用例各自持有独立事务边界（仓储直接持有 db，
 * 无法被外部事务挂接），本批不改动它们。若强行并事务，需要改动 tasks / scheduling /
 * expenses 三个模块的仓储签名，代价远超收益。
 *
 * 这个顺序的收益是**杜绝重复写入**：两个并发确认只有一条能拿到占用，另一条拿到
 * `null` 转 409——这正是「一次性消费」的核心。代价是「占用成功但写入失败」时会
 * 短暂处于 confirmed，随后被回滚修正；若回滚本身也失败（只能是数据库故障），
 * 会留下一条没有业务实体的 confirmed 草稿，此时记一条错误日志作为待修信号。
 * 该偏差已在交付报告中如实标注。
 *
 * ## 过期语义
 *
 * §11 判定 2：过期后 confirm 返回 `CONFLICT`（409），`message` 明确「草稿已过期」。
 * 用时间与 `status='expired'` 双判——草稿可能已过期但尚未被后台标记为 expired。
 */
import { z } from 'zod';

import {
  ConflictError,
  InvariantError,
  NotFoundError,
  ValidationError,
  toAppError,
} from '@/shared/errors/app-error.ts';
import type { Logger } from '@/shared/telemetry/logger.ts';

import type { UserRepository } from '../../identity/domain/user-repository.ts';
import type { User } from '../../identity/domain/user.ts';
import type { ManageExpenseUseCase } from '../../expenses/application/manage-expense.ts';
import type { ManageScheduleBlockUseCase } from '../../scheduling/application/manage-scheduling.ts';
import type { ManageTaskUseCase } from '../../tasks/application/manage-task.ts';
import type { AiDraft } from '../domain/ai-draft.ts';
import type { AiDraftRepository } from '../domain/ai-draft-repository.ts';
import {
  expenseParseResultSchema,
  parseAiDraftResultJson,
  reviewSummaryResultSchema,
  scheduleSuggestionResultSchema,
  taskBreakdownResultSchema,
} from './ai-draft-result.ts';

/** 确认时可由用户改写的开销字段（见 `ai-draft-dto.ts` 的 `aiDraftConfirmBodySchema`）。 */
export interface AiDraftConfirmExpenseInput {
  readonly categoryId: string;
  readonly amountMinor?: number | undefined;
  readonly currencyCode?: string | undefined;
  readonly occurredOn?: string | undefined;
  readonly note?: string | null | undefined;
}

/**
 * 确认时可由用户改写的任务草稿行（UI 规范 §5 C1「可编辑、可移除单项」）。
 *
 * 缺省（未提供 `tasks`）时沿用服务端草稿的 `suggestions`；提供时以用户编辑后的
 * 列表为准——「可编辑」若只改界面不落库，就是空壳。
 */
export interface AiDraftConfirmTaskInput {
  readonly title: string;
  readonly estimatedMinutes?: number | null | undefined;
}

/** 确认入参（结构上等同 `aiDraftConfirmBodySchema` 的解析结果）。 */
export interface AiDraftConfirmInput {
  readonly expense?: AiDraftConfirmExpenseInput | undefined;
  readonly tasks?: readonly AiDraftConfirmTaskInput[] | undefined;
}

/** 确认结果：草稿新状态 + 写入的业务实体 id。 */
export interface AiDraftConfirmResult {
  readonly draft: AiDraft;
  readonly createdIds: readonly string[];
}

export interface ConfirmAiDraftDependencies {
  readonly drafts: AiDraftRepository;
  readonly tasks: ManageTaskUseCase;
  readonly schedules: ManageScheduleBlockUseCase;
  readonly expenses: ManageExpenseUseCase;
  readonly users: UserRepository;
  readonly logger: Logger;
  readonly now: () => Date;
}

export class ConfirmAiDraftUseCase {
  readonly #deps: ConfirmAiDraftDependencies;

  constructor(dependencies: ConfirmAiDraftDependencies) {
    this.#deps = dependencies;
  }

  /**
   * 确认草稿：占用 → 写业务实体 → 返回。
   *
   * @throws {NotFoundError} 草稿不存在或不属于当前用户。
   * @throws {ConflictError} 草稿已过期（409）或已被其他请求消费（409）。
   * @throws {ValidationError} 草稿生成为 failed / 开销草稿缺分类。
   */
  async confirm(
    userId: string,
    draftId: string,
    input: AiDraftConfirmInput,
    requestId?: string,
  ): Promise<AiDraftConfirmResult> {
    const draft = await this.#requireDraft(userId, draftId);
    if (this.#isExpired(draft)) {
      throw new ConflictError('草稿已过期');
    }
    if (draft.status === 'failed') {
      throw new ValidationError('草稿生成失败，无法确认');
    }
    if (draft.status !== 'pending') {
      throw new ConflictError('草稿已被处理');
    }

    const parsed = parseAiDraftResultJson(draft.draftType, draft.resultJson);
    if (!parsed.ok) {
      // pending 草稿必带合法 result_json（写入方保证）；走到这里说明数据被绕过写坏。
      throw new InvariantError({
        message: '待确认草稿的 result_json 与类型 schema 不符',
        details: { draftId },
      });
    }

    // 原子占用：并发确认只有一条能命中，另一条见 null 转 409。
    const claimed = await this.#deps.drafts.transitionStatus(
      userId,
      draftId,
      'pending',
      'confirmed',
    );
    if (claimed === null) {
      throw new ConflictError('草稿已被处理');
    }

    let createdIds: readonly string[];
    try {
      createdIds = await this.#writeEntities(userId, draft, parsed.value, input, requestId);
    } catch (error) {
      // 回滚占用：业务写入失败时草稿必须回到 pending，否则用户既没拿到实体、
      // 也失去了修复后重试的机会。回滚自身失败（只能是 DB 故障）不掩盖原始错误。
      await this.#deps.drafts
        .transitionStatus(userId, draftId, 'confirmed', 'pending')
        .catch((rollbackError: unknown) => {
          this.#deps.logger.error('草稿确认回滚失败', {
            operation: 'ai_draft_confirm',
            errorCode: toAppError(rollbackError).code,
            draftId,
          });
        });
      throw error;
    }

    return { draft: claimed, createdIds };
  }

  /**
   * 取消草稿：置 `cancelled`，不写任何业务实体（§11）。
   *
   * **只在 `pending` 上生效**：`confirmed` / `cancelled` / `failed` / `expired` 都是
   * 终态，取消一个终态草稿没有可取消的东西，一律 409「草稿已被处理」。§11 只写了
   * 「取消草稿，不写入业务实体」，未定义终态上的取消语义；此处按「终态不可再迁移」
   * 收敛（对外表现为幂等失败，而不是静默改状态）。UI 侧也只对 `pending` 草稿渲染
   * 「取消」（`status='failed'` 的生成失败按 200 返回空载荷走空态，不出现草稿面板）。
   *
   * @throws {NotFoundError} 草稿不存在或不属于当前用户。
   * @throws {ConflictError} 草稿已过期，或处于任一终态（含 `failed`）。
   */
  async cancel(userId: string, draftId: string): Promise<AiDraft> {
    const draft = await this.#requireDraft(userId, draftId);
    if (this.#isExpired(draft)) {
      throw new ConflictError('草稿已过期');
    }

    const updated = await this.#deps.drafts.transitionStatus(
      userId,
      draftId,
      'pending',
      'cancelled',
    );
    if (updated === null) {
      throw new ConflictError('草稿已被处理');
    }
    return updated;
  }

  /**
   * 按草稿类型把 `result_json` 翻译成既有用例的调用。
   *
   * 金额以外的服务端可推导字段（`lifeAreaId` / `goalId` / `actionId` / `paymentMethod` /
   * 排程时区等）不取自模型输出，而是由服务端显式给值——模型无从知道这些归属，
   * 让它们成为模型的自由变量只会写入错关联。
   */
  async #writeEntities(
    userId: string,
    draft: AiDraft,
    value: unknown,
    input: AiDraftConfirmInput,
    requestId: string | undefined,
  ): Promise<readonly string[]> {
    switch (draft.draftType) {
      case 'task_breakdown': {
        const result = requireParsed(taskBreakdownResultSchema, value);
        // 用户在草稿面板里改过/移除过的建议优先落库（UI 规范 §5 C1「可编辑、可移除
        // 单项」）；未带 `tasks` 时回落到服务端草稿值。两者同形，写入走同一条普通
        // 创建用例，不存在第二条可能漂移的实现。
        const pending =
          input.tasks ??
          result.suggestions.map((suggestion) => ({
            title: suggestion.title,
            estimatedMinutes: suggestion.estimatedMinutes,
          }));
        const created: string[] = [];
        for (const item of pending) {
          const task = await this.#deps.tasks.create(
            userId,
            {
              title: item.title,
              status: 'inbox',
              lifeAreaId: null,
              dueDate: null,
              estimatedMinutes: item.estimatedMinutes ?? null,
              minimumVersion: null,
              goalId: null,
              actionId: null,
              // 来源标 `ai`（DB §4.5 的 `source` 取值）——确认路径走的就是普通创建
              // 用例，来源若不显式传就只剩默认的 `manual`，AI 来源在写入那刻丢失。
              source: 'ai',
            },
            requestId,
          );
          created.push(task.id);
        }
        return created;
      }

      case 'schedule_suggestion': {
        const user = await this.#requireUser(userId);
        const result = requireParsed(scheduleSuggestionResultSchema, value);
        const created: string[] = [];
        for (const suggestion of result.suggestions) {
          const outcome = await this.#deps.schedules.create(
            userId,
            {
              taskId: suggestion.taskId,
              actionId: null,
              startsAt: suggestion.blockStart,
              endsAt: suggestion.blockEnd,
              // 时区取用户设置（与既有 /schedules 写入口径一致），不采信模型输出。
              timezone: user.settings.timezone,
              source: 'suggested',
            },
            requestId,
          );
          created.push(outcome.block.id);
        }
        return created;
      }

      case 'expense_parse': {
        const result = requireParsed(expenseParseResultSchema, value);
        const override = input.expense;
        if (override === undefined) {
          // 分类模型给不出来（可能为 null），必须由用户在确认界面选定（FR-082 / A6）。
          throw new ValidationError('确认开销草稿时必须选定分类', {
            fields: { 'expense.categoryId': '请选择开销分类' },
          });
        }
        const created = await this.#deps.expenses.create(
          userId,
          {
            categoryId: override.categoryId,
            lifeAreaId: null,
            goalId: null,
            actionId: null,
            // 金额一律整数分；用户给了就用用户确认的值，否则沿用草稿值。
            amountMinor: String(override.amountMinor ?? result.amountMinor),
            currencyCode: override.currencyCode ?? result.currencyCode,
            occurredOn: override.occurredOn ?? result.occurredOn,
            paymentMethod: null,
            note: override.note === undefined ? result.note : override.note,
            source: 'ai_draft',
          },
          requestId,
        );
        return [created.id];
      }

      case 'review_summary': {
        // 校验一次（若结构不符则与其它类型一样判为数据被写坏），但**不产生写入**。
        // 这不是缺口，而是《UI 页面规范》§5 D（引导与 AI 草稿补节）的明文口径：「**不自动写入任何复盘字段**；
        // 摘要中的调整建议若被采纳，一律走开销与复盘补节 B3/B4 既有就地操作链——
        // 不新增旁路写入」。故确认（消费草稿）只把状态置 confirmed，`createdIds` 为空。
        requireParsed(reviewSummaryResultSchema, value);
        return [];
      }

      default:
        // 四值已全部覆盖；此处为穷尽性兜底——越过它说明枚举与实现脱节。
        throw new InvariantError({ message: '未知的草稿类型' });
    }
  }

  async #requireDraft(userId: string, draftId: string): Promise<AiDraft> {
    const draft = await this.#deps.drafts.findById(userId, draftId);
    if (draft === null) {
      throw new NotFoundError('草稿不存在');
    }
    return draft;
  }

  async #requireUser(userId: string): Promise<User> {
    const user = await this.#deps.users.findById(userId);
    if (user === null) {
      throw new NotFoundError('用户不存在');
    }
    return user;
  }

  /** 过期判定：已标记 expired，或 `expires_at` 已到（含相等）。 */
  #isExpired(draft: AiDraft): boolean {
    return draft.status === 'expired' || Date.parse(draft.expiresAt) <= this.#deps.now().getTime();
  }
}

/** 用草稿类型对应的 schema 再取一次强类型值；不符即视为数据被写坏。 */
function requireParsed<TSchema extends z.ZodType>(
  schema: TSchema,
  value: unknown,
): z.infer<TSchema> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new InvariantError({ message: '草稿 result_json 与类型 schema 不符' });
  }
  return parsed.data;
}
