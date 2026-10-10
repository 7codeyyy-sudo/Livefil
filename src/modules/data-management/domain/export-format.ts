/**
 * 导出文件格式（OPS-002，《接口文档》§13「格式版本」节——冻结契约为准据）。
 *
 * ## 版本与范围
 *
 * `formatVersion = 1`（八定值之一，终审 2026-10-09 生效）；导出范围＝FR-090
 * 字面七类：任务、目标、执行记录、习惯（例程）、开销、复盘、设置——**不含**
 * 行动/时间块/生活领域等契约外实体（SRS FR-090 的范围即契约范围，见
 * RD-015 披露：任务的 `actionId` 悬空引用在导入时置空）。
 *
 * 例程步骤随例程嵌套（`steps`）、复盘调整随复盘嵌套（`adjustments`）——
 * 它们是「习惯」「复盘」的子结构，单独成类会把 FR-090 的七类清单撑成九类。
 *
 * ## 为什么实体用宽松类型而不是逐字段 zod
 *
 * 导出是**原样往返**：字段清单随各表演进，逐字段固化会让每次加列都要求
 * 同步改导出 schema（漂移点）。因此实体形状定为 `{ id: string } & 未知键`，
 * 解析校验只锁**结构与主键**（契约「服务端解析校验」的底线）；写入侧由
 * 导入仓储按列白名单显式映射——未知键被丢弃、缺列由 DB 约束兜底（单事务
 * 失败全回滚，契约 replace/merge 语义本身包含回滚）。
 */
import { randomUUID } from 'node:crypto';

/** 当前格式版本（契约冻结值 v1）。 */
export const CURRENT_FORMAT_VERSION = 1;

/** 导出格式（契约 `format` 取值；CSV 随批＝开工回执裁定「实现」）。 */
export type ExportFormat = 'json' | 'csv';

/** 七类导出实体的键名（与文件顶层字段同名）。 */
export const EXPORT_ENTITY_KEYS = [
  'tasks',
  'goals',
  'executionLogs',
  'routines',
  'expenses',
  'reviews',
] as const;

export type ExportEntityKey = (typeof EXPORT_ENTITY_KEYS)[number];

/** 单条导出实体：`id` 必备，其余字段按各表原样携带（写入侧按白名单映射）。 */
export interface ExportEntity {
  readonly id: string;
  readonly [field: string]: unknown;
}

/** 例程（嵌套步骤）与复盘（嵌套调整）的聚合形状。 */
export interface ExportRoutine extends ExportEntity {
  readonly steps?: readonly ExportEntity[];
}

export interface ExportReview extends ExportEntity {
  readonly adjustments?: readonly ExportEntity[];
}

/** 设置导出面（FR-090「设置」＝偏好设置 + 展示名，不含任何凭据字段）。 */
export interface ExportSettings {
  readonly displayName: string | null;
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
}

/** 导出文件顶层形状（契约：顶层含 `formatVersion`、`exportedAt`、`userId`）。 */
export interface ExportFile {
  readonly formatVersion: number;
  readonly exportedAt: string;
  readonly userId: string;
  readonly tasks: readonly ExportEntity[];
  readonly goals: readonly ExportEntity[];
  readonly executionLogs: readonly ExportEntity[];
  readonly routines: readonly ExportRoutine[];
  readonly expenses: readonly ExportEntity[];
  readonly reviews: readonly ExportReview[];
  /** 缺失或非对象时为 null（解析不硬造设置；写入侧据此跳过设置面）。 */
  readonly settings: ExportSettings | null;
}

/**
 * 文件名（契约「双呈现」第一呈现位）：`livefil-export-v1-2026-10-09.json`。
 *
 * 日期取 `exportedAt` 的 UTC 日历日——文件名要跨时区可复现，本地时区会让
 * 同一次导出在不同机器上得到不同文件名。
 */
export function exportFileName(
  format: ExportFormat,
  formatVersion: number,
  exportedAtIso: string,
): string {
  const day = exportedAtIso.slice(0, 10);
  return `livefil-export-v${String(formatVersion)}-${day}.${format}`;
}

/** 兼容判定（契约「最小兼容声明」）：旧文件永远可导入，未来版本一律不兼容。 */
export function isCompatible(fileVersion: number): boolean {
  return fileVersion <= CURRENT_FORMAT_VERSION;
}

/**
 * CSV 列头（**实现级定值**，随交付提请追认——契约只定义 `format` 参数，
 * 未定义列结构；RD-015 §披露）。
 *
 * 设计口径：CSV 面向表格软件的人读场景（CSV 无导入面，FR-091 只收 JSON），
 * 故拆成「高频可读列 + `data` 列兜底全量」——前几列让人不点开就能扫，
 * `data` 列保每行原样 JSON，需要时可还原。
 */
export const CSV_HEADER = [
  'type',
  'id',
  'name',
  'status',
  'when',
  'amount',
  'currency',
  'createdAt',
  'data',
] as const;

/** RFC 4180 转义：含分隔符/引号/换行的字段加引号，内部引号翻倍。 */
function csvCell(value: string): string {
  if (/[",\r\n]/.test(value)) {
    return `"${value.replaceAll('"', '""')}"`;
  }
  return value;
}

function isoOf(value: unknown): string {
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (typeof value === 'string') {
    return value;
  }
  return '';
}

function csvRow(
  type: string,
  entity: ExportEntity | ExportSettings,
  name: string,
  status: string,
  when: string,
  amount: string,
  currency: string,
  createdAt: unknown,
): string {
  const cells = [
    type,
    'id' in entity ? entity.id : '',
    name,
    status,
    when,
    amount,
    currency,
    isoOf(createdAt),
    JSON.stringify(entity),
  ];
  return cells.map((cell) => csvCell(String(cell))).join(',');
}

/**
 * 导出文件 → CSV 文本。
 *
 * 每类型一行不现实（例程有步骤、复盘有调整），行粒度取**子结构拍平**：
 * 步骤/调整以 `type=routine_step|review_adjustment` 单独成行、父级 id 放进
 * `data`（其内含 `routineId`/`reviewId`）。设置行无业务 id，用导出用户 id 占位。
 */
export function renderExportCsv(file: ExportFile): string {
  const rows: string[] = [CSV_HEADER.join(',')];

  const base = (
    type: string,
    entity: ExportEntity,
    name: string,
    status: unknown,
    when: unknown,
    amount = '',
    currency = '',
  ): void => {
    rows.push(
      csvRow(
        type,
        entity,
        name,
        typeof status === 'string' ? status : '',
        isoOf(when),
        amount,
        currency,
        'createdAt' in entity ? entity.createdAt : '',
      ),
    );
  };

  for (const task of file.tasks) {
    base('task', task, String(task['title'] ?? ''), task['status'], task['dueDate']);
  }
  for (const goal of file.goals) {
    base('goal', goal, String(goal['name'] ?? ''), goal['status'], goal['targetDate']);
  }
  for (const log of file.executionLogs) {
    base('execution_log', log, String(log['note'] ?? ''), log['status'], log['occurredAt']);
  }
  for (const routine of file.routines) {
    base('routine', routine, String(routine['name'] ?? ''), '', routine['anchorTime']);
    for (const step of routine.steps ?? []) {
      base('routine_step', step, String(step['title'] ?? ''), '', '');
    }
  }
  for (const expense of file.expenses) {
    base(
      'expense',
      expense,
      String(expense['note'] ?? ''),
      '',
      expense['occurredOn'],
      String(expense['amountMinor'] ?? ''),
      String(expense['currencyCode'] ?? ''),
    );
  }
  for (const review of file.reviews) {
    const key = `${String(review['reviewType'] ?? '')}:${String(review['periodKey'] ?? '')}`;
    base('review', review, key, '', review['periodKey']);
    for (const adjustment of review.adjustments ?? []) {
      base(
        'review_adjustment',
        adjustment,
        String(adjustment['targetType'] ?? ''),
        adjustment['action'],
        '',
      );
    }
  }
  if (file.settings !== null) {
    rows.push(
      csvRow(
        'settings',
        { id: file.userId, ...file.settings },
        file.settings.displayName ?? '',
        '',
        '',
        '',
        '',
        file.exportedAt,
      ),
    );
  }

  // 统一换行（CRLF——RFC 4180 惯例，Excel 兼容最好）。
  return `${rows.join('\r\n')}\r\n`;
}

/** 生成导入预览/导出作业的 id（无外部依赖，等价于 uuid v4）。 */
export function newJobId(): string {
  return randomUUID();
}
