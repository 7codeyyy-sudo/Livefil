/**
 * 用户仓储端口（DB-001，《详细设计说明书》§（仓储依赖纪律））。
 *
 * 端口定义在**领域层**、实现落在 `infrastructure`：route handler 与 use case
 * 只依赖本接口，默认的集成测试注入 fake 实现，于是整个 `check` 链不需要
 * PostgreSQL 就能验证会话、校验与事务边界（§11 的测试纪律）。
 */
import type { LocalUserSeedArea, User, UserSettingsPatch } from './user.ts';

/** `ensureLocalUser` 的结果。 */
export interface EnsureLocalUserResult {
  readonly user: User;
  /** 本次调用是否真的**创建**了用户（用于断言幂等性，也便于日志区分首启与常规）。 */
  readonly created: boolean;
}

export interface UserRepository {
  /**
   * 幂等确保唯一本地用户存在。
   *
   * 首次创建时，`seedLifeAreas` 必须在**同一个事务**内写入（《详细设计》§4.6：
   * 「建用户 + 播种六领域」是一次引导动作，中途失败不该留下"有用户但没有任何
   * 领域"的半成品状态）。
   *
   * 种子从参数传入而不是由仓储自己决定：名单是业务规则，归 `life-areas` 领域；
   * 仓储只负责"按给的内容写"，它不该知道"工作/健康/财务"这些名字。
   *
   * 并发首启必须只产生一个用户——实现侧由唯一约束/行锁串行化，领域侧只约定结果。
   */
  ensureLocalUser(seedLifeAreas: readonly LocalUserSeedArea[]): Promise<EnsureLocalUserResult>;

  /** 按 id 查用户；不存在返回 `null`（由调用方决定语义）。 */
  findById(userId: string): Promise<User | null>;

  /**
   * 更新设置：单事务读—改—写回，带乐观并发。
   *
   * @param expectedVersion 调用方拿到的版本号。
   * @param displayName 名字（AUTH-002 契约增补 #6）——**独立于 settings 分组**
   * 的可选参数：`UserSettingsPatch` 只收设置字段，把顶层列混进去会让 fake 与
   * 真实实现的 patch 语义分叉（tests/ 红线不可改，可选参数是唯一不破面的通路）。
   * @returns 写入后的新用户（`version` 已自增）。
   * @throws {ConflictError} 版本与库中不符时抛出（由实现负责抛领域错误）。
   */
  updateSettings(
    userId: string,
    patch: UserSettingsPatch,
    expectedVersion: number,
    displayName?: string | null,
  ): Promise<User>;
}
