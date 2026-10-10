/**
 * 邮件发送适配器（AUTH-002，RD-012 §8.1/§8.3；PD-016 L108：邮件服务商
 * HTTP API + 内置 fetch，零新依赖）。
 *
 * ## 三个纪律点
 *
 * 1. **超时**：`AbortSignal.timeout`——发信是外部依赖，挂起的连接会让注册
 *    流程停在「已提交但无响应」（硬门禁：外部调用有超时、限流和降级）。
 * 2. **无自动重试**：发码可重发（受频控兜底），失败重试只会放大故障——
 *    与 resilient-ai 的「429 不重试」同族理由。
 * 3. **失败降级**：传输失败抛 `DependencyUnavailableError`（502 统一文案），
 *    由路由层归一——用户看到「发送失败请稍后再试」，而不是静默丢码。
 *
 * ## mock（`EMAIL_PROVIDER=mock`，仅 dev/test）
 *
 * 静默成功、**不回传验证码、不写码入任何日志**（B12：不做 devCode 后门）。
 * 集成测试注入 fake `EmailSender` 端口取码；e2e 按 `page.route` 范式打契约。
 * 生产 + 认证部署 + mock 已在 env 装配期拒绝（env.ts 跨字段规则）。
 */
import type {
  EmailSender,
  SendAccountNoticeEmail,
  SendVerificationCodeEmail,
} from '../domain/email-sender.ts';
import { serverEnv } from '@/shared/validation/env.server.ts';
import { DependencyUnavailableError } from '@/shared/errors/app-error.ts';

/** 发信超时（毫秒）——注册流程的用户等待上界。 */
const SEND_TIMEOUT_MS = 10_000;

/** 验证码邮件正文（中文，product 基调与 UI 冻结文案一致）。 */
function codeEmailBody(email: SendVerificationCodeEmail): { subject: string; text: string } {
  const purposeText: Record<SendVerificationCodeEmail['purpose'], string> = {
    register: '注册验证码',
    login: '登录验证码',
    password_reset: '密码重置验证码',
    change_email: '邮箱变更验证码',
  };
  return {
    subject: `【Livefil】${purposeText[email.purpose]}`,
    text:
      `你的验证码是 ${email.code}，10 分钟内有效。\n\n` +
      `如果不是本人操作，请忽略本邮件。请勿将验证码告诉他人。\n\n` +
      `— Livefil`,
  };
}

function noticeEmailBody(email: SendAccountNoticeEmail): { subject: string; text: string } {
  if (email.kind === 'already_registered') {
    return {
      subject: '【Livefil】该邮箱已注册',
      text: '该邮箱已注册，请直接登录。如果不是本人操作，请忽略本邮件。\n\n— Livefil',
    };
  }
  return {
    subject: '【Livefil】该邮箱未注册',
    text: '该邮箱尚未注册。如果这是你的邮箱，请先注册后再操作。\n\n— Livefil',
  };
}

/** 组装 HTTP 发信请求（单一出网点——密钥只在这里出现，便于审计）。 */
async function sendViaHttpApi(
  api: { readonly url: string; readonly key: string; readonly from: string },
  to: string,
  body: { subject: string; text: string },
): Promise<void> {
  let response: Response;
  try {
    response = await fetch(api.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${api.key}`,
      },
      body: JSON.stringify({ from: api.from, to, subject: body.subject, text: body.text }),
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });
  } catch (error) {
    // 超时与网络故障同族：外部依赖当下不可达。原因进 cause（只在服务端日志）。
    throw new DependencyUnavailableError('邮件服务暂时不可用，请稍后再试', { cause: error });
  }

  if (!response.ok) {
    throw new DependencyUnavailableError('邮件服务暂时不可用，请稍后再试', {
      details: { status: response.status },
    });
  }
}

export function createEmailSender(): EmailSender {
  const provider = serverEnv.emailProvider;

  async function send(to: string, body: { subject: string; text: string }): Promise<void> {
    if (provider === 'mock') {
      // 静默成功：mock 不发信、不记录内容（RD-012 §8.3 B12——无 devCode 后门）。
      return;
    }

    const url = serverEnv.emailApiUrl;
    const key = serverEnv.emailApiKey;
    const from = serverEnv.emailFrom;
    if (url === undefined || key === undefined || from === undefined) {
      // env 跨字段规则已拦（EMAIL_PROVIDER=http 时三件必填），这里是纵深防御：
      // 配置对象被绕过校验直接构造时，也不能把 undefined 发出网。
      throw new DependencyUnavailableError('邮件服务配置不完整');
    }

    await sendViaHttpApi({ url, key, from }, to, body);
  }

  return Object.freeze({
    sendVerificationCode(email: SendVerificationCodeEmail): Promise<void> {
      return send(email.to, codeEmailBody(email));
    },
    sendAccountNotice(email: SendAccountNoticeEmail): Promise<void> {
      return send(email.to, noticeEmailBody(email));
    },
  });
}
