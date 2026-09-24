/**
 * 写操作幂等编排（TASK-002，《接口文档》§1.1、§4；《数据库设计文档》§4.15）。
 *
 * ## 它在请求流程里的位置
 *
 * 路由处理器先解析请求体（要参与指纹），然后调用本模块：带 `Idempotency-Key`
 * 时先**占行**再执行业务，成功后落响应快照；重试请求重放首次结果（409
 * `IDEMPOTENCY_REPLAY`，不重复执行）。不带键的请求原样执行——接口文档的口径是
 * 「建议携带」，不强制。
 *
 * ## 为什么编排在 `app/_lib/`、端口却由这里定义
 *
 * 幂等没有自己的领域模块（它是跨 tasks/goals 的横切关注点），所以端口归**消费方**
 * （API 适配层）所有；Drizzle 实现在 `src/infrastructure/idempotency/`，两者在
 * 组合根做结构赋值对接——基础设施不必为了实现一个属于别人的接口而反向 import。
 *
 * ## 指纹为什么包含方法与路径
 *
 * 同一个客户端可能把同一个 key 生成器用在"创建任务"和"批量归档"两个请求上；
 * 只哈希请求体时这两者撞 key 会得到一条令人费解的 400。带上方法与路径后，
 * 同一个 key 只在「同一操作的重试」之间有意义——这正是幂等键的意图。
 */
import { createHash } from 'node:crypto';

import type { NextRequest } from 'next/server';

import { ConflictError, ValidationError } from '@/shared/errors/app-error.ts';

/**
 * 幂等存储端口（由组合根提供 Drizzle 实现）。
 *
 * 与 `src/infrastructure/idempotency/idempotency-store.drizzle.ts` 的具体类型
 * 结构兼容——对接发生在组合根，本文件不 import 基础设施。
 */
export interface IdempotencyStore {
  claim(
    userId: string,
    key: string,
    requestHash: string,
  ): Promise<
    | { readonly outcome: 'claimed' }
    | { readonly outcome: 'replay'; readonly snapshot: unknown }
    | { readonly outcome: 'in-progress' }
  >;
  complete(userId: string, key: string, snapshot: unknown): Promise<void>;
  /** 业务执行失败后释放占位（失败＝什么都没发生，同一个 key 必须可以重试）。 */
  release(userId: string, key: string): Promise<void>;
}

/** 执行结果：状态码与响应体（已是完整信封，原样快照/返回）。 */
export interface HandlerResult {
  readonly status: number;
  readonly body: unknown;
}

/** 键的长度上限（§4.15 `varchar(128)`）。 */
const IDEMPOTENCY_KEY_MAX_LENGTH = 128;

/**
 * 同步 push 的**保留前缀**（《接口文档》§12.1.1）。
 *
 * 批量 push 用 `key = "sync:" + operationId` 在同一张表上做**逐条**幂等。若普通写
 * 端点也能用这个前缀，一个客户端生成的普通键就可能撞进同步的键空间：撞上之后
 * 两条路径对"命中已完成记录"的处理完全相反（单请求 409 重放 vs 逐条 `already_applied`），
 * 故障现象会变得极难解释。所以这里直接拒绝该前缀。
 */
const SYNC_RESERVED_PREFIX = 'sync:';

/**
 * 在幂等保护下执行一个写操作。
 *
 * @param request 当前请求（取 `Idempotency-Key` 头与指纹用的方法/路径）。
 * @param userId 当前用户（幂等键按用户隔离：不同用户的同 key 互不相干）。
 * @param requestPayload 参与指纹的请求负载（通常是已解析的请求体；无体请求传 null）。
 * @param store 幂等存储（组合根注入）。
 * @param execute 真正的业务执行——只在「首次占位成功」时被调用一次。
 * @returns 首次执行返回其结果；重放返回 409 与 `IDEMPOTENCY_REPLAY` 错误信封。
 * @throws {ValidationError} key 超长时抛出。
 * @throws {ConflictError} 同 key 的请求仍在处理中时抛出（调用方稍后重试）。
 */
export async function withIdempotency(
  request: NextRequest,
  userId: string,
  requestPayload: unknown,
  store: IdempotencyStore,
  execute: () => Promise<HandlerResult>,
): Promise<HandlerResult> {
  const key = request.headers.get('Idempotency-Key');
  if (key === null || key === '') {
    return execute();
  }
  if (key.length > IDEMPOTENCY_KEY_MAX_LENGTH) {
    throw new ValidationError(
      `Idempotency-Key 不能超过 ${String(IDEMPOTENCY_KEY_MAX_LENGTH)} 个字符`,
    );
  }
  if (key.startsWith(SYNC_RESERVED_PREFIX)) {
    throw new ValidationError(`Idempotency-Key 不得使用保留前缀「${SYNC_RESERVED_PREFIX}」`);
  }

  // 指纹 = 方法 + 路径 + 请求负载。键相同而指纹不同的请求是客户端把同一个键
  // 用在了不同操作上——按 §4.15 返回 400，而不是悄悄执行第二次。
  const requestHash = createHash('sha256')
    .update(`${request.method} ${new URL(request.url).pathname}\n`)
    .update(JSON.stringify(requestPayload ?? null))
    .digest('hex');

  const claim = await store.claim(userId, key, requestHash);
  if (claim.outcome === 'replay') {
    // 重放：不重复执行。快照已随首次执行存入 `response_snapshot`，
    // 这里以 409 + 冻结错误码明确告知"已处理"。
    return {
      status: 409,
      body: {
        error: { code: 'IDEMPOTENCY_REPLAY', message: '该操作已经处理过' },
      },
    };
  }
  if (claim.outcome === 'in-progress') {
    throw new ConflictError('相同的请求正在处理中，请稍后重试');
  }

  let result: HandlerResult;
  try {
    result = await execute();
  } catch (error) {
    // 失败必须释放占位，否则这行 processing 会把同一 key 的所有重试
    // 永久挡成 409 冲突。释放自身失败（只能是 DB 故障）不掩盖原始错误。
    await store.release(userId, key).catch(() => {});
    throw error;
  }
  await store.complete(userId, key, result.body);
  return result;
}
