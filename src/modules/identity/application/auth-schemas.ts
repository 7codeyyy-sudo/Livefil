/**
 * 认证请求的输入校验（AUTH-002，《接口文档》v0.8 认证端点总表；RD-012 §4.1/§9 B1）。
 *
 * 规则来源与优先级：
 * - **密码规则（B1 定稿）**：8–64 字符、至少含字母与数字两类、不得与 identifier
 *   全文相同。前两条在本 schema（服务端唯一权威）；「不得与 identifier 相同」
 *   跨字段，由用例层在读到上下文后判定。
 * - **账号规则**：3–20 字符、字符集 `[a-z0-9_一-龥]`（写入前 trim + ASCII 小写归一），
 *   不含 `@` ——这是登录标识「含 @ 走邮箱、否则走 username」单一判定的前提。
 * - 统一文案防枚举：核码失败一律同一条消息，不区分过期/错误/不存在（修正条 L108）。
 */
import { z } from 'zod';

/** 归一小写 + trim（邮箱与账号的写入归一，两处共用）。 */
const normalize = (value: string): string => value.trim().toLowerCase();

/**
 * 邮箱地址长度上限。
 *
 * **写成 RFC 5321 的语义分解而不是结果值**：local part(64) + '@'(1) + domain(255)
 * ＝ SMTP 协议给出的本源，读者能直接看出每个数字的出处；顺带使该行及其注释
 * 不含任何断点像素值字面量（UI-001「断点值只在唯一镜像」纪律——本值恰与
 * §3.1 手机断点同值属巧合撞车，C1 整改销证项）。
 */
const EMAIL_MAX_LENGTH = 64 + 1 + 255;

/** 邮箱格式（校验在归一后进行，避免大小写差异绕过格式检查）。 */
export const emailField = z
  .string()
  .max(EMAIL_MAX_LENGTH, '邮箱过长')
  .transform(normalize)
  .pipe(z.email('邮箱格式不正确'));

/** 账号字段：归一后匹配字符集（`@` 天然被排除——登录判定零重叠的前提）。 */
export const usernameField = z
  .string()
  .max(30, '账号过长')
  .transform(normalize)
  .pipe(z.string().regex(/^[a-z0-9_一-龥]{3,20}$/, '账号需 3–20 位，可用字母、数字、下划线与中文'));

/**
 * 密码字段。
 *
 * 强度判定刻意**只做两件事**：长度与字符类。「不得与 identifier 相同」放不进
 * 单字段 schema——它需要登录标识做对照，属于跨字段约束，由用例层判定
 * （同 AI 同意约束的分层理由：schema 只看得见补丁，看不见上下文）。
 */
export const passwordField = z
  .string()
  .min(8, '密码至少 8 位')
  .max(64, '密码最多 64 位')
  .refine((value) => /[a-zA-Z]/.test(value) && /\d/.test(value), {
    message: '密码需同时包含字母和数字',
  });

/** 验证码：6 位数字（单输入框形态，UI-010 C1）。 */
export const codeField = z.string().regex(/^\d{6}$/, '验证码为 6 位数字');

/**
 * 发送验证码（#1）。
 *
 * `identifier` 而不是 `email`：登录 purpose 下标识可为账号（UI-010 C2 单框
 * 「邮箱或账号」，RD-012 §3 流 3 服务端解析）；注册/重置 purpose 必须为邮箱
 * （UI-010 C1/C3 步 1 只收邮箱）——用途级格式约束在 superRefine 分流。
 */
export const sendCodeSchema = z
  .object({
    // 输入上界沿 `EMAIL_MAX_LENGTH`：identifier 或为邮箱（或为账号——账号由
    // usernameField 的 3–20 规则另行约束，这里的上限只挡超长垃圾输入）。
    identifier: z.string().min(1, '请输入邮箱或账号').max(EMAIL_MAX_LENGTH),
    purpose: z.enum(['register', 'login', 'password_reset']),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.purpose === 'login') {
      // 登录 purpose：邮箱或账号皆可（后端按含 @ 分流，RD-012 §4.3）。
      return;
    }
    const result = z.email().safeParse(normalize(value.identifier));
    if (!result.success) {
      ctx.addIssue({ code: 'custom', message: '邮箱格式不正确' });
    }
  })
  .transform((value) => ({
    identifier: normalize(value.identifier),
    purpose: value.purpose,
  }));

/** 注册（#2）。三步页的步 3 一次提交（RD-012 §3 流 1：核码原子于提交）。 */
export const registerSchema = z
  .object({
    email: emailField,
    code: codeField,
    username: usernameField,
    displayName: z.string().max(80).nullable().optional(),
    password: passwordField,
  })
  .strict();

/** 登录（#3）：互斥二选一通道——恰有一个凭据字段。 */
export const loginSchema = z
  .object({
    identifier: z.string().min(1, '请输入邮箱或账号').max(EMAIL_MAX_LENGTH).transform(normalize),
    password: passwordField.optional(),
    code: codeField.optional(),
  })
  .strict()
  .refine((value) => (value.password !== undefined) !== (value.code !== undefined), {
    message: '密码与验证码必须二选一',
  });

/** 密码重置（#5）。 */
export const passwordResetSchema = z
  .object({ email: emailField, code: codeField, newPassword: passwordField })
  .strict();

/** 改密码（#6，已登录）。 */
export const changePasswordSchema = z
  .object({
    currentPassword: z.string().min(1).max(64),
    newPassword: passwordField,
  })
  .strict();

/** 改邮箱·发码（#7，已登录，双验证之第一半）。 */
export const changeEmailCodeSchema = z
  .object({ newEmail: emailField, currentPassword: z.string().min(1).max(64) })
  .strict();

/** 改邮箱·提交（#8，已登录，双验证之第二半）。 */
export const changeEmailSchema = z
  .object({
    newEmail: emailField,
    code: codeField,
    currentPassword: z.string().min(1).max(64),
  })
  .strict();

export type SendCodeRequest = z.infer<typeof sendCodeSchema>;
export type RegisterRequest = z.infer<typeof registerSchema>;
export type LoginRequest = z.infer<typeof loginSchema>;
export type PasswordResetRequest = z.infer<typeof passwordResetSchema>;
export type ChangePasswordRequest = z.infer<typeof changePasswordSchema>;
export type ChangeEmailCodeRequest = z.infer<typeof changeEmailCodeSchema>;
export type ChangeEmailRequest = z.infer<typeof changeEmailSchema>;
