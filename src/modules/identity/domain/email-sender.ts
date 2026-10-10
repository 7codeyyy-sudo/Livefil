/**
 * 邮件发送端口（AUTH-002，RD-012 §8.1/§8.3；挂账 5 解锁落点）。
 *
 * 端口在领域层：用例决定「发什么语义的信」，传输（HTTP API / mock）在基础设施。
 * 发信走**邮件服务商 HTTP API + 内置 fetch**（PD-016 L108 明文优先，零新依赖）。
 *
 * ## 枚举防护的语义分层（RD-012 §4.4）
 *
 * API 侧恒定响应，**差异只存在于邮件内容**：邮箱已注册的注册请求改发
 * 「已注册请登录」提示信——收件人即邮箱主人，这不构成对外枚举。
 */
export type EmailPurpose = 'register' | 'login' | 'password_reset' | 'change_email';

export interface SendVerificationCodeEmail {
  readonly to: string;
  /** 明文验证码——只在进程内从用例流向传输层，不落库不入日志。 */
  readonly code: string;
  readonly purpose: EmailPurpose;
}

/** 邮箱状态提示信（发码阶段的枚举分流）。 */
export interface SendAccountNoticeEmail {
  readonly to: string;
  /** already_registered：注册请求遇已注册邮箱；not_registered：登录/重置遇未注册邮箱。 */
  readonly kind: 'already_registered' | 'not_registered';
}

export interface EmailSender {
  /** 发送验证码邮件；传输失败抛 `DependencyUnavailableError`（502）。 */
  sendVerificationCode(email: SendVerificationCodeEmail): Promise<void>;
  /** 发送状态提示信（恒定响应的「差异唯一所在」）。 */
  sendAccountNotice(email: SendAccountNoticeEmail): Promise<void>;
}
