/**
 * 限流端口（AUTH-002，RD-012 §4.2 / §14.1 契约四族）。
 *
 * 端口在领域层、实现经组合根注入：用例只表达「这个键还有没有配额」，
 * 存储形态（进程内滑动窗口 vs DB 计数）是基础设施的实现细节。
 *
 * ## 单实例边界（如实申报，RD-012 §11-5）
 *
 * 进程内窗口实现与甲案部署形态一致（spike §3：单实例多租户 1 台）；
 * 多实例化时须换共享存储——这是已知边界，不是待定项。
 */
export interface RateLimiter {
  /**
   * 消费一次配额并判定是否放行。
   *
   * @param key 维度键（如 `login:identifier:foo`、`register:ip:1.2.3.4`）。
   * @param limit 窗口内上限。
   * @param windowMs 窗口长度（毫秒）。
   * @returns `true` 放行；`false` 超限（调用方回 429 统一文案）。
   */
  consume(key: string, limit: number, windowMs: number): boolean;
}

/** 契约 §14.1 四族阈值（单点定义，用例与测试同源）。 */
export const RATE_LIMITS = {
  /** 发码：每 IP 20 次/小时（每 email 5/时、15/日走 DB 计数，见 verification-code.ts）。 */
  codeSendPerIp: { limit: 20, windowMs: 60 * 60 * 1000 },
  /** 登录：每 identifier 10 次/15 分钟；每 IP 30 次/15 分钟。 */
  loginPerIdentifier: { limit: 10, windowMs: 15 * 60 * 1000 },
  loginPerIp: { limit: 30, windowMs: 15 * 60 * 1000 },
  /** 注册：每 IP 10 次/小时。 */
  registerPerIp: { limit: 10, windowMs: 60 * 60 * 1000 },
  /** 重置/改密/改邮箱：每主体 5 次/小时。 */
  passwordOps: { limit: 5, windowMs: 60 * 60 * 1000 },
} as const;
