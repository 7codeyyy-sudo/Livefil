import styles from './AiScopeNotice.module.css';

export type AiScopeNoticeProps = {
  /**
   * 〔本次主动提交的内容〕的替换文本——**随场景变化**（如「你输入的这段描述」
   * 「你所选的任务与可用时间」）。冻结句式本身不改写。
   */
  readonly scope: string;
};

/**
 * AI 数据范围告知行（《UI 页面规范》v0.22 §5 C4，FR-084；文案冻结）。
 *
 * ## 每次入口展开时都出现
 *
 * §5 C4 写死「**每次** AI 入口展开时，面板 / 建议块 / 确认区头部常驻一行」，
 * 所以它是各 AI 容器头部的一块常驻文本，而不是只在首次出现。句式固定为
 * 「本次将发送给 AI：〔…〕。AI 不读取你的完整历史记录；结果为草稿，确认后才写入。」
 *
 * ## 为什么是纯展示件
 *
 * 与 `GuideBar` / `AsyncState` 同一边界：它只接收替换文本、不做任何状态或取数，
 * 因此不带 `'use client'`，可在任意层复用（含首次确认 `Modal` 的正文）。
 */
export function AiScopeNotice({ scope }: AiScopeNoticeProps) {
  return (
    <p className={styles.notice} data-variant="ai-scope-notice">
      本次将发送给 AI：{scope}。AI 不读取你的完整历史记录；结果为草稿，确认后才写入。
    </p>
  );
}
