/**
 * 本地会话的签名与验签（IAM-001，《详细设计说明书》§8.1）。
 *
 * ## 为什么是无状态 HMAC Cookie，而不是会话表
 *
 * §8.1 明确：本批不建 `sessions` 表。会话载荷只有 `userId` 与签发时间，
 * 服务端用密钥签名后交给 Cookie；验证时重算签名即可，不需要查库。
 * 建表意味着还要面对"什么时候清理过期行""如何吊销"这些问题，而本地单用户
 * 模式根本没有登出黑名单与多设备的需求——为不存在的问题预先付出复杂度，
 * 是这个项目一贯拒绝的做法。可吊销会话随云端批次重定。
 *
 * ## 为什么用工厂 + 显式注入
 *
 * §8.3「分层必填」：根环境校验对 `AUTH_SECRET` 保持 optional（health、styleguide、
 * CI 不依赖它），必填约束落到这里——**缺密钥即在装配期失败**，也就是进程启动时
 * 就暴露，而不是等到某个请求进来才发现签不了名。测试则注入一个固定密钥，
 * 于是 `check` 链在零环境变量的机器上也能跑。
 *
 * ## 载荷为什么不带过期时间
 *
 * 本地模式的会话就是"这台机器上的这个用户"，加过期时间只会让用户在长时间
 * 不用之后回到应用时被迫重新初始化一次——而那次初始化做的事（确保用户存在）
 * 与已有会话要做的事完全相同。等云端批次需要吊销与刷新时再加。
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

import type {
  SessionPayload,
  SessionTokenService,
} from '@/modules/identity/domain/session-token.ts';
import { InvariantError } from '@/shared/errors/app-error.ts';

const SIGNATURE_ALGORITHM = 'sha256';
/** 载荷与签名之间的分隔符。 */
const TOKEN_SEPARATOR = '.';

/** 密钥最小长度，与 `src/shared/validation/env.ts` 的校验保持一致。 */
const MIN_SECRET_LENGTH = 32;

function encodeBase64Url(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url');
}

function decodeBase64Url(value: string): string {
  return Buffer.from(value, 'base64url').toString('utf8');
}

function computeSignature(secret: string, encodedPayload: string): string {
  return createHmac(SIGNATURE_ALGORITHM, secret).update(encodedPayload).digest('base64url');
}

/**
 * 判断解析出的对象是否为合法载荷。
 *
 * 验签通过只说明"这串是本服务签的"，不说明内容是我们要的形状——例如旧版本
 * 签下的载荷、或字段被我们改名后遗留的串。所以形状校验独立于验签。
 */
function isSessionPayload(value: unknown): value is SessionPayload {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as { readonly userId?: unknown; readonly issuedAt?: unknown };
  return (
    typeof candidate.userId === 'string' &&
    candidate.userId !== '' &&
    typeof candidate.issuedAt === 'number' &&
    Number.isFinite(candidate.issuedAt)
  );
}

/**
 * 创建会话签名器。
 *
 * 返回类型写领域端口 `SessionTokenService` 而不是某个具体对象类型：这让
 * "实现可替换"在类型上成立（测试注入固定密钥的实现、将来换成 JWT 或
 * 可吊销会话都不影响调用方），也让应用层只依赖端口、看不见本文件。
 *
 * @param options.secret 签名密钥，通常来自 `serverEnv.authSecret`。
 *   允许 `undefined` 是刻意的：调用方直接传环境变量值，由本工厂统一判定缺失。
 * @throws {InvariantError} 密钥缺失或过短时抛出（**装配期失败**，见 §8.3）。
 */
export function createSessionSigner(options: {
  readonly secret: string | undefined;
}): SessionTokenService {
  const secret = options.secret?.trim();

  if (secret === undefined || secret === '') {
    // 只报变量名，不回显取值（NFR-SEC-002）。
    throw new InvariantError({ message: '会话签名密钥未配置（AUTH_SECRET）' });
  }

  if (secret.length < MIN_SECRET_LENGTH) {
    throw new InvariantError({
      message: `会话签名密钥长度不足 ${MIN_SECRET_LENGTH} 个字符（AUTH_SECRET）`,
    });
  }

  return {
    sign(payload: SessionPayload): string {
      const encodedPayload = encodeBase64Url(JSON.stringify(payload));
      return `${encodedPayload}${TOKEN_SEPARATOR}${computeSignature(secret, encodedPayload)}`;
    },

    verify(token: string): SessionPayload | null {
      const separatorIndex = token.indexOf(TOKEN_SEPARATOR);
      if (separatorIndex <= 0 || separatorIndex === token.length - 1) {
        return null;
      }

      const encodedPayload = token.slice(0, separatorIndex);
      const providedSignature = token.slice(separatorIndex + 1);
      const expectedSignature = computeSignature(secret, encodedPayload);

      // 长度不等时 `timingSafeEqual` 会抛错，必须先判长度。
      // 长度本身不是秘密（签名长度固定），所以这一步的短路不泄露信息。
      if (providedSignature.length !== expectedSignature.length) {
        return null;
      }

      // 定长比较：普通的 `===` 会在第一个不同字节处返回，比较耗时因此与
      // 匹配前缀的长度相关——那是可被测量的信息。
      if (!timingSafeEqual(Buffer.from(providedSignature), Buffer.from(expectedSignature))) {
        return null;
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(decodeBase64Url(encodedPayload));
      } catch {
        // 签名对但载荷不是 JSON：只可能来自同密钥的另一版本实现，按无会话处理。
        return null;
      }

      return isSessionPayload(parsed) ? parsed : null;
    },
  };
}
