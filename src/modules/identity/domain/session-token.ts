/**
 * 会话令牌端口（IAM-001，《详细设计说明书》§8.1）。
 *
 * ## 为什么端口在领域层而不是应用层
 *
 * 端口属于**使用它的层**是常见的说法，但在本项目的依赖规则下，实现方
 * （`src/modules/<模块>/infrastructure`）被明确禁止引用应用层——把端口定义在
 * 应用层会让"实现一个端口"变成一次违规引用。所以端口统一收在领域层：
 * 实现方可以引用领域层，应用层也可以引用本模块的领域层，两边都不越界。
 * 仓储端口（`user-repository.ts`）是同一个理由。
 *
 * ## 为什么载荷里没有过期时间
 *
 * 本地模式的会话就是"这台机器上的这个用户"。加过期时间只会让用户长时间不用
 * 之后回到应用时被迫重新初始化一次，而那次初始化做的事（确保用户存在）与
 * 已有会话要做的事完全相同。可吊销会话与刷新随云端批次（决策 T-006 挂账）。
 */

/** 会话载荷。字段名短，因为整串会进 Cookie 的字节预算。 */
export interface SessionPayload {
  /** 用户 id。 */
  readonly userId: string;
  /** 签发时间（epoch 毫秒）。 */
  readonly issuedAt: number;
}

/**
 * 会话令牌的签发与验证。
 *
 * 实现是 HMAC 无状态令牌（`src/infrastructure/auth/session-signer.ts`）；
 * 本批不建 `sessions` 表（§8.1），因此没有「吊销」「续期」这类方法——
 * 端口只暴露当前确实存在的行为。
 */
export interface SessionTokenService {
  /** 生成签名令牌。 */
  sign(payload: SessionPayload): string;
  /**
   * 验签并解析。
   *
   * @returns 签名有效且载荷形状正确时返回载荷，否则返回 `null`。
   *   **刻意不抛异常**：坏 Cookie 是常态（用户清过站点数据、手工改过值），
   *   调用方要的语义是"没有有效会话"，而不是"发生了一次错误"——把常态路径
   *   做成异常，会让真正的异常被淹没在噪音里。
   */
  verify(token: string): SessionPayload | null;
}
