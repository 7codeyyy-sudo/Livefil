/**
 * 认证账号仓储端口（AUTH-002，RD-012 §2.1/§3 流 1·2）。
 *
 * ## 为什么不扩展 `UserRepository`
 *
 * `tests/helpers/fake-repositories.ts` 为 `UserRepository` 提供了 fake 实现——
 * 给接口加必实现方法会让既有 fake 在类型检查中失败，而 `tests/` 是红线（PD-025 护栏 1）。
 * 认证面的方法集合与「本地用户/设置」的职责本就不同，独立端口同时解决
 * 依赖方向与红线两个问题。
 *
 * ## 与同步白名单的关系
 *
 * `username`/`password_hash`/`email_verified_at` 随 `users` 存储，但 `users`
 * 不在同步实体集合（RD-012 §2.1）——密码哈希无进入同步载荷的路径。
 */
import type { LocalUserSeedArea, User } from './user.ts';

/** 认证面看到的账号记录（含凭据字段；**只在服务端进程内存在**）。 */
export interface AccountCredentials {
  readonly userId: string;
  readonly mode: 'local' | 'cloud';
  readonly email: string | null;
  readonly username: string | null;
  readonly displayName: string | null;
  /** scrypt 编码串；本地用户为 null。 */
  readonly passwordHash: string | null;
  readonly emailVerifiedAt: Date | null;
}

/** 创建云端账号的输入（注册流，RD-012 §3 流 1；PD-029 第 1 项免邮箱验证）。 */
export interface CreateCloudAccountInput {
  /**
   * 归一小写后的邮箱；**可空**（PD-029：email 选填、不验证、不发信——
   * 无邮箱用户靠 `username` + 密码登录）。
   */
  readonly email: string | null;
  /** 归一后的账号（唯一冲突由实现抛 409）。 */
  readonly username: string;
  readonly displayName: string | null;
  readonly passwordHash: string;
  /**
   * 邮箱验证时刻；**可空且注册时恒为 null**（PD-029 免邮箱验证——没验证过
   * 就不写时刻，诚实优于填 now 冒充）。改邮箱双验证通过时仍写入非空。
   */
  readonly emailVerifiedAt: Date | null;
}

export interface AccountRepository {
  /** 按邮箱取账号（登录标识判定的邮箱路径；归一小写后查询）。 */
  findByEmail(email: string): Promise<AccountCredentials | null>;
  /** 按账号取账号（登录标识判定的 username 路径）。 */
  findByUsername(username: string): Promise<AccountCredentials | null>;
  /**
   * 按 id 取账号（改密/改邮箱前取当前凭据）。
   *
   * @throws {NotFoundError} 用户不存在。
   */
  findById(userId: string): Promise<AccountCredentials | null>;

  /**
   * 创建云端账号：**单事务**写入用户 + 播种默认领域（对标 `ensureLocalUser`
   * 的「建用户 + 播种」原子性，详设 §4.6）。
   *
   * @throws {ConflictError} email 或 username 唯一冲突（字段级提示）。
   */
  createCloudAccount(
    input: CreateCloudAccountInput,
    seedLifeAreas: readonly LocalUserSeedArea[],
  ): Promise<User>;

  /** 更新密码哈希（改密/重置）。 */
  updatePasswordHash(userId: string, passwordHash: string): Promise<void>;

  /**
   * 更新邮箱（改邮箱双验证通过后）：归一小写 + 刷新 `email_verified_at`。
   *
   * @throws {ConflictError} 新邮箱已被占用。
   */
  updateEmail(userId: string, email: string, verifiedAt: Date): Promise<void>;
}
