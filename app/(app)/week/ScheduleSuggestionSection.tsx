'use client';

import { useEffect, useRef, useState } from 'react';

import {
  AiConsentDialog,
  AiScopeNotice,
  AiUnavailableNotice,
  Badge,
  Button,
  Checkbox,
  Input,
  Skeleton,
  useAsyncQuery,
  useToast,
} from '@/shared/ui/components';

import { cancelAiDraft, generateScheduleSuggestion } from '../_lib/ai-api';
import { grantAiConsent, useAiConsent } from '../_lib/ai-consent';
import { ApiRequestError, fetchJson, sendJson } from '../_lib/api-client';

import styles from './ScheduleSuggestionSection.module.css';

/** 〔本次主动提交的内容〕的替换文本（C4 冻结句式里的占位）。 */
const SCOPE_TEXT = '你所选的任务与可用时间';

/** 可用时间的默认值（分钟）。 */
const DEFAULT_AVAILABLE_MINUTES = '60';

/** 空结果态文案（§5 C2 小补；2026-10-05 口定，覆盖 PM v0.24 流程）。 */
const EMPTY_RESULT_TEXT = '这次没给出建议。你可以手动安排，或重新生成。';

/** 选来做排程建议的候选任务（`GET /tasks?status=inbox`）。 */
interface CandidateTask {
  readonly id: string;
  readonly title: string;
}

/** 一条就地建议（编辑只在本地态；「接受」才落到时间线）。 */
interface SuggestionRow {
  readonly key: string;
  readonly taskId: string;
  /** ISO 8601 瞬时（本地 / UTC 混合均可，展示按本地时区）。 */
  readonly start: string;
  readonly end: string;
  readonly reason: string;
}

type DraftState =
  | { readonly status: 'idle' }
  | { readonly status: 'loading' }
  /** 空结果（`status='failed'` 或零建议）＝空态、非故障。 */
  | { readonly status: 'empty' }
  | { readonly status: 'error' }
  | { readonly status: 'ready'; readonly rows: readonly SuggestionRow[] };

export type ScheduleSuggestionSectionProps = {
  /** 本周起点（`YYYY-MM-DD`）。 */
  readonly weekStart: string;
  /** 本周闭区间末日（`YYYY-MM-DD`）。 */
  readonly weekEnd: string;
  /** 「手动安排」→ 打开既有排程创建弹层（AI-005 失败回退路径）。 */
  readonly onManualSchedule: (taskIds: readonly string[]) => void;
  /** 一条建议被接受（写入时间块）后刷新周视图。 */
  readonly onScheduled: () => void;
};

function localTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

/** 本地日历日 + 墙钟 → ISO 瞬时（`new Date` 按本地时区解释无时区后缀的字符串）。 */
function localIso(day: string, clock: string): string {
  return new Date(`${day}T${clock}`).toISOString();
}

/** ISO 瞬时 → `datetime-local` 输入值（本地时区）。 */
function toLocalInput(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return '';
  }
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${String(date.getFullYear())}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** `datetime-local` 输入值 → ISO 瞬时；无法解析时原样返回（交给服务端挡下）。 */
function fromLocalInput(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toISOString();
}

/** 时间块预览文案（`MM-DD HH:mm – HH:mm`，tabular-nums 由样式负责）。 */
function previewRange(start: string, end: string): string {
  const format = (iso: string): string => {
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) {
      return iso;
    }
    const pad = (value: number): string => String(value).padStart(2, '0');
    return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
  };
  return `${format(start)} – ${format(end)}`;
}

async function fetchCandidateTasks(signal: AbortSignal): Promise<readonly CandidateTask[]> {
  const envelope = await fetchJson<{ readonly items: readonly CandidateTask[] }>(
    '/api/v1/tasks?status=inbox&limit=50',
    signal,
  );
  return envelope.data.items;
}

/**
 * 排程建议（《UI 页面规范》v0.22 §5 C2，FR-081；AI-005）。
 *
 * ## 入口与「只读取主动选择」
 *
 * 排程页原无任务选择，这里给出勾选清单与「可用时间」，点「**安排时间**」才发请求
 * ——只把用户**主动勾选**的任务与可用分钟交给模型（AI-005 勾选）。
 *
 * ## 就地建议块（非浮层）
 *
 * 每条＝时间块预览（起止 + 任务名，tabular-nums）+「编辑」（改起止）+「接受」
 * （primary，创建时间块）+「拒绝」（低强调，移除该条）。
 *
 * ## 接受为什么走 `POST /schedule-blocks` 而不是草稿 confirm
 *
 * `confirm` 一型会**一次写入全部 `suggestions`**（见 `ConfirmAiDraftUseCase`），
 * 无法承载「逐条拒绝后再接受」的语义；而 §5 C2 明确「接受＝创建时间块、拒绝＝移除
 * 该条」。故每条接受直接走既有排程创建用例（`source='suggested'`），与后端确认
 * 路径写出的实体完全同形；撤销即 `DELETE /api/v1/schedule-blocks/{id}`。
 *
 * ## 失败回退
 *
 * 开关开但 provider 故障（`ApiRequestError` = 504/502/429）时出错误行 + 「手动安排」，
 * 后者打开既有排程创建弹层——手动路径始终可用，不自动切换、不弹窗。
 *
 * ## 空结果不是故障
 *
 * 生成返 200 但零建议（`status='failed'`）时走**空态**（说明 + 「重新生成」+「手动安排」），
 * 不渲染错误行——「AI 暂不可用」只用于真故障与 AI 关闭态（RD-20260929-009 终审 (c)）。
 */
export function ScheduleSuggestionSection({
  weekStart,
  weekEnd,
  onManualSchedule,
  onScheduled,
}: ScheduleSuggestionSectionProps) {
  const toast = useToast();
  const consent = useAiConsent();

  const tasks = useAsyncQuery({
    queryKey: ['tasks', 'schedule-suggestion-candidates'],
    queryFn: fetchCandidateTasks,
  });

  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [availableMinutes, setAvailableMinutes] = useState(DEFAULT_AVAILABLE_MINUTES);
  const [draft, setDraft] = useState<DraftState>({ status: 'idle' });
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [acceptingKey, setAcceptingKey] = useState<string | null>(null);
  /** 已生成的草稿 id（重生成 / 卸载时取消，避免留下悬空 pending 草稿）。 */
  const draftIdRef = useRef<string | null>(null);
  /** 首次调用前的一次性确认弹层是否打开（`consent !== true` 时由入口触发）。 */
  const [consentOpen, setConsentOpen] = useState(false);

  // 卸载时取消尚未消费的草稿（fire-and-forget）：草稿会自然过期，但主动取消更干净。
  useEffect(
    () => () => {
      const id = draftIdRef.current;
      if (id !== null) {
        void cancelAiDraft(id).catch(() => {
          // 取消失败不影响任何业务数据。
        });
      }
    },
    [],
  );

  const runGeneration = async (): Promise<void> => {
    const minutes = Number(availableMinutes);
    const taskIds = [...selected];
    if (taskIds.length === 0 || !Number.isInteger(minutes) || minutes <= 0) {
      return;
    }
    setDraft({ status: 'loading' });
    try {
      const envelope = await generateScheduleSuggestion({
        taskIds,
        availableMinutes: minutes,
        windowStart: localIso(weekStart, '00:00:00'),
        windowEnd: localIso(weekEnd, '23:59:59'),
      });
      const data = envelope.data;
      draftIdRef.current = data.draftId;
      // 空结果（`status='failed'` 或零建议）＝**空态、非故障**：E 错误行只留真故障与
      // AI 关闭态，这里给空态说明 + 重新生成 + 手动安排（RD-20260929-009 终审 (c) 小补）。
      if (data.status === 'failed' || data.suggestions.length === 0) {
        setDraft({ status: 'empty' });
        return;
      }
      setDraft({
        status: 'ready',
        rows: data.suggestions.map((suggestion, index) => ({
          key: `row-${String(index)}`,
          taskId: suggestion.taskId,
          start: suggestion.blockStart,
          end: suggestion.blockEnd,
          reason: suggestion.reason,
        })),
      });
    } catch {
      // provider 故障（504/502/429）与网络失败都落「AI 暂不可用」错误行。
      setDraft({ status: 'error' });
    }
  };

  const generate = () => {
    if (selected.size === 0 || !(Number(availableMinutes) > 0)) {
      return;
    }
    if (consent !== true) {
      setConsentOpen(true);
      return;
    }
    const previous = draftIdRef.current;
    if (previous !== null) {
      void cancelAiDraft(previous).catch(() => {});
      draftIdRef.current = null;
    }
    void runGeneration();
  };

  const agreeConsent = () => {
    setConsentOpen(false);
    grantAiConsent();
    void runGeneration();
  };

  const toggleSelected = (taskId: string, next: boolean) => {
    setSelected((current) => {
      const copy = new Set(current);
      if (next) {
        copy.add(taskId);
      } else {
        copy.delete(taskId);
      }
      return copy;
    });
  };

  const updateRow = (key: string, patch: Partial<Pick<SuggestionRow, 'start' | 'end'>>) => {
    setDraft((current) =>
      current.status === 'ready'
        ? {
            ...current,
            rows: current.rows.map((row) => (row.key === key ? { ...row, ...patch } : row)),
          }
        : current,
    );
  };

  const removeRow = (key: string) => {
    setDraft((current) =>
      current.status === 'ready'
        ? { ...current, rows: current.rows.filter((row) => row.key !== key) }
        : current,
    );
  };

  const undo = async (blockId: string) => {
    try {
      await sendJson('DELETE', `/api/v1/schedule-blocks/${blockId}`);
      onScheduled();
      toast.success('已撤销');
    } catch (error) {
      toast.error(error instanceof ApiRequestError ? error.message : '撤销失败，请稍后重试');
    }
  };

  const accept = async (row: SuggestionRow) => {
    setAcceptingKey(row.key);
    try {
      const envelope = await sendJson<{ readonly id: string }>('POST', '/api/v1/schedule-blocks', {
        taskId: row.taskId,
        startsAt: row.start,
        endsAt: row.end,
        timezone: localTimeZone(),
        source: 'suggested',
      });
      const blockId = envelope.data.id;
      removeRow(row.key);
      onScheduled();
      toast.success('已加入时间线', {
        action: {
          label: '撤销',
          onClick: () => {
            void undo(blockId);
          },
        },
      });
    } catch (error) {
      toast.error(error instanceof ApiRequestError ? error.message : '加入时间线失败，请稍后重试');
    } finally {
      setAcceptingKey(null);
    }
  };

  const candidates = tasks.state.status === 'success' ? tasks.state.data : null;
  const titleById = new Map((candidates ?? []).map((task) => [task.id, task.title]));

  return (
    <section className={styles.section} aria-label="排程建议">
      <div className={styles.head}>
        <h3 className={styles.title}>排程助手</h3>
        <p className={styles.hint}>勾选要安排的任务、给出可用时间，助手会给出建议时间块。</p>
      </div>

      {candidates === null ? (
        tasks.state.status === 'error' ? (
          <p className={styles.hint}>收件箱任务没能取回来，无法选择要安排的任务。</p>
        ) : (
          <Skeleton width="60%" />
        )
      ) : candidates.length === 0 ? (
        <p className={styles.hint}>收件箱里还没有可安排的任务。</p>
      ) : (
        <ul className={styles.candidates}>
          {candidates.map((task) => (
            <li key={task.id} className={styles.candidate}>
              <Checkbox
                label={`选择任务：${task.title}`}
                checked={selected.has(task.id)}
                onChange={(next) => {
                  toggleSelected(task.id, next);
                }}
              />
              <span className={styles.candidateTitle}>{task.title}</span>
            </li>
          ))}
        </ul>
      )}

      <div className={styles.controls}>
        <Input
          label="可用时间（分钟）"
          type="number"
          min={1}
          value={availableMinutes}
          onChange={(event) => {
            setAvailableMinutes(event.target.value);
          }}
        />
        <Button
          variant="secondary"
          disabled={selected.size === 0 || !(Number(availableMinutes) > 0)}
          onClick={generate}
        >
          安排时间
        </Button>
      </div>

      {consentOpen ? (
        <AiConsentDialog
          open
          scope={SCOPE_TEXT}
          onAgree={agreeConsent}
          onCancel={() => {
            setConsentOpen(false);
          }}
        />
      ) : null}

      {draft.status === 'loading' ? (
        <div className={styles.skeleton}>
          <Skeleton />
          <Skeleton width="80%" />
        </div>
      ) : null}

      {draft.status === 'error' ? (
        <AiUnavailableNotice
          onRetry={generate}
          secondaryAction={{ label: '手动安排', onClick: () => onManualSchedule([...selected]) }}
        />
      ) : null}

      {draft.status === 'empty' ? (
        <div className={styles.empty}>
          <p className={styles.hint}>{EMPTY_RESULT_TEXT}</p>
          <div className={styles.rowActions}>
            <Button variant="ghost" onClick={generate}>
              重新生成
            </Button>
            <Button
              variant="secondary"
              onClick={() => {
                onManualSchedule([...selected]);
              }}
            >
              手动安排
            </Button>
          </div>
        </div>
      ) : null}

      {draft.status === 'ready' ? (
        <div className={styles.suggestions}>
          <div className={styles.meta}>
            <AiScopeNotice scope={SCOPE_TEXT} />
            <Badge variant="neutral">建议</Badge>
          </div>
          {draft.rows.length === 0 ? (
            <p className={styles.hint}>建议都已处理完。可以重新生成。</p>
          ) : (
            <ul className={styles.rows}>
              {draft.rows.map((row) => (
                <li key={row.key} className={styles.row}>
                  {editingKey === row.key ? (
                    <div className={styles.editFields}>
                      <Input
                        label="开始"
                        type="datetime-local"
                        value={toLocalInput(row.start)}
                        onChange={(event) => {
                          updateRow(row.key, { start: fromLocalInput(event.target.value) });
                        }}
                      />
                      <Input
                        label="结束"
                        type="datetime-local"
                        value={toLocalInput(row.end)}
                        onChange={(event) => {
                          updateRow(row.key, { end: fromLocalInput(event.target.value) });
                        }}
                      />
                    </div>
                  ) : (
                    <div className={styles.preview}>
                      <span className={styles.time}>{previewRange(row.start, row.end)}</span>
                      <span className={styles.taskName}>
                        {titleById.get(row.taskId) ?? '已选任务'}
                      </span>
                    </div>
                  )}
                  <p className={styles.reason}>{row.reason}</p>
                  <div className={styles.rowActions}>
                    <Button
                      variant="ghost"
                      onClick={() => {
                        setEditingKey((current) => (current === row.key ? null : row.key));
                      }}
                    >
                      {editingKey === row.key ? '完成' : '编辑'}
                    </Button>
                    <Button
                      variant="primary"
                      loading={acceptingKey === row.key}
                      onClick={() => void accept(row)}
                    >
                      接受
                    </Button>
                    <Button
                      variant="ghost"
                      onClick={() => {
                        removeRow(row.key);
                      }}
                    >
                      拒绝
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
    </section>
  );
}
