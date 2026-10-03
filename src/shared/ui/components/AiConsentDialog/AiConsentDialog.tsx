'use client';

import { Button } from '../Button/Button';
import { Modal } from '../Modal/Modal';
import { AiScopeNotice } from '../AiScopeNotice/AiScopeNotice';

/**
 * 首次调用 AI 前的一次性数据发送确认（《UI 页面规范》v0.22 §5 C4；§4.5 Modal）。
 *
 * ## 冻结形态
 *
 * 标题「即将发送数据给 AI」、正文＝C4 数据范围行、「同意并继续」（primary）/
 * 「取消」（低强调）。同意与否由调用方落状态——组件只发出两个请求（同 Modal 的
 * `footer` 约定：不接收 `{label}` 配置对象，按钮由调用方给）。
 *
 * ## 与设置页分区 5 的分工
 *
 * 分区 5 的开关层「数据发送提示」是**总开关与持久同意**，本弹层是**每次可见的
 * 范围告知**的首次确认（§5 C4 末段：两层不重复弹）。因此这里不带任何持久字段。
 *
 * ## 为什么关掉右上角的 ×
 *
 * §5 C4 只给了「同意并继续」与「取消」两个出口；「取消」已经承担了关闭语义，
 * 再多一个 × 会让"取消这次调用"有两种等价入口，徒增歧义（同 ConfirmDialog 的处理）。
 */
export type AiConsentDialogProps = {
  readonly open: boolean;
  /** 〔本次主动提交的内容〕的替换文本。 */
  readonly scope: string;
  readonly onAgree: () => void;
  readonly onCancel: () => void;
};

export function AiConsentDialog({ open, scope, onAgree, onCancel }: AiConsentDialogProps) {
  return (
    <Modal
      open={open}
      title="即将发送数据给 AI"
      onClose={onCancel}
      closable={false}
      initialFocusSelector="[data-ai-consent-agree]"
      footer={
        <>
          <Button variant="ghost" onClick={onCancel}>
            取消
          </Button>
          <Button variant="primary" data-ai-consent-agree onClick={onAgree}>
            同意并继续
          </Button>
        </>
      }
    >
      <AiScopeNotice scope={scope} />
    </Modal>
  );
}
