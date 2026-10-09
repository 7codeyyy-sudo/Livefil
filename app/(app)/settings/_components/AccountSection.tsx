/**
 * 账号设置分区（AUTH-002，v0.26 UI-010 分区 9；RD-012 §9-B6/B7/B9）。
 *
 * **仅认证部署渲染**（`mode === 'cloud'`）——本地自用态本分区不存在
 * （C4 明文），本地部署下这些端点也不可达（RD-012 §5.4）。
 *
 * ## 分区内两个表单各自提交（不做分区级保存）
 *
 * 改邮箱是**双验证两步流**（发码 → 提交，B6）、改密码是单提交——
 * 统一的「保存分区」按钮对前者无意义、对后者多一次无谓的脏态。
 * 每个动作自带按钮与结果反馈，即时提交即时 toast（表单纪律 L826）。
 *
 * ## 模式标识不在本分区重复
 *
 * 双态句的呈现位是**设置页顶部**（UI-010「模式标识双态句」条文：`/me` 返回 +
 * 设置页顶部）——顶部 `modeNote` 已按 `mode` 渲染，分区内再放一行会让同页
 * 出现两处同句（PM-006 C4 与该条文的呈现位表述取后者，RD-013 披露）。
 *
 * ## 账号（username）行只读、无修改入口
 *
 * 详设 10 端点（RD-012 §4.1）**未建改 username 端点**——UI 条文的「各自
 * 修改入口」与详设的差异以详设为准据，不虚构无契约的入口（RD-013 披露）。
 */
import { useState } from 'react';
import { useRouter } from 'next/navigation';

import { Button, Input, useToast } from '@/shared/ui/components';
import type { UserDto } from '@/modules/identity/application/user-dto.ts';
import { ApiRequestError } from '../../_lib/api-client';
import { updateProfile } from '../../_lib/identity-api';

import { SettingsSection } from '../_components/SettingsSection';
import { changeEmail, changePassword, logout, sendChangeEmailCode } from '../_lib/account-api';
import styles from './AccountSection.module.css';

const RATE_LIMITED = '操作过于频繁，请稍后再试。';

function message(err: unknown): string {
  if (err instanceof ApiRequestError) {
    if (err.status === 429) {
      return RATE_LIMITED;
    }
    return err.message;
  }
  return '网络异常，请稍后再试。';
}

/** 密码规则 helper（B1 定稿，与服务端 Zod 同源）。 */
function passwordRulesMet(password: string): boolean {
  return (
    password.length >= 8 &&
    password.length <= 64 &&
    /[a-zA-Z]/.test(password) &&
    /\d/.test(password)
  );
}

export function AccountSection({
  profile,
  onProfileUpdated,
}: {
  readonly profile: UserDto;
  /** 保存成功后回传最新用户（父级刷新基线与只读行）。 */
  readonly onProfileUpdated: (user: UserDto) => void;
}) {
  const router = useRouter();
  const toast = useToast();

  // 名字修改（档 A：可改可重复，走 PATCH /me displayName——非新端点）。
  const [displayName, setDisplayName] = useState(profile.displayName ?? '');
  const [savingName, setSavingName] = useState(false);

  // 改密码。
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [savingPassword, setSavingPassword] = useState(false);

  // 改邮箱（两步：发码 → 提交）。
  const [newEmail, setNewEmail] = useState('');
  const [emailPassword, setEmailPassword] = useState('');
  const [emailCode, setEmailCode] = useState('');
  const [emailStep, setEmailStep] = useState<1 | 2>(1);
  const [savingEmail, setSavingEmail] = useState(false);

  const [error, setError] = useState<string | null>(null);

  async function saveDisplayName(): Promise<void> {
    if (savingName) {
      return;
    }
    setSavingName(true);
    setError(null);
    try {
      const { data } = await updateProfile({
        displayName: displayName.trim() === '' ? null : displayName.trim(),
        version: profile.version,
      });
      onProfileUpdated(data);
      toast.success('名字已更新');
    } catch (err) {
      setError(message(err));
    } finally {
      setSavingName(false);
    }
  }

  async function savePassword(): Promise<void> {
    if (savingPassword) {
      return;
    }
    setSavingPassword(true);
    setError(null);
    try {
      await changePassword({ currentPassword, newPassword });
      setCurrentPassword('');
      setNewPassword('');
      toast.success('密码已更新，其他设备已退出登录');
    } catch (err) {
      setError(message(err));
    } finally {
      setSavingPassword(false);
    }
  }

  async function sendEmailCode(): Promise<void> {
    if (savingEmail) {
      return;
    }
    setSavingEmail(true);
    setError(null);
    try {
      await sendChangeEmailCode({ newEmail: newEmail.trim(), currentPassword: emailPassword });
      setEmailStep(2);
      // 恒定 200（防枚举）：统一句，不回传新邮箱是否已注册。
      toast.success('如果该邮箱可用，验证码已发送。');
    } catch (err) {
      setError(message(err));
    } finally {
      setSavingEmail(false);
    }
  }

  async function saveEmail(): Promise<void> {
    if (savingEmail) {
      return;
    }
    setSavingEmail(true);
    setError(null);
    try {
      const { data } = await changeEmail({
        newEmail: newEmail.trim(),
        code: emailCode,
        currentPassword: emailPassword,
      });
      onProfileUpdated({ ...profile, email: data.email });
      setEmailStep(1);
      setNewEmail('');
      setEmailCode('');
      setEmailPassword('');
      toast.success('邮箱已更新，其他设备已退出登录');
    } catch (err) {
      setError(message(err));
    } finally {
      setSavingEmail(false);
    }
  }

  async function signOut(): Promise<void> {
    try {
      await logout();
    } finally {
      // 登出成功或幂等重复：都回到登录页（服务端 401 时 SessionGuard 也会带路）。
      router.replace('/login');
      router.refresh();
    }
  }

  return (
    <SettingsSection title="账号" description="登录凭据与身份信息。仅云端账号可见。">
      {error !== null ? (
        <p className={styles.alert} role="alert">
          {error}
        </p>
      ) : null}

      <dl className={styles.infoList}>
        <div className={styles.infoRow}>
          <dt>邮箱</dt>
          <dd>{profile.email ?? '未设置'}</dd>
        </div>
        <div className={styles.infoRow}>
          <dt>账号</dt>
          <dd>{profile.username ?? '未设置'}</dd>
        </div>
      </dl>

      <div className={styles.block}>
        <Input
          label="名字"
          value={displayName}
          hint="可改可重复，仅用于展示。"
          onChange={(event) => setDisplayName(event.target.value)}
        />
        <Button
          type="button"
          loading={savingName}
          disabled={displayName.trim() === (profile.displayName ?? '')}
          onClick={() => void saveDisplayName()}
        >
          保存名字
        </Button>
      </div>

      <div className={styles.block}>
        <h3 className={styles.blockTitle}>修改密码</h3>
        <Input
          label="当前密码"
          type="password"
          autoComplete="current-password"
          value={currentPassword}
          onChange={(event) => setCurrentPassword(event.target.value)}
        />
        <Input
          label="新密码"
          type="password"
          autoComplete="new-password"
          value={newPassword}
          hint={
            passwordRulesMet(newPassword)
              ? '密码规则已满足。'
              : '至少 8 位、最多 64 位，同时包含字母和数字。'
          }
          onChange={(event) => setNewPassword(event.target.value)}
        />
        <Button
          type="button"
          variant="primary"
          loading={savingPassword}
          disabled={currentPassword === '' || !passwordRulesMet(newPassword)}
          onClick={() => void savePassword()}
        >
          确认修改
        </Button>
      </div>

      <div className={styles.block}>
        <h3 className={styles.blockTitle}>修改邮箱</h3>
        <Input
          label="新邮箱"
          type="email"
          value={newEmail}
          onChange={(event) => setNewEmail(event.target.value)}
        />
        <Input
          label="当前密码"
          type="password"
          autoComplete="current-password"
          value={emailPassword}
          onChange={(event) => setEmailPassword(event.target.value)}
        />
        {emailStep === 2 ? (
          <Input
            label="验证码"
            value={emailCode}
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
            hint="验证码已发送至新邮箱，10 分钟内有效。"
            onChange={(event) => setEmailCode(event.target.value)}
          />
        ) : null}
        <div className={styles.inlineActions}>
          {emailStep === 1 ? (
            <Button
              type="button"
              loading={savingEmail}
              disabled={newEmail.trim() === '' || emailPassword === ''}
              onClick={() => void sendEmailCode()}
            >
              发送验证码
            </Button>
          ) : (
            <Button
              type="button"
              variant="primary"
              loading={savingEmail}
              disabled={emailCode === ''}
              onClick={() => void saveEmail()}
            >
              确认修改
            </Button>
          )}
          {emailStep === 2 ? (
            <Button
              type="button"
              variant="ghost"
              onClick={() => {
                setEmailStep(1);
                setEmailCode('');
                setError(null);
              }}
            >
              上一步
            </Button>
          ) : null}
        </div>
      </div>

      {/* 登出置分区底部（C4）；直接执行无确认（B9：登出非破坏）。 */}
      <div className={styles.signOutRow}>
        <Button type="button" variant="ghost" onClick={() => void signOut()}>
          退出登录
        </Button>
      </div>
    </SettingsSection>
  );
}
