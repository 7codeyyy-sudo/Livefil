import { redirect } from 'next/navigation';

/**
 * 站点根路径 `/`：重定向到今日页（UI-003，规范 v0.12 §3.2）。
 *
 * ## 为什么这个文件还在，而不是把首页搬进 `(app)`
 *
 * 同一路径只能有一个 `page.tsx`——`app/page.tsx` 与 `app/(app)/page.tsx`
 * 都解析到 `/`，同时存在会让构建直接失败。而 `/` 又必须重定向到 `/today`
 * （v0.12 冻结），所以它留在这里作存根。
 *
 * ## 它与 FND-001 验收的关系（这条不能省）
 *
 * `fnd-001-acceptance` 断言：`/` 返回 **200**，且响应体匹配 **`Livefil`**
 * （**大小写敏感**）。而 `fetch` **默认跟随重定向**，所以实际被断言的是
 * `/today` 的 HTML。它之所以仍然通过，是因为外壳的品牌区渲染的是
 * `clientEnv.appName`（取值 `Livefil`），而不是原型里那个小写的品牌字样。
 *
 * 换言之：把品牌文字写成小写、或改掉重定向目标，都会让 FND-001 变红。
 *
 * ## 为什么用 `redirect` 而不是 `permanentRedirect`
 *
 * `/` 指向今日页是**产品决定**，不是协议级的永久事实。307 让将来改判
 * 不必与浏览器缓存的 308 对抗。
 */
export default function RootPage() {
  redirect('/today');
}
