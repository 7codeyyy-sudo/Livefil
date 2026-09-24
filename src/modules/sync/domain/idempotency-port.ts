/**
 * 逐条幂等的存储端口（SYNC-003，《接口文档》§12.1.1、《数据库设计文档》§4.15）。
 *
 * ## 为什么这里再定义一个端口，而不复用 `app/_lib/idempotency.ts`
 *
 * 依赖方向只允许 `app → application → domain`：同步用例若 import `app/_lib/`，
 * 就把表现层变成了应用层的依赖（`dependency-rules.ts` 的「应用层不得依赖 app」
 * 会直接失败）。两个端口**结构相同**，实现（`src/infrastructure/idempotency/`）
 * 也只写一份——对接由组合根做结构赋值，基础设施不必为了满足谁的接口而反向 import。
 *
 * ## 与单请求幂等的语义差异
 *
 * `POST /tasks` 那种单请求幂等，命中已完成记录时整请求返回 409 `IDEMPOTENCY_REPLAY`；
 * 批量 push **不能**沿用（一条已处理会让整批失败），所以这里只暴露"占位/完成/释放"
 * 三个原语，由用例决定每条操作各自的返回状态（§12.1.1）。
 */

/** 占位结果。 */
export type SyncIdempotencyClaim =
  | { readonly outcome: 'claimed' }
  | { readonly outcome: 'replay'; readonly snapshot: unknown }
  | { readonly outcome: 'in-progress' };

export interface SyncIdempotencyPort {
  /**
   * 占位。
   *
   * @throws {ValidationError} 同 key 的请求体指纹不一致时抛出（同 `operationId`
   *   被用在另一条操作上，属客户端错误，调用方应把它判成该条 `rejected`）。
   */
  claim(userId: string, key: string, requestHash: string): Promise<SyncIdempotencyClaim>;

  /** 成功处理后落响应快照（`already_applied` 重放它）。 */
  complete(userId: string, key: string, snapshot: unknown): Promise<void>;

  /** 未产生成功结果时释放占位（`rejected` 与 `conflict` 都走这里）。 */
  release(userId: string, key: string): Promise<void>;
}
