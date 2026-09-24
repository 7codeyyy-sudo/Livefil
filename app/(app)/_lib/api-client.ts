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
 * @throws {ApiRequestError} 非 2xx、响应不是合法 JSON、或信封结构不符时。
 */
export async function fetchJson<T>(path: string, signal: AbortSignal): Promise<ApiEnvelope<T>> {
  const response = await fetch(path, {
    signal: AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT)]),
    headers: { accept: 'application/json' },
  });

  return readEnvelope<T>(response);
}

/** 写操作的方法（本批用到的那四个；PUT 用于恢复模式单行 upsert）。 */
export type MutationMethod = 'POST' | 'PATCH' | 'DELETE' | 'PUT';

/**
 * 一条没能送达的本地写操作（SYNC-003，《UI 页面规范》v0.20 §4.9.1 的时机 ④）。
 *
 * 字段与 `pending_operations` 的一条记录同源：本客户端只负责说清「用户刚才想改
 * 什么」，是否入队、怎么推送由同步层决定。
 */
export interface SyncWriteDescriptor {
  /** 契约里的单数 snake_case 类型名（`task` / `schedule_block` …）。 */
  readonly entityType: string;
  readonly entityId: string;
  readonly operationType: 'create' | 'update' | 'delete';
  /** 期望的服务端版本（CAS 依据）；请求体里没有 `version` 时为 `null`。 */
  readonly baseVersion: number | null;
  /** 待写入的实体字段。 */
  readonly payload: Readonly<Record<string, unknown>>;
}

/**
 * 本地写操作的接收方（由 `sync-runtime` 接线）。
 *
 * 端口定义在**消费方**这里而不是同步模块里，理由与 `app/_lib/idempotency.ts`
 * 相同：本文件不该为了一个回调去依赖模块内部，接线发生在调用方。
 */
export type SyncWriteSink = (descriptor: SyncWriteDescriptor) => Promise<void>;

let syncWriteSink: SyncWriteSink | null = null;

/**
 * 接线本地写操作的接收方；传 `null` 卸载。
 *
 * 未接线时本模块的行为与 SYNC-003 之前**逐字节一致**（失败照常抛出，什么都不记）。
 */
export function setSyncWriteSink(sink: SyncWriteSink | null): void {
  syncWriteSink = sink;
}

/**
 * 发一次写请求并返回信封（IAM-002 / IAM-003 的设置与领域保存）。
 *
 * ## 为什么**没有** `signal` 参数
 *
 * 读请求会随组件卸载而作废（`useAsyncQuery` 的 AbortController），写请求不会：
 * 「保存」一旦发出去，用户离开页面并不改变它该完成这个事实——中止它反而会留下
 * 一个「不知道有没有保存成功」的状态。所以写请求只用超时兜住真正的挂起。
 *
 * ## 为什么错误要带上状态码
 *
 * `PATCH /me` 的 409 是**乐观并发冲突**，它不是"保存失败"，而是"你手上的版本
 * 已经过时了"，界面需要给出不同的处置（提示重新加载而不是让用户再点一次）。
 * 只给一句 message 的话，调用方只能靠比对文案来分辨，那是注定会漂移的。
 *
 * @throws {ApiRequestError} 非 2xx、响应不是合法 JSON、或信封结构不符时。
 * @throws {Error} 请求根本没送出去时（网络中断、超时、被中止）——此时原始错误
 *   原样抛出，另外**尽力**把这条编辑交给同步层入队（见 `enqueueFailedWrite`）。
 */
export async function sendJson<T>(
  method: MutationMethod,
  path: string,
  body?: unknown,
  options?: { readonly headers?: Readonly<Record<string, string>> },
): Promise<ApiEnvelope<T>> {
  const hasBody = body !== undefined;
  const extraHeaders = options?.headers ?? {};

  let response: Response;
  try {
    response = await fetch(path, {
      method,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT),
      headers: {
        accept: 'application/json',
        ...(hasBody ? { 'content-type': 'application/json' } : {}),
        ...extraHeaders,
      },
      ...(hasBody ? { body: JSON.stringify(body) } : {}),
    });
  } catch (error) {
    // 请求**没有到达服务端**（网络中断 / 超时 / 传输层错误）：服务端没有给出任何
    // 结论，这条编辑只存在于本地。交给同步层入队，否则用户的改动就此消失。
    //
    // 判据是"抛出的不是 `ApiRequestError`"：一旦拿到了任何 HTTP 响应（含 4xx/5xx），
    // 服务端已经明确答复，界面会以错误态呈现、用户可自行重试。此时再入队会把一条
    // 已知被拒的操作塞进队列，且与 §4.9.1 状态 4 的触发条件（**推送**请求本身失败）
    // 不是一回事。
    await enqueueFailedWrite(method, path, body);
    throw error;
  }

  return readEnvelope<T>(response);
}

/**
 * 尽力把一条送不出去的写请求交给同步层。
 *
 * 同步层未接线、路径不在可同步集合内、或入队本身失败（隐私模式、配额耗尽）时
 * 都静默跳过：这几种情况的共同点是"原始错误才是调用方要看到的那一个"，
 * 在这里抛出的任何东西都会把真正的原因盖掉。
 */
async function enqueueFailedWrite(
  method: MutationMethod,
  path: string,
  body: unknown,
): Promise<void> {
  const sink = syncWriteSink;
  if (sink === null) {
    return;
  }

  const descriptor = describeFailedWrite(method, path, body);
  if (descriptor === null) {
    return;
  }

  try {
    await sink(descriptor);
  } catch {
    // 见函数说明：入队失败不改变"这次请求失败了"这个事实。
  }
}

/**
 * 写端点集合 → 同步实体类型（snake_case 单数，与《接口文档》§12 同口径）。
 *
 * 刻意是一张**白名单**而不是从路径反推类型名：路径里的 `schedule-blocks` 与
 * 实体类型 `schedule_block` 之间没有机械的转换规则，猜错的后果是把操作记到
 * 一个服务端不认识的类型上（逐条 `rejected`）。同时白名单天然把
 * `/api/v1/sync/**`（push / resolve 自己）排除在外——同步层的请求绝不该被
 * 自己再入队一遍。
 */
const SYNC_ENTITY_BY_COLLECTION: Readonly<Record<string, string>> = {
  tasks: 'task',
  goals: 'goal',
  actions: 'action',
  routines: 'routine',
  'schedule-blocks': 'schedule_block',
  'fixed-commitments': 'fixed_commitment',
  'life-areas': 'life_area',
};

/** 可入队的路径形态：`/api/v1/<集合>/<实体 uuid>`，且**没有**更深的子路径。 */
const ENTITY_WRITE_PATH =
  /^\/api\/v1\/([^/]+)\/([0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12})$/;

/**
 * 方法 → 操作类型。
 *
 * 只有「改一个已存在的实体」与「删一个已存在的实体」两种形态可入队：
 * `POST` 大多是创建或子资源动作（`/tasks/{id}/archive`、`/tasks/batch`），
 * 它要成功才拿得到新 id、失败则没有可入队的实体——本批不猜。
 */
const OPERATION_BY_METHOD: Readonly<Record<string, 'update' | 'delete'>> = {
  PATCH: 'update',
  PUT: 'update',
  DELETE: 'delete',
};

/** 一次失败的写请求 → 同步描述；形态不可入队时返回 `null`。 */
function describeFailedWrite(
  method: MutationMethod,
  path: string,
  body: unknown,
): SyncWriteDescriptor | null {
  const operationType = OPERATION_BY_METHOD[method];
  if (operationType === undefined) {
    return null;
  }

  const matched = ENTITY_WRITE_PATH.exec(path);
  if (matched === null) {
    return null;
  }
  const [, collection, entityId] = matched;
  if (collection === undefined || entityId === undefined) {
    return null;
  }

  const entityType = SYNC_ENTITY_BY_COLLECTION[collection];
  if (entityType === undefined) {
    return null;
  }

  if (operationType === 'delete') {
    // `DELETE` 没有请求体（本项目的删除端点都不带 body），因此既没有版本可做
    // CAS，也没有字段可写；实体本身由服务端按 id 找到。
    return { entityType, entityId, operationType, baseVersion: null, payload: {} };
  }

  const fields = isRecord(body) ? body : {};
  const { version, ...payload } = fields;
  return {
    entityType,
    entityId,
    operationType,
    baseVersion: typeof version === 'number' ? version : null,
    payload,
  };
}

/** 是否为可逐键读取的普通对象（数组与 `null` 都不算）。 */
function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * 请求失败。
 *
 * `status` 用来区分「可以再试一次」与「必须先解决某个状态」（409 冲突、
 * 422 校验失败）。没有它的话，界面只能对所有失败一视同仁地提示"保存失败"，
 * 而用户按提示重试一百次也不会成功。
 */
export class ApiRequestError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'ApiRequestError';
    this.status = status;
  }
}

/** 把一个响应读成信封；失败一律转成 `ApiRequestError`。 */
async function readEnvelope<T>(response: Response): Promise<ApiEnvelope<T>> {
  if (!response.ok) {
    throw new ApiRequestError(await readFailureMessage(response), response.status);
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    // 2xx 但不是 JSON：这是契约违约，不是"接口没数据"。混作一谈会让一个坏掉的
    // 端点看起来像"这里什么都没有"。
    throw new ApiRequestError('服务端响应不是合法的 JSON', response.status);
  }

  if (!isEnvelope(body)) {
    throw new ApiRequestError('服务端响应格式不符合约定', response.status);
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
