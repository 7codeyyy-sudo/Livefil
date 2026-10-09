'use client';

/**
 * 注册面板（AUTH-002，v0.26 UI-010 C1；RD-012 §9-B1/B2/B7）。
 *
 * ## 三步与核码的分工（RD-012 §3 流 1）
 *
 * 步 2 的「验证」只做**前端格式校验**（6 位数字）——真正的核码在步 3
 * 与建号**单事务原子完成**（服务端 `核码 → 唯一 → 建号`）。把核码拆到步 2
 * 单独请求会引入「先验后建」的竞态窗口，且多一次往返。
 * 因此步 2 冻结错误行的出现位置＝步 3 提交失败时（服务端统一文案，
 * 与 C1 冻结句逐字同源）。
 *
 * ## 密码规则 helper（B1 定稿）
 *
 * 8–64 字符、至少含字母与数字、不得与邮箱/账号相同——**满足项转 success 色**；
 * 服务端 Zod 为唯一权威，前端只是实时回显（R6：登录失败行不暗示数据变更，
 * 本页同族纪律：校验失败只述字段问题）。
 *
 * ## 撞名边界（B2）
 *
 * username 撞名 409 只在**已持有效邮箱验证码**的步 3 提交后暴露——
 * 枚举 username 必须先过控制邮箱门槛 + 注册 IP 限流。
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

/** B1 密码规则（与服务端 Zod 同源的三条）。 */
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

export function RegisterPanel() {
  const router = useRouter();

  const [step, setStep] = useState<Step>(1);
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
      // 服务端统一文案直接回显：核码失败「验证码不正确或已过期。」、
      // 撞名「该账号名已被使用。」（409 字段级，B2 边界内的可达提示）。
      return err.message;
    }
    return '网络异常，请稍后再试。';
  }

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

  /** 步 3 提交：核码 + 建号单事务在服务端完成。 */
  async function submit(): Promise<void> {
    if (submitting) {
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await register({
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
            // 步 2 只做前端格式校验（核码在步 3 原子完成，流 1 步 2 说明）。
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
            void submit();
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
