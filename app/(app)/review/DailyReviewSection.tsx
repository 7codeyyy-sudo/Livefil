'use client';

import { useState } from 'react';
import Link from 'next/link';

import {
  Badge,
  Button,
  ErrorState,
  Input,
  Skeleton,
  Textarea,
  useAsyncQuery,
} from '@/shared/ui/components';

import {
  formatMinutes,
  formatSignedMinutes,
  fetchDailyReview,
  localCalendarDay,
  saveDailyReview,
} from '../_lib/review-api';
import type { DailyReviewItem, EnergyLevel, ReviewAnswerKey } from '../_lib/review-api';

import styles from './ReviewPanel.module.css';

/** 三问的卡题与 `answers` 键（B1 明文对应关系；顺序即纵向顺序）。 */
const QUESTIONS: readonly { readonly key: ReviewAnswerKey; readonly title: string }[] = [
  { key: 'completed', title: '今天完成了什么' },
  { key: 'blocker', title: '哪件事最影响计划' },
  { key: 'nextAdjustment', title: '明天要保留、缩小、延期或删除什么' },
];

/** 精力三档（B1；只给中文名，取值仍以接口枚举为准）。 */
const ENERGY_OPTIONS: readonly { readonly value: EnergyLevel; readonly label: string }[] = [
  { value: 'low', label: '低' },
  { value: 'medium', label: '中' },
  { value: 'high', label: '高' },
];

/** 三问 + 精力的编辑草稿（空串＝未答；`null`＝没选精力）。 */
interface DailyDraft {
  readonly completed: string;
  readonly blocker: string;
  readonly nextAdjustment: string;
  readonly energyLevel: EnergyLevel | null;
}

const EMPTY_DRAFT: DailyDraft = {
  completed: '',
  blocker: '',
  nextAdjustment: '',
  energyLevel: null,
};

/**
 * 日复盘（《UI 页面规范》§5 B1，REVIEW-001）。
 *
 * ## 空态为什么不是 `AsyncState` 的空态
 *
 * 接口 §10 的 `data: null` 表示「这天还没填写」，而 **B1 明确要求此时落「未创建」
 * 可填写态**——即三问表单照常可用。也就是说这里的「空」不改变页面结构，只在事实
 * 摘要区块里体现。三态因此手写（loading / error / success），与 `ExpensesPanel`
 * 处理列表三态的方式一致；`AsyncState` 适合的是「空即换一套界面」的场景。
 *
 * ## 为什么没有 effect 回填草稿
 *
 * 草稿只在用户真正改动后才存在（`edit`），其余时刻一律从服务端那份派生。这样
 * 「换日期」「保存成功」都不需要写一行同步逻辑：前者让 `edit.date` 与当前日期不等
 * 而自动作废，后者把 `edit` 清空即回到服务端真相。React 19 也禁止在 effect 里
 * 同步 setState（同 `ExpensesPanel` 的取舍）。
 *
 * ## 为什么提交总是全量 PUT
 *
 * B1 要求「只答一题不得清空其余已答内容」。把三键都放进草稿、提交时整体送出，
 * 这条就自动成立；如果只提交「改动过的键」，漏传即等于清空。
 */
export function DailyReviewSection() {
  const [date, setDate] = useState(localCalendarDay);
  const [edit, setEdit] = useState<{ readonly date: string; readonly draft: DailyDraft } | null>(
    null,
  );
  const [skippedDate, setSkippedDate] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [savedDate, setSavedDate] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);

  const query = useAsyncQuery({
    queryKey: ['reviews', 'daily', date],
    queryFn: (signal) => fetchDailyReview(date, signal),
  });

  const loaded = query.state.status === 'success' ? query.state.data : null;
  const draft = edit !== null && edit.date === date ? edit.draft : draftFromServer(loaded);
  const skipped = skippedDate === date;

  const update = (patch: Partial<DailyDraft>) => {
    setEdit({ date, draft: { ...draft, ...patch } });
  };

  const filled = toAnswers(draft);
  const hasAnyAnswer = filled !== null || draft.energyLevel !== null;

  const submit = async () => {
    if (!hasAnyAnswer) {
      return;
    }
    setSaving(true);
    setFormError(null);
    try {
      // 接口 §10：`answers` 与 `energyLevel` 不可同时为空（「跳过今天」不落记录）。
      await saveDailyReview(date, { answers: filled, energyLevel: draft.energyLevel });
      setEdit(null);
      setSavedDate(date);
      query.refetch();
    } catch (error) {
      setFormError(error instanceof Error ? error.message : '保存失败，请稍后重试');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className={styles.section}>
      <div className={styles.toolbar}>
        <Input
          label="日期"
          type="date"
          max={localCalendarDay()}
          value={date}
          onChange={(event) => {
            setDate(event.target.value);
          }}
        />
      </div>

      <FactsBlock item={loaded} loading={query.state.status === 'loading'} />

      {query.state.status === 'error' ? (
        <ErrorState
          title="日复盘没能加载"
          description="数据没能取回来。可以先重试。"
          action={
            <Button variant="primary" onClick={query.refetch}>
              重试
            </Button>
          }
        />
      ) : null}

      {query.state.status === 'loading' ? (
        <div className={styles.skeleton}>
          <Skeleton />
          <Skeleton width="85%" />
          <Skeleton width="70%" />
        </div>
      ) : null}

      {query.state.status === 'success' ? (
        skipped ? (
          <div className={styles.skipped}>
            <p className={styles.hint}>已跳过今天</p>
            <Button
              variant="ghost"
              onClick={() => {
                setSkippedDate(null);
              }}
            >
              补写今天复盘
            </Button>
          </div>
        ) : (
          <div className={styles.form}>
            {QUESTIONS.map(({ key, title }) => (
              <Textarea
                key={key}
                label={title}
                value={draft[key]}
                rows={3}
                onChange={(event) => {
                  update(answerPatch(key, event.target.value));
                }}
              />
            ))}

            <div className={styles.energy} role="group" aria-label="今天的精力">
              <p className={styles.blockLabel}>今天的精力（可选）</p>
              <div className={styles.energyOptions}>
                {ENERGY_OPTIONS.map((option) => (
                  <Button
                    key={option.value}
                    variant="ghost"
                    aria-pressed={draft.energyLevel === option.value}
                    onClick={() => {
                      update({ energyLevel: option.value });
                    }}
                  >
                    {option.label}
                  </Button>
                ))}
              </div>
            </div>

            <div className={styles.actions}>
              <Button variant="primary" loading={saving} disabled={!hasAnyAnswer} onClick={submit}>
                保存
              </Button>
              <Button
                variant="ghost"
                disabled={saving}
                onClick={() => {
                  setSkippedDate(date);
                }}
              >
                跳过今天
              </Button>
            </div>

            {hasAnyAnswer ? null : (
              <p className={styles.hint}>填写任意一题即可保存，或选择跳过今天</p>
            )}

            {formError === null ? null : (
              <p className={styles.error} role="alert">
                {formError}
              </p>
            )}

            {savedDate === null ? null : (
              <p className={styles.status} role="status">
                已保存 · {savedDate}
              </p>
            )}
          </div>
        )
      ) : null}
    </div>
  );
}

/**
 * 事实摘要区块（B1「区块一」）。
 *
 * `item` 为 `null` 有两种成因——这天没填写（`data: null`）或还没取回来——两者的
 * 事实摘要都只能是「没有事实」，因此共用同一个空态；加载中另给骨架，不闪空态文案。
 */
function FactsBlock({
  item,
  loading,
}: {
  readonly item: DailyReviewItem | null;
  readonly loading: boolean;
}) {
  const hasFacts =
    item !== null &&
    (item.facts.plannedMinutes > 0 ||
      item.facts.actualMinutes > 0 ||
      item.facts.completedCount > 0 ||
      item.facts.uncompletedCount > 0);

  return (
    <section className={styles.facts} aria-label="今天的事实摘要">
      <h3 className={styles.blockTitle}>今天的事实</h3>
      {loading ? (
        <div className={styles.skeleton}>
          <Skeleton width="60%" />
        </div>
      ) : hasFacts && item !== null ? (
        <>
          <div className={styles.factRow}>
            <Badge variant="neutral">完成 {item.facts.completedCount}</Badge>
            <Badge variant="neutral">未完成 {item.facts.uncompletedCount}</Badge>
          </div>
          <p className={styles.hint}>
            计划 {formatMinutes(item.facts.plannedMinutes)} · 实际{' '}
            {formatMinutes(item.facts.actualMinutes)} · 差值{' '}
            {formatSignedMinutes(item.facts.actualMinutes - item.facts.plannedMinutes)}
          </p>
        </>
      ) : (
        <>
          <p className={styles.hint}>今天没有执行记录。</p>
          <p className={styles.hint}>有计划或执行后，这里会显示当天的事实摘要。</p>
          <p className={styles.hint}>
            <Link href="/today">查看今日计划</Link>
          </p>
        </>
      )}
    </section>
  );
}

/** 服务端那份 → 草稿（空值为空串、无精力为 `null`）。 */
function draftFromServer(item: DailyReviewItem | null): DailyDraft {
  if (item === null) {
    return EMPTY_DRAFT;
  }
  return {
    completed: item.answers?.completed ?? '',
    blocker: item.answers?.blocker ?? '',
    nextAdjustment: item.answers?.nextAdjustment ?? '',
    energyLevel: item.energyLevel,
  };
}

/** 单题改动 → 草稿补丁（显式分支而不是计算键：计算键会把联合类型退化成 `string` 索引）。 */
function answerPatch(key: ReviewAnswerKey, value: string): Partial<DailyDraft> {
  if (key === 'completed') {
    return { completed: value };
  }
  if (key === 'blocker') {
    return { blocker: value };
  }
  return { nextAdjustment: value };
}

/** 草稿 → 提交用的 `answers`（去空白、丢空串；全空返回 `null`＝未答）。 */
function toAnswers(draft: DailyDraft): { readonly [key in ReviewAnswerKey]?: string } | null {
  const answers: { completed?: string; blocker?: string; nextAdjustment?: string } = {};
  for (const { key } of QUESTIONS) {
    const value = draft[key].trim();
    if (value !== '') {
      answers[key] = value;
    }
  }
  return Object.keys(answers).length === 0 ? null : answers;
}
