/**
 * 身份与生活领域的接口封装（IAM-002 / IAM-003）。
 *
 * ## 为什么单独一层
 *
 * 组件不该拼 URL、不该知道信封长什么样。把它们收在这里有两个直接好处：
 * 路径只在**一处**出现（拼错一个字符的表现是 404，而 404 与"数据不存在"在
 * 界面上长得几乎一样），以及返回类型可以被显式标注成模块的对外 DTO 类型。
 *
 * ## 为什么可以 import 模块的 DTO 类型
 *
 * 只 import `type`：编译期擦除，不进客户端包，不违反《依赖边界规则》
 * （`app` 允许引用 `src/modules/<模块>/application`）。反过来，如果 import 的是
 * DTO 的映射函数（`toUserDto`），那会把服务端代码拖进客户端图——所以这里只碰类型。
 */
import type { LifeAreaDto } from '@/modules/life-areas/application/life-area-dto.ts';
import type { UserDto } from '@/modules/identity/application/user-dto.ts';

import { fetchJson, sendJson } from './api-client';
import type { ApiEnvelope } from './api-client';

/**
 * 当前用户（`GET /me`）。
 *
 * `isEmpty` 恒为 `false`：`/me` 永远返回一个对象（本地模式下没有会话就自动建
 * 用户），因此**不存在"空"这一态**。取值不是"随便给一个"，而是如实表达
 * 「这个资源没有空态」，容器据此永远不会走到空分支。
 */
export const PROFILE_QUERY = {
  queryKey: ['me'],
  url: '/api/v1/me',
  isEmpty: () => false,
} as const;

/**
 * 生活领域（`GET /life-areas`）。
 *
 * `includeArchived=true` 是刻意的：设置页要能展示并恢复归档项，而那需要拿到
 * 归档项本身。若只在"展开已归档"时再发一次请求，展开动作就会有一次加载态闪烁。
 */
export const LIFE_AREAS_QUERY = {
  queryKey: ['life-areas', 'all'],
  url: '/api/v1/life-areas?includeArchived=true',
} as const;

/** `PATCH /me` 的请求体：设置字段 + 乐观并发版本。 */
export type ProfilePatch = Partial<{
  readonly locale: string;
  readonly timezone: string;
  readonly currencyCode: string;
  readonly weekStartsOn: number;
  readonly defaultTaskDurationMinutes: number | null;
  readonly defaultBufferMinutes: number | null;
  readonly aiEnabled: boolean;
  readonly aiDataConsent: boolean;
  readonly reminderEnabled: boolean;
  readonly quietHoursStart: string | null;
  readonly quietHoursEnd: string | null;
}> & { readonly version: number };

export function fetchProfile(signal: AbortSignal): Promise<ApiEnvelope<UserDto>> {
  return fetchJson<UserDto>(PROFILE_QUERY.url, signal);
}

/** `GET /life-areas` 的 `data` 形状（接口文档 §GET /life-areas）。 */
export interface LifeAreaListData {
  readonly items: readonly LifeAreaDto[];
}

export function fetchLifeAreas(signal: AbortSignal): Promise<ApiEnvelope<LifeAreaListData>> {
  return fetchJson<LifeAreaListData>(LIFE_AREAS_QUERY.url, signal);
}

export function updateProfile(patch: ProfilePatch): Promise<ApiEnvelope<UserDto>> {
  return sendJson<UserDto>('PATCH', PROFILE_QUERY.url, patch);
}

export interface CreateLifeAreaRequest {
  readonly name: string;
  readonly colorKey: string;
}

export function createLifeArea(input: CreateLifeAreaRequest): Promise<ApiEnvelope<LifeAreaDto>> {
  return sendJson<LifeAreaDto>('POST', '/api/v1/life-areas', input);
}

export type LifeAreaPatchRequest = Partial<{
  readonly name: string;
  readonly colorKey: string;
  readonly isArchived: boolean;
}>;

export function updateLifeArea(
  lifeAreaId: string,
  patch: LifeAreaPatchRequest,
): Promise<ApiEnvelope<LifeAreaDto>> {
  return sendJson<LifeAreaDto>('PATCH', `/api/v1/life-areas/${lifeAreaId}`, patch);
}

/**
 * 提交排序。
 *
 * 契约要求 `orderedIds` **恰好**是当前全部未归档领域（多、少、含他人 id 都会被
 * 服务端拒绝），所以调用方必须传完整的未归档 id 序列，而不是"把某一项移到某个
 * 位置"。这样做是为了让一次部分提交不可能制造出重复的 `sort_order`。
 */
export function reorderLifeAreas(
  orderedIds: readonly string[],
): Promise<ApiEnvelope<LifeAreaListData>> {
  return sendJson<LifeAreaListData>('POST', '/api/v1/life-areas/reorder', { orderedIds });
}
