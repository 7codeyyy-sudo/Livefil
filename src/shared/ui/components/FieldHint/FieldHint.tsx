'use client';

import { useCallback, useId, useState } from 'react';

import { IconButton } from '../IconButton/IconButton';

import styles from './FieldHint.module.css';

/**
 * 表单字段解释的首批冻结文案（《UI 页面规范》v0.22 §5 B「表单字段解释」，AI-002）。
 *
 * **「」内为冻结文本，逐字使用、唯一准据。**
 *
 * 文案本体放在**共享层**而不是 `app/(app)/_lib/help-content.ts`：消费者里有
 * `ReminderRuleSection`（同为共享层），而分层规则禁止共享层反向依赖 app 层。
 */
export const FIELD_HINTS = {
  buffer: '缓冲是两件事之间的空白，留出转场时间。',
  minimumVersion: '做到最低标准也算完成，先保证不停摆。',
  reminderRepeat: '重复提醒会在你设定的日子按同一时间再次提醒。',
  quietHoursExempt: '勾选后，即使在安静时段也会提醒这一条。',
  expenseAssociation: '开销可关联一个目标、一个行动或一个生活领域，也可以不关联。',
  weekStartsOn: '每周从这一天开始统计，影响周视图与周复盘。',
} as const;

/** 字段解释的键，对应 `FIELD_HINTS` 里的一条冻结文案。 */
export type FieldHintKey = keyof typeof FIELD_HINTS;

/** 字段解释的展开状态（由 `useFieldHint` 产出，在切换按钮与说明行之间共享）。 */
export type FieldHintState = {
  /** 说明行是否展开。 */
  readonly open: boolean;
  /** 说明行的 id；展开时用于 `aria-describedby` 关联。 */
  readonly textId: string;
  readonly toggle: () => void;
};

/**
 * 字段解释的展开状态。
 *
 * 状态**必须由宿主持有**：`?` 按钮在标签尾部、说明行在字段下方，两者是同一个
 * 状态的两个渲染位置——各自持有状态的话，按钮就点不动那一行了。
 */
export function useFieldHint(): FieldHintState {
  const [open, setOpen] = useState(false);
  const textId = useId();

  const toggle = useCallback(() => {
    setOpen((current) => !current);
  }, []);

  return { open, textId, toggle };
}

export type FieldHintProps = {
  /** 字段标签，用于生成无障碍名称（「查看「缓冲」的说明」）。 */
  readonly label: string;
  readonly state: FieldHintState;
};

/**
 * 标签尾部的 `?` 按钮（§5 B「表单字段解释」）。
 *
 * 键盘可达由原生 `<button>` 保证；展开态用 `aria-expanded` 播报，`aria-controls`
 * 与 `aria-describedby`（展开时）指向说明行。**它不是浮层**：说明行是文档流里
 * 的一行，因此不以 tooltip / popover 形态出现。
 */
export function FieldHint({ label, state }: FieldHintProps) {
  return (
    <span className={styles.toggle}>
      <IconButton
        label={`查看「${label}」的说明`}
        aria-expanded={state.open}
        aria-controls={state.textId}
        // 收起时不登记 `aria-describedby`：指向未渲染的 id 会让读屏读到空内容，
        // 比不指更糟（与 `Input` 的 `describedBy` 同一口径）。
        {...(state.open ? { 'aria-describedby': state.textId } : {})}
        onClick={state.toggle}
      >
        ?
      </IconButton>
    </span>
  );
}

export type FieldHintTextProps = {
  readonly hint: FieldHintKey;
  readonly state: FieldHintState;
};

/**
 * 字段下方的展开说明行。收起时不渲染（原因见 `FieldHint` 里 `aria-describedby`
 * 的说明），因此它必须在**字段容器内、控件之后**的位置被宿主渲染。
 */
export function FieldHintText({ hint, state }: FieldHintTextProps) {
  if (!state.open) {
    return null;
  }

  return (
    <p className={styles.text} id={state.textId} data-variant="field-hint-text">
      {FIELD_HINTS[hint]}
    </p>
  );
}
