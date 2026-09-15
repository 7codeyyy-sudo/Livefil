/**
 * 服务端环境变量的应用侧入口（FND-001）。
 *
 * `server-only` 会在客户端组件误引用本模块时直接构建报错，从机制上阻止
 * DATABASE_URL、AUTH_SECRET、AI_API_KEY 之类秘密进入浏览器包（NFR-SEC-002）。
 *
 * 校验在模块首次加载时立即执行，属于「失败即停」：
 * 服务端环境变量不合法时，进程不应带着半可用配置继续提供服务。
 */
import 'server-only';
import { type ServerEnv, parseServerEnv } from './env';

export const serverEnv: ServerEnv = parseServerEnv(process.env);

export type { ServerEnv };
