'use client';

import { useState } from 'react';

import { OfflineBanner } from '../AsyncState/OfflineBanner';
import { Button } from '../Button/Button';
import { Modal } from '../Modal/Modal';

import styles from './SyncStatusBanner.module.css';
import { truncateWithEllipsis } from './truncate';

/** 「查看详情」列表里的一行（已由调用方归并成一个实体一条）。 */
export type SyncBannerItem = {
  /** 稳定键（`entityType:entityId`）：列表不能用数组下标当 key。 */
  readonly id: string;
  readonly name: string;
  readonly reason: string;
};

/**
 * 横幅的六态（§4.9.1 的状态表）。
 *
 * 判别联合而不是 `{ tone, text }` 这样的扁平结构：文案里的计数与列表长度都
 * 依赖具体状态，扁平化会让"待同步态拿到了被拒绝项"这种事在类型上变得合法。
 */
export type SyncStatusBannerState =
  | { readonly kind: 'offline' }
  | { readonly kind: 'syncing' }
  | { readonly kind: 'pending'; readonly count: number }
  | { readonly kind: 'failed'; readonly count: number }
  | { readonly kind: 'rejected'; readonly count: number; readonly items: readonly SyncBannerItem[] }
  | { readonly kind: 'conflict'; readonly count: number };

export type SyncStatusBannerProps = {
  readonly state: SyncStatusBannerState;
  /** 「立即同步」：状态 2/3/4/5 共用同一个入口（§4.9.1 明文，不在别处放常驻按钮）。 */
  readonly onSyncNow: () => void;
  /** 「查看并处理」：进入 §4.9.2 的冲突弹层。 */
  readonly onOpenConflicts: () => void;
};

/**
 * 同步状态横幅（《UI 页面规范》v0.20 §4.9.1）。
 *
 * ## 它是纯展示组件
 *
 * 不碰 IndexedDB、不碰网络、不订阅在线状态以外的任何外部源——状态由容器
 * （`app/(app)/_components/SyncStatusContainer.tsx`）算好传进来。这样六态文案
 * 与优先级可以被单独验证，而不必先起一个同步引擎。
 *
 * ## 六态互斥，容器只有一个
 *
 * §4.9.1 把「单容器、单挂载点、状态互斥」列为不可改变的口径。因此本组件
 * **只渲染一个状态**：状态由 `state.kind` 唯一决定，没有"同时显示两条"的分支。
 *
 * ## 离线态为什么不自己写文案
 *
 * §4.9.1 明确离线态"沿用 §4.7 既有机制"。因此这里直接复用 `<OfflineBanner>`：
 * 它的 DOM（含 `data-offline-banner` 与冻结文案）与 UI-004 时期逐字节一致，
 * 既有浏览器用例因此不受本节影响。
 */
export function SyncStatusBanner({ state, onSyncNow, onOpenConflicts }: SyncStatusBannerProps) {
  const [detailsOpen, setDetailsOpen] = useState(false);

  if (state.kind === 'offline') {
    return <OfflineBanner />;
  }

  const tone = state.kind === 'rejected' || state.kind === 'conflict' ? 'danger' : 'warning';

  return (
    <>
      <div className={styles.banner} data-sync-banner="true" data-tone={tone} role="status">
        <div className={styles.inner}>
          <p className={styles.message}>
            {/* 状态 5/6 才配图标（§4.9.1）：区分不只靠颜色，但也不给每个状态都加装饰。 */}
            {tone === 'danger' ? <WarningIcon /> : null}
            {describeState(state)}
          </p>

          <div className={styles.actions}>
            {state.kind === 'conflict' ? (
              <Button onClick={onOpenConflicts}>查看并处理</Button>
            ) : null}

            {state.kind === 'rejected' ? (
              <Button onClick={() => setDetailsOpen(true)}>查看详情</Button>
            ) : null}

            {/* 同步中：按钮自己表达进度（loading 自动禁用并标 aria-busy），
                否则用户可以连点，制造出并发的推送轮次。 */}
            <Button onClick={onSyncNow} loading={state.kind === 'syncing'}>
              立即同步
            </Button>
          </div>
        </div>
      </div>

      {state.kind === 'rejected' ? (
        <Modal
          open={detailsOpen}
          onClose={() => setDetailsOpen(false)}
          title="同步被拒绝的内容"
          footer={
            <Button variant="primary" onClick={() => setDetailsOpen(false)}>
              知道了
            </Button>
          }
        >
          <ul className={styles.detailsList}>
            {state.items.map((item) => (
              <li key={item.id} className={styles.detailsItem}>
                <p className={styles.detailsName}>{truncateWithEllipsis(item.name, 24)}</p>
                <p className={styles.detailsReason}>{item.reason}</p>
              </li>
            ))}
          </ul>
        </Modal>
      ) : null}
    </>
  );
}

/**
 * 状态 → 文案（§4.9.1 表格的「文案（冻结，逐字使用）」列）。
 *
 * 抽成函数而不是塞进 JSX：这五句是**冻结文案**，集中在一处才便于与规范逐字对照。
 * 计数一律用「N 条」的写法（规范明文），不做「1 条 / 多条」的分支。
 */
function describeState(state: SyncStatusBannerState): string {
  switch (state.kind) {
    case 'syncing':
      return '同步中…';
    case 'pending':
      return `${String(state.count)} 条待同步`;
    case 'failed':
      return `同步未完成，${String(state.count)} 条内容仍保存在此设备`;
    case 'rejected':
      return `${String(state.count)} 条内容同步被拒绝，仍保存在此设备`;
    case 'conflict':
      return `${String(state.count)} 条内容与其他设备不一致，需要你选择保留哪一份`;
    case 'offline':
      // 离线态在组件顶部就分流给了 `<OfflineBanner>`，这里只是让 switch 穷尽。
      return '当前处于离线状态，显示的内容可能不是最新';
  }
}

/**
 * 警示图标（`currentColor` 内联 SVG，颜色由 CSS 侧给）。
 *
 * 与 Toast / ErrorState 是同一枚圆环感叹号。**仍不抽共享模块**：三处的尺寸
 * 语境各不相同（13px 正文、16px 正文、13px 横幅），共用立刻要给它加 size 参数。
 */
function WarningIcon() {
  return (
    <svg className={styles.icon} viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <circle cx="8" cy="8" r="6.25" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <path d="M8 4.75V8.75" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <circle cx="8" cy="11.25" r="0.9" fill="currentColor" />
    </svg>
  );
}
