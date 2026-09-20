// @vitest-environment node
/**
 * 内存版仓储（DB-001 / IAM-004 的测试基建）。
 *
 * ## 为什么需要它
 *
 * 《依赖边界规则》要求"仓储接口在领域层、实现在基础设施层"，这条纪律的**回报**
 * 就在这里：整个 `check` 链可以在没有 PostgreSQL 的机器上验证会话、校验、事务
 * 边界与越权语义——因为默认注入的是下面这两个实现。真机验证（迁移、事务回滚）
 * 由 `tests/db/**` 承担，跑在 `db:test` 上。
 *
 * ## 与真实实现保持一致的地方（刻意）
 *
 * - `ensureLocalUser` 在**同一个"事务"里**建用户并播种领域（这里用一个数组写入
 *   模拟原子的批量插入）；
 * - `updateSettings` 在版本不符时抛 `ConflictError`、用户不存在时抛
 *   `NotFoundError`；
 * - 全部查询强制 `userId` 作用域，非本人 id 一律"查不到"（不泄露存在性）。
 *
 * ## 刻意不模拟的地方
 *
 * 不模拟唯一索引争用、不模拟隔离级别——那些是 PostgreSQL 的行为，用一个数组
 * 假装模拟它，只会得到"看起来在测并发、实际什么都没测"的假证据。并发首启的
 * 真实保证由 schema 里的部分唯一索引 + 真机测试覆盖。
 */
import type {
  LifeArea,
  LifeAreaCreateInput,
  LifeAreaPatch,
} from '../../src/modules/life-areas/domain/life-area.ts';
import {
  assertReorderCoversActiveSet,
  isLifeAreaColorKey,
} from '../../src/modules/life-areas/domain/life-area.ts';
import type {
  LifeAreaRepository,
  ListLifeAreasOptions,
} from '../../src/modules/life-areas/domain/life-area-repository.ts';
import type {
  LocalUserSeedArea,
  User,
  UserSettings,
  UserSettingsPatch,
} from '../../src/modules/identity/domain/user.ts';
import type {
  EnsureLocalUserResult,
  UserRepository,
} from '../../src/modules/identity/domain/user-repository.ts';
import { ConflictError, InvariantError, NotFoundError } from '../../src/shared/errors/app-error.ts';
import type { AuditEventInput, AuditLogger } from '../../src/shared/telemetry/audit-event.ts';

/**
 * 新用户的设置默认值（与迁移里的列默认值**逐项一致**）。
 *
 * 为什么强调"逐项一致"：假仓储与 schema 一旦在默认值上分歧，集成测试会在一个
 * 生产上不存在的初始状态下通过——例如假仓储给 `reminderEnabled: false` 而
 * 数据库默认 `true`，那么"新用户是否默认收到提醒"这类判断就测错了方向。
 * 真机默认值由 `tests/db/phase2.db.test.mjs` 断言，这份表要与它同步。
 *
 * `timezone` 没有数据库默认值：它是**列里唯一必须由应用显式提供**的字段
 * （《详细设计》§4.1「默认由用户确认」），真实实现写入的是 `INITIAL_TIMEZONE`。
 */
export const DEFAULT_USER_SETTINGS: UserSettings = Object.freeze({
  locale: 'zh-CN',
  timezone: 'Asia/Shanghai',
  currencyCode: 'CNY',
  weekStartsOn: 1,
  defaultTaskDurationMinutes: null,
  defaultBufferMinutes: null,
  aiEnabled: false,
  aiDataConsent: false,
  reminderEnabled: true,
  quietHoursStart: null,
  quietHoursEnd: null,
});

/**
 * 共享的内存"数据库"。
 *
 * 两个仓储共用一个 store，而不是各自持有一份：真实系统里它们是同一个数据库，
 * 而"建用户时顺带播种领域"这件事跨了两张表——让两个假仓储看到同一份数据，
 * 才能测出这件事。
 */
export interface FakeDatabase {
  readonly users: User[];
  readonly lifeAreas: LifeArea[];
  sequence: number;
}

export function createFakeDatabase(): FakeDatabase {
  return { users: [], lifeAreas: [], sequence: 0 };
}

/** 生成一个稳定可读的 id（顺序递增，便于断言里对照）。 */
function nextId(database: FakeDatabase, prefix: string): string {
  database.sequence += 1;
  return `${prefix}-${String(database.sequence).padStart(4, '0')}`;
}

export function createFakeUserRepository(database: FakeDatabase): UserRepository {
  function findLocalUser(): User | null {
    return database.users.find((user) => user.mode === 'local') ?? null;
  }

  return {
    async ensureLocalUser(
      seedLifeAreas: readonly LocalUserSeedArea[],
    ): Promise<EnsureLocalUserResult> {
      const existing = findLocalUser();
      if (existing !== null) {
        return { user: existing, created: false };
      }

      const user: User = {
        id: nextId(database, 'user'),
        mode: 'local',
        displayName: null,
        settings: DEFAULT_USER_SETTINGS,
        version: 1,
      };

      // 同一"事务"内的两次写入：先用户、再领域。中途失败不会留下"有用户但
      // 没有任何领域"的半成品（这里不会失败，但顺序表达了那个意图）。
      database.users.push(user);
      for (const [index, seed] of seedLifeAreas.entries()) {
        // 与真实实现一致：非法 color_key 属于契约违约，明确报错而不是硬塞进库。
        if (!isLifeAreaColorKey(seed.colorKey)) {
          throw new InvariantError({ message: 'life_areas.color_key 的取值不在契约集合内' });
        }
        database.lifeAreas.push({
          id: nextId(database, 'area'),
          userId: user.id,
          name: seed.name,
          colorKey: seed.colorKey,
          sortOrder: seed.sortOrder ?? index,
          isDefault: true,
          isArchived: false,
          version: 1,
        });
      }

      return { user, created: true };
    },

    async findById(userId: string): Promise<User | null> {
      return database.users.find((user) => user.id === userId) ?? null;
    },

    async updateSettings(
      userId: string,
      patch: UserSettingsPatch,
      expectedVersion: number,
    ): Promise<User> {
      const index = database.users.findIndex((user) => user.id === userId);
      const current = database.users[index];

      if (current === undefined) {
        throw new NotFoundError('用户不存在');
      }

      if (current.version !== expectedVersion) {
        // 与真实实现同一句话、同一个错误类：测试断言的应当是**语义**，
        // 而语义由错误类 + 消息共同表达。
        throw new ConflictError('设置已被其他操作修改，请刷新后重试', {
          details: { expectedVersion, actualVersion: current.version },
        });
      }

      // 用 `key in patch` 而不是 `??`：显式传 `null`（清空安静时段）与
      // "不改这一项"是两件事——真实实现同样如此（见 `update-user-settings.ts`）。
      const settings: UserSettings = { ...current.settings };
      for (const key of Object.keys(patch) as (keyof UserSettingsPatch)[]) {
        const value = patch[key];
        if (value !== undefined) {
          Object.assign(settings, { [key]: value });
        }
      }

      const updated: User = { ...current, settings, version: current.version + 1 };
      database.users[index] = updated;
      return updated;
    },
  };
}

export function createFakeLifeAreaRepository(database: FakeDatabase): LifeAreaRepository {
  function scoped(userId: string): LifeArea[] {
    return database.lifeAreas.filter((area) => area.userId === userId);
  }

  function active(userId: string): LifeArea[] {
    // 与真实实现一致：重排只针对未归档项，并且顺序即 `sortOrder` 升序。
    return scoped(userId)
      .filter((area) => !area.isArchived)
      .sort((a, b) => a.sortOrder - b.sortOrder);
  }

  function replace(updated: LifeArea): void {
    const index = database.lifeAreas.findIndex((area) => area.id === updated.id);
    if (index >= 0) {
      database.lifeAreas[index] = updated;
    }
  }

  return {
    async listByUser(userId: string, options: ListLifeAreasOptions): Promise<readonly LifeArea[]> {
      const items = options.includeArchived ? scoped(userId) : active(userId);
      return [...items].sort((a, b) => a.sortOrder - b.sortOrder);
    },

    async findById(userId: string, lifeAreaId: string): Promise<LifeArea | null> {
      // 作用域不匹配与不存在都返回 `null`：调用方统一转成 NOT_FOUND，
      // 于是"猜 id"无法区分"不存在"与"是别人的"。
      return (
        database.lifeAreas.find((area) => area.id === lifeAreaId && area.userId === userId) ?? null
      );
    },

    async create(userId: string, input: LifeAreaCreateInput): Promise<LifeArea> {
      const clash = active(userId).some((area) => area.name === input.name);
      if (clash) {
        throw new ConflictError(`已存在同名的未归档领域：${input.name}`);
      }

      const maxOrder = scoped(userId).reduce((max, area) => Math.max(max, area.sortOrder), -1);
      const created: LifeArea = {
        id: nextId(database, 'area'),
        userId,
        name: input.name,
        colorKey: input.colorKey,
        sortOrder: maxOrder + 1,
        isDefault: false,
        isArchived: false,
        version: 1,
      };
      database.lifeAreas.push(created);
      return created;
    },

    async update(userId: string, lifeAreaId: string, patch: LifeAreaPatch): Promise<LifeArea> {
      const current = database.lifeAreas.find(
        (area) => area.id === lifeAreaId && area.userId === userId,
      );
      if (current === undefined) {
        throw new NotFoundError('生活领域不存在或不属于当前用户');
      }

      const updated: LifeArea = {
        ...current,
        ...(patch.name === undefined ? {} : { name: patch.name }),
        ...(patch.colorKey === undefined ? {} : { colorKey: patch.colorKey }),
        ...(patch.isArchived === undefined ? {} : { isArchived: patch.isArchived }),
        version: current.version + 1,
      };
      replace(updated);
      return updated;
    },

    async reorderActive(
      userId: string,
      orderedIds: readonly string[],
    ): Promise<readonly LifeArea[]> {
      const currentActive = active(userId);
      // 与真实实现共用同一个领域纯函数：集合一致性规则因此只有一处定义。
      assertReorderCoversActiveSet(
        currentActive.map((area) => area.id),
        orderedIds,
      );

      for (const [index, id] of orderedIds.entries()) {
        const area = database.lifeAreas.find((item) => item.id === id);
        if (area !== undefined) {
          replace({ ...area, sortOrder: index, version: area.version + 1 });
        }
      }

      return active(userId);
    },
  };
}

export interface FakeAuditLogger extends AuditLogger {
  readonly events: readonly AuditEventInput[];
}

/** 记录审计事件的假日志器（断言"写操作确实产生了审计事件"）。 */
export function createFakeAuditLogger(): FakeAuditLogger {
  const events: AuditEventInput[] = [];
  return {
    events,
    record(event: AuditEventInput): void {
      events.push(event);
    },
  };
}
