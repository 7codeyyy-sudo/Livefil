/**
 * 认证用例的装配单点（AUTH-002，组合根 → 用例依赖的唯一胶合层）。
 *
 * 路由只表达业务流转（校验入参 → 调用例 → 组装信封），依赖从这里拿——
 * 与 `composition-root.ts` 的分工是：那里管「实现的懒加载单例」，这里管
 * 「用例构造参数的组装」。写 8 遍装配必然漂移，而认证装配的漂移表现是
 * 某个端点少了一层限流或少记了一条审计——安全缺陷，不是样式问题。
 *
 * 依赖方向合规：`app/**` 只经组合根取端口（FND-004），不直接引用
 * `src/infrastructure/**`。
 */
import { SendVerificationCodeUseCase } from '@/modules/identity/application/send-verification-code.ts';
import { RegisterUserUseCase } from '@/modules/identity/application/register-user.ts';
import { LoginUserUseCase } from '@/modules/identity/application/login-user.ts';
import { LogoutUseCase } from '@/modules/identity/application/logout.ts';
import {
  ChangeEmailUseCase,
  ChangePasswordUseCase,
  ResetPasswordUseCase,
  SendChangeEmailCodeUseCase,
} from '@/modules/identity/application/credential-operations.ts';

import {
  getAuditLogger,
  getEmailSender,
  getPasswordHasher,
  getLifeAreaSeeds,
  getRateLimiter,
  getRepositories,
  getSessionTokenService,
  getVerificationCodeCrypto,
} from '../../composition-root.ts';
import { serverEnv } from '@/shared/validation/env.server.ts';

/** 发送验证码用例（#1）。 */
export function createSendCodeUseCase(): SendVerificationCodeUseCase {
  const repositories = getRepositories();
  return new SendVerificationCodeUseCase({
    accounts: repositories.accounts,
    codes: repositories.verificationCodes,
    crypto: getVerificationCodeCrypto(),
    email: getEmailSender(),
    rateLimiter: getRateLimiter(),
    audit: getAuditLogger(),
  });
}

/** 注册用例（#2；PD-029 勘误：邀请码门 + 邮箱验证双态——emailEnabled 驱动）。 */
export function createRegisterUseCase(): RegisterUserUseCase {
  const repositories = getRepositories();
  return new RegisterUserUseCase({
    accounts: repositories.accounts,
    codes: repositories.verificationCodes,
    crypto: getVerificationCodeCrypto(),
    passwordHasher: getPasswordHasher(),
    sessions: repositories.sessions,
    signer: getSessionTokenService(),
    rateLimiter: getRateLimiter(),
    audit: getAuditLogger(),
    lifeAreaSeeds: getLifeAreaSeeds(),
    // 邀请码白名单来自 env（已归一）——码门的判定输入只有这一个来源。
    inviteCodes: serverEnv.inviteCodes,
    // 邮箱验证双态开关（单一分支点）：真＝全形态核码、假＝降级态免验证。
    emailEnabled: serverEnv.emailEnabled,
  });
}

/** 登录用例（#3）。 */
export function createLoginUseCase(): LoginUserUseCase {
  const repositories = getRepositories();
  return new LoginUserUseCase({
    accounts: repositories.accounts,
    codes: repositories.verificationCodes,
    crypto: getVerificationCodeCrypto(),
    passwordHasher: getPasswordHasher(),
    sessions: repositories.sessions,
    signer: getSessionTokenService(),
    rateLimiter: getRateLimiter(),
    audit: getAuditLogger(),
  });
}

/** 登出用例（#4）。 */
export function createLogoutUseCase(): LogoutUseCase {
  return new LogoutUseCase({
    sessions: getRepositories().sessions,
    audit: getAuditLogger(),
  });
}

/** 密码重置用例（#5）。 */
export function createResetPasswordUseCase(): ResetPasswordUseCase {
  const repositories = getRepositories();
  return new ResetPasswordUseCase({
    accounts: repositories.accounts,
    codes: repositories.verificationCodes,
    crypto: getVerificationCodeCrypto(),
    passwordHasher: getPasswordHasher(),
    sessions: repositories.sessions,
    audit: getAuditLogger(),
    rateLimiter: getRateLimiter(),
  });
}

/** 改密码用例（#6）。 */
export function createChangePasswordUseCase(): ChangePasswordUseCase {
  const repositories = getRepositories();
  return new ChangePasswordUseCase({
    accounts: repositories.accounts,
    passwordHasher: getPasswordHasher(),
    sessions: repositories.sessions,
    audit: getAuditLogger(),
  });
}

/** 改邮箱·发码用例（#7）。 */
export function createSendChangeEmailCodeUseCase(): SendChangeEmailCodeUseCase {
  const repositories = getRepositories();
  return new SendChangeEmailCodeUseCase({
    accounts: repositories.accounts,
    codes: repositories.verificationCodes,
    crypto: getVerificationCodeCrypto(),
    passwordHasher: getPasswordHasher(),
    sessions: repositories.sessions,
    audit: getAuditLogger(),
    rateLimiter: getRateLimiter(),
  });
}

/** 改邮箱·提交用例（#8）。 */
export function createChangeEmailUseCase(): ChangeEmailUseCase {
  const repositories = getRepositories();
  return new ChangeEmailUseCase({
    accounts: repositories.accounts,
    codes: repositories.verificationCodes,
    crypto: getVerificationCodeCrypto(),
    passwordHasher: getPasswordHasher(),
    sessions: repositories.sessions,
    audit: getAuditLogger(),
  });
}
