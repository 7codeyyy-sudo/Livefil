/**
 * `/today` 的时区边界降级（缺陷修复）。
 *
 * ## 为什么要降级，而不是直接拒绝
 *
 * `GET /today` 的 `timezone` 来自**客户端浏览器**（`Intl.DateTimeFormat
 * .resolvedOptions().timeZone`）。主流浏览器给的是 IANA 名，但部分内核
 * （如 UC/夸克）会给出 `GMT+08:00` 这类偏移串或其它的非 IANA 写法。这类值
 * 过不了 `Intl` 的构造，而 `buildTodayView` 里的 `zonedToUtc` 约定
 * 「timeZone 须已过 `assertTimeZone`」——少了这一步校验，裸 `RangeError`
 * 会一路冒到路由层变成 500，用户看到的是「数据没能取回来」。
 *
 * 客户端值只是**提示**，不是权威：权威是用户档案里的时区设置（IAM-002）。
 * 因此顺序是「客户端值合法则用它 → 否则回落档案 → 再不行才 `UTC`」。
 * **刻意不直接回落 `UTC`**：UTC 与用户所在时区相差数小时，会把「今天」的
 * 窗口整体切错一天，那是静默错数据，比报错更难被发现。
 *
 * ## 为什么不改 `today-view.ts`
 *
 * `buildTodayView` 的依赖对象由集成测试直接构造，给它加必填依赖会打破那些
 * 测试。把解析留在路由层，用例本身保持原样；而且「客户端给的值能不能用」
 * 本就是边界（HTTP 输入 → 用例输入）该管的事。
 */
import { assertTimeZone } from '../domain/zoned-time.ts';

/** 所有候选都非法时的最终兜底。 */
const FALLBACK_TIME_ZONE = 'UTC';

/**
 * 解析 `/today` 实际使用的时区。
 *
 * @param candidate 客户端给出的时区（`timezone` 查询参数）。
 * @param loadProfileTimeZone 仅在客户端值非法时才会调用的档案读取。
 */
export async function resolveTodayTimeZone(
  candidate: string,
  loadProfileTimeZone: () => Promise<string | null>,
): Promise<string> {
  const fromClient = tryTimeZone(candidate);
  if (fromClient !== null) {
    return fromClient;
  }
  return tryTimeZone(await loadProfileTimeZone()) ?? FALLBACK_TIME_ZONE;
}

/** 合法则原样返回；非法（`Intl` 抛 `RangeError` 被 `assertTimeZone` 转成 `ValidationError`）返回 `null`。 */
function tryTimeZone(value: string | null): string | null {
  if (value === null) {
    return null;
  }
  try {
    return assertTimeZone(value);
  } catch {
    return null;
  }
}
