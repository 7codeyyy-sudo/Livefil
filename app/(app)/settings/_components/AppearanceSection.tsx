'use client';

import { useId, useSyncExternalStore } from 'react';

import {
  BACKGROUND_CHOICES,
  type BackgroundChoice,
} from '@/shared/ui/layout/BackgroundField/BackgroundField.types';

import {
  getAppearanceServerSnapshot,
  getAppearanceSnapshot,
  setAppearanceChoice,
  subscribeAppearance,
} from '../../_lib/appearance/appearance-store';

import styles from './AppearanceSection.module.css';
import { SettingsSection } from './SettingsSection';

/** 每一档的文案：短名 + 一句话说明（几何事实，不是营销词）。 */
const CHOICE_META: Readonly<
  Record<BackgroundChoice, { readonly label: string; readonly note: string }>
> = Object.freeze({
  tesseract: { label: '超立方体', note: '四维立方体的线框，16 顶点、32 棱，带地面投影。' },
  cell24: { label: '正二十四胞体', note: '24 顶点、96 棱，四维独有、三维里不存在。' },
  clifford: { label: 'Clifford 环面', note: '四维里唯一平坦的环面。' },
  hopf: { label: 'Hopf 纤维丛', note: '一族互相套扣的大圆。' },
  none: { label: '纯色底', note: '关闭背景动画，只留页面底色。' },
});

/**
 * 设置页「外观」分区（UI-009）。
 *
 * ## 为什么没有「保存」按钮
 *
 * 背景档位是**即时生效**的本机偏好（《UI 页面规范》v0.24 §3.4 / §5 勘误补记的口径）——
 * 选中即写入并立即改变背景，不需要用户再点一次保存。因此这里不给 `SettingsSection`
 * 传 `onSave`，页脚整块不渲染。
 *
 * ## 好处是它天然「所见即所得」
 *
 * 用户在设置页改档位的同一瞬间就能看到背景变化（背景层是全站固定的），因此不存在
 * "改了但没保存"的中间态，也就不需要脏标记与离开确认。
 *
 * ## 快照未水合时不选中任何一档
 *
 * `getAppearanceServerSnapshot` 恒为 `null`（服务端没有 `localStorage`），首帧
 * 因此没有任何单选框被选中；水合后 `useSyncExternalStore` 立即用真实档位重渲染，
 * 服务端与客户端两棵树一致，不会水合不匹配。
 */
export function AppearanceSection() {
  const choice = useSyncExternalStore(
    subscribeAppearance,
    getAppearanceSnapshot,
    getAppearanceServerSnapshot,
  );
  const groupName = useId();

  return (
    <SettingsSection
      title="外观"
      description="选择右下角的装饰性背景。改动即时生效，无需保存。"
      tourAnchor="settings-appearance"
    >
      <div className={styles.options} role="radiogroup" aria-label="背景样式">
        {BACKGROUND_CHOICES.map((value) => {
          const meta = CHOICE_META[value];
          return (
            <label key={value} className={styles.option}>
              <input
                className={styles.radio}
                type="radio"
                name={groupName}
                value={value}
                checked={choice === value}
                onChange={() => {
                  setAppearanceChoice(value);
                }}
              />
              <span className={styles.optionText}>
                <span className={styles.optionLabel}>{meta.label}</span>
                <span className={styles.optionNote}>{meta.note}</span>
              </span>
            </label>
          );
        })}
      </div>

      <p className={styles.note}>
        本机偏好，不随账户同步。开启系统的「减少动效」后，背景自转会停止。
      </p>
    </SettingsSection>
  );
}
