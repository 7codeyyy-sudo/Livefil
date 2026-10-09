/**
 * data-management 请求 schema 与导出文件解析（OPS-002，《接口文档》§13）。
 *
 * 端点入参走 zod（接口 §14「所有外部输入使用 schema 校验」）；导出文件的解析
 * 单独成段——它是「文件原文」这种非典型输入，校验深度的取舍见
 * `parseExportFile` 的文件头注释。
 */
import { z } from 'zod';

import { ValidationError } from '@/shared/errors/app-error.ts';

import {
  CURRENT_FORMAT_VERSION,
  type ExportEntity,
  type ExportFile,
  type ExportRoutine,
  type ExportReview,
  type ExportSettings,
} from '../domain/export-format.ts';
import { RECYCLE_ENTITY_TYPES, type RecycleEntityType } from '../domain/data-ports.ts';
import { RECYCLE_PAGE_MAX, RECYCLE_PAGE_DEFAULT } from '../domain/limits.ts';

/**
 * 回收区保留天数（应用层转发位）：`app/**` 不得引用模块领域层（依赖规则），
 * 路由从这里取契约冻结值——领域仍是唯一定义源，转发只是过层。
 */
export { RETENTION_DAYS } from '../domain/limits.ts';

/** `POST /data-exports` 请求体（契约：`format` 缺省 json）。 */
export const exportRequestSchema = z.object({
  format: z.enum(['json', 'csv']).optional(),
});

/** `POST /data-imports/preview` 请求体（契约：`{ file }`＝导出文件原文）。 */
export const previewRequestSchema = z.object({
  // 上限防内存滥用：导出面是 5–20 用户规模，超大文件只可能来自异常客户端。
  file: z
    .string()
    .min(1, '导入文件为空')
    .max(64 * 1024 * 1024, '导入文件过大'),
});

/** `POST /data-imports/{importId}/confirm` 请求体（契约：replace 必带 confirm）。 */
export const confirmImportSchema = z
  .object({
    mode: z.enum(['merge', 'replace']),
    confirm: z.boolean().optional(),
  })
  .refine((value) => value.mode !== 'replace' || value.confirm === true, {
    message: '覆盖导入必须携带 confirm: true（服务端级二次确认）',
    path: ['confirm'],
  });

/** `GET /recycle-items` 查询（单页上限＝八定值 100）。 */
export const recycleListQuerySchema = z.object({
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(RECYCLE_PAGE_MAX)
    .optional()
    .default(RECYCLE_PAGE_DEFAULT),
});

/** 路径段 entityType（非法值 400，不进仓储）。 */
export const entityTypeSchema = z.enum(
  RECYCLE_ENTITY_TYPES as [RecycleEntityType, ...RecycleEntityType[]],
);

/* ---------------- 导出文件解析 ---------------- */

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 结构层校验深度：锁「对象 + 数组 + 合法 id」，字段清单不固化（见模块头注释）。 */
function parseEntityList(raw: unknown, key: string): readonly ExportEntity[] {
  if (raw === undefined || raw === null) {
    return [];
  }
  if (!Array.isArray(raw)) {
    throw new ValidationError(`导入文件的 ${key} 不是数组`);
  }
  return raw.map((item, index) => parseEntity(item, `${key}[${String(index)}]`));
}

function parseEntity(raw: unknown, where: string): ExportEntity {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new ValidationError(`导入文件的 ${where} 不是对象`);
  }
  const record = raw as Record<string, unknown>;
  const id = record['id'];
  if (typeof id !== 'string' || !UUID_PATTERN.test(id)) {
    throw new ValidationError(`导入文件的 ${where} 缺少合法 id（应为 UUID）`);
  }
  return record as ExportEntity;
}

function parseRoutine(raw: unknown, where: string): ExportRoutine {
  const entity = parseEntity(raw, where);
  const steps = (entity as { steps?: unknown }).steps;
  if (steps === undefined || steps === null) {
    return entity;
  }
  if (!Array.isArray(steps)) {
    throw new ValidationError(`导入文件的 ${where}.steps 不是数组`);
  }
  return {
    ...entity,
    steps: steps.map((step, index) => parseEntity(step, `${where}.steps[${String(index)}]`)),
  } as ExportRoutine;
}

function parseReview(raw: unknown, where: string): ExportReview {
  const entity = parseEntity(raw, where);
  const adjustments = (entity as { adjustments?: unknown }).adjustments;
  if (adjustments === undefined || adjustments === null) {
    return entity;
  }
  if (!Array.isArray(adjustments)) {
    throw new ValidationError(`导入文件的 ${where}.adjustments 不是数组`);
  }
  return {
    ...entity,
    adjustments: adjustments.map((item, index) =>
      parseEntity(item, `${where}.adjustments[${String(index)}]`),
    ),
  } as ExportReview;
}

const SETTINGS_FIELDS = [
  'displayName',
  'locale',
  'timezone',
  'currencyCode',
  'weekStartsOn',
  'defaultTaskDurationMinutes',
  'defaultBufferMinutes',
  'aiEnabled',
  'aiDataConsent',
  'reminderEnabled',
  'quietHoursStart',
  'quietHoursEnd',
] as const;

function parseSettings(raw: unknown): ExportSettings | null {
  if (raw === undefined || raw === null) {
    return null;
  }
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ValidationError('导入文件的 settings 不是对象');
  }
  // 只挑已知键、只收同型值：导出侧永远写全，缺键/异型来自被改写的文件——
  // 静默丢弃比猜默认值诚实（导入不会替文件「补齐」它没说的东西）。
  const source = raw as Record<string, unknown>;
  const picked: Record<string, unknown> = {};
  for (const field of SETTINGS_FIELDS) {
    const value = source[field];
    if (value === undefined) {
      continue;
    }
    const expected =
      field === 'displayName' || field === 'quietHoursStart' || field === 'quietHoursEnd'
        ? 'nullable-string'
        : field === 'locale' || field === 'timezone' || field === 'currencyCode'
          ? 'string'
          : field === 'weekStartsOn' ||
              field === 'defaultTaskDurationMinutes' ||
              field === 'defaultBufferMinutes'
            ? 'number'
            : 'boolean';
    const ok =
      (expected === 'nullable-string' && (typeof value === 'string' || value === null)) ||
      (expected === 'string' && typeof value === 'string') ||
      (expected === 'number' && typeof value === 'number') ||
      (expected === 'boolean' && typeof value === 'boolean');
    if (ok) {
      picked[field] = value;
    }
  }
  return picked as unknown as ExportSettings;
}

/**
 * 解析导出文件（preview 的「服务端解析校验、零写入」）。
 *
 * 解析深度＝结构与主键（对象/数组/UUID），不逐字段核对——字段级错误在
 * confirm 的单事务里由 DB 约束兜底并整笔回滚（契约 replace/merge 自带
 * 回滚语义，UI 失败文案承接）。这样「预览快、确认稳」两段各司其职，
 * 且导出 schema 不必与七张表逐列同步（避免双份清单漂移）。
 *
 * @throws {ValidationError} 结构不合法（400，消息指向具体位置）。
 */
export function parseExportFile(raw: string): ExportFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ValidationError('导入文件不是合法的 JSON');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new ValidationError('导入文件不是 JSON 对象');
  }
  const source = parsed as Record<string, unknown>;

  const formatVersion = source['formatVersion'];
  if (typeof formatVersion !== 'number' || !Number.isInteger(formatVersion) || formatVersion < 1) {
    throw new ValidationError('导入文件缺少格式版本（formatVersion）');
  }
  const exportedAt = source['exportedAt'];
  if (typeof exportedAt !== 'string' || exportedAt === '') {
    throw new ValidationError('导入文件缺少导出时间（exportedAt）');
  }
  const userId = source['userId'];
  if (typeof userId !== 'string' || userId === '') {
    throw new ValidationError('导入文件缺少导出用户（userId）');
  }

  const tasks = parseEntityList(source['tasks'], 'tasks');
  const goals = parseEntityList(source['goals'], 'goals');
  const executionLogs = parseEntityList(source['executionLogs'], 'executionLogs');
  const expenses = parseEntityList(source['expenses'], 'expenses');
  const routines = parseEntityList(source['routines'], 'routines').map((item, index) =>
    parseRoutine(item, `routines[${String(index)}]`),
  );
  const reviews = parseEntityList(source['reviews'], 'reviews').map((item, index) =>
    parseReview(item, `reviews[${String(index)}]`),
  );

  return {
    formatVersion,
    exportedAt,
    userId,
    tasks,
    goals,
    executionLogs,
    routines,
    expenses,
    reviews,
    settings: parseSettings(source['settings']),
  };
}

/** 兼容判定（契约：`formatVersion > 当前` ⇒ preview `compatible=false`）。 */
export function fileCompatibility(file: ExportFile): boolean {
  return file.formatVersion <= CURRENT_FORMAT_VERSION;
}
