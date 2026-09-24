'use client';

import { Button } from '../Button/Button';
import { ConfirmDialog } from '../ConfirmDialog/ConfirmDialog';

import styles from './SyncStatusBanner.module.css';
import { truncateWithEllipsis } from './truncate';

/** 摘要里的一行关键字段（`标题：每天散步`）。 */
export type ConflictFieldView = {
  /** 字段名（同一实体内唯一，可安全用作列表 key）。 */
  readonly label: string;
  readonly value: string;
};

/** 一个版本的摘要。 */
export type ConflictVersionView = {
  /** 最后修改时间（用户时区）；取不到时为 `null`。 */
  readonly changedAtLabel: string | null;
  /** 关键字段，**不超过 3 行**（§4.9.2 第 3 条）。 */
  readonly fields: readonly ConflictFieldView[];
};

export type ConflictDialogProps = {
  readonly open: boolean;
  /** 实体名称（可读名，取不到时由调用方退化成实体 id）。过长时这里截断加省略号。 */
  readonly entityName: string;
  readonly local: ConflictVersionView;
  readonly server: ConflictVersionView;
  /** 解决请求进行中：三枚按钮全部禁用，避免重复提交。 */
  readonly pending?: boolean | undefined;
  /** 单条处理失败的原因（§4.9.2 第 7 条）；为 `null` 时不渲染错误行。 */
  readonly errorMessage?: string | null | undefined;
  /** 「稍后处理」：关闭弹层，冲突保留待处理（ESC / 点遮罩走同一条路）。 */
  readonly onLater: () => void;
  readonly onKeepServer: () => void;
  readonly onKeepLocal: () => void;
  /** 错误行里的「重试」；仅在有错误时使用。 */
  readonly onRetry?: (() => void) | undefined;
};

/** 必含说明行（§4.9.2 第 4 条：「不可省略、不可弱化」）。 */
const IRREVERSIBLE_NOTICE = '选择后另一版本将被覆盖，此操作不可撤销。';

/**
 * 冲突解决弹层（《UI 页面规范》v0.20 §4.9.2，SYNC-004）。
 *
 * ## 它是一个装了内容的 ConfirmDialog，不是一个新组件类型
 *
 * §4.9.2 明文要求「全部复用 §4.5 批次 3a 既有 ConfirmDialog，不引入新组件
 * 类型」。因此这里做的是**内容装配**：把两版摘要塞进 `descriptionSlot`、
 * 把「稍后处理」放到取消位、把「保留服务器版本」放到 `extraAction`。
 * 弹层的机制（焦点陷阱、滚动锁、ESC、退场延迟卸载）一行都没有重写。
 *
 * ## 三枚按钮的层级与顺序
 *
 * 左起「稍后处理」（`ghost`，低强调）→「保留服务器版本」（`secondary`）→
 * 「保留此设备版本」（`primary`，每组至多一枚高强调）。初始焦点在**取消位**：
 * 两枚覆盖性选择都不可逆，起点应落在最安全的退出路径上（§4.9.2 第 5 条）。
 * 这也是 `ConfirmDialog` 新增 `initialFocus` / `cancelVariant` / `extraAction`
 * 三个可选 props 的唯一原因。
 *
 * ## 不做的事
 *
 * 不做字段级 diff / 合并编辑器、不出现第三枚「合并」按钮、不留占位
 * （§4.9.2 第 8 条：`manual_merge` 本批不做 UI）。
 */
export function ConflictDialog({
  open,
  entityName,
  local,
  server,
  pending = false,
  errorMessage = null,
  onLater,
  onKeepServer,
  onKeepLocal,
  onRetry,
}: ConflictDialogProps) {
  return (
    <ConfirmDialog
      open={open}
      onCancel={onLater}
      onConfirm={onKeepLocal}
      title={`这条内容有两个版本 · ${truncateWithEllipsis(entityName, 24)}`}
      description={IRREVERSIBLE_NOTICE}
      cancelLabel="稍后处理"
      cancelVariant="ghost"
      confirmLabel="保留此设备版本"
      extraAction={{ label: '保留服务器版本', onClick: onKeepServer, disabled: pending }}
      initialFocus="cancel"
      pending={pending}
      descriptionSlot={
        <>
          <VersionCard heading="此设备的版本" version={local} />
          <VersionCard heading="服务器上的版本" version={server} />
        </>
      }
      errorSlot={
        // 用 `undefined` 而不是 `null` 表示"没有错误行"：ConfirmDialog 的槽位判据是
        // `=== undefined`，传 `null` 会渲染出一个空的插槽容器。
        errorMessage === null ? undefined : (
          // `role="alert"`：失败是就地插入的，读屏需要立刻播报（§4.9.2 第 7 条）。
          <div className={styles.errorRow} role="alert">
            <ErrorIcon />
            <p className={styles.errorText}>{errorMessage}</p>
            {onRetry === undefined ? null : (
              <Button variant="primary" onClick={onRetry}>
                重试
              </Button>
            )}
          </div>
        )
      }
    />
  );
}

/** 一个版本的摘要卡片（同宽、`--color-surface-soft` 底 + `--radius-md`）。 */
function VersionCard({
  heading,
  version,
}: {
  readonly heading: string;
  readonly version: ConflictVersionView;
}) {
  return (
    <div className={styles.versionCard}>
      <p className={styles.versionHeading}>{heading}</p>
      {version.changedAtLabel === null ? null : (
        <p className={styles.versionMeta}>{version.changedAtLabel}</p>
      )}
      {version.fields.map((field) => (
        <p key={field.label} className={styles.versionLine}>
          {`${field.label}：${field.value}`}
        </p>
      ))}
    </div>
  );
}

/**
 * 错误行的警示图标：这一行**唯一**的红色（§4.6 单点红原则）。
 *
 * 与 SyncStatusBanner / ErrorState 是同一枚圆环感叹号，尺寸由 CSS 侧给——
 * 这里复用横幅那份 `.icon`（同一条 13px 语境），因此不需要再写一份样式。
 */
function ErrorIcon() {
  return (
    <svg className={styles.icon} viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <circle cx="8" cy="8" r="6.25" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <path d="M8 4.75V8.75" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <circle cx="8" cy="11.25" r="0.9" fill="currentColor" />
    </svg>
  );
}
