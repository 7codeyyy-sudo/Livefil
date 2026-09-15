/**
 * 客户端可见环境变量的白名单（FND-001）。
 *
 * 只有 `NEXT_PUBLIC_` 前缀的变量会被 Next.js 内联进浏览器包，因此本模块**只允许**
 * 读取该前缀。任何服务端变量都必须改从 `env.server.ts` 读取，
 * 防止数据库连接串、会话密钥和 AI 密钥意外泄露到客户端产物（NFR-SEC-002）。
 */

/** 产品名兜底值：未配置 `NEXT_PUBLIC_APP_NAME` 时使用，避免界面出现空白标题。 */
const APP_NAME_FALLBACK = 'Livefil';

export interface ClientEnv {
  readonly appName: string;
}

export const clientEnv: ClientEnv = Object.freeze({
  appName: process.env.NEXT_PUBLIC_APP_NAME ?? APP_NAME_FALLBACK,
});
