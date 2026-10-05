'use client';

import { useEffect, useRef, useState } from 'react';

import {
  AiConsentDialog,
  AiScopeNotice,
  AiUnavailableNotice,
  Badge,
  Button,
  Drawer,
  IconButton,
  Input,
  Skeleton,
  useToast,
} from '@/shared/ui/components';

import { cancelAiDraft, confirmAiDraft, generateTaskBreakdown } from '../_lib/ai-api';
import { grantAiConsent, useAiConsent } from '../_lib/ai-consent';
import { ApiRequestError } from '../_lib/api-client';

import styles from './TaskBreakdownDraftDrawer.module.css';

/** 〔本次主动提交的内容〕的替换文本（C4 冻结句式里的占位）。 */
const SCOPE_TEXT = '你输入的这段描述';

/** 空结果态文案（§5 C1 小补；2026-10-05 口定，覆盖 PM v0.24 流程）。 */
const EMPTY_RESULT_TEXT = '这次没拆出可用的任务。你可以手动新建，或重新生成。';

/** 可编辑的一行建议（本地态；行 id 用于 React key，与服务端无关联）。 */
interface EditableRow {
  readonly id: string;
  readonly title: string;
  readonly minutes: string;
}

type DraftState =
  | { readonly status: 'loading' }
  /** 空结果（`status='failed'` 或零建议）＝空态、非故障。 */
  | { readonly status: 'empty' }
  | { readonly status: 'error' }
  | {
      readonly status: 'ready';
      readonly draftId: string;
      readonly expiresAt: string;
      readonly rows: readonly EditableRow[];
    };

export type TaskBreakdownDraftDrawerProps = {
  /** 用户在快速输入框里写下的原文（`task-breakdown` 的 `text`）。 */
  readonly text: string;
  readonly onClose: () => void;
  /** 确认创建成功后刷新收件箱。 */
  readonly onConfirmed: () => void;
};

/** 本地钟点 `HH:mm`（`expiresAt` 按用户本地时区显示）。 */
function clockOf(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/** 编辑框里的分钟文本 → 契约的整数分钟；空或非法一律 `null`（＝未填预计时长）。 */
function parseMinutes(value: string): number | null {
  const trimmed = value.trim();
  if (trimmed === '') {
    return null;
  }
  const parsed = Number(trimmed);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

/**
 * 任务拆解草稿面板（《UI 页面规范》v0.22 §5 C1，FR-080；AI-004）。
 *
 * ## 载体与头部
 *
 * Drawer 草稿面板（§4.5 冻结件「展示原文、建议结果、编辑和取消」）。头部行＝
 * C4 数据范围行 +「草稿」Badge +「有效期至 HH:mm」（取自 `expiresAt`）。
 *
 * ## 生成时机与首次确认
 *
 * 入口点下即生成（§5 C1「入口：快速输入框旁次按钮『拆分任务』」）；首次调用前
 * 先出一次性 `AiConsentDialog`（§5 C4），同意后本会话不再弹（`ai-consent.ts`
 * 用 `sessionStorage`）。同意状态为 `true` 之前不发任何请求。
 *
 * ## 确认前零写入
 *
 * 面板里的编辑只在本地态；「确认创建」才发 `confirm`，把**用户编辑后的**建议
 * （请求体的 `tasks`）交给服务端走普通任务创建用例写入正式数据；「取消」发
 * `cancel` 且不写业务实体（FR-080 硬约束）。
 *
 * ## 为什么确认体要带 `tasks`
 *
 * §5 C1 写死建议行「**可编辑、可移除单项**」——若确认时不把编辑结果交回服务端，
 * 「可编辑」就只是改了不生效的空壳。§11 未定义 `confirm` 的请求体，`tasks` 属本
 * 实现自选口径（见 `ai-draft-dto.ts`）；未带 `tasks` 时服务端回落草稿原值。
 */
export function TaskBreakdownDraftDrawer({
  text,
  onClose,
  onConfirmed,
}: TaskBreakdownDraftDrawerProps) {
  const toast = useToast();
  const consent = useAiConsent();
  const [attempt, setAttempt] = useState(0);
  const [draft, setDraft] = useState<DraftState>({ status: 'loading' });
  const [confirming, setConfirming] = useState(false);
  /** 到期态：由生成时排下的定时器翻转（渲染期读 `Date.now()` 是不纯的，lint 明禁）。 */
  const [draftExpired, setDraftExpired] = useState(false);
  const expiryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    // 同意之前不生成：把"首次确认"挡在请求之前（§5 C4）。
    if (consent !== true) {
      return;
    }
    let cancelled = false;

    /** 按 `expiresAt` 排一次到期翻转；已在期的直接置位。 */
    const scheduleExpiry = (expiresAt: string) => {
      if (expiryTimerRef.current !== null) {
        clearTimeout(expiryTimerRef.current);
        expiryTimerRef.current = null;
      }
      const remaining = Date.parse(expiresAt) - Date.now();
      if (!Number.isFinite(remaining) || remaining <= 0) {
        setDraftExpired(true);
        return;
      }
      setDraftExpired(false);
      expiryTimerRef.current = setTimeout(() => {
        setDraftExpired(true);
      }, remaining);
    };

    generateTaskBreakdown({ text })
      .then((envelope) => {
        if (cancelled) {
          return;
        }
        const data = envelope.data;
        // 空结果（`status='failed'` 或零建议）＝**空态、非故障**：E 错误行只留真故障与
        // AI 关闭态，这里给空态说明 + 重新生成（RD-20260929-009 终审 (c) 小补）。
        if (data.status === 'failed' || data.suggestions.length === 0) {
          setDraft({ status: 'empty' });
          return;
        }
        setDraft({
          status: 'ready',
          draftId: data.draftId,
          expiresAt: data.expiresAt,
          rows: data.suggestions.map((suggestion, index) => ({
            id: `row-${String(index)}`,
            title: suggestion.title,
            minutes: String(suggestion.estimatedMinutes),
          })),
        });
        scheduleExpiry(data.expiresAt);
      })
      .catch(() => {
        // provider 故障（504/502/429）与网络失败都落"AI 暂不可用"错误行。
        if (!cancelled) {
          setDraft({ status: 'error' });
        }
      });

    return () => {
      cancelled = true;
      if (expiryTimerRef.current !== null) {
        clearTimeout(expiryTimerRef.current);
        expiryTimerRef.current = null;
      }
    };
  }, [consent, attempt, text]);

  const regenerate = () => {
    setDraft({ status: 'loading' });
    setDraftExpired(false);
    setAttempt((current) => current + 1);
  };

  /** 关闭面板：草稿已生成时顺带取消它（不留下悬空的 pending 草稿）。 */
  const handleClose = () => {
    if (draft.status === 'ready') {
      void cancelAiDraft(draft.draftId).catch(() => {
        // 取消失败不阻塞关闭：草稿会随时间自然过期，不影响业务数据。
      });
    }
    onClose();
  };

  const updateRow = (id: string, patch: Partial<Pick<EditableRow, 'title' | 'minutes'>>) => {
    setDraft((current) => {
      if (current.status !== 'ready') {
        return current;
      }
      return {
        ...current,
        rows: current.rows.map((row) => (row.id === id ? { ...row, ...patch } : row)),
      };
    });
  };

  const removeRow = (id: string) => {
    setDraft((current) => {
      if (current.status !== 'ready') {
        return current;
      }
      return { ...current, rows: current.rows.filter((row) => row.id !== id) };
    });
  };

  const confirm = async () => {
    if (draft.status !== 'ready') {
      return;
    }
    setConfirming(true);
    try {
      // 带上用户编辑后的建议：服务端据此走普通任务创建用例落库（§5 C1）。
      const envelope = await confirmAiDraft(draft.draftId, {
        tasks: draft.rows.map((row) => ({
          title: row.title.trim(),
          estimatedMinutes: parseMinutes(row.minutes),
        })),
      });
      const created = envelope.data.createdIds.length;
      toast.success(`已创建 ${String(created)} 个任务`);
      onConfirmed();
      onClose();
    } catch (error) {
      toast.error(error instanceof ApiRequestError ? error.message : '确认失败，请稍后重试');
      setConfirming(false);
    }
  };

  // 首次确认：同意之前只出 Modal，不渲染草稿面板。
  if (consent !== true) {
    return <AiConsentDialog open scope={SCOPE_TEXT} onAgree={grantAiConsent} onCancel={onClose} />;
  }

  const expired = draft.status === 'ready' && draftExpired;
  // 空标题的确认会被服务端按 400 挡下（`tasks[].title` 的 `min(1)`），不如在这里
  // 就禁用并在字段上就地说明——「可编辑」不该以一次注定失败的请求收场。
  const allTitled = draft.status === 'ready' && draft.rows.every((row) => row.title.trim() !== '');

  return (
    <Drawer
      open
      title="拆分任务"
      onClose={handleClose}
      initialFocusSelector="[data-breakdown-row-title]"
      footer={
        <>
          <Button variant="ghost" onClick={handleClose} disabled={confirming}>
            取消
          </Button>
          <Button
            variant="primary"
            loading={confirming}
            disabled={draft.status !== 'ready' || expired || draft.rows.length === 0 || !allTitled}
            onClick={() => void confirm()}
          >
            确认创建
          </Button>
        </>
      }
    >
      <div className={styles.body}>
        <div className={styles.meta}>
          <AiScopeNotice scope={SCOPE_TEXT} />
          <div className={styles.metaRow}>
            <Badge variant="neutral">草稿</Badge>
            {draft.status === 'ready' ? (
              <span className={styles.expiry}>有效期至 {clockOf(draft.expiresAt)}</span>
            ) : null}
          </div>
        </div>

        {draft.status === 'loading' ? (
          <div className={styles.skeleton}>
            <Skeleton />
            <Skeleton width="85%" />
          </div>
        ) : null}

        {draft.status === 'error' ? <AiUnavailableNotice onRetry={regenerate} /> : null}

        {draft.status === 'empty' ? (
          <div className={styles.empty}>
            <p className={styles.emptyText}>{EMPTY_RESULT_TEXT}</p>
            <Button variant="ghost" onClick={regenerate}>
              重新生成
            </Button>
          </div>
        ) : null}

        {expired ? (
          <div className={styles.expired}>
            <p className={styles.expiredText} role="alert">
              草稿已过期，请重新生成。
            </p>
            <Button variant="secondary" onClick={regenerate}>
              重新生成
            </Button>
          </div>
        ) : null}

        {draft.status === 'ready' && !expired ? (
          draft.rows.length === 0 ? (
            <p className={styles.emptyRows}>建议里的任务都被移除了。可以重新生成。</p>
          ) : (
            <ul className={styles.rows}>
              {draft.rows.map((row) => (
                <li key={row.id} className={styles.row}>
                  <div className={styles.rowFields}>
                    <Input
                      data-breakdown-row-title
                      label="任务标题"
                      value={row.title}
                      error={row.title.trim() === '' ? '请填写任务标题' : undefined}
                      onChange={(event) => {
                        updateRow(row.id, { title: event.target.value });
                      }}
                    />
                    <Input
                      label="预计分钟"
                      type="number"
                      min={1}
                      value={row.minutes}
                      onChange={(event) => {
                        updateRow(row.id, { minutes: event.target.value });
                      }}
                    />
                  </div>
                  <IconButton
                    label={`移除建议：${row.title}`}
                    onClick={() => {
                      removeRow(row.id);
                    }}
                  >
                    ×
                  </IconButton>
                </li>
              ))}
            </ul>
          )
        ) : null}
      </div>
    </Drawer>
  );
}
