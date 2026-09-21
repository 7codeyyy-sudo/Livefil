/**
 * 会话 Cookie 的读写契约（IAM-001，《接口文档》§POST /auth/local/session）。
 *
 * ## 为什么在 `presentation` 而不是 `infrastructure`
 *
 * Cookie 名与属性是**HTTP 传输层**的契约（浏览器按它决定发不发这个 Cookie），
 * 与"令牌怎么签名"是两件事：签名是可替换的实现细节（领域端口
 * `SessionTokenService`），而 `httpOnly`/`sameSite`/`path` 是接口适配层对
 * 客户端的承诺。分层上它属于表现层，只依赖共享层、不依赖领域——因此放在
 * 这里也不会破坏「表现层不得越过应用层访问领域」。
 *
 * 集中在一个文件而不是散在 route handler 里：一旦某个端点漏设 `httpOnly`
 * 或写错 `path`，表现是"登录状态时有时无"这种极难归因的现象。
 *
 * 刻意不依赖 `next/server`：读取交给调用方（`request.cookies.get(name)?.value`
 * 是一行代码）。保持框架中立，它才能在 Node 脚本与其它适配层复用。
 */

/** 会话 Cookie 名。带产品前缀，避免同域下与其它应用的 Cookie 撞名。 */
export const SESSION_COOKIE_NAME = 'livefil_session';

export interface SessionCookieAttributes {
  readonly httpOnly: true;
  readonly sameSite: 'lax';
  readonly secure: boolean;
  readonly path: '/';
}

/**
 * 会话 Cookie 属性。
 *
 * - `httpOnly`：脚本读不到它——XSS 偷走会话是最常见的会话劫持路径。
 * - `sameSite: 'lax'`：跨站请求不携带（挡住 CSRF 的常规路径），但站内导航照常，
 *   不会让用户点个链接就"掉线"。
 * - `secure`：**仅在 HTTPS 下有意义**。生产必须为 true；本地开发走 http，
 *   若强行 true，浏览器会直接丢弃这个 Cookie，表现为"会话永远建立不起来"。
 *   因此按环境判定，而不是恒定 true。
 * - `path: '/'`：整个站点都需要它。
 *
 * 不设 `maxAge`/`expires`：会话 Cookie 随浏览器会话存在，本地模式没有
 * "记住我多久"的需求，给一个过期时间只会制造一个需要解释的数字。
 */
export function sessionCookieAttributes(isProduction: boolean): SessionCookieAttributes {
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure: isProduction,
    path: '/',
  };
}
