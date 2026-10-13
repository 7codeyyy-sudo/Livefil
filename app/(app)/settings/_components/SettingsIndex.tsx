'use client';

/**
 * `/settings` 索引（PM-20261012-008 提案 A 2.2.1/2.2.2 的双面落点）。
 *
 * 同一个 URL 按视口承担两个角色，这是「旧地址重定向」与「移动端栏列表」
 * 两条口径能共存的唯一干净解法（服务端拿不到视口，UA 嗅探不可靠）：
 *
 * - **≤767px**：渲染栏列表（移动端设置首页＝列表 → 点进单栏 → 返回）；
 * - **≥768px**：`router.replace` 到首栏（旧 `/settings` 书签与侧栏入口
 *   的落点＝提案 2.2.5 的「进首栏」；首栏按部署形态取——local 态没有
 *   账号栏，落到外观）。
 *
 * 视口未知时（SSR 与水合首帧）渲染 `null`：桌面端因此不会闪一下栏列表
 * 再跳走，移动端也只是一帧空白（外层本来就是取数骨架）。
 *
 * 首栏重定向用 `replace` 而不是 `push`：否则桌面用户按返回会退回同一个
 * `/settings`、又被重定向回来，形成一次"返回键失效"。
 */
import Link from 'next/link';
import { useEffect, useSyncExternalStore } from 'react';
import { useRouter } from 'next/navigation';

import { firstVisibleColumn, visibleColumns } from '../_lib/columns';

import { useSettings } from './SettingsForm';
import styles from './SettingsIndex.module.css';

/** 手机档断点（§3.1：320–767px），与外壳三档视口一致。 */
const MOBILE_QUERY = '(max-width: 767px)';

/** 订阅视口档位变化（`useSyncExternalStore` 的订阅口；模块级定义，注册不抖动）。 */
function subscribeToViewport(onChange: () => void): () => void {
  const query = window.matchMedia(MOBILE_QUERY);
  query.addEventListener('change', onChange);
  return () => query.removeEventListener('change', onChange);
}

/**
 * 视口是否处于手机档。未知期（SSR 与水合首帧）返回 `null`，见文件头。
 *
 * 用 `useSyncExternalStore` 而不是 `useEffect + setState`：视口尺寸是外部
 * 可变源，订阅模型才是它的本形——effect 里同步 `setState` 还会触发级联渲染。
 */
function useIsMobile(): boolean | null {
  return useSyncExternalStore(
    subscribeToViewport,
    () => window.matchMedia(MOBILE_QUERY).matches,
    () => null,
  );
}

export function SettingsIndex() {
  const { profile } = useSettings();
  const router = useRouter();
  const isMobile = useIsMobile();
  const target = firstVisibleColumn(profile.mode);

  useEffect(() => {
    if (isMobile === false) {
      router.replace(target.href);
    }
  }, [isMobile, router, target.href]);

  if (isMobile !== true) {
    return null;
  }

  return (
    <ul className={styles.list}>
      {visibleColumns(profile.mode).map((column) => (
        <li key={column.id}>
          <Link href={column.href} className={styles.item}>
            <span className={styles.name}>{column.name}</span>
            {/* 指向标只做视觉提示，读屏不需要它（链接文字已说清去向）。 */}
            <span className={styles.chevron} aria-hidden="true">
              ›
            </span>
          </Link>
        </li>
      ))}
    </ul>
  );
}
