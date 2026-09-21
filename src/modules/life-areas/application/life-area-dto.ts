/**
 * 生活领域的对外 DTO 与请求校验（IAM-003，《接口文档》§3）。
 *
 * DTO 与校验放同一个文件：两者描述的是同一个边界（HTTP 出入参），分开会让人
 * 在改字段时只改一半——尤其"新增字段要同时加校验与映射"这种事，放在一起最不容易漏。
 */
import { z } from 'zod';

import {
  LIFE_AREA_COLOR_KEYS,
  LIFE_AREA_NAME_MAX_LENGTH,
  type LifeArea,
} from '../domain/life-area.ts';

/** `GET/POST/PATCH /life-areas` 响应中的单项。 */
export interface LifeAreaDto {
  readonly id: string;
  readonly name: string;
  readonly colorKey: string;
  readonly sortOrder: number;
  readonly isDefault: boolean;
  readonly isArchived: boolean;
  readonly version: number;
}

export function toLifeAreaDto(lifeArea: LifeArea): LifeAreaDto {
  return {
    id: lifeArea.id,
    name: lifeArea.name,
    colorKey: lifeArea.colorKey,
    sortOrder: lifeArea.sortOrder,
    isDefault: lifeArea.isDefault,
    isArchived: lifeArea.isArchived,
    version: lifeArea.version,
  };
}

/** 名称：去掉首尾空白后校验长度。 */
const lifeAreaName = z
  .string()
  .transform((value) => value.trim())
  .refine((value) => value.length > 0, { message: '名称不能为空' })
  .refine((value) => value.length <= LIFE_AREA_NAME_MAX_LENGTH, {
    message: `名称不能超过 ${String(LIFE_AREA_NAME_MAX_LENGTH)} 个字符`,
  });

/** 语义色 key：合法集合与 UI 规范 §2.1 的分类色族一一对应。 */
const lifeAreaColorKey = z.enum(LIFE_AREA_COLOR_KEYS);

export const createLifeAreaSchema = z
  .object({
    name: lifeAreaName,
    // 缺省取 blue（《接口文档》§POST /life-areas：「缺省取 blue」）。
    colorKey: lifeAreaColorKey.default('blue'),
  })
  .strict();

export const updateLifeAreaSchema = z
  .object({
    name: lifeAreaName.optional(),
    colorKey: lifeAreaColorKey.optional(),
    isArchived: z.boolean().optional(),
  })
  .strict()
  // 空补丁会被当成"成功但什么都没改"，用户以为保存了。明确拒绝。
  .refine((value) => Object.keys(value).length > 0, { message: '至少需要提供一个要修改的字段' });

export const reorderLifeAreasSchema = z
  .object({
    orderedIds: z.array(z.string().min(1)).min(1),
  })
  .strict();

export type CreateLifeAreaRequest = z.infer<typeof createLifeAreaSchema>;
export type UpdateLifeAreaRequest = z.infer<typeof updateLifeAreaSchema>;
export type ReorderLifeAreasRequest = z.infer<typeof reorderLifeAreasSchema>;
