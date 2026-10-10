'use client';

/**
 * 登录面板（AUTH-002，v0.26 UI-010 C2；RD-012 §9-B3/B4/B5）。
 *
 * ## 冻结文案与状态行（C2）
 *
 * - 页顶说明行「请先登录后继续。」——只在带 `next`（401 跳来）时出现。
 * - 失败行「邮箱/账号或密码不正确。」——服务端 401 统一文案的本地回显，
 *   **不区分**查无/密码错/码失败（防枚举；R6 约束：只述凭据问题）。
 * - 限流行「操作过于频繁，请稍后再试。」——429 `RATE_LIMITED`。
 *
 * ## 标识判定与回跳（B3/B4）
 *
 * 单框「邮箱或账号」原样提交——含 @ 与否的分流在服务端（RD-012 §4.3）。
 * 回跳 `next` 过同源校验（`^\/(?!\/)`）：防开放跳转，非法回退默认页。
 *
 * ## 自动聚焦（B5）
 *
 * ≥768px 聚焦标识输入框；窄屏不聚焦——自动唤起键盘会遮挡半个表单。
 *
 * ## 降级态（PD-029 第 3 项）
 *
 * `emailEnabled=false`（无邮件通道）：隐藏验证码 Tab、强制单密码通道——
 * 验证码需要邮件载体，UI 不提供收不到码的入口（不放假按钮）。忘记密码入口
 * **保留**（分发单第 4 行只授权「Tab 单密码」）：降级态忘记密码页自身显示
 * 「联系管理员重置」文案承接。冻结文案零改动（结构增减随 PM 注记对照表）。
 */
import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';

import { Button, Input } from '@/shared/ui/components';
import { ApiRequestError } from '../../../(app)/_lib/api-client';

import { login, sendVerificationCode } from '../../_lib/auth-api';
import styles from '../../auth.module.css';

type Tab = 'password' | 'code';

/** 401 统一文案（契约 v0.8 #3 / C2 冻结句，与服务端同源）。 */
const LOGIN_FAILED = '邮箱/账号或密码不正确。';
/** 429 统一文案（契约 §14.1 / C2 冻结句）。 */
const RATE_LIMITED = '操作过于频繁，请稍后再试。';

/** 同源回跳校验（B4）：必须是以单 `/` 开头的站内路径，否则回退默认页。 */
function safeNext(next: string | null): string {
  if (next !== null && /^\/(?!\/)/.test(next)) {
    return next;
  }
  return '/';
}

export function LoginPanel({
  next,
  emailEnabled,
}: {
  readonly next: string | null;
  /**
   * 邮件通道是否启用（PD-029 第 3 项单一分支点，服务端 page 传入）。
   * 降级态（false）：隐藏验证码 Tab（单密码通道）——验证码需要邮件载体。
   */
  readonly emailEnabled: boolean;
}) {
  const router = useRouter();
  const identifierRef = useRef<HTMLInputElement>(null);

  const [tab, setTab] = useState<Tab>('password');
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [codeSent, setCodeSent] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(next !== null ? '请先登录后继续。' : null);

  // 降级态强制密码通道（Tab 未渲染，state 不该停在 code 上）。
  const activeTab: Tab = emailEnabled ? tab : 'password';

  // B5：宽屏聚焦标识框；窄屏不聚焦（自动弹键盘会遮挡表单）。
  useEffect(() => {
    if (window.matchMedia('(min-width: 768px)').matches) {
      identifierRef.current?.focus();
    }
  }, []);

  function errorMessage(err: unknown): string {
    if (err instanceof ApiRequestError) {
      if (err.status === 429) {
        return RATE_LIMITED;
      }
      if (err.status === 401) {
        return LOGIN_FAILED;
      }
      return err.message;
    }
    return '网络异常，请稍后再试。';
  }

  async function sendCode(): Promise<void> {
    if (identifier.trim() === '' || submitting) {
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await sendVerificationCode({ identifier: identifier.trim(), purpose: 'login' });
      setCodeSent(true);
      setNotice(`验证码已发送至 ${identifier.trim()}，10 分钟内有效。`);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSubmitting(false);
    }
  }

  async function submit(): Promise<void> {
    if (identifier.trim() === '' || submitting) {
      return;
    }
    if (activeTab === 'password' && password === '') {
      return;
    }
    if (activeTab === 'code' && code === '') {
      return;
    }
    setSubmitting(true);
    setError(null);
    setNotice(null);
    try {
      await login(
        activeTab === 'password'
          ? { identifier: identifier.trim(), password }
          : { identifier: identifier.trim(), code },
      );
      // 成功即回跳（B4 同源校验）。`replace` 而非 `push`：登录不该留在历史里，
      // 否则「后退」会回到登录页。
      router.replace(safeNext(next));
      router.refresh();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <>
      <h1 className={styles.title}>登录</h1>
      {notice !== null ? (
        <p className={styles.notice} role="status">
          {notice}
        </p>
      ) : null}
      {error !== null ? (
        <p className={styles.alert} role="alert">
          {error}
        </p>
      ) : null}

      {/* 双 Tab＝分段先例（C2：/review 同款 aria-pressed Button，不新造 Tab 组件）。
          降级态（PD-029 第 3 项）不渲染 Tab 区——验证码需要邮件载体，单密码通道。 */}
      {emailEnabled ? (
        <div className={styles.segments} role="group" aria-label="登录方式">
          <Button
            type="button"
            variant={tab === 'password' ? 'primary' : 'secondary'}
            aria-pressed={tab === 'password'}
            onClick={() => {
              setTab('password');
              setError(null);
            }}
          >
            密码
          </Button>
          <Button
            type="button"
            variant={tab === 'code' ? 'primary' : 'secondary'}
            aria-pressed={tab === 'code'}
            onClick={() => {
              setTab('code');
              setError(null);
            }}
          >
            验证码
          </Button>
        </div>
      ) : null}

      <form
        className={styles.form}
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <Input
          label="邮箱或账号"
          ref={identifierRef}
          value={identifier}
          autoComplete="username"
          onChange={(event) => setIdentifier(event.target.value)}
        />

        {activeTab === 'password' ? (
          <Input
            label="密码"
            type="password"
            value={password}
            autoComplete="current-password"
            onChange={(event) => setPassword(event.target.value)}
          />
        ) : (
          <Input
            label="验证码"
            value={code}
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
            onChange={(event) => setCode(event.target.value)}
          />
        )}

        <Button type="submit" variant="primary" loading={submitting}>
          登录
        </Button>

        <div className={styles.secondaryRow}>
          {activeTab === 'password' ? (
            <Button
              type="button"
              variant="ghost"
              onClick={() => {
                setError(null);
                router.push('/forgot-password');
              }}
            >
              忘记密码
            </Button>
          ) : (
            <Button
              type="button"
              variant="ghost"
              loading={submitting}
              onClick={() => void sendCode()}
            >
              {codeSent ? '重新发送' : '发送验证码'}
            </Button>
          )}
        </div>
      </form>

      <p className={styles.footer}>
        还没有账号？
        <Button
          type="button"
          variant="ghost"
          onClick={() => {
            router.push('/register');
          }}
        >
          注册
        </Button>
      </p>
    </>
  );
}
