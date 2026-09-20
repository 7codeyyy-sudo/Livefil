/**
 * 页面取数用的最小 API 客户端（UI-004，《UI 页面规范》v0.14 §4.7）。
 *
 * 只做三件事：发请求、按《接口文档》§1.2/§1.3 的信封取 `data`、把失败
 * 归一成带 `message` 的 `Error`。**刻意不做**：
 *
 * - **不重试**——§4.7 明确不自动重试，重试是用户在错误态按下的那个按钮；
 * - **不缓存**——缓存属 Phase 3 的数据场景（§4.7 同条）；
 * - **不带凭证与自定义头**——本地模式无需授权头（§1.1），云端模式随 IAM-001。
 *
 * ## 超时是唯一的例外
 *
 * 《详细设计说明书》§6.2 要求「所有网络调用必须有超时」，而 §4.7 只说
 * 「不自动重试」。两者不冲突：超时是**失败的上界**，重试是**失败后的动作**。
 * 没有超时的话，一个挂住的连接会让页面永远停在骨架态——用户既看不到错误，
 * 也没有可点的重试按钮。
 *
 * 实现用 `AbortSignal.any` 把「调用方的 signal」与「超时」合成一个：这样
 * 卸载仍能立即中止请求，而超时中止**不会**被取数原语误判为「这次请求作废」
 * （它看的是调用方那个 signal，超时不改变它）——超时应当、也确实会落到错误态。
 */

/**
 * 单次请求的超时上界（毫秒）。
 *
 * 列表类查询不该让用户等更久；AI 那类长请求（NFR-PERF-005 允许更长的上限）
 * 不走本客户端。取值先集中在这里，等出现第二类调用再按用途分档——为还没
 * 出现的第二档预先造一张表，只会得到一个没人验证的默认值。
 */
const REQUEST_TIMEOUT = 10_000;

/**
 * 《接口文档》§1.2 的成功响应信封（§1.3 的分页响应同构，多了游标字段）。
 *
 * `meta` 里的 `requestId`/`serverTime`/`nextCursor`/`hasMore` 本批用不到，
 * 但**照合同保留整个信封**而不是只取 `data`：UI-005 的分页要读游标，
 * 届时若这里已经把 meta 丢掉，就得回头改每一个调用点。
 */
export type ApiEnvelope<T> = {
  readonly data: T;
  readonly meta?: Readonly<Record<string, unknown>> | undefined;
};

/**
 * 取一个 JSON 端点并返回信封。
 *
 * @param path 版本化路径（如 `/api/v1/tasks`）。同源相对路径，无需拼 base URL。
 * @param signal 调用方的中止信号，来自 `useAsyncQuery`。
 */
export async function fetchJson<T>(path: string, signal: AbortSignal): Promise<ApiEnvelope<T>> {
  const response = await fetch(path, {
    signal: AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT)]),
    headers: { accept: 'application/json' },
  });

  if (!response.ok) {
    throw new Error(await readFailureMessage(response));
  }

  const body: unknown = await response.json();

  if (!isEnvelope(body)) {
    // 响应形状不对属于**契约违约**，不能当成空数据悄悄放过：那会让一个坏掉的
    // 端点看起来像「这里什么都没有」，而这正是最难排查的一类问题。
    throw new Error('服务端响应格式不符合约定');
  }

  return body as ApiEnvelope<T>;
}

/**
 * 从失败响应里取一句能给人看的话。
 *
 * 《接口文档》§1.4 保证所有失败都是 `{ error: { code, message, requestId } }`，
 * 而 `app/api/v1/[[...slug]]/route.ts` 的兜底确保了连 404 也走这个结构。
 * 但仍要防两种意外：反代返回的 HTML 错误页、以及未来某个端点漏走统一转换。
 */
async function readFailureMessage(response: Response): Promise<string> {
  try {
    const body: unknown = await response.json();
    const message = readErrorMessage(body);
    if (message !== null) {
      return message;
    }
  } catch {
    // 解析失败只说明「错误体不是约定的 JSON」，不影响下面那句兜底文案。
  }

  return `请求失败（${String(response.status)}）`;
}

/** 从 `{ error: { message } }` 里取 message；形状不符时返回 `null`。 */
function readErrorMessage(body: unknown): string | null {
  if (typeof body !== 'object' || body === null || !('error' in body)) {
    return null;
  }

  const { error } = body;
  if (typeof error !== 'object' || error === null || !('message' in error)) {
    return null;
  }

  const { message } = error;
  return typeof message === 'string' ? message : null;
}

/**
 * 判断是否为信封结构。
 *
 * 只校验最外那一层：实体级校验需要一份完整的响应 schema，而《接口文档》
 * 目前给的是字段示例而不是 schema。**记债**：实体级校验随 Phase 3 的
 * 模块应用层一并建立（那里才会有领域模型可对照），本批不做半套。
 */
function isEnvelope(body: unknown): body is ApiEnvelope<unknown> {
  return typeof body === 'object' && body !== null && 'data' in body;
}
