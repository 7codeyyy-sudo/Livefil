'use client';

import { useEffect, useRef, useState } from 'react';

import {
  AiConsentDialog,
  AiScopeNotice,
  AiUnavailableNotice,
  Button,
  Input,
  Skeleton,
} from '@/shared/ui/components';

import { cancelAiDraft, confirmAiDraft, generateExpenseParse } from '../_lib/ai-api';
import { grantAiConsent, useAiConsent } from '../_lib/ai-consent';
import { ApiRequestError } from '../_lib/api-client';
import {
  createExpense,
  formatMinorToHuman,
  isAmountTyping,
  parseHumanToMinor,
} from '../_lib/expense-api';
import type { ExpenseCategoryItem } from '../_lib/expense-api';
import { localCalendarDate } from '../_lib/queries';
import { useAiEnabled } from '../_lib/use-ai-enabled';
import { ExpenseSelect } from './ExpenseSelect';
import type { SelectGroup } from './ExpenseSelect';

import styles from './ExpenseAiParseArea.module.css';

/** 〔本次主动提交的内容〕的替换文本（C4 冻结句式里的占位）。 */
const SCOPE_TEXT = '你粘贴的这段文本';

/** 未识别出金额时的冻结错误文案（§5 C3）。 */
const AMOUNT_NOT_RECOGNIZED = '未识别出金额，请手动填写。';

/** 解析流程的四个阶段（`confirm` 承载确认界面所需的草稿上下文）。 */
type ParseStage =
  | { readonly status: 'idle' }
  | { readonly status: 'typing' }
  | { readonly status: 'loading' }
  | { readonly status: 'error' }
  | {
      readonly status: 'confirm';
      /** `null` ＝ 生成失败（未识别出金额），确认时走普通创建用例。 */
      readonly draftId: string | null;
      readonly failed: boolean;
    };

export type ExpenseAiParseAreaProps = {
  readonly categories: readonly ExpenseCategoryItem[];
  readonly recentCategoryIds: readonly string[];
  readonly defaultCurrencyCode: string;
  /** 记账成功后关抽屉 + 刷新列表（复用抽屉既有的保存回调）。 */
  readonly onSaved: () => void;
};

/**
 * 开销解析（《UI 页面规范》v0.22 §5 C3，FR-082；AI-006）。
 *
 * ## 载体
 *
 * 「粘贴文本记一笔」是记账 Drawer body 底部的**低强调**入口；点开才出现 inline
 * 输入（`placeholder` 取 FR-082 原文示例）。识别结果不是一个浮层，而是同一 body
 * 内的确认区：说明行 + 金额（置顶突出）/ 日期 / 分类三字段 + 确认/放弃。
 *
 * ## 确认前零写入
 *
 * 识别只产出一张 `pending` 草稿，界面上的改动全在本地态；「确认记账」才落库。
 * 「放弃」取消草稿并回初始态，不写任何业务实体。
 *
 * ## 未识别出金额
 *
 * 生成失败按 §1.3 返 200 + `draft: null`，而 `confirm` 对 `failed` 草稿一律 422。
 * 因此这一支**不用 confirm**，而是走普通创建用例（§5 C3 原文：「确认记账」→
 * 走普通创建用例）——金额由用户手填，不提供无金额确认（按钮在金额非法时禁用）。
 */
export function ExpenseAiParseArea({
  categories,
  recentCategoryIds,
  defaultCurrencyCode,
  onSaved,
}: ExpenseAiParseAreaProps) {
  const aiEnabled = useAiEnabled();
  const consent = useAiConsent();

  const [stage, setStage] = useState<ParseStage>({ status: 'idle' });
  const [text, setText] = useState('');
  const [amount, setAmount] = useState('');
  const [occurredOn, setOccurredOn] = useState(() => localCalendarDate());
  const [categoryId, setCategoryId] = useState('');
  const [categoryError, setCategoryError] = useState<string | undefined>(undefined);
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [consentOpen, setConsentOpen] = useState(false);
  /** 已生成的草稿 id（放弃 / 卸载时取消，避免留下悬空 pending 草稿）。 */
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

  const reset = () => {
    setStage({ status: 'idle' });
    setText('');
    setAmount('');
    setOccurredOn(localCalendarDate());
    setCategoryId('');
    setCategoryError(undefined);
    setFormError(null);
  };

  const runParse = async (): Promise<void> => {
    setStage({ status: 'loading' });
    setFormError(null);
    try {
      const envelope = await generateExpenseParse({ text: text.trim() });
      const data = envelope.data;
      if (data.status === 'failed' || data.draft === null) {
        // 未识别出金额：草稿是 `failed` 终态，没有可取消、也没有可确认的东西。
        draftIdRef.current = null;
        setAmount('');
        setOccurredOn(localCalendarDate());
        setCategoryId('');
        setStage({ status: 'confirm', draftId: null, failed: true });
        return;
      }
      draftIdRef.current = data.draftId;
      const suggested = data.draft.categoryId;
      setAmount(formatMinorToHuman(String(data.draft.amountMinor)));
      setOccurredOn(data.draft.occurredOn);
      // 只回填**真实存在**的分类：模型给的 id 不一定在用户的分类表里。
      setCategoryId(
        suggested !== null && categories.some((item) => item.id === suggested) ? suggested : '',
      );
      setStage({
        status: 'confirm',
        draftId: data.draftId,
        failed: false,
      });
    } catch {
      // provider 故障（504/502/429）与网络失败都落「AI 暂不可用」错误行。
      setStage({ status: 'error' });
    }
  };

  const startParse = () => {
    if (text.trim() === '') {
      return;
    }
    if (consent !== true) {
      setConsentOpen(true);
      return;
    }
    void runParse();
  };

  const agreeConsent = () => {
    setConsentOpen(false);
    grantAiConsent();
    void runParse();
  };

  /** 放弃：取消草稿（若在）并回初始态，零写入（§5 C3）。 */
  const discard = () => {
    const id = draftIdRef.current;
    if (id !== null) {
      void cancelAiDraft(id).catch(() => {
        // 取消失败不阻塞回到初始态：草稿会随时间自然过期。
      });
      draftIdRef.current = null;
    }
    reset();
  };

  const confirm = async (): Promise<void> => {
    if (stage.status !== 'confirm') {
      return;
    }
    const parsed = parseHumanToMinor(amount);
    if (!parsed.ok) {
      return;
    }
    if (categoryId === '') {
      setCategoryError('请选择一个分类');
      return;
    }
    // 契约的 `amountMinor` 是 JSON 数字；越界（超出安全整数）宁可报错也不静默失真。
    const minorNumber = Number(parsed.minor);
    if (!Number.isSafeInteger(minorNumber)) {
      setFormError('金额超出可记录范围。');
      return;
    }

    setCategoryError(undefined);
    setFormError(null);
    setSubmitting(true);
    try {
      if (stage.draftId === null) {
        await createExpense({
          amountMinor: parsed.minor,
          currencyCode: defaultCurrencyCode,
          categoryId,
          occurredOn,
          lifeAreaId: null,
          goalId: null,
          actionId: null,
          paymentMethod: null,
          note: null,
        });
      } else {
        await confirmAiDraft(stage.draftId, {
          expense: { categoryId, amountMinor: minorNumber, occurredOn },
        });
        draftIdRef.current = null;
      }
      // 成功即关抽屉（由调用方负责），错误行与 submitting 不再需要复位。
      onSaved();
    } catch (error) {
      setFormError(error instanceof ApiRequestError ? error.message : '记账失败，请稍后重试');
      setSubmitting(false);
    }
  };

  // AI 关闭态（§5 E）：`null`（还没读出来）与 `false` 都不渲染入口。
  if (aiEnabled !== true) {
    return null;
  }

  if (stage.status === 'idle') {
    return (
      <div className={styles.area}>
        <div className={styles.inputRow}>
          <Button
            variant="ghost"
            onClick={() => {
              setStage({ status: 'typing' });
            }}
          >
            粘贴文本记一笔
          </Button>
        </div>
      </div>
    );
  }

  if (stage.status === 'typing') {
    return (
      <div className={styles.area}>
        <div className={styles.inputRow}>
          <Input
            label="粘贴文本"
            placeholder="午饭 35 元，餐饮"
            value={text}
            onChange={(event) => {
              setText(event.target.value);
            }}
          />
          <Button variant="secondary" disabled={text.trim() === ''} onClick={startParse}>
            识别
          </Button>
          <Button variant="ghost" onClick={reset}>
            取消
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
      </div>
    );
  }

  if (stage.status === 'loading') {
    return (
      <div className={styles.area}>
        <div className={styles.loading}>
          <Skeleton />
          <Skeleton width="80%" />
        </div>
      </div>
    );
  }

  if (stage.status === 'error') {
    return (
      <div className={styles.area}>
        <AiUnavailableNotice
          onRetry={() => {
            void runParse();
          }}
          secondaryAction={{ label: '放弃', onClick: reset }}
        />
      </div>
    );
  }

  const parsed = parseHumanToMinor(amount);
  // 金额错误随时可见（禁用按钮不能成为唯一解释）：空且未识别 → 冻结文案，其余 → 校验原文。
  const amountError =
    amount.trim() === ''
      ? stage.failed
        ? AMOUNT_NOT_RECOGNIZED
        : '请填写金额'
      : parsed.ok
        ? undefined
        : parsed.message;

  return (
    <div className={styles.area}>
      <div className={styles.confirm}>
        <AiScopeNotice scope={SCOPE_TEXT} />
        <p className={styles.notice}>请核对金额后确认，写入前不会保存。</p>

        <div className={styles.amountField}>
          <Input
            data-expense-ai-amount
            label="金额（必填）"
            aria-required="true"
            inputMode="decimal"
            autoComplete="off"
            placeholder="0.00"
            value={amount}
            error={amountError}
            onChange={(event) => {
              if (isAmountTyping(event.target.value)) {
                setAmount(event.target.value);
              }
            }}
          />
        </div>

        <Input
          label="日期（必填）"
          aria-required="true"
          type="date"
          max={localCalendarDate()}
          value={occurredOn}
          onChange={(event) => {
            setOccurredOn(event.target.value);
          }}
        />

        <ExpenseSelect
          label="分类（必填）"
          searchable
          searchLabel="搜索分类"
          value={categoryId}
          error={categoryError}
          placeholder="请选择"
          groups={selectGroups(categories, recentCategoryIds)}
          onChange={(next) => {
            setCategoryError(undefined);
            setCategoryId(next);
          }}
        />

        {formError === null ? null : (
          <p className={styles.error} role="alert">
            {formError}
          </p>
        )}

        <div className={styles.actions}>
          {/* 金额非法即禁用：§5 C3「不提供无金额确认」。 */}
          <Button
            variant="primary"
            loading={submitting}
            disabled={!parsed.ok}
            onClick={() => void confirm()}
          >
            确认记账
          </Button>
          <Button variant="ghost" disabled={submitting} onClick={discard}>
            放弃
          </Button>
        </div>
      </div>
    </div>
  );
}

/**
 * 分类选择器的分组：最近使用（≤3）→ 默认分类 → 自定义。
 *
 * 与记账表单同一列示口径（§5 A3），但少一个「当前（已停用）」组——AI 确认界面
 * 的初值要么为空、要么是模型给的真实分类，不存在「已停用分类被预选」的情形。
 */
function selectGroups(
  categories: readonly ExpenseCategoryItem[],
  recentCategoryIds: readonly string[],
): readonly SelectGroup[] {
  const active = categories.filter((item) => !item.isArchived);
  const recent = recentCategoryIds
    .map((id) => active.find((item) => item.id === id))
    .filter((item): item is ExpenseCategoryItem => item !== undefined)
    .slice(0, 3);
  const defaults = active
    .filter((item) => item.isDefault)
    .sort((a, b) => a.sortOrder - b.sortOrder);
  const customs = active
    .filter((item) => !item.isDefault)
    .sort((a, b) => b.sortOrder - a.sortOrder);

  const groups: SelectGroup[] = [];
  if (recent.length > 0) {
    groups.push({
      label: '最近使用',
      options: recent.map((item) => ({ value: item.id, label: item.name })),
    });
  }
  groups.push({
    label: '默认分类',
    options: defaults.map((item) => ({ value: item.id, label: item.name })),
  });
  if (customs.length > 0) {
    groups.push({
      label: '自定义',
      options: customs.map((item) => ({ value: item.id, label: item.name })),
    });
  }
  return groups;
}
