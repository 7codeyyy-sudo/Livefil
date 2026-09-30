/**
 * 提醒与通知的接口封装与面板视图模型（NOTIFY-001 / NOTIFY-002，接口文档 §16）。
 *
 * 与 `review-api.ts` / `expense-api.ts` 同款分层：组件不拼 URL、不读信封。
 * §16 的三个列表端点的 `data` 都是**裸数组**（不是 §1.3 的分页对象）。
 *
 * ## 枚举为什么在这里重新声明，而不是 import 模块常量
 *
 * `app/**` 允许引用 `src/modules/<模块>/application`（且只在此层做类型引用），
 * 但**不得访问模块的 domain / infrastructure**。等级、目标类型、错误码这些常量
 * 住在 `src/modules/notifications/domain/`，所以客户端侧照抄一份——这也让它们
 * 成为「契约的客户端镜像」，与 DTO 的字段子集同源。
 */
import { fetchJson, sendJson } from './api-client';
import type { ApiEnvelope } from './api-client';

/** 三级通知等级（§16：服务端按 `targetType` 派生、只读）。 */
export const NOTIFICATION_LEVELS = ['critical', 'normal', 'review'] as const;

export type NotificationLevel = (typeof NOTIFICATION_LEVELS)[number];

/** 等级呈现名（UI v0.23 C 节映射表）。 */
export const NOTIFICATION_LEVEL_LABELS: Readonly<Record<NotificationLevel, string>> = {
  critical: '关键',
  normal: '普通',
  review: '复盘',
};

/** 提醒对象类型（§16 `targetType` 三值）。 */
export const NOTIFICATION_TARGET_TYPES = ['task', 'routine', 'review'] as const;

export type NotificationTargetType = (typeof NOTIFICATION_TARGET_TYPES)[number];

/**
 * 对象类别名。
 *
 * §16 `GET /notifications/pending` 的冻结 payload **不携带对象名**（只有
 * `targetType` / `targetId`），所以这里是名称解析失败时的兜底标题——见
 * `resolveTargetName` 的说明。
 */
export const NOTIFICATION_TARGET_LABELS: Readonly<Record<NotificationTargetType, string>> = {
  task: '任务',
  routine: '例程',
  review: '复盘',
};

/** 重复规则（§16 创建体）。 */
export const NOTIFICATION_REPEAT_RULES = ['none', 'daily', 'weekly'] as const;

export type NotificationRepeatRule = (typeof NOTIFICATION_REPEAT_RULES)[number];

export const NOTIFICATION_REPEAT_LABELS: Readonly<Record<NotificationRepeatRule, string>> = {
  none: '不重复',
  daily: '每天',
  weekly: '每周',
};

/** 触达失败原因四值（§4.12.2，与 §1.4 API 错误码**不同源**）。 */
export const NOTIFICATION_ERROR_CODES = [
  'NOTIFICATION_PERMISSION_DENIED',
  'NOTIFICATION_UNSUPPORTED',
  'NOTIFICATION_CONSTRUCT_FAILED',
  'DELIVERY_INTERNAL_ERROR',
] as const;

export type NotificationErrorCode = (typeof NOTIFICATION_ERROR_CODES)[number];

/** `GET /notifications/pending` 的单项（§16 冻结字段，逐字段照抄）。 */
export interface PendingNotificationItem {
  readonly deliveryId: string;
  readonly targetType: string;
  readonly targetId: string | null;
  readonly level: string;
  readonly status: string;
  readonly scheduledFor: string;
  readonly errorCode: string | null;
  readonly nextRetryAt: string | null;
}

/** `GET /notification-rules` 的单项（§16）。 */
export interface NotificationRuleItem {
  readonly ruleId: string;
  readonly targetType: string;
  readonly targetId: string | null;
  readonly remindAt: string;
  readonly repeatRule: string;
  readonly allowQuietHours: boolean;
  readonly enabled: boolean;
  readonly level: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** 触达上报的服务端权威回带（第 8 端点）。 */
export interface NotificationAttemptResult {
  readonly deliveryId: string;
  readonly status: string;
  readonly attemptCount: number;
  readonly lastAttemptAt: string | null;
  readonly errorCode: string | null;
  readonly nextRetryAt: string | null;
}

/**
 * 读取待处理提醒。
 *
 * 这条请求同时是**物化触发点**（设计准据：RD-20260929-008「补正 1」）：服务端在
 * 读路径的事务内先作废三类失效交付、再为到点规则物化新交付。因此面板刷新本身
 * 就是交付行的诞生入口，不存在额外的"生成"端点。
 */
export function fetchPendingNotifications(
  signal: AbortSignal,
): Promise<ApiEnvelope<readonly PendingNotificationItem[]>> {
  return fetchJson<readonly PendingNotificationItem[]>('/api/v1/notifications/pending', signal);
}

/**
 * 查询某对象（或某类对象）的提醒规则。
 *
 * `review` 类规则的 `targetId` 恒为 `NULL`（§16：周复盘提醒不绑定单条实体），
 * 所以该分支不拼 `targetId` 参数，只按 `targetType` 过滤。
 */
export function fetchNotificationRules(
  query: { readonly targetType: NotificationTargetType; readonly targetId?: string | null },
  signal: AbortSignal,
): Promise<ApiEnvelope<readonly NotificationRuleItem[]>> {
  const params = new URLSearchParams({ targetType: query.targetType });
  if (query.targetId != null) {
    params.set('targetId', query.targetId);
  }
  return fetchJson<readonly NotificationRuleItem[]>(
    `/api/v1/notification-rules?${params.toString()}`,
    signal,
  );
}

/** 创建提醒规则。`targetId` 为 `null`（review 类）时**整个键省略**，与 §16 一致。 */
export function createNotificationRule(input: {
  readonly targetType: NotificationTargetType;
  readonly targetId: string | null;
  readonly remindAt: string;
  readonly repeatRule: NotificationRepeatRule;
  readonly allowQuietHours: boolean;
}): Promise<ApiEnvelope<NotificationRuleItem>> {
  return sendJson<NotificationRuleItem>('POST', '/api/v1/notification-rules', {
    targetType: input.targetType,
    ...(input.targetId === null ? {} : { targetId: input.targetId }),
    remindAt: input.remindAt,
    repeatRule: input.repeatRule,
    allowQuietHours: input.allowQuietHours,
  });
}

/** 更新提醒规则（单条关闭即 `{ enabled: false }`；`level` 不在可改字段内）。 */
export function updateNotificationRule(
  ruleId: string,
  patch: Partial<{
    readonly remindAt: string;
    readonly repeatRule: NotificationRepeatRule;
    readonly allowQuietHours: boolean;
    readonly enabled: boolean;
  }>,
): Promise<ApiEnvelope<NotificationRuleItem>> {
  return sendJson<NotificationRuleItem>(
    'PATCH',
    `/api/v1/notification-rules/${encodeURIComponent(ruleId)}`,
    patch,
  );
}

/** 用户「已处理」出口：写 `dismissed_at`，`status` 保持四值不变（§16）。 */
export function dismissNotification(deliveryId: string): Promise<ApiEnvelope<unknown>> {
  return sendJson<unknown>(
    'POST',
    `/api/v1/notifications/${encodeURIComponent(deliveryId)}/dismiss`,
  );
}

/**
 * 上报一次前台浏览器通知的尝试结果（第 8 端点）。
 *
 * `idempotencyKey` **每次尝试都要新生成一个**：§16 明文的客户端纪律——一次尝试
 * 一个键，否则网络层自动重试会撞上同一个 key 的重放（409），把一次尝试记成两次
 * 或干脆记失败。
 */
export function reportNotificationAttempt(
  deliveryId: string,
  input: {
    readonly outcome: 'sent' | 'failed';
    readonly errorCode?: NotificationErrorCode;
  },
  idempotencyKey: string,
): Promise<ApiEnvelope<NotificationAttemptResult>> {
  return sendJson<NotificationAttemptResult>(
    'POST',
    `/api/v1/notification-deliveries/${encodeURIComponent(deliveryId)}/attempt`,
    input,
    { headers: { 'Idempotency-Key': idempotencyKey } },
  );
}

/** 名称表：`targetId` → 对象名。 */
export interface TargetNameMaps {
  readonly tasks: ReadonlyMap<string, string>;
  readonly routines: ReadonlyMap<string, string>;
}

export const EMPTY_NAME_MAPS: TargetNameMaps = Object.freeze({
  tasks: new Map<string, string>(),
  routines: new Map<string, string>(),
});

/** `GET /tasks` 的名称子集（列表项只取这两个字段）。 */
interface TaskNameItem {
  readonly id: string;
  readonly title: string;
}

/** `GET /routines` 的名称子集（该端点返回 `{ routine, steps }` 明细，名称在 `routine.name`）。 */
interface RoutineNameItem {
  readonly routine: { readonly id: string; readonly name: string };
}

/**
 * 批量取对象名，供面板标题与浏览器通知标题使用。
 *
 * **为什么是两次列表请求而不是逐 id 取**：§16 pending 不携带对象名，客户端只能
 * 自己补；逐条 `GET /tasks/{id}` 会退化成 N+1（一次开面板最多几十个请求），而
 * 「任务清单 + 例程清单」各一条即可覆盖。例程没有单条 GET 端点，列表是唯一来源。
 *
 * 覆盖不到的 id（超出 100 条上限、已软删、非本人）由 `resolveTargetName` 回落到
 * 类别名——面板不会因为一个名字取不到而报错。
 */
export async function fetchTargetNameMaps(signal: AbortSignal): Promise<TargetNameMaps> {
  const [tasks, routines] = await Promise.all([
    fetchJson<{ readonly items: readonly TaskNameItem[] }>('/api/v1/tasks?limit=100', signal),
    fetchJson<{ readonly items: readonly RoutineNameItem[] }>('/api/v1/routines', signal),
  ]);

  return {
    tasks: new Map(tasks.data.items.map((item) => [item.id, item.title])),
    routines: new Map(routines.data.items.map((item) => [item.routine.id, item.routine.name])),
  };
}

/** 解析一条 pending 的对象名；解析不到时回落为类别名（`复盘` / `任务` / `例程`）。 */
export function resolveTargetName(
  maps: TargetNameMaps,
  targetType: string,
  targetId: string | null,
): string {
  const label =
    NOTIFICATION_TARGET_LABELS[targetType as NotificationTargetType] ??
    NOTIFICATION_TARGET_LABELS.task;

  if (targetId === null) {
    return label;
  }
  if (targetType === 'task') {
    return maps.tasks.get(targetId) ?? label;
  }
  if (targetType === 'routine') {
    return maps.routines.get(targetId) ?? label;
  }
  return label;
}

/**
 * 对象的真实落点。
 *
 * §16 没有「任务详情」路由（这正是 UI v0.23 宿主勘误的由来），所以按对象类别落到
 * 各自的聚合页：任务 → `/inbox`、例程 → `/today`、复盘 → `/review`。三处都是真实
 * 存在的路由，不是占位入口。
 */
export function notificationTargetHref(targetType: string): string {
  if (targetType === 'routine') {
    return '/today';
  }
  if (targetType === 'review') {
    return '/review';
  }
  return '/inbox';
}

/**
 * 触发时间的展示串。
 *
 * 与 `TodayPanel` / `WeekPanel` 同一口径（浏览器本地时区 + `toLocaleString`），
 * 不另造一份格式化规则——本地模式下浏览器时区即用户所处时区。
 */
export function formatNotificationTime(instant: string): string {
  return new Date(instant).toLocaleString([], {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** 一次性读取（与页面其它查询同款的最小封装），供 /review 的提醒区使用。 */
export function fetchRulesForReview(
  signal: AbortSignal,
): Promise<ApiEnvelope<readonly NotificationRuleItem[]>> {
  return fetchNotificationRules({ targetType: 'review' }, signal);
}
