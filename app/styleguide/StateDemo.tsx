import { Button, EmptyState, ErrorState, LoadingState, Skeleton } from '@/shared/ui/components';

import styles from './styleguide.module.css';

/**
 * 页面状态组件的展示（UI-002 批次 4）。
 *
 * 刻意保持为**服务端组件**（不加 `'use client'`）：这三个组件都没有交互，
 * 需要交互的按钮由调用方作为槽位传进来——这里传的是 `Button`，它自带
 * 客户端边界。这也是「操作走 ReactNode 槽」这个约定的实际收益：
 * 组件的服务端/客户端属性与调用方完全解耦。
 *
 * 四格各有 `data-variant`：这三个组件里只有 LoadingState/ErrorState 带 role，
 * EmptyState 没有语义角色，而 `getByRole('alert')` 在本页还会撞上表单错误提示
 * 与 Next 的 RouteAnnouncer。用容器上的定位钩子把范围钉死，比按文本猜稳。
 *
 * 第四格是**不带任何操作**的空态：两个槽都是可选的，浏览器端用例需要
 * 一个「只给了两段文字」的实例来验证槽位真的可省。
 */
export function StateDemo() {
  return (
    <div className={styles.stateGrid}>
      <div className={styles.statePanel} data-variant="state-empty">
        <p className={styles.note}>EmptyState —— 无内容时给出具体下一步</p>
        <EmptyState
          title="这里还没有内容"
          description="先记录一件小事，之后再慢慢整理。"
          action={
            <Button variant="primary" data-variant="empty-primary">
              新建任务
            </Button>
          }
          secondaryAction={<Button data-variant="empty-secondary">了解做法</Button>}
        />
      </div>

      <div className={styles.statePanel} data-variant="state-loading">
        <p className={styles.note}>
          LoadingState —— 首次加载；骨架由调用方用 Skeleton 拼出与真实内容同形的轮廓
        </p>
        <LoadingState>
          <Skeleton width="40%" height="1.5em" />
          <Skeleton width="100%" />
          <Skeleton width="80%" />
        </LoadingState>
      </div>

      <div className={styles.statePanel} data-variant="state-error">
        <p className={styles.note}>ErrorState —— 阻塞式错误，主操作必填（这里是「重试」）</p>
        <ErrorState
          title="内容没能加载出来"
          description="可能是网络不稳定。重试一次，或稍后再回来看看。"
          action={
            <Button variant="primary" data-variant="error-retry">
              重试
            </Button>
          }
          secondaryAction={<Button data-variant="error-secondary">返回首页</Button>}
        />
      </div>

      <div className={styles.statePanel} data-variant="state-empty-plain">
        <p className={styles.note}>EmptyState（两个操作槽都不给）</p>
        <EmptyState title="暂无开销记录" description="记一笔之后，这里会显示明细与统计。" />
      </div>
    </div>
  );
}
