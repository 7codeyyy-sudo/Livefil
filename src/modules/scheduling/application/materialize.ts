/**
 * 重复实例物化（SCHED/ROUTINE，DB §4.5/§4.16 冻结口径：实例物化、不做虚拟展开）。
 *
 * 展开只发生在**查询窗口内**（`GET /tasks` 带 from/to、`GET /schedule-blocks`、
 * `GET /today`、`GET /fixed-commitments` 的入口处调用）；窗口外不预生成。
 * 幂等靠唯一约束（`(user_id, template_id, due_date/local_date)`）+
 * `onConflictDoNothing` 回读——不做"先查后插"的预检（并发窗口里两个请求
 * 都能查到"不存在"，唯一约束才是硬保证）。
 */
import { zonedToUtc, calendarDayOf } from '../domain/zoned-time.ts';
import { expandRuleDates, parseRecurrenceRule } from '../domain/recurrence.ts';
import type { TaskRepository } from '../../tasks/domain/task-repository.ts';
import type { FixedCommitmentRepository } from '../domain/fixed-commitment-repository.ts';

/** 展开重复任务实例到窗口；返回本次新创建的行数（已存在的跳过）。 */
export async function materializeRecurringTasks(
  userId: string,
  from: string,
  to: string,
  tasks: TaskRepository,
): Promise<number> {
  const templates = await tasks.listRecurringTemplates(userId);
  let created = 0;
  for (const template of templates) {
    // 模板的 rule 在此已过创建时校验；解析失败按数据损坏处理（跳过并继续，
    // 让一条坏模板不至于拖垮整个窗口查询——真损坏另有数据修复路径）。
    let rule;
    try {
      rule = parseRecurrenceRule(template.recurrenceRule);
    } catch {
      continue;
    }
    const anchorDate = template.createdAt.slice(0, 10);
    for (const date of expandRuleDates(rule, anchorDate, from, to)) {
      const existing = await tasks.findByTemplateAndDate(userId, template.id, date);
      if (existing !== null) {
        continue;
      }
      await tasks.createRecurrenceInstance(userId, template, date);
      created += 1;
    }
  }
  return created;
}

/** 展开重复固定事项实例到窗口；返回本次新创建的行数。 */
export async function materializeFixedCommitments(
  userId: string,
  from: string,
  to: string,
  fixed: FixedCommitmentRepository,
): Promise<number> {
  const templates = await fixed.listTemplates(userId);
  let created = 0;
  for (const template of templates) {
    let rule;
    try {
      rule = parseRecurrenceRule(template.recurrenceRule);
    } catch {
      continue;
    }
    // 固定事项的钟点按模板时区解释（DST 安全），锚点＝模板创建日的本地日历日。
    const anchorDate = calendarDayOf(new Date(template.createdAt), template.timezone);
    for (const date of expandRuleDates(rule, anchorDate, from, to)) {
      const existing = await fixed.findByTemplateAndDate(userId, template.id, date);
      if (existing !== null) {
        continue;
      }
      const startsAtUtc = zonedToUtc(date, template.startsAtLocal as string, template.timezone);
      const endsAtUtc = new Date(startsAtUtc.getTime() + template.durationMinutes * 60_000);
      await fixed.create(userId, {
        title: template.title,
        templateId: template.id,
        localDate: date,
        startsAtUtc,
        endsAtUtc,
        startsAtLocal: null,
        durationMinutes: template.durationMinutes,
        timezone: template.timezone,
        recurrenceRule: null,
      });
      created += 1;
    }
  }
  return created;
}

/** 供端点/聚合入口复用的窗口物化编排（任务 + 固定事项一次做完）。 */
export async function materializeWindow(
  userId: string,
  from: string,
  to: string,
  repositories: {
    readonly tasks: TaskRepository;
    readonly fixed: FixedCommitmentRepository;
  },
): Promise<void> {
  await materializeRecurringTasks(userId, from, to, repositories.tasks);
  await materializeFixedCommitments(userId, from, to, repositories.fixed);
}
