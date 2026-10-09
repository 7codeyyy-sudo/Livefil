/**
 * 密码哈希端口（AUTH-002，RD-012 §8.1）。
 *
 * 端口在领域层（同 `session-token.ts` 的理由）：scrypt 实现属基础设施，
 * 用例只该知道「能把明文变成编码串、能校验」——换算法不动用例与测试。
 *
 * 为什么不是 HMAC：HMAC 是**可逆推**的对称运算（知道密钥就能重算同一串），
 * 适合「验证签发者」但不适合「存储密码」——库泄露后攻击者可拿字典直接对撞。
 * 密码哈希必须是慢且带盐的单向函数（scrypt，Node 内置，零依赖——事故 002）。
 */
export interface PasswordHasher {
  /** 生成加盐编码串，格式 `scrypt$N$r$p$salt$hash`（参数随串，便于日后升参）。 */
  hash(plainPassword: string): Promise<string>;
  /**
   * 校验明文与编码串。
   *
   * 实现必须**恒定时间比较**（`timingSafeEqual`），且对损坏的编码串返回 false
   * 而不是抛错——坏数据是常态路径，不是异常。
   */
  verify(plainPassword: string, encoded: string): Promise<boolean>;
}
