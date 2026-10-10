/**
 * 忘记密码 `/forgot-password`（AUTH-002，v0.26 UI-010 C3；PD-029 第 3 项降级态）。
 *
 * 全形态：步 1 邮箱 →「发送验证码」；步 2 验证码 + 新密码 →「重设密码」；
 * 完成态「密码已重设，请用新密码登录。」+ 主按钮「去登录」。
 *
 * 降级态（`emailEnabled=false`，无邮件通道）：**整页替换为「联系管理员重置」
 * 说明**——自助重置需要发码（邮件载体），通道缺席时不提供收不到码的入口
 * （不放假流程）；登录页的「忘记密码」入口仍可达本页（分发单第 4 行只授权
 * 登录页「Tab 单密码」，忘记密码入口保留、由本页承接降级文案）。
 *
 * 防枚举统一响应（C3 冻结句）：「如果该邮箱已注册，验证码已发送。」——
 * 无论邮箱是否存在，步 1 一律显示此句（差异只在邮件侧，RD-012 §4.4）。
 *
 * 已登录态访问本页：**允许、不拦截**（RD-012 §9-B8）；重置成功后服务端
 * 全量吊销会话（含当前），自然回到未登录。
 */
'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

import { Button, Input } from '@/shared/ui/components';
import { ApiRequestError } from '../../../(app)/_lib/api-client';

import { resetPassword, sendVerificationCode } from '../../_lib/auth-api';
import styles from '../../auth.module.css';

/** C3 防枚举统一响应（冻结句）。 */
const UNIFORM_SENT = '如果该邮箱已注册，验证码已发送。';
/** 429 统一文案（契约 §14.1 / C3 冻结句）。 */
const RATE_LIMITED = '操作过于频繁，请稍后再试。';
/** 降级态承接文案（PD-029 第 3 项；非冻结，列入文案对照表供 PM 注记）。 */
const CONTACT_ADMIN = '当前部署未开通自助重置，请联系管理员重置密码。';

export function ForgotPasswordPanel({
  emailEnabled,
}: {
  /**
   * 邮件通道是否启用（PD-029 第 3 项单一分支点，服务端 page 传入）。
   * 降级态：整页替换为「联系管理员重置」说明。
   */
  readonly emailEnabled: boolean;
}) {
  const router = useRouter();

  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function errorMessage(err: unknown): string {
    if (err instanceof ApiRequestError) {
      if (err.status === 429) {
        return RATE_LIMITED;
      }
      return err.message;
    }
    return '网络异常，请稍后再试。';
  }

  async function sendCode(): Promise<void> {
    if (email.trim() === '' || submitting) {
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await sendVerificationCode({ identifier: email.trim(), purpose: 'password_reset' });
      // 统一响应（C3 冻结句）：无论邮箱是否存在都前进——差异只在邮件侧。
      setStep(2);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSubmitting(false);
    }
  }

  async function submit(): Promise<void> {
    if (submitting) {
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await resetPassword({ email: email.trim(), code, newPassword });
      setStep(3);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSubmitting(false);
    }
  }

  // 降级态（PD-029 第 3 项）：整页替换为「联系管理员重置」——自助重置需要
  // 邮件通道发码，通道缺席时不提供收不到码的入口（不放假流程）。上面的
  // hooks 与函数照常定义（React hooks 规则），只是不渲染两步表单。
  if (!emailEnabled) {
    return (
      <>
        <h1 className={styles.title}>忘记密码</h1>
        <p className={styles.subtitle} role="status">
          {CONTACT_ADMIN}
        </p>
        <p className={styles.footer}>
          想起密码了？
          <Button
            type="button"
            variant="ghost"
            onClick={() => {
              router.push('/login');
            }}
          >
            返回登录
          </Button>
        </p>
      </>
    );
  }

  return (
    <>
      <h1 className={styles.title}>忘记密码</h1>
      <p className={styles.caption}>{step === 3 ? '完成' : `第 ${String(step)} 步，共 2 步`}</p>
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
            void sendCode();
          }}
        >
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
          <p className={styles.notice}>{UNIFORM_SENT}</p>
        </form>
      ) : null}

      {step === 2 ? (
        <form
          className={styles.form}
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
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
          <Input
            label="新密码"
            type="password"
            value={newPassword}
            autoComplete="new-password"
            onChange={(event) => setNewPassword(event.target.value)}
          />
          <p className={styles.caption}>至少 8 位，同时包含字母和数字。</p>
          <Button type="submit" variant="primary" loading={submitting}>
            重设密码
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
          </div>
        </form>
      ) : null}

      {step === 3 ? (
        <div className={styles.form}>
          <p className={styles.subtitle} role="status">
            密码已重设，请用新密码登录。
          </p>
          <Button
            type="button"
            variant="primary"
            onClick={() => {
              router.replace('/login');
            }}
          >
            去登录
          </Button>
        </div>
      ) : null}

      {step !== 3 ? (
        <p className={styles.footer}>
          想起密码了？
          <Button
            type="button"
            variant="ghost"
            onClick={() => {
              router.push('/login');
            }}
          >
            返回登录
          </Button>
        </p>
      ) : null}
    </>
  );
}
