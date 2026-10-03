'use client';

import { useEffect, useRef, useState } from 'react';

import {
  AiConsentDialog,
  AiScopeNotice,
  AiUnavailableNotice,
  Badge,
  Button,
  Checkbox,
  Skeleton,
  Textarea,
} from '@/shared/ui/components';

import { cancelAiDraft, generateReviewSummary } from '../_lib/ai-api';
import type { ReviewSummaryText } from '../_lib/ai-api';
import { grantAiConsent, useAiConsent } from '../_lib/ai-consent';
import { useAiEnabled } from '../_lib/use-ai-enabled';

import styles from './WeeklyAiSummarySection.module.css';

/** 〔本次主动提交的内容〕的替换文本（C4 冻结句式里的占位）。 */
const SCOPE_TEXT = '你勾选的这几类本周数据';

/** 空态文案（§5 D，冻结）。 */
const EMPTY_TEXT = '本周摘要在你选择数据后生成，不会自动运行。';

/** 底部禁区行（§5 D / FR-083，冻结；「AI建议」之间无空格）。 */
const FORBIDDEN_LINE = 'AI建议仅供参考，不提供医疗、心理、投资或借贷判断。';

/** 四类数据范围（§5 D 冻结清单）。 */
type ScopeKey = 'plan' | 'deferral' | 'expense' | 'review';

const SCOPE_OPTIONS: readonly { readonly key: ScopeKey; readonly label: string }[] = [
  { key: 'plan', label: '计划执行与时长' },
  { key: 'deferral', label: '重复延期' },
  { key: 'expense', label: '开销摘要' },
  { key: 'review', label: '本周复盘回答' },
];

/** 默认勾选「前两项」（§5 D）。 */
const DEFAULT_SCOPE: ReadonlySet<ScopeKey> = new Set<ScopeKey>(['plan', 'deferral']);

type Stage =
  | { readonly status: 'idle' }
  | { readonly status: 'selecting' }
  | { readonly status: 'loading' }
  | { readonly status: 'error' }
  | { readonly status: 'ready'; readonly text: string };

export type WeeklyAiSummarySectionProps = {
  /** 被复盘那一周的周一（`YYYY-MM-DD`）。 */
  readonly weekStart: string;
};

/**
 * 周复盘 AI 摘要区（《UI 页面规范》v0.22 §5 D，FR-083；AI-006）。
 *
 * ## 位置与排序
 *
 * 挂在「理解偏差」段内、既有洞察列表（B3）之后（调用点决定），不破
 * 「看到事实 → 理解偏差 → 做出调整」三段排序。
 *
 * ## 用户主动、不自动运行
 *
 * 初始只出空态与「生成本周摘要」；点开后先勾选四类数据范围（默认前两项、
 * 至少一项）→ C4 数据范围行 → 生成。不自动生成、不轮询。
 *
 * ## 不写入任何复盘字段
 *
 * 摘要只在页内呈现；「编辑」只改本地文本，「取消」丢弃草稿回初始态。摘要里的
 * 调整建议若被采纳，一律走 B3/B4 既有就地操作链（§5 D 明文），本区不新增旁路写入。
 *
 * ## 已知取舍
 *
 * 生成失败（`status='failed'`，按 200 返回空摘要）与 provider 故障共用同一错误行
 * ——二者对用户的下一步（重试）相同，但「AI 暂不可用」对空结果并不精确，已在
 * 交付报告中如实标注。
 */
export function WeeklyAiSummarySection({ weekStart }: WeeklyAiSummarySectionProps) {
  const aiEnabled = useAiEnabled();
  const consent = useAiConsent();

  const [stage, setStage] = useState<Stage>({ status: 'idle' });
  const [selected, setSelected] = useState<ReadonlySet<ScopeKey>>(DEFAULT_SCOPE);
  const [editing, setEditing] = useState(false);
  const [consentOpen, setConsentOpen] = useState(false);
  /** 已生成的草稿 id（取消 / 卸载时取消，避免留下悬空 pending 草稿）。 */
  const draftIdRef = useRef<string | null>(null);

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

  const runGenerate = async (keys: ReadonlySet<ScopeKey>): Promise<void> => {
    const includeTasks = keys.has('plan') || keys.has('deferral') || keys.has('review');
    const includeExpenses = keys.has('expense');
    if (!includeTasks && !includeExpenses) {
      return;
    }
    setStage({ status: 'loading' });
    try {
      const envelope = await generateReviewSummary({
        weekStart,
        scope: { includeTasks, includeExpenses },
      });
      const data = envelope.data;
      const text = summaryToText(data.summary);
      // 生成失败按 §1.3 返 200 + 空载荷：没有可编辑的正文，落错误行 + 重试。
      if (data.status === 'failed' || text === '') {
        setStage({ status: 'error' });
        return;
      }
      draftIdRef.current = data.draftId;
      setEditing(false);
      setStage({ status: 'ready', text });
    } catch {
      // provider 故障（504/502/429）与网络失败都落「AI 暂不可用」错误行。
      setStage({ status: 'error' });
    }
  };

  const generate = () => {
    if (selected.size === 0) {
      return;
    }
    if (consent !== true) {
      setConsentOpen(true);
      return;
    }
    void runGenerate(selected);
  };

  const agreeConsent = () => {
    setConsentOpen(false);
    grantAiConsent();
    void runGenerate(selected);
  };

  /** 取消＝丢弃草稿、区回初始态（§5 D）。 */
  const discard = () => {
    const id = draftIdRef.current;
    if (id !== null) {
      void cancelAiDraft(id).catch(() => {
        // 取消失败不阻塞回初始态：草稿会随时间自然过期。
      });
      draftIdRef.current = null;
    }
    setEditing(false);
    setStage({ status: 'idle' });
  };

  const toggleScope = (key: ScopeKey, next: boolean) => {
    setSelected((current) => {
      const copy = new Set(current);
      if (next) {
        copy.add(key);
      } else {
        copy.delete(key);
      }
      return copy;
    });
  };

  // AI 关闭态（§5 E）：`null`（还没读出来）与 `false` 都不渲染入口。
  if (aiEnabled !== true) {
    return null;
  }

  return (
    <section className={styles.section} aria-label="AI 摘要">
      {stage.status === 'idle' ? (
        <div className={styles.empty}>
          <p className={styles.hint}>{EMPTY_TEXT}</p>
          <Button
            variant="secondary"
            onClick={() => {
              setStage({ status: 'selecting' });
            }}
          >
            生成本周摘要
          </Button>
        </div>
      ) : null}

      {stage.status === 'selecting' ? (
        <div className={styles.panel}>
          <div className={styles.scope} role="group" aria-label="数据范围">
            {SCOPE_OPTIONS.map((option) => (
              <Checkbox
                key={option.key}
                label={option.label}
                checked={selected.has(option.key)}
                onChange={(next) => {
                  toggleScope(option.key, next);
                }}
              />
            ))}
          </div>
          <AiScopeNotice scope={SCOPE_TEXT} />
          <div className={styles.actions}>
            <Button variant="secondary" disabled={selected.size === 0} onClick={generate}>
              生成本周摘要
            </Button>
            <Button
              variant="ghost"
              onClick={() => {
                setStage({ status: 'idle' });
              }}
            >
              取消
            </Button>
          </div>
        </div>
      ) : null}

      {stage.status === 'loading' ? (
        <div className={styles.panel}>
          <Skeleton />
          <Skeleton width="85%" />
        </div>
      ) : null}

      {stage.status === 'error' ? (
        <div className={styles.panel}>
          <AiUnavailableNotice
            onRetry={() => {
              void runGenerate(selected);
            }}
          />
        </div>
      ) : null}

      {stage.status === 'ready' ? (
        <div className={styles.panel}>
          <AiScopeNotice scope={SCOPE_TEXT} />
          <div className={styles.head}>
            <Badge variant="neutral">AI 建议</Badge>
          </div>

          {editing ? (
            <Textarea
              label="摘要正文"
              value={stage.text}
              onChange={(event) => {
                const next = event.target.value;
                setStage({ status: 'ready', text: next });
              }}
            />
          ) : (
            <div className={styles.body}>
              {stage.text.split('\n').map((line, index) => (
                // 正文行没有稳定 id（用户可随意改写），用位置作键——只影响重排优化。
                <p key={`${String(index)}:${line}`} className={styles.line}>
                  {line}
                </p>
              ))}
            </div>
          )}

          <div className={styles.actions}>
            <Button
              variant="ghost"
              onClick={() => {
                setEditing((current) => !current);
              }}
            >
              {editing ? '完成' : '编辑'}
            </Button>
            <Button
              variant="ghost"
              onClick={() => {
                void runGenerate(selected);
              }}
            >
              重新生成
            </Button>
            <Button variant="ghost" onClick={discard}>
              取消
            </Button>
          </div>

          <p className={styles.forbidden}>{FORBIDDEN_LINE}</p>
        </div>
      ) : null}

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
    </section>
  );
}

/** 摘要载荷 → 可编辑正文（要点在前、建议在后，逐行）。 */
function summaryToText(summary: ReviewSummaryText): string {
  return [...summary.highlights, ...summary.suggestions].join('\n');
}
