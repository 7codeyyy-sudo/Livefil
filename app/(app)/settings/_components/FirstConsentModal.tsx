'use client';

/**
 * 首次知情 Modal（§5 新补节 A 节，v0.26 冻结；PM-20261012-008 承接其重看入口）。
 *
 * ## 本批的承载范围
 *
 * 只交付 **Modal 本体 + 分区 8「重新查看隐私说明」的唤起**（提案 2.1 第 4 栏
 * 所称「真实功能＝唤起首次知情 Modal」）。规范里「首次进入今日页时自动弹出、
 * 经确认关闭后不再出现（判定存储归实现披露）」的**自动触发**属今日页侧的另一批，
 * 不在本提案改造面——故本组件无持久化判定：它按调用方的 `open` 开合。
 *
 * ## 文案与形态
 *
 * 标题与三行知情逐字取自 v0.26 冻结准据（§5 新补节 A）；形态＝§4.5 冻结 Modal；
 * 「我知道了」为 primary 且初始焦点（经 `initialFocusSelector` 指向它的
 * `data-consent-ack` 标记）；「查看完整说明」关闭 Modal 并滚动到本页
 * 隐私说明列表（Modal 由分区 8 唤起，目标就在同一栏内——不新建说明路由，
 * A 节承载裁定原文即如此）。
 */
import { Button, Modal } from '@/shared/ui/components';
import type { UserDto } from '@/modules/identity/application/user-dto.ts';

import styles from './PrivacyNotice.module.css';

export type FirstConsentModalProps = {
  readonly open: boolean;
  readonly mode: UserDto['mode'];
  readonly onClose: () => void;
};

export function FirstConsentModal({ open, mode, onClose }: FirstConsentModalProps) {
  const showFullNotice = (): void => {
    onClose();
    // 滚动放在下一帧：Modal 关闭有退场过程，目标元素此刻仍在文档里，
    // 立即滚动与退场动画叠加也不会丢（锚点就在同一栏下方）。
    requestAnimationFrame(() => {
      document.getElementById('privacy-notice')?.scrollIntoView();
    });
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="开始前，先知道这三件事"
      initialFocusSelector="[data-consent-ack]"
      footer={
        <>
          <Button variant="secondary" onClick={showFullNotice}>
            查看完整说明
          </Button>
          <Button variant="primary" data-consent-ack onClick={onClose}>
            我知道了
          </Button>
        </>
      }
    >
      <ol className={styles.list}>
        <li>
          <strong>账号与数据</strong>
          {mode === 'cloud' ? (
            <>——数据保存在云端并按账号隔离，只有你登录后能看到。</>
          ) : (
            <>
              ——<strong>本地模式</strong>
              ：数据只保存在本环境，没有账号系统，能访问本部署地址的人都看到同一份数据。
            </>
          )}
        </li>
        <li>
          <strong>可导出、可删除</strong>
          ：设置页随时可导出 JSON、删除数据（回收区保留期内可恢复）。
        </li>
        <li>
          <strong>AI 可关闭</strong>
          ：AI 只在你主动使用时发送当次提交的内容，可在「AI 与隐私」关闭。
        </li>
      </ol>
    </Modal>
  );
}
