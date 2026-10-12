'use client';

/**
 * 分区 8「测试与隐私说明」（§5 第 8 条；PM-20261012-008 提案 2.1 第 4 栏补齐渲染）。
 *
 * 此前该分区**渲染缺失**（走查实录：全页文本搜索零命中）——文案在 v0.26 冻结
 * 准据里躺着，却没有任何组件承载它。本组件把两段冻结文案逐字接上：
 *
 * - **测试说明**＝§5 第 8 条五条（逐字使用，含〔随契约定，本稿不虚构〕的
 *   反馈渠道占位——契约未定稿前照原文渲染，不虚构联系方式）；
 * - **隐私说明**＝六条，第 1/2 条按部署形态分句（`GET /me` 的 `mode` 驱动，
 *   与「页面顶部」模式标识同一数据源）；
 * - 区底次按钮「**重新查看隐私说明**」＝唤起首次知情 Modal（§5 新补节 A 节
 *   的真实功能、常驻知情通道；Modal 只在本页触发，今日页首次自动弹属另一批）。
 *
 * 裁量留痕：第 2 条原文尾部的「（PD-001 风险 4 知情正身，2026-10-06 预审认可
 * 为如实、不弱化）」是规范的行内批注（来源与审批记录），不是给用户看的文案，
 * 未渲染进页面。
 */
import { useState } from 'react';

import { Button } from '@/shared/ui/components';

import { FirstConsentModal } from './FirstConsentModal';
import { SettingsSection } from './SettingsSection';
import { useSettings } from './SettingsForm';
import styles from './PrivacyNotice.module.css';

export function PrivacyNoticeSection() {
  const { profile } = useSettings();
  const isCloud = profile.mode === 'cloud';
  const [reviewing, setReviewing] = useState(false);

  return (
    <SettingsSection title="测试与隐私说明">
      <div className={styles.block}>
        <h3 className={styles.subtitle}>测试说明</h3>
        <ul className={styles.list}>
          <li>
            本次为邀请测试（首批 5–20 人）：<strong>公开注册</strong>即可参与，不设邀请码门槛；
            目的是验证计划、执行、开销与复盘在真实生活中的使用。
          </li>
          <li>测试周期为注册登录后连续 4 周：第 1 周关注注册激活与 7 日使用，4 周后统计留存。</li>
          <li>你的反馈每周汇总一次、参与需求排序，可能改变功能优先级。</li>
          <li>反馈渠道与联系方式：〔随契约定，本稿不虚构〕。</li>
          <li>数据随时可导出或删除：设置页 · 数据管理。</li>
        </ul>
      </div>

      <div className={styles.block} id="privacy-notice">
        <h3 className={styles.subtitle}>隐私说明</h3>
        <ol className={styles.list}>
          <li>
            <strong>数据存放在哪里</strong>
            {isCloud ? (
              <>
                ——你的任务、目标、时间块、例程、开销与复盘保存在
                <strong>云端服务器的数据库</strong>
                中，按账号隔离存放；页面顶部「云端模式 · 数据保存在云端并按账号隔离」即当前状态。
              </>
            ) : (
              <>
                ——你的任务、目标、时间块、例程、开销与复盘数据保存在当前环境的数据库中（本地模式）；
                页面顶部「本地模式 · 数据仅保存在本环境」即当前状态。
              </>
            )}
          </li>
          <li>
            <strong>谁能看到你的数据</strong>
            {isCloud ? (
              <>
                ——你的数据按账号隔离——只有登录后的你能看到自己的数据，其他账号互不可见；
                服务端对每次数据访问执行用户级权限校验。
              </>
            ) : (
              <>
                ——本地模式没有账号与认证，
                <strong>任何能访问本部署地址的人都会进入同一份数据空间</strong>
                ——请只在自己控制的设备与网络中使用，不要公开部署地址。
              </>
            )}
          </li>
          <li>
            <strong>哪些内容会发送给 AI</strong>
            ：仅在你主动使用 AI 功能时发送当次提交的内容（详见「AI 与隐私」的数据发送提示）； AI
            结果为草稿，确认后才写入。
          </li>
          <li>
            <strong>不会做什么</strong>
            ：不将你的数据用于广告画像或未说明的训练用途；日志与统计默认使用匿名化标识，
            不记录完整的开销备注与目标内容。
          </li>
          <li>
            <strong>你的权利</strong>
            ：随时导出全部数据、删除数据（回收区保留期内可恢复）、关闭 AI 并继续使用全部手动功能。
          </li>
          <li>
            <strong>与外部服务的关系</strong>
            ：注册验证码与密码重置邮件经邮件服务商发送（仅发送邮箱地址与验证码，不发送你的任务与
            开销内容）；AI 结果由 AI 服务生成（见第 3 条）；除此之外不向第三方披露你的数据，
            也不将数据用于广告画像或未说明的训练用途。
          </li>
        </ol>
      </div>

      <Button variant="secondary" onClick={() => setReviewing(true)}>
        重新查看隐私说明
      </Button>

      <FirstConsentModal open={reviewing} mode={profile.mode} onClose={() => setReviewing(false)} />
    </SettingsSection>
  );
}
