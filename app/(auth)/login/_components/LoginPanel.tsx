'use client';

/**
 * 登录面板（AUTH-002；v0.30「星球黎明」视觉层）。
 *
 * ## 本版改了什么
 *
 * 纯视觉换版：`(auth)` 的窄栏零装饰形态（v0.26 UI-010 C0）在**登录页**退出，
 * 改为左列巨字 + 玻璃表单面板 + 星夜背景（`LoginBackdrop`）。视觉准据＝需求方
 * 已验收的预览稿（`temp/login-preview.html` v12 定稿）；注册与忘记密码两页
 * 仍走 `auth.module.css` 的窄栏形态（本文件不含它们的样式）。
 *
 * ## 行为零改动（逐条保留）
 *
 * - **回跳**：`next` 过同源校验（`^\/(?!\/)`）后 `router.replace` + `refresh`。
 * - **双通道**：`emailEnabled` 决定验证码通道是否出现；降级态强制密码通道
 *   （Tab 不渲染，state 不该停在 code 上）。
 * - **标识判定**：单框「邮箱或账号」原样提交，含 @ 与否的分流在服务端。
 * - **错误与限流**：401 统一文案（防枚举、只述凭据问题）、429 限流文案、
 *   其余按 `ApiRequestError.message` 回显、非接口错误回落网络异常句。
 * - **发码**：`sendVerificationCode` + 「重新发送」态 + 发码成功提示。
 * - **自动聚焦**（B5）：≥768px 聚焦标识框；窄屏不聚焦（自动弹键盘会遮挡表单）。
 *
 * ## 一处文案位置的合并（需在交付说明与规范里登记）
 *
 * 401 跳转的说明行「请先登录后继续。」原为**条件出现**（仅带 `next` 时）；
 * 新形态的副题**常驻**同一句（去掉句号，见预览稿字号表）。两者同句同时出现会
 * 读成重复，因此不再渲染那条例说明行——文案没有丢，只是从「条件行」并入常驻副题。
 * 「验证码已发送至 …」这类**状态**提示仍按原样在面板内出现（`role="status"`）。
 *
 * ## 视觉层与组件库的关系
 *
 * 本页不再使用共享库的 `Input` / `Button`：设计准据是下划线字段 + 通栏按钮 +
 * 文本式分段，共享控件（盒式输入、min-height 布局）无法表达；这里用原生元素 +
 * 本页样式模块复刻同样的可访问性语义（label ↔ 控件、`aria-pressed` 分段、
 * `aria-busy` + `disabled` 提交态、`role="alert"` 失败行、`:focus-visible` 焦点环）。
 * 行为与语义与旧版逐条对应，只有外观换了语言。
 */
import { useEffect, useId, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';

import { clientEnv } from '@/shared/validation/env.client.ts';
import { ApiRequestError } from '../../../(app)/_lib/api-client';

import { login, sendVerificationCode } from '../../_lib/auth-api';
import { LoginBackdrop } from './LoginBackdrop';

import styles from './LoginPanel.module.css';

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
   * 降级态（false）：隐藏验证码通道（单密码通道）——验证码需要邮件载体。
   */
  readonly emailEnabled: boolean;
}) {
  const router = useRouter();
  const identifierRef = useRef<HTMLInputElement>(null);
  const fieldId = useId();

  const [tab, setTab] = useState<Tab>('password');
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [codeSent, setCodeSent] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // 降级态强制密码通道（通道未渲染，state 不该停在 code 上）。
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
    <main>
      {/* 星夜背景（WebGL 画布 + 全站材质噪声）：纯装饰、无 WebGL 时静默降级。 */}
      <LoginBackdrop />

      <div className={styles.head}>
        <span className={styles.eyebrow}>{clientEnv.appName}</span>
        <h1 className={styles.hero}>欢迎回来</h1>
        {/* 常驻副题（原 401 说明行并入此处，见文件头注记）。 */}
        <p className={styles.sub}>请先登录后继续</p>
      </div>

      <form
        className={styles.panel}
        aria-label="登录"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        {/* 双通道切换＝分段先例（C2：/review 同款 aria-pressed，不新造 Tab 组件）。
            降级态（PD-029 第 3 项）不渲染这一件——验证码需要邮件载体。 */}
        {emailEnabled ? (
          <div className={styles.modes} role="group" aria-label="登录方式">
            <button
              type="button"
              className={styles.mode}
              aria-pressed={tab === 'password'}
              onClick={() => {
                setTab('password');
                setError(null);
              }}
            >
              密码
            </button>
            <button
              type="button"
              className={styles.mode}
              aria-pressed={tab === 'code'}
              onClick={() => {
                setTab('code');
                setError(null);
              }}
            >
              验证码
            </button>
          </div>
        ) : null}

        {notice !== null ? (
          <p className={styles.status} role="status">
            {notice}
          </p>
        ) : null}
        {error !== null ? (
          <p className={styles.alert} role="alert">
            {error}
          </p>
        ) : null}

        <div className={styles.fields}>
          <div className={styles.field}>
            <label className={styles.label} htmlFor={`${fieldId}-identifier`}>
              邮箱或账号
            </label>
            <input
              id={`${fieldId}-identifier`}
              className={styles.input}
              ref={identifierRef}
              value={identifier}
              autoComplete="username"
              placeholder="you@example.com"
              onChange={(event) => setIdentifier(event.target.value)}
            />
          </div>

          {activeTab === 'password' ? (
            <div className={styles.field}>
              <label className={styles.label} htmlFor={`${fieldId}-password`}>
                密码
              </label>
              <input
                id={`${fieldId}-password`}
                className={styles.input}
                type="password"
                value={password}
                autoComplete="current-password"
                placeholder="••••••••"
                onChange={(event) => setPassword(event.target.value)}
              />
            </div>
          ) : (
            <div className={styles.field}>
              <label className={styles.label} htmlFor={`${fieldId}-code`}>
                验证码
              </label>
              <input
                id={`${fieldId}-code`}
                className={styles.input}
                value={code}
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={6}
                onChange={(event) => setCode(event.target.value)}
              />
            </div>
          )}
        </div>

        <button
          type="submit"
          className={styles.submit}
          disabled={submitting}
          aria-busy={submitting}
          data-loading={submitting}
        >
          登录
        </button>

        {/* 行内次操作（与预览稿的链接行同位）：密码通道＝忘记密码；验证码通道＝
            发送验证码（发过即「重新发送」）。两者都只保留当前通道该有的动作。 */}
        <div className={styles.links}>
          {activeTab === 'password' ? (
            <Link href="/forgot-password">忘记密码</Link>
          ) : (
            <button
              type="button"
              className={styles.link}
              disabled={submitting}
              onClick={() => void sendCode()}
            >
              {codeSent ? '重新发送' : '发送验证码'}
            </button>
          )}
          <span aria-hidden="true">·</span>
          <Link href="/register">注册</Link>
        </div>
      </form>
    </main>
  );
}
