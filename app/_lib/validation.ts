/**
 * 端点层的输入校验助手（IAM-002 / IAM-003）。
 *
 * 放在 `app/_lib/` 而不是 `src/shared/`：它们依赖 `next/server` 的请求对象，
 * 而 `src/shared/` 保持框架中立（与 `api-route.ts` 同一个理由）。
 */
import type { NextRequest } from 'next/server';
import type { z } from 'zod';

import { ValidationError } from '@/shared/errors/app-error.ts';

/**
 * 读取并解析 JSON 请求体。
 *
 * 空体、截断的 JSON、非 JSON 的 content-type 都会走到 `request.json()` 的拒绝路径。
 * 统一转成 `VALIDATION_ERROR`（400）而不是让它变成 500：这是**客户端的输入问题**，
 * 报 500 会把一个可修复的调用错误伪装成服务故障。
 */
export async function readJsonBody(request: NextRequest): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    throw new ValidationError('请求体不是合法的 JSON');
  }
}

/**
 * 把 Zod 校验问题转成 `error.fields`（《接口文档》§1.4 的字段级错误）。
 *
 * 每个字段只保留**第一条**消息：同一个字段同时触发"类型不对"与"取值越界"时，
 * 罗列全部只会让使用者看到一串互相矛盾的提示，而修好第一条后第二条往往自动消失。
 */
export function toFieldErrors(error: z.ZodError): Record<string, string> {
  const fields: Record<string, string> = {};

  for (const issue of error.issues) {
    const key = issue.path.length === 0 ? '_' : issue.path.join('.');
    fields[key] ??= issue.message;
  }

  return fields;
}

/**
 * 用 Zod schema 校验请求体，失败即抛 `ValidationError`。
 *
 * @throws {ValidationError} 校验失败时抛出，`fields` 为字段级原因。
 */
export function parseOrThrow<TSchema extends z.ZodType>(
  schema: TSchema,
  value: unknown,
): z.infer<TSchema> {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new ValidationError('请求内容不合法', { fields: toFieldErrors(result.error) });
  }
  return result.data;
}
