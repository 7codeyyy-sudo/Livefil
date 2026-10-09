/**
 * 用户仓储的 Drizzle 实现（DB-001 / IAM-001）。
 *
 * 这一层负责三件事：**行↔实体的映射**、**事务边界**、**把数据库错误翻译成领域错误**。
 * 业务规则不在这里——它属于 `domain` 与 `application`。
 */
import { and, eq, sql } from 'drizzle-orm';

import type { Database } from '@/infrastructure/database/client.ts';
import { lifeAreas, users, type UserRow } from '@/infrastructure/database/schema.ts';
import { ConflictError, InvariantError, NotFoundError } from '@/shared/errors/app-error.ts';
import { hasPostgresErrorCode } from '@/shared/errors/postgres-error.ts';

import type {
  AccountCredentials,
  AccountRepository,
  CreateCloudAccountInput,
} from '../domain/account-repository.ts';
import type { EnsureLocalUserResult, UserRepository } from '../domain/user-repository.ts';
import type { LocalUserSeedArea, User, UserMode, UserSettingsPatch } from '../domain/user.ts';

/** PostgreSQL 的唯一约束冲突。 */
const UNIQUE_VIOLATION = '23505';

/** 本地模式的 `users.mode` 取值。 */
const LOCAL_MODE = 'local';

/**
 * 首启写入的初始时区。
 *
 * `users.timezone` 是 NOT NULL 且**刻意没有数据库默认值**——《数据库设计文档》
 * §4.1 注明它「默认由用户确认」，也就是说这个值本身是待确认的。但创建用户那一刻
 * 必须有个值，于是取与 `locale` 默认值（`zh-CN`）同源的产品默认市场时区，
 * 由用户在设置页确认或修改（IAM-002）。
 *
 * 不取 `UTC`：把 UTC 展示给用户会让"今天"的边界算错一整天，而用户不会知道
 * 该去改哪个开关。也不读服务端时区：那描述的是服务器在哪，不是用户在哪。
 */
const INITIAL_TIMEZONE = 'Asia/Shanghai';

/**
 * 把 `users.mode` 归一为领域枚举。
 *
 * 不做 `as UserMode` 强转：库里出现第三种取值意味着有人绕过应用写了数据，
 * 静默当成 `local` 会把它变成一个"看起来正常但语义错误"的会话。
 */
function toUserMode(value: string): UserMode {
  if (value === 'local' || value === 'cloud') {
    return value;
  }
  throw new InvariantError({ message: 'users.mode 的取值不在受支持集合内' });
}

/** 行 → 领域实体。 */
function toUser(row: UserRow): User {
  return {
    id: row.id,
    mode: toUserMode(row.mode),
    displayName: row.displayName,
    settings: {
      locale: row.locale,
      timezone: row.timezone,
      currencyCode: row.currencyCode,
      weekStartsOn: row.weekStartsOn,
      defaultTaskDurationMinutes: row.defaultTaskDurationMinutes,
      defaultBufferMinutes: row.defaultBufferMinutes,
      aiEnabled: row.aiEnabled,
      aiDataConsent: row.aiDataConsent,
      reminderEnabled: row.reminderEnabled,
      quietHoursStart: row.quietHoursStart,
      quietHoursEnd: row.quietHoursEnd,
    },
    version: row.version,
  };
}

/**
 * 创建用户仓储。
 *
 * @param db 绑定好 schema 的 Drizzle 句柄（由 `src/infrastructure/database` 的连接工厂产出）。
 */
export function createUserRepository(db: Database): UserRepository {
  /**
   * 读取唯一的本地用户；不存在返回 `null`。
   *
   * 这条查询**按设计**不带用户作用域：会话引导本身就是它要建立的东西，
   * 此刻还没有 userId 可用；判据换成 `mode = 'local'`，而库里至多一行。
   *
   * @user-scope-exempt: 会话引导阶段读取唯一本地用户，此刻还没有 userId 可用
   */
  async function findLocalUser(): Promise<User | null> {
    const rows = await db.select().from(users).where(eq(users.mode, LOCAL_MODE)).limit(1);
    const row = rows[0];
    return row === undefined ? null : toUser(row);
  }

  return {
    async ensureLocalUser(
      seedLifeAreas: readonly LocalUserSeedArea[],
    ): Promise<EnsureLocalUserResult> {
      try {
        return await db.transaction(async (tx) => {
          // 同上：首启引导阶段先定位库里是否已有本地用户，此刻还没有 userId。
          // @user-scope-exempt: 首启引导阶段定位唯一本地用户，此刻还没有 userId 可用
          const existing = await tx
            .select()
            .from(users)
            .where(eq(users.mode, LOCAL_MODE))
            .limit(1)
            .for('update');

          const found = existing[0];
          if (found !== undefined) {
            return { user: toUser(found), created: false };
          }

          const inserted = await tx
            .insert(users)
            .values({ mode: LOCAL_MODE, timezone: INITIAL_TIMEZONE })
            .returning();

          const created = inserted[0];
          if (created === undefined) {
            throw new InvariantError({ message: '创建本地用户后数据库未返回记录' });
          }

          // 播种与建用户**同一事务**（《详细设计》§4.6）：中途失败不该留下
          // "有用户但没有任何生活领域"的半成品状态。
          if (seedLifeAreas.length > 0) {
            await tx.insert(lifeAreas).values(
              seedLifeAreas.map((area) => ({
                userId: created.id,
                name: area.name,
                colorKey: area.colorKey,
                sortOrder: area.sortOrder,
                isDefault: true,
              })),
            );
          }

          return { user: toUser(created), created: true };
        });
      } catch (error) {
        if (!hasPostgresErrorCode(error, UNIQUE_VIOLATION)) {
          throw error;
        }
        // 并发首启：另一个事务刚创建了本地用户。`SELECT ... FOR UPDATE` 对空结果集
        // 不加锁，所以这条路径**必然**存在——唯一索引才是幂等的硬保证，这里把它
        // 转成"读取既有用户"，让结果与"本来就是唯一用户"完全一致。
        const existingUser = await findLocalUser();
        if (existingUser === null) {
          throw new InvariantError({ message: '唯一冲突后仍读不到本地用户' });
        }
        return { user: existingUser, created: false };
      }
    },

    findById(userId: string): Promise<User | null> {
      return db
        .select()
        .from(users)
        .where(eq(users.id, userId))
        .limit(1)
        .then((rows) => {
          const row = rows[0];
          return row === undefined ? null : toUser(row);
        });
    },

    async updateSettings(
      userId: string,
      patch: UserSettingsPatch,
      expectedVersion: number,
    ): Promise<User> {
      return db.transaction(async (tx) => {
        const updated = await tx
          .update(users)
          .set({
            ...patch,
            // 版本自增必须与 WHERE 同句完成：拆成"读—改—写"会留下窗口，
            // 两个并发写会同时通过检查（那正是乐观并发要防的场景）。
            version: sql`${users.version} + 1`,
          })
          .where(and(eq(users.id, userId), eq(users.version, expectedVersion)))
          .returning();

        const row = updated[0];
        if (row !== undefined) {
          return toUser(row);
        }

        // 没更新到行有两种原因，必须分开报：用户不存在（404）与版本过期（409）。
        const current = await tx
          .select({ version: users.version })
          .from(users)
          .where(eq(users.id, userId))
          .limit(1);

        const existing = current[0];
        if (existing === undefined) {
          throw new NotFoundError('用户不存在');
        }
        throw new ConflictError('设置已被其他操作修改，请刷新后重试', {
          details: { currentVersion: existing.version, expectedVersion },
        });
      });
    },
  };
}

/** 唯一冲突 → 字段级 409（区分 email 与 username，供注册页精准提示；AUTH-002）。 */
function translateUniqueViolation(error: unknown): never {
  if (!hasPostgresErrorCode(error, UNIQUE_VIOLATION)) {
    throw error;
  }
  const message = error instanceof Error ? error.message : '';
  if (message.includes('users_username_unique')) {
    throw new ConflictError('该账号名已被使用。', { fields: { username: '已被使用' } });
  }
  if (message.includes('users_email_unique')) {
    throw new ConflictError('该邮箱已注册。', { fields: { email: '已被注册' } });
  }
  throw new ConflictError('账号信息与既有账号冲突');
}

/** 行 → 认证面凭据（含 passwordHash——**只在服务端进程内存在**，AUTH-002）。 */
function toCredentials(row: UserRow): AccountCredentials | null {
  if (row.email === null) {
    // 本地用户没有邮箱；登录标识路径不该走到这里（调用方按归一后的邮箱查云端账号）。
    return null;
  }
  return {
    userId: row.id,
    mode: toUserMode(row.mode),
    email: row.email,
    username: row.username,
    displayName: row.displayName,
    passwordHash: row.passwordHash,
    emailVerifiedAt: row.emailVerifiedAt,
  };
}

/**
 * 创建认证账号仓储（AUTH-002，RD-012 §2.1/§3 流 1·2）。
 *
 * 与 `createUserRepository` 同文件：两者共享 `toUser`/`toUserMode`/唯一冲突
 * 翻译——拆成两个文件会让行↔实体映射漂移成两份，而它们必须永远一致。
 *
 * ## 用户作用域豁免（IAM-004 静态判定）
 *
 * `findByEmail`/`findByUsername` 的查询发生在**认证之前**——此刻没有会话、
 * 没有 userId，按邮箱/账号定位正是登录语义本身（同 `findLocalUser` 的豁免
 * 性质）。其余查询全部以 userId 为谓词。
 */
export function createAccountRepository(db: Database): AccountRepository {
  return {
    // 认证前按邮箱定位——登录语义本身，无 userId 可用。
    // @user-scope-exempt: 登录标识按邮箱定位，发生在认证之前无 userId 可用
    findByEmail(email: string): Promise<AccountCredentials | null> {
      return db
        .select()
        .from(users)
        .where(eq(users.email, email))
        .limit(1)
        .then((rows) => {
          const row = rows[0];
          return row === undefined ? null : toCredentials(row);
        });
    },

    // 同上：认证前按账号定位。
    // @user-scope-exempt: 登录标识按账号定位，发生在认证之前无 userId 可用
    findByUsername(username: string): Promise<AccountCredentials | null> {
      return db
        .select()
        .from(users)
        .where(eq(users.username, username))
        .limit(1)
        .then((rows) => {
          const row = rows[0];
          return row === undefined ? null : toCredentials(row);
        });
    },

    findById(userId: string): Promise<AccountCredentials | null> {
      return db
        .select()
        .from(users)
        .where(eq(users.id, userId))
        .limit(1)
        .then((rows) => {
          const row = rows[0];
          return row === undefined ? null : toCredentials(row);
        });
    },

    async createCloudAccount(
      input: CreateCloudAccountInput,
      seedLifeAreas: readonly LocalUserSeedArea[],
    ): Promise<User> {
      try {
        return await db.transaction(async (tx) => {
          // 建用户 + 播种同一事务（对标 ensureLocalUser，详设 §4.6）：
          // 中途失败不留「有账号但没有任何生活领域」的半成品。
          const inserted = await tx
            .insert(users)
            .values({
              mode: 'cloud',
              email: input.email,
              username: input.username,
              displayName: input.displayName,
              passwordHash: input.passwordHash,
              emailVerifiedAt: input.emailVerifiedAt,
              timezone: INITIAL_TIMEZONE,
            })
            .returning();

          const created = inserted[0];
          if (created === undefined) {
            throw new InvariantError({ message: '创建云端账号后数据库未返回记录' });
          }

          if (seedLifeAreas.length > 0) {
            await tx.insert(lifeAreas).values(
              seedLifeAreas.map((area) => ({
                userId: created.id,
                name: area.name,
                colorKey: area.colorKey,
                sortOrder: area.sortOrder,
                isDefault: true,
              })),
            );
          }

          return toUser(created);
        });
      } catch (error) {
        translateUniqueViolation(error);
      }
    },

    async updatePasswordHash(userId: string, passwordHash: string): Promise<void> {
      const updated = await db
        .update(users)
        .set({ passwordHash, updatedAt: new Date() })
        .where(eq(users.id, userId))
        .returning({ id: users.id });
      if (updated[0] === undefined) {
        throw new NotFoundError('用户不存在');
      }
    },

    async updateEmail(userId: string, email: string, verifiedAt: Date): Promise<void> {
      try {
        const updated = await db
          .update(users)
          .set({ email, emailVerifiedAt: verifiedAt, updatedAt: new Date() })
          .where(eq(users.id, userId))
          .returning({ id: users.id });
        if (updated[0] === undefined) {
          throw new NotFoundError('用户不存在');
        }
      } catch (error) {
        translateUniqueViolation(error);
      }
    },
  };
}
