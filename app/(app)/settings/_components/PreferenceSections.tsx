'use client';

/**
 * 四个偏好分区（IAM-002，《UI 页面规范》v0.16 §5 的分区 2~5）。
 *
 * ## 为什么四个分区放在一个文件里
 *
 * 它们形状完全相同：一块 `SettingsSection` 外壳 + 三四个控件 + 一次保存，唯一的
 * 差异是字段清单与文案。拆成四个文件会让"保存是怎么接的"出现四份一模一样的代码，
 * 而真正的差异（哪些字段、什么提示、开关关闭时哪些控件要禁用）反而被稀释在
 * 重复的样板里。
 *
 * 生活领域分区不在本文件：它有独立的取数与增删改（`LifeAreasSection.tsx`）。
 */
import { useId, useState } from 'react';

import { Input, Select, Switch } from '@/shared/ui/components';
import { LOCALE_LABELS, SUPPORTED_LOCALES } from '@/shared/validation/locales.ts';

import styles from './PreferenceSections.module.css';
import { SettingsSection } from './SettingsSection';
import { useSaveAction } from './settings-hooks';
import {
  isSectionDirty,
  toNullableInteger,
  toNumberInput,
  type SectionBindings,
  type SettingsDraft,
} from './settings-draft';

/** 分区 2：地区与语言。 */
const REGION_KEYS = ['locale', 'timezone', 'currencyCode', 'weekStartsOn'] as const;
/** 分区 3：任务默认值。 */
const TASK_DEFAULT_KEYS = ['defaultTaskDurationMinutes', 'defaultBufferMinutes'] as const;
/** 分区 4：提醒与安静时段。 */
const REMINDER_KEYS = ['reminderEnabled', 'quietHoursStart', 'quietHoursEnd'] as const;
/** 分区 5：AI 与隐私。 */
const AI_KEYS = ['aiEnabled', 'aiDataConsent'] as const;

const WEEK_START_LABELS: Readonly<Record<number, string>> = Object.freeze({
  0: '周日',
  1: '周一',
  2: '周二',
  3: '周三',
  4: '周四',
  5: '周五',
  6: '周六',
});

/**
 * 可选时区。
 *
 * 与 `user-settings-schema.ts` 用同一个来源（运行时能力）而不是各自的清单：
 * 写死的时区表会随 tzdata 升级而陈旧，而"陈旧"在这里的表现是拒绝一个用户
 * 实际上合法的时区。取不到时（运行时缺完整 ICU）回退到几个常见值，
 * 至少让表单可用，而不是渲染一个空的下拉。
 */
const FALLBACK_TIME_ZONES: readonly string[] = Object.freeze([
  'UTC',
  'Asia/Shanghai',
  'Asia/Tokyo',
  'Europe/London',
  'America/New_York',
]);

function supportedTimeZones(): readonly string[] {
  try {
    return Intl.supportedValuesOf('timeZone');
  } catch {
    return FALLBACK_TIME_ZONES;
  }
}

const TIME_ZONES = supportedTimeZones();

/** 提交一组字段。抽出来是为了让每个分区只有一行「怎么保存」，而不是五行样板。 */
async function saveKeys(
  bindings: SectionBindings,
  keys: readonly (keyof SettingsDraft)[],
): Promise<void> {
  await bindings.save(keys);
}

export function RegionSection(bindings: SectionBindings) {
  const { saving, error, run } = useSaveAction();
  const { draft, baseline, update } = bindings;

  // 当前值可能不在运行时清单里（换过环境、tzdata 差异）。补进去，否则
  // `<select>` 会静默回落到第一项——用户看到的时区会在他没动过的情况下改变。
  const timeZones = TIME_ZONES.includes(draft.timezone)
    ? TIME_ZONES
    : [draft.timezone, ...TIME_ZONES];

  return (
    <SettingsSection
      title="地区与语言"
      description="影响日期、时间的显示方式与一周的起始日。"
      dirty={isSectionDirty(draft, baseline, REGION_KEYS)}
      saving={saving}
      error={error}
      onSave={() => {
        void run(() => saveKeys(bindings, REGION_KEYS));
      }}
    >
      <Select
        label="界面语言"
        value={draft.locale}
        onChange={(event) => {
          update({ locale: event.target.value });
        }}
      >
        {SUPPORTED_LOCALES.map((locale) => (
          <option key={locale} value={locale}>
            {LOCALE_LABELS[locale]}
          </option>
        ))}
      </Select>

      {/*
        规范 §5 写的是「timezone（可搜索选择）」，而项目里只有原生 `select`
        （§7 明令优先原生控件）。原生 select 支持**首字母跳转**，不是真正的模糊
        搜索。这里如实说明差距，而不是把"能打字跳转"包装成"可搜索"。
      */}
      <Select
        label="时区"
        hint="选中后可键入字母快速跳转；真正的模糊搜索未实现。"
        value={draft.timezone}
        onChange={(event) => {
          update({ timezone: event.target.value });
        }}
      >
        {timeZones.map((timeZone) => (
          <option key={timeZone} value={timeZone}>
            {timeZone}
          </option>
        ))}
      </Select>

      <Input
        label="货币代码"
        hint="三位大写字母，如 CNY、USD。"
        value={draft.currencyCode}
        maxLength={3}
        autoComplete="off"
        spellCheck={false}
        onChange={(event) => {
          // 统一转大写：服务端契约是 `^[A-Z]{3}$`，而人是会输小写的。
          // 与其让用户被 422 打回，不如在输入时归一。
          update({ currencyCode: event.target.value.toUpperCase() });
        }}
      />

      <Select
        label="一周起始日"
        value={String(draft.weekStartsOn)}
        onChange={(event) => {
          update({ weekStartsOn: Number(event.target.value) });
        }}
      >
        {Object.entries(WEEK_START_LABELS).map(([value, label]) => (
          <option key={value} value={value}>
            {label}
          </option>
        ))}
      </Select>
    </SettingsSection>
  );
}

export function TaskDefaultsSection(bindings: SectionBindings) {
  const { saving, error, run } = useSaveAction();
  const { draft, baseline, update } = bindings;

  return (
    <SettingsSection
      title="任务默认值"
      description="新建任务时预填的时长与间隔，留空表示不预填。"
      dirty={isSectionDirty(draft, baseline, TASK_DEFAULT_KEYS)}
      saving={saving}
      error={error}
      onSave={() => {
        void run(() => saveKeys(bindings, TASK_DEFAULT_KEYS));
      }}
    >
      <Input
        label="默认时长（分钟）"
        type="number"
        inputMode="numeric"
        min={1}
        value={toNumberInput(draft.defaultTaskDurationMinutes)}
        onChange={(event) => {
          update({ defaultTaskDurationMinutes: toNullableInteger(event.target.value) });
        }}
      />

      <Input
        label="默认缓冲（分钟）"
        type="number"
        inputMode="numeric"
        min={0}
        hint="两个任务之间的间隔，可以是 0。"
        value={toNumberInput(draft.defaultBufferMinutes)}
        onChange={(event) => {
          update({ defaultBufferMinutes: toNullableInteger(event.target.value) });
        }}
      />
    </SettingsSection>
  );
}

export function RemindersSection(bindings: SectionBindings) {
  const { saving, error, run } = useSaveAction();
  const { draft, baseline, update } = bindings;

  return (
    <SettingsSection
      title="提醒与安静时段"
      description="不开启总开关时，安静时段不会被使用。"
      dirty={isSectionDirty(draft, baseline, REMINDER_KEYS)}
      saving={saving}
      error={error}
      onSave={() => {
        void run(() => saveKeys(bindings, REMINDER_KEYS));
      }}
    >
      <Switch
        label="启用提醒"
        checked={draft.reminderEnabled}
        onChange={(next) => {
          update({ reminderEnabled: next });
        }}
      />

      {/*
        §5：「开关关闭时时间控件禁用而非移除」。移除会让用户在关闭状态下看不到
        自己设过什么，再次打开时也无法预期会恢复成什么。
      */}
      <Input
        label="安静时段开始"
        type="time"
        disabled={!draft.reminderEnabled}
        hint="留空表示不设安静时段。"
        value={draft.quietHoursStart ?? ''}
        onChange={(event) => {
          const value = event.target.value;
          update({ quietHoursStart: value === '' ? null : value });
        }}
      />

      <Input
        label="安静时段结束"
        type="time"
        disabled={!draft.reminderEnabled}
        hint="开始与结束需要同时设置或同时留空。"
        value={draft.quietHoursEnd ?? ''}
        onChange={(event) => {
          const value = event.target.value;
          update({ quietHoursEnd: value === '' ? null : value });
        }}
      />
    </SettingsSection>
  );
}

export function AiSection(bindings: SectionBindings) {
  const { saving, error, run } = useSaveAction();
  const { draft, baseline, update } = bindings;
  const consentHintId = useId();
  const [consentPrompt, setConsentPrompt] = useState(false);

  return (
    <SettingsSection
      title="AI 与隐私"
      description="AI 生成的内容一律先作为草稿，确认后才会写入你的数据。"
      dirty={isSectionDirty(draft, baseline, AI_KEYS)}
      saving={saving}
      error={error}
      onSave={() => {
        void run(() => saveKeys(bindings, AI_KEYS));
      }}
    >
      {/*
        §5：「AI 开关（role=switch）；开启时必须先确认「数据发送提示」，未同意时
        开关保持关闭并附说明文字」。所以这里**不把开关翻过去**，而是给出为什么——
        翻过去再让服务端用 422 打回来，用户会以为是程序坏了。
      */}
      <Switch
        label="启用 AI 功能"
        checked={draft.aiEnabled}
        describedBy={consentHintId}
        onChange={(next) => {
          if (next && !draft.aiDataConsent) {
            setConsentPrompt(true);
            return;
          }
          setConsentPrompt(false);
          update({ aiEnabled: next });
        }}
      />

      <Switch
        label="同意将必要数据发送给模型服务"
        checked={draft.aiDataConsent}
        describedBy={consentHintId}
        onChange={(next) => {
          if (!next) {
            // 撤回同意时必须同时关闭 AI：留着"已启用但未同意"的组合，
            // 服务端跨字段校验会直接拒绝，用户却看不出是哪一步不对。
            update({ aiDataConsent: false, aiEnabled: false });
            setConsentPrompt(false);
            return;
          }
          update({ aiDataConsent: true });
        }}
      />

      <p id={consentHintId} className={styles.hint}>
        开启 AI 前需要先同意把必要数据发送给模型服务；未同意时开关保持关闭。
      </p>

      {consentPrompt ? (
        <p className={styles.prompt} role="status">
          请先打开下方的「同意将必要数据发送给模型服务」，AI 开关才能打开。
        </p>
      ) : null}
    </SettingsSection>
  );
}
