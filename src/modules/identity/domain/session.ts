/**
 * 认证会话实体与仓储端口（AUTH-002，《数据库设计文档》§4.19，RD-012 §2.2）。
 *
 * 端口在领域层（同 `session-token.ts` 的理由）：实现方在 `infrastructure`，
 * 用例在 `application`，两边都不该为了一个接口互相引用。
 *
 * 甲案三要件的落点：**可吊销**（`revokedAt` 即时生效）、**多设备**（每设备一行）、
 * **设备标签**（`deviceLabel`）。行状态是权威——令牌里的 `exp` 只做前置快拒。
 */
import type { SessionPayload } from './session-token.ts';

/** 认证部署的会话行。 */
export interface AuthSession {
  readonly id: string;
  readonly userId: string;
  /** 登录时取 User-Agent 截断 + 去控制字符落存；不做 UA 解析库（零依赖）。 */
  readonly deviceLabel: string | null;
  readonly createdAt: Date;
  /** 更新节流 ≥5 分钟（防每请求写放大，RD-012 §3 流 4）。 */
  readonly lastSeenAt: Date;
  /** 签发＝now+30 天；半衰点（剩余 <15 天）滑动续期。 */
  readonly expiresAt: Date;
  /** 非空即失效（登出/改密/重置/改邮箱/账户删除）。 */
  readonly revokedAt: Date | null;
}

export interface CreateSessionInput {
  readonly userId: string;
  readonly deviceLabel: string | null;
  readonly expiresAt: Date;
}

export interface SessionRepository {
  /** 新建会话行（登录/注册成功；**永不复用入站 sid**——会话固定防护）。 */
  create(input: CreateSessionInput): Promise<AuthSession>;

  /**
   * 按 sid + uid 双条件取行。
   *
   * uid 一并进条件而不是只按主键查：令牌载荷里两个字段都有，把它们同时作为
   * 谓词等于让「签名有效但 uid 与行不符」的畸形令牌在查询层就被拒——
   * 这也是仓储用户作用域纪律（IAM-004 静态判定）的自然满足。
   */
  findByIdForUser(sessionId: string, userId: string): Promise<AuthSession | null>;

  /**
   * 活动续期与 last_seen 合并写：剩余 <15 天（半衰点）时续至 now+30 天。
   *
   * @returns 续期发生时返回新行（调用据此重发 Set-Cookie）；未到续期点返回 null。
   */
  renewIfDue(sessionId: string, userId: string, now: Date): Promise<AuthSession | null>;

  /** 记录活动（节流 ≥5 分钟由实现判定，未到节流点不产生写）。 */
  touch(sessionId: string, userId: string, now: Date): Promise<void>;

  /** 吊销单个会话（登出）；幂等。 */
  revoke(sessionId: string, userId: string, now: Date): Promise<void>;

  /**
   * 吊销该用户全部会话（重置密码、**账户删除跨批端口**）。
   *
   * `revokeAllSessions(userId)` 的契约面（RD-012 §2.1 方向：data-management →
   * identity）——批 1 的账户删除落库后经组合根调用本方法，非 HTTP 端点。
   */
  revokeAll(userId: string, now: Date): Promise<void>;

  /**
   * 吊销该用户其余全部会话（改密/改邮箱后保留当前，重置密码则全吊销＝不传 keep）。
   *
   * @param keepSessionId 需要保留的当前会话；`null` 表示全量吊销。
   */
  revokeOthers(userId: string, keepSessionId: string | null, now: Date): Promise<void>;

  /** 惰性清理：删除该用户已过期/已吊销的行（登录时顺手做，不引入 cron）。 */
  purgeExpired(userId: string, now: Date): Promise<void>;
}

/** 会话时长常量（RD-012 §2.2/§3 流 4；单点定义，测试与实现同源）。 */
export const SESSION_TTL_DAYS = 30;
/** 半衰点续期阈值（天）。 */
export const SESSION_RENEW_BEFORE_DAYS = 15;
/** last_seen 更新节流（毫秒）。 */
export const SESSION_TOUCH_THROTTLE_MS = 5 * 60 * 1000;

/** 从「剩余天数」推导续期判据的辅助（实现与测试共用，避免阈值写两处）。 */
export function shouldRenew(expiresAt: Date, now: Date): boolean {
  const remainingMs = expiresAt.getTime() - now.getTime();
  return remainingMs < SESSION_RENEW_BEFORE_DAYS * 24 * 60 * 60 * 1000;
}

/** 令牌载荷扩展（RD-012 §8.2：签名令牌含 sid/exp，签名器复用零改动）。 */
export type CloudSessionPayload = SessionPayload & {
  readonly sessionId: string;
  /** 前置快拒用的过期时刻（epoch 毫秒）；权威过期以 sessions 行为准。 */
  readonly exp: number;
};
