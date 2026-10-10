'use client';

/**
 * 注册面板（PD-029 双态：邀请码制 + 邮箱验证随邮件通道；v0.26 UI-010 C1 承接）。
 *
 * ## 双态形态（PD-029 第 1/3 项，读 `emailEnabled` 切换）
 *
 * - **降级态（无邮件通道）**：邀请码 + 账号 + 名字 + 密码（单表单，分发单
 *   第 4 行四项）——免邮箱验证，靠**邀请码门 + IP 限流**双闸防滥用（第 5 项）。
 * - **全形态（配好 `EMAIL_API_URL`）**：邀请码 + 原三步邮箱验证（邀请码在
 *   步 1 与邮箱同收——入场券语义，也与降级态「邀请码在最前」对齐）。步 3
 *   服务端**真核码**（拍板 3「三步注册回归」的验证能力，不是假流程）。
 *
 * ## 密码规则 helper（B1 定稿）
 *
 * 8–64 字符、至少含字母与数字、不得与邮箱/账号相同——**满足项转 success 色**；
 * 服务端 Zod 为唯一权威，前端只是实时回显。降级态无邮箱，「不与邮箱或账号
 * 相同」自然退化为只比账号（没有邮箱可比）。
 *
 * ## 文案纪律
 *
 * 冻结文案（C1 页题/页底、步内标签）零改动；**新增文案**（邀请码字段、
 * 降级态无步骤 caption）逐条列入 RD-016 文案对照表供 PM 注记。邀请码失败
 * 直接回显服务端统一文案「邀请码不正确。」（无码/错码同一句，防枚举）。
 */
import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';

import { Button, Input } from '@/shared/ui/components';
import { ApiRequestError } from '../../../(app)/_lib/api-client';

import { register, sendVerificationCode } from '../../_lib/auth-api';
import styles from '../../auth.module.css';

type Step = 1 | 2 | 3;

/** 429 统一文案（契约 §14.1 / C1 冻结句）。 */
const RATE_LIMITED = '操作过于频繁，请稍后再试。';

/** B1 密码规则（与服务端 Zod 同源的四条）。 */
function usePasswordRules(password: string, email: string, username: string) {
  return useMemo(
    () => [
      { label: '至少 8 位', met: password.length >= 8 },
      { label: '最多 64 位', met: password.length <= 64 },
      { label: '同时包含字母和数字', met: /[a-zA-Z]/.test(password) && /\d/.test(password) },
      {
        label: '不与邮箱或账号相同',
        met: password !== '' && password !== email && password !== username,
      },
    ],
    [password, email, username],
  );
}

export function RegisterPanel({
  emailEnabled,
}: {
  /**
   * 邮件通道是否启用（PD-029 第 3 项单一分支点，服务端 page 传入）。
   * 降级态＝四项单表单；全形态＝邀请码 + 三步邮箱验证。
   */
  readonly emailEnabled: boolean;
}) {
  const router = useRouter();

  const [step, setStep] = useState<Step>(1);
  const [inviteCode, setInviteCode] = useState('');
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [username, setUsername] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [codeSent, setCodeSent] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const rules = usePasswordRules(password, email, username);

  function errorMessage(err: unknown): string {
    if (err instanceof ApiRequestError) {
      if (err.status === 429) {
        return RATE_LIMITED;
      }
      // 服务端统一文案直接回显：邀请码失败「邀请码不正确。」（无码/错码同句）、
      // 撞名「该账号名已被使用。」（409 字段级）、全形态缺邮箱字段等 400。
      return err.message;
    }
    return '网络异常，请稍后再试。';
  }

  /** 降级态提交：邀请码 + 账号 + 名字 + 密码（免邮箱验证）。 */
  async function submitDegrade(): Promise<void> {
    if (inviteCode.trim() === '' || username.trim() === '' || password === '' || submitting) {
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await register({
        inviteCode: inviteCode.trim(),
        username: username.trim(),
        displayName: displayName.trim() === '' ? null : displayName.trim(),
        password,
      });
      // 注册即登录（服务端已 Set-Cookie）：直接进应用。
      router.replace('/');
      router.refresh();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSubmitting(false);
    }
  }

  /** 全形态步 1：发注册验证码。 */
  async function sendCode(): Promise<boolean> {
    if (email.trim() === '' || submitting) {
      return false;
    }
    setSubmitting(true);
    setError(null);
    try {
      await sendVerificationCode({ identifier: email.trim(), purpose: 'register' });
      setCodeSent(true);
      return true;
    } catch (err) {
      setError(errorMessage(err));
      return false;
    } finally {
      setSubmitting(false);
    }
  }

  /** 全形态步 3 提交：邀请码 + 邮箱 + 验证码 + 账号 + 名字 + 密码（服务端核码）。 */
  async function submitFull(): Promise<void> {
    if (submitting) {
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await register({
        inviteCode: inviteCode.trim(),
        email: email.trim(),
        code,
        username: username.trim(),
        displayName: displayName.trim() === '' ? null : displayName.trim(),
        password,
      });
      // 注册即登录（服务端已 Set-Cookie）：直接进应用。
      router.replace('/');
      router.refresh();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSubmitting(false);
    }
  }

  /* ---------------- 降级态：四项单表单 ---------------- */
  if (!emailEnabled) {
    return (
      <>
        <h1 className={styles.title}>创建账号</h1>
        {error !== null ? (
          <p className={styles.alert} role="alert">
            {error}
          </p>
        ) : null}
        <form
          className={styles.form}
          onSubmit={(event) => {
            event.preventDefault();
            void submitDegrade();
          }}
        >
          <Input
            label="邀请码"
            value={inviteCode}
            autoComplete="off"
            onChange={(event) => setInviteCode(event.target.value)}
          />
          <Input
            label="账号"
            value={username}
            autoComplete="username"
            onChange={(event) => setUsername(event.target.value)}
          />
          <Input
            label="名字（可留空）"
            value={displayName}
            autoComplete="nickname"
            onChange={(event) => setDisplayName(event.target.value)}
          />
          <Input
            label="密码"
            type="password"
            value={password}
            autoComplete="new-password"
            onChange={(event) => setPassword(event.target.value)}
          />
          <ul className={styles.rules}>
            {rules.map((rule) => (
              <li key={rule.label} className={rule.met ? styles.ruleMet : undefined}>
                {`${rule.met ? '✓ ' : '· '}${rule.label}`}
              </li>
            ))}
          </ul>
          <Button type="submit" variant="primary" loading={submitting}>
            创建账号
          </Button>
        </form>

        <p className={styles.footer}>
          已有账号？
          <Button
            type="button"
            variant="ghost"
            onClick={() => {
              router.push('/login');
            }}
          >
            登录
          </Button>
        </p>
      </>
    );
  }

  /* ---------------- 全形态：邀请码 + 三步邮箱验证 ---------------- */
  return (
    <>
      <h1 className={styles.title}>创建账号</h1>
      <p className={styles.caption}>{`第 ${String(step)} 步，共 3 步`}</p>
      {error !== null ? (
        <p className={styles.alert} role="alert">
          {error}
        </p>
      ) : null}

      {step === 1 ? (
        <form
          className={styles.form}
          onSubmit={(event) => {
            event.preventDefault();
            // 发码成功才进下一步（失败留在本步显示错误——错误行在页首 alert）。
            void sendCode().then((sent) => {
              if (sent) {
                setStep(2);
              }
            });
          }}
        >
          <Input
            label="邀请码"
            value={inviteCode}
            autoComplete="off"
            onChange={(event) => setInviteCode(event.target.value)}
          />
          <Input
            label="邮箱"
            type="email"
            value={email}
            autoComplete="email"
            onChange={(event) => setEmail(event.target.value)}
          />
          <Button type="submit" variant="primary" loading={submitting}>
            发送验证码
          </Button>
        </form>
      ) : null}

      {step === 2 ? (
        <form
          className={styles.form}
          onSubmit={(event) => {
            event.preventDefault();
            // 步 2 只做前端格式校验（核码在步 3 与建号单事务完成，C1 流 1 说明）。
            if (/^\d{6}$/.test(code)) {
              setError(null);
              setStep(3);
            } else {
              setError('验证码为 6 位数字');
            }
          }}
        >
          <p className={styles.subtitle}>{`验证码已发送至 ${email}，10 分钟内有效。`}</p>
          <Input
            label="验证码"
            value={code}
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
            onChange={(event) => setCode(event.target.value)}
          />
          <Button type="submit" variant="primary">
            验证
          </Button>
          <div className={styles.secondaryRow}>
            <Button
              type="button"
              variant="ghost"
              onClick={() => {
                setError(null);
                setStep(1);
              }}
            >
              上一步
            </Button>
            <Button
              type="button"
              variant="ghost"
              loading={submitting}
              onClick={() => void sendCode()}
            >
              {codeSent ? '重新发送' : '发送验证码'}
            </Button>
          </div>
        </form>
      ) : null}

      {step === 3 ? (
        <form
          className={styles.form}
          onSubmit={(event) => {
            event.preventDefault();
            void submitFull();
          }}
        >
          <Input
            label="账号"
            value={username}
            autoComplete="username"
            onChange={(event) => setUsername(event.target.value)}
          />
          <Input
            label="名字（可留空）"
            value={displayName}
            autoComplete="nickname"
            onChange={(event) => setDisplayName(event.target.value)}
          />
          <Input
            label="密码"
            type="password"
            value={password}
            autoComplete="new-password"
            onChange={(event) => setPassword(event.target.value)}
          />
          <ul className={styles.rules}>
            {rules.map((rule) => (
              <li key={rule.label} className={rule.met ? styles.ruleMet : undefined}>
                {`${rule.met ? '✓ ' : '· '}${rule.label}`}
              </li>
            ))}
          </ul>
          <Button type="submit" variant="primary" loading={submitting}>
            创建账号
          </Button>
          <div className={styles.secondaryRow}>
            <Button
              type="button"
              variant="ghost"
              onClick={() => {
                setError(null);
                setStep(2);
              }}
            >
              上一步
            </Button>
          </div>
        </form>
      ) : null}

      <p className={styles.footer}>
        已有账号？
        <Button
          type="button"
          variant="ghost"
          onClick={() => {
            router.push('/login');
          }}
        >
          登录
        </Button>
      </p>
    </>
  );
}
