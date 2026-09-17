'use client';

import { useId, useRef } from 'react';
import type { KeyboardEvent, ReactNode } from 'react';

import styles from './Tabs.module.css';

export type TabItem = {
  readonly value: string;
  readonly label: string;
  /** 该标签对应的面板内容。 */
  readonly content: ReactNode;
};

export type TabsProps = {
  readonly items: readonly TabItem[];
  /** 当前选中的 `value`（受控）。 */
  readonly value: string;
  readonly onValueChange: (value: string) => void;
  /** 标签栏的无障碍名称——同 IconButton 的 `label`，必填。 */
  readonly label: string;
};

/**
 * 标签页（《UI 页面规范》§2.4 的分段控件形态 + §7 的键盘可达要求）。
 *
 * ## 视觉按「分段控件」，行为按「真 Tab」
 *
 * 原型的 `.add-tabs` 是分段控件的外观（柔和面容器 + 激活项抬升阴影），
 * 但任务要求行为按真 Tab 实现，所以这里同时给出 `tablist` / `tab` / `tabpanel`
 * 三层语义与左右方向键切换——外观与语义是两件事，可以各自取最合适的做法。
 *
 * ## 键盘模型：自动激活 + roving tabindex
 *
 * 方向键移动焦点时**同时切换选中项**。这是 WAI-ARIA 允许的两种模式之一，
 * 在标签数量少、面板渲染代价低时更顺手；代价是「快速掠过中间标签」会依次
 * 触发它们的渲染，等到有昂贵面板时再改为手动激活（Enter/Space 确认）。
 *
 * `tabIndex` 只在选中项上为 0、其余为 -1：这样 Tab 键把标签栏当作**一个**
 * 停靠点，而不是逐项停靠——否则键盘用户要按 N 次才能穿过标签栏。
 */
export function Tabs({ items, value, onValueChange, label }: TabsProps) {
  const baseId = useId();
  const tabElements = useRef(new Map<string, HTMLButtonElement>());

  const selectedIndex = items.findIndex((item) => item.value === value);

  if (selectedIndex === -1) {
    // 受控值对不上任何一项时，屏幕上会呈现「一个都没选中」——这违反 ARIA 对
    // tablist 的要求（必须有且仅有一个选中项），而且是静默的。显式抛错让它在
    // 开发期就暴露，而不是等到有人用读屏软件打开页面才发现。
    throw new Error(
      `Tabs 的 value 是「${value}」，但 items 里没有对应的项；受控值必须与其中一项的 value 一致`,
    );
  }

  /** 选中第 index 项并把焦点移过去（自动激活）。 */
  function activate(index: number) {
    const target = items[index];
    if (target === undefined) {
      return;
    }
    onValueChange(target.value);
    tabElements.current.get(target.value)?.focus();
  }

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const lastIndex = items.length - 1;

    switch (event.key) {
      case 'ArrowRight':
        // 在两端回绕。§7 要求「键盘可完成…关闭浮层」，同理标签切换也不该有死角。
        event.preventDefault();
        activate(selectedIndex === lastIndex ? 0 : selectedIndex + 1);
        break;
      case 'ArrowLeft':
        event.preventDefault();
        activate(selectedIndex === 0 ? lastIndex : selectedIndex - 1);
        break;
      case 'Home':
        event.preventDefault();
        activate(0);
        break;
      case 'End':
        event.preventDefault();
        activate(lastIndex);
        break;
      default:
        break;
    }
  }

  return (
    <div className={styles.tabs}>
      <div className={styles.list} role="tablist" aria-label={label} onKeyDown={handleKeyDown}>
        {items.map((item, index) => {
          const isSelected = index === selectedIndex;

          return (
            <button
              key={item.value}
              // 必须用块体：React 19 会把 ref 回调的**返回值**当作清理函数，
              // 而 `Map.set` 返回的是 Map——写成简写箭头会得到一个非法清理函数。
              ref={(element) => {
                if (element === null) {
                  tabElements.current.delete(item.value);
                } else {
                  tabElements.current.set(item.value, element);
                }
              }}
              type="button"
              role="tab"
              id={`${baseId}-tab-${item.value}`}
              aria-selected={isSelected}
              aria-controls={`${baseId}-panel-${item.value}`}
              tabIndex={isSelected ? 0 : -1}
              className={[styles.tab, isSelected ? styles.active : undefined]
                .filter(Boolean)
                .join(' ')}
              data-selected={isSelected}
              onClick={() => {
                onValueChange(item.value);
              }}
            >
              {item.label}
            </button>
          );
        })}
      </div>

      {items.map((item, index) => (
        <div
          key={item.value}
          role="tabpanel"
          id={`${baseId}-panel-${item.value}`}
          aria-labelledby={`${baseId}-tab-${item.value}`}
          // 用 hidden 而不是条件渲染：未选中的面板保留挂载状态，
          // 切回来时用户填了一半的输入还在（「添加」弹窗来回切类型的场景）。
          hidden={index !== selectedIndex}
          // 面板本身可聚焦：WAI-ARIA 建议当面板内没有可聚焦元素时给出这个停靠点。
          tabIndex={0}
          className={styles.panel}
          data-variant={`panel-${item.value}`}
        >
          {item.content}
        </div>
      ))}
    </div>
  );
}
