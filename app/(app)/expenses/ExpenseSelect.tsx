'use client';

import { Fragment, useState } from 'react';
import type { ReactNode } from 'react';

import { Input, Select } from '@/shared/ui/components';

import styles from './ExpenseSelect.module.css';

/** 选择器里的一项。 */
export interface SelectOption {
  readonly value: string;
  readonly label: string;
}

/** 一组选项（渲染成原生 `<optgroup>`；`label` 为空则平铺）。 */
export interface SelectGroup {
  readonly label: string;
  readonly options: readonly SelectOption[];
}

export type ExpenseSelectProps = {
  readonly label: string;
  readonly value: string;
  readonly onChange: (next: string) => void;
  readonly groups: readonly SelectGroup[];
  /** 空值项文案（如「全部」/「不指定」）；不给则不渲染空值项。 */
  readonly placeholder?: string | undefined;
  /** 是否提供搜索框（A3/A5/A6 的「可搜索选择」）。 */
  readonly searchable?: boolean | undefined;
  readonly searchLabel?: string | undefined;
  readonly error?: string | undefined;
  readonly hint?: string | undefined;
  readonly disabled?: boolean | undefined;
  /** 选择器下方的固定操作行（「管理分类」「＋ 新建分类」等）。 */
  readonly footer?: ReactNode | undefined;
};

/**
 * 可搜索 + 分组的选择控件（EXP-002/003，《UI 页面规范》§5 A3/A5/A6）。
 *
 * ## 为什么用「原生 Select + 搜索输入」而不是自造下拉浮层
 *
 * 组件库没有 combobox 这样的「可搜索选择」范式，而规范又冻结了「只组合既有
 * 组件、不引入新组件范式」。原生 `<select>` 恰好提供了 `<optgroup>` 这个**分组**
 * 原语，缺的只有搜索；用一个既有 `Input` 过滤选项就能补齐，且键盘、移动端滚轮、
 * 读屏全部保持原生行为。代价是搜索框与下拉是两个控件——这是本批的已知取舍。
 *
 * 搜索命中跨组展示并**保持组序**（A3）：这里只按原顺序过滤，不做重排。
 */
export function ExpenseSelect({
  label,
  value,
  onChange,
  groups,
  placeholder,
  searchable = false,
  searchLabel,
  error,
  hint,
  disabled,
  footer,
}: ExpenseSelectProps) {
  const [query, setQuery] = useState('');

  const visibleGroups = filterGroups(groups, query);
  const selected = groups
    .flatMap((group) => group.options)
    .find((option) => option.value === value);
  const visibleHasSelected = visibleGroups.some((group) =>
    group.options.some((option) => option.value === value),
  );
  // 搜索时选中项可能被过滤掉；补回一个「当前」组，避免原生 select 显示空白。
  const renderedGroups: readonly SelectGroup[] =
    selected !== undefined && !visibleHasSelected
      ? [{ label: '当前', options: [selected] }, ...visibleGroups]
      : visibleGroups;

  return (
    <div className={styles.field}>
      {searchable ? (
        <Input
          label={searchLabel ?? `搜索${label}`}
          value={query}
          disabled={disabled}
          onChange={(event) => {
            setQuery(event.target.value);
          }}
        />
      ) : null}

      <Select
        label={label}
        value={value}
        error={error}
        hint={hint}
        disabled={disabled}
        onChange={(event) => {
          onChange(event.target.value);
        }}
      >
        {placeholder === undefined ? null : <option value="">{placeholder}</option>}
        {renderedGroups.map((group, index) =>
          group.label === '' ? (
            <Fragment key={`flat-${String(index)}`}>
              {group.options.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </Fragment>
          ) : (
            <optgroup key={group.label} label={group.label}>
              {group.options.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </optgroup>
          ),
        )}
      </Select>

      {footer === undefined ? null : <div className={styles.footer}>{footer}</div>}
    </div>
  );
}

/** 按关键词过滤选项，保留组序并丢弃空组；关键词为空则原样返回。 */
function filterGroups(groups: readonly SelectGroup[], query: string): readonly SelectGroup[] {
  const needle = query.trim().toLowerCase();
  if (needle === '') {
    return groups;
  }
  const result: SelectGroup[] = [];
  for (const group of groups) {
    const options = group.options.filter((option) => option.label.toLowerCase().includes(needle));
    if (options.length > 0) {
      result.push({ label: group.label, options });
    }
  }
  return result;
}
