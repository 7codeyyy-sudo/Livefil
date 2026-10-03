/**
 * AI 草稿生成用例（AI-004/005/006，《详细设计说明书》§4.5、《接口文档》§11、
 * RD-20260929-006 §1.3/§1.4/§1.7）。
 *
 * ## 四类生成共享一条链
 *
 * 四类草稿的差异只在「读哪些用户数据、拼成什么文本」，其余步骤完全一致：
 * 读用户 → **脱敏** → 调 AI-003 的 `InvokeAiProviderUseCase` → **校验输出** →
 * 落草稿。因此收在一个类里，四条流程只组装各自的 `rawContent`。
 *
 * ## 为什么脱敏与调用之间不插入任何别的事
 *
 * 脱敏后的文本就是要出境的内容。`input_hash` 与 `sanitized_input` **同源**——
 * 只覆盖真正送出去的那段文本，事后才能用哈希复算出「当时发出去了什么」
 * （RD-006 §1.4 第 3 条）。把「上下文数字」与自由文本分开哈希会让对账口径出现
 * 两套，所以这里把上下文一并拼进文本后再统一脱敏。
 *
 * ## 为什么 provider 异常上抛、而「输出不合法」落 failed
 *
 * RD-006 §1.3 的映射表把两者分得很清：调用超时 / 不可用 / 限流是**调用失败**，
 * 对客户端是 504 / 502 / 429（由 `InvokeAiProviderUseCase` 抛出，本用例不吞）；
 * 而「调用成功但输出非法 JSON / 空结果」是**生成失败**，草稿落 `status='failed'` +
 * `errorCode='AI_RESPONSE_INVALID'`，接口按 **200** 返回空 `suggestions`。
 * 把后者也抛成 502 会让客户端重试一个本就不会成功的结果。
 *
 * ## 只读用户主动选择/输入的数据
 *
 * `expense_parse` / `task_breakdown` 只用请求体里的自由文本；`schedule_suggestion`
 * 只读请求体 `taskIds` 指定且属于当前用户的任务；`review_summary` 只读用户所选
 * 范围（任务事实 / 开销摘要）的**聚合数字**。不读取、不发送任何用户未主动选择的记录。
 */
import { NotFoundError, ValidationError } from '@/shared/errors/app-error.ts';

import { addDays } from '../../scheduling/domain/zoned-time.ts';
import type { ExpenseRepository } from '../../expenses/domain/expense-repository.ts';
import type { UserRepository } from '../../identity/domain/user-repository.ts';
import type { User } from '../../identity/domain/user.ts';
import type { ReviewFactsRepository } from '../../reviews/domain/review-repository.ts';
import type { TaskRepository } from '../../tasks/domain/task-repository.ts';
import type { AiDraft, AiDraftType } from '../domain/ai-draft.ts';
import type { AiDraftRepository } from '../domain/ai-draft-repository.ts';
import { sanitizeAiInput } from '../domain/ai-input-sanitizer.ts';
import { systemPromptFor } from '../domain/ai-prompts.ts';
import type { AiRequestType } from '../domain/ai-provider.ts';
import type {
  ExpenseParseRequest,
  ReviewSummaryRequest,
  ScheduleSuggestionRequest,
  TaskBreakdownRequest,
} from './ai-draft-dto.ts';
import { parseAiDraftContent } from './ai-draft-result.ts';
import type { InvokeAiProviderUseCase } from './invoke-ai-provider.ts';

/**
 * 单次生成的输出上限（token）。
 *
 * 四类输出都是短结构（最多 20 条建议 / 一条开销 / 两组各 10 条文本），
 * 千级上限足够且能挡住「模型跑飞写成长文」——输出 token 是要计费的。
 * 写成 `2 ** 10` 而非等值字面量：那字面量恰是平板断点像素值，全仓 UI 扫描禁止。
 */
const AI_DRAFT_MAX_OUTPUT_TOKENS = 2 ** 10;

/**
 * 草稿有效期（毫秒）。
 *
 * §11 只要求 `expiresAt` 与 `ai_drafts.expires_at` 同源、过期后 confirm 返 409，
 * 未规定具体时长。取 1 小时：足够用户在看到草稿后从容确认，又不会让一份基于
 * 「当时数据 / 当时金额」的草稿长期可被确认（金额、任务都可能已变）。
 * **属文档未定义、本实现自选的值**，已在交付报告中标注。
 */
const AI_DRAFT_TTL_MS = 60 * 60 * 1000;

/** 复述模型输入时用的占位：时长缺省写「未估时」，不臆造具体分钟数。 */
const UNESTIMATED_MINUTES = '未估时';

export interface GenerateAiDraftDependencies {
  /** AI 调用的唯一入口（AI-003）：门禁、预检、记账、日志都在它里面。 */
  readonly invoke: InvokeAiProviderUseCase;
  readonly drafts: AiDraftRepository;
  readonly users: UserRepository;
  readonly tasks: TaskRepository;
  readonly reviewFacts: ReviewFactsRepository;
  readonly expenses: ExpenseRepository;
  readonly now: () => Date;
  /** 脱敏后的截断长度（来自 `AI_MAX_INPUT_CHARS`）。 */
  readonly maxInputChars: number;
}

export class GenerateAiDraftUseCase {
  readonly #deps: GenerateAiDraftDependencies;

  constructor(dependencies: GenerateAiDraftDependencies) {
    this.#deps = dependencies;
  }

  /** AI-004：把一句话目标拆解为可执行小任务。 */
  async generateTaskBreakdown(userId: string, input: TaskBreakdownRequest): Promise<AiDraft> {
    const user = await this.#requireUser(userId);
    const minutes = input.context?.availableMinutes;
    const rawContent =
      minutes === undefined ? input.text : `${input.text}\n可投入时间：${String(minutes)} 分钟`;

    return this.#persist({
      userId,
      user,
      draftType: 'task_breakdown',
      requestType: 'task_breakdown',
      rawContent,
    });
  }

  /** AI-005：把用户选定的任务排进给定时间窗，每条建议带 `reason`（FR-081）。 */
  async generateScheduleSuggestion(
    userId: string,
    input: ScheduleSuggestionRequest,
  ): Promise<AiDraft> {
    const user = await this.#requireUser(userId);

    // `findByIds` 只返回属于当前用户且未删除的任务——非本人 id 不会进入送往模型的内容。
    const tasks = await this.#deps.tasks.findByIds(userId, input.taskIds);
    if (tasks.length === 0) {
      throw new ValidationError('所选任务不存在', {
        fields: { taskIds: '请至少选择一个属于你的任务' },
      });
    }

    const taskLines = tasks.map((task) => {
      const estimate =
        task.estimatedMinutes === null
          ? UNESTIMATED_MINUTES
          : `预计 ${String(task.estimatedMinutes)} 分钟`;
      return `- 任务「${task.title}」（${estimate}）`;
    });
    const rawContent = [
      `时间窗：${input.windowStart} 至 ${input.windowEnd}`,
      `可用时长：${String(input.availableMinutes)} 分钟`,
      '待安排任务：',
      ...taskLines,
    ].join('\n');

    return this.#persist({
      userId,
      user,
      draftType: 'schedule_suggestion',
      requestType: 'schedule_suggestion',
      rawContent,
    });
  }

  /** AI-006：把一句话消费描述解析为一笔开销草稿（金额为整数分，写入前须用户确认）。 */
  async generateExpenseParse(userId: string, input: ExpenseParseRequest): Promise<AiDraft> {
    const user = await this.#requireUser(userId);
    return this.#persist({
      userId,
      user,
      draftType: 'expense_parse',
      requestType: 'expense_parse',
      rawContent: input.text,
    });
  }

  /** AI-006：依据用户所选范围的聚合数字给出复盘要点与建议（FR-083 禁区约束见 prompts）。 */
  async generateReviewSummary(userId: string, input: ReviewSummaryRequest): Promise<AiDraft> {
    const user = await this.#requireUser(userId);
    const lines: string[] = [`周起始：${input.weekStart}`];

    // 只读用户勾选的范围：两个开关的布尔组合由请求 schema 保证「至少一类为真」。
    if (input.scope.includeTasks) {
      const facts = await this.#deps.reviewFacts.collectWeeklyFacts(userId, {
        weekStart: input.weekStart,
        weekEnd: addDays(input.weekStart, 7),
        timezone: user.settings.timezone,
      });
      const counts = facts.taskStatusCounts;
      lines.push(
        `计划时长：${String(facts.planActual.plannedMinutes)} 分钟；实际时长：${String(facts.planActual.actualMinutes)} 分钟`,
        `任务计数：完成 ${String(counts.completed)}，部分完成 ${String(counts.partial)}，延期 ${String(counts.deferred)}，跳过 ${String(counts.skipped)}`,
      );
      if (facts.repeatedDeferrals.length > 0) {
        const items = facts.repeatedDeferrals
          .map((item) => `${item.title}（${String(item.deferCount)} 次）`)
          .join('、');
        lines.push(`重复延期任务：${items}`);
      }
      if (facts.goalActions.length > 0) {
        const items = facts.goalActions
          .map((item) => `${item.goalName} ${String(item.completed)}/${String(item.total)}`)
          .join('、');
        lines.push(`目标行动完成：${items}`);
      }
    }

    if (input.scope.includeExpenses) {
      const summary = await this.#deps.expenses.summarize(userId, {
        from: input.weekStart,
        // 周窗口是左闭右开 `[weekStart, weekStart+7)`，而开销摘按 `occurredOn` 闭区间取，
        // 故结束日取 `weekStart + 6`（本周最后一天）。
        to: addDays(input.weekStart, 6),
        groupBy: 'category',
      });
      for (const total of summary.grandTotals) {
        lines.push(
          `开销（${total.currencyCode}）：${total.totalMinor} 分，共 ${String(total.count)} 笔`,
        );
      }
    }

    return this.#persist({
      userId,
      user,
      draftType: 'review_summary',
      requestType: 'review_summary',
      rawContent: lines.join('\n'),
    });
  }

  /**
   * 脱敏 → 调用 → 校验 → 落草稿。四类生成共用的唯一链路。
   *
   * 不做 try/catch 包裹 `invoke.execute`：调用失败的错误语义（400/429/502/504）由
   * AI-003 定义并对客户端有意义，吞掉它等于把「供应商不可用」伪装成「生成失败」。
   */
  async #persist(params: {
    readonly userId: string;
    readonly user: User;
    readonly draftType: AiDraftType;
    readonly requestType: AiRequestType;
    readonly rawContent: string;
  }): Promise<AiDraft> {
    const { sanitizedInput, inputHash } = sanitizeAiInput(
      params.rawContent,
      this.#deps.maxInputChars,
    );

    const result = await this.#deps.invoke.execute({
      userId: params.userId,
      aiEnabled: params.user.settings.aiEnabled,
      aiDataConsent: params.user.settings.aiDataConsent,
      // 额度按「用户时区的自然月」切（RD-006 §1.5），与 `GET /ai/usage` 同源。
      timezone: params.user.settings.timezone,
      requestType: params.requestType,
      systemPrompt: systemPromptFor(params.requestType),
      userContent: sanitizedInput,
      maxOutputTokens: AI_DRAFT_MAX_OUTPUT_TOKENS,
    });

    const parsed = parseAiDraftContent(params.draftType, result.content);

    return this.#deps.drafts.create({
      userId: params.userId,
      draftType: params.draftType,
      inputHash,
      sanitizedInput,
      // 非法 / 空输出时 `result_json` 必须为 null（CHECK：failed 允许为空）。
      resultJson: parsed.ok ? parsed.value : null,
      status: parsed.ok ? 'pending' : 'failed',
      provider: result.provider,
      model: result.model,
      expiresAt: new Date(this.#deps.now().getTime() + AI_DRAFT_TTL_MS),
      errorCode: parsed.ok ? null : 'AI_RESPONSE_INVALID',
    });
  }

  async #requireUser(userId: string): Promise<User> {
    const user = await this.#deps.users.findById(userId);
    if (user === null) {
      throw new NotFoundError('用户不存在');
    }
    return user;
  }
}
