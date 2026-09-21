/**
 * 生活领域仓储端口（DB-001 / IAM-003，《详细设计说明书》§（仓储依赖纪律））。
 *
 * ## 每个方法都带 `userId`
 *
 * 这不是冗余参数，而是**用户作用域的强制表达**：一旦端口上存在"不带 userId 的
 * 查询"，实现侧就总有机会写出一次全表读，而那样的读在本地单用户环境下**永远
 * 看不出问题**——直到进入多用户模式才变成数据泄漏。IAM-004 会为此加架构断言
 * （禁止无作用域的仓储读），端口形状先把这个约束摆在类型上。
 *
 * ## 非本人 id 一律 `null`
 *
 * 查询返回 `null`、由调用方转成 `NOT_FOUND` 语义（§4.8：不泄露存在性）。
 * 端口层不抛异常，是为了让 fake 实现与真实实现的行为**在这一点上完全相同**——
 * 集成测试因此能真实覆盖"访问他人 id"的分支，而不必依赖数据库。
 */
import type { LifeArea, LifeAreaCreateInput, LifeAreaPatch } from './life-area.ts';

export interface ListLifeAreasOptions {
  /** 是否包含已归档项（接口文档 §GET /life-areas 的 `includeArchived`）。 */
  readonly includeArchived: boolean;
}

export interface LifeAreaRepository {
  /** 按 `sortOrder` 升序列出该用户的领域。 */
  listByUser(userId: string, options: ListLifeAreasOptions): Promise<readonly LifeArea[]>;

  /**
   * 按 id 查单个领域（**含已归档**）。
   *
   * 必须能查到已归档项：恢复归档正是通过 `update({ isArchived: false })` 完成的。
   */
  findById(userId: string, lifeAreaId: string): Promise<LifeArea | null>;

  /**
   * 创建领域，`sortOrder` 由实现取当前末位 + 1。
   *
   * @throws {ConflictError} 同用户已有未归档的同名领域时（唯一索引兜底，实现侧先预检以给出友好信息）。
   */
  create(userId: string, input: LifeAreaCreateInput): Promise<LifeArea>;

  /** 更新名称 / 颜色 / 归档状态。 */
  update(userId: string, lifeAreaId: string, patch: LifeAreaPatch): Promise<LifeArea>;

  /**
   * 按给定顺序重排**全部未归档**领域（单事务）。
   *
   * 集合一致性由 `assertReorderCoversActiveSet` 校验（领域层的纯函数，
   * 实现侧在事务内调用），因此"多一个 / 少一个 / 含他人 id"都会在写入前失败。
   */
  reorderActive(userId: string, orderedIds: readonly string[]): Promise<readonly LifeArea[]>;
}
