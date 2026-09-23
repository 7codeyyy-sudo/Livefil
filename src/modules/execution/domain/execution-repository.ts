/**
 * 执行记录与恢复状态仓储端口（EXEC-001/002）。
 *
 * 两个聚合的端口放同一文件：它们同属 execution 模块、且 /today 聚合与
 * 完成率统计总是成对消费（Phase 3 goals-repository 双端口同文件的先例）。
 */
import type { ExecutionLog, ExecutionLogCreateInput, ExecutionStatus } from './execution-log.ts';

export interface ListExecutionLogsOptions {
  readonly fromUtc: Date;
  readonly toUtc: Date;
  readonly taskId?: string | undefined;
  readonly actionId?: string | undefined;
  readonly status?: ExecutionStatus | undefined;
  /** 不透明游标；首页不传。 */
  readonly cursor?: string | undefined;
  readonly limit: number;
}

export interface ExecutionLogPage {
  readonly items: readonly ExecutionLog[];
  readonly nextCursor: string | null;
  readonly hasMore: boolean;
}

export interface ExecutionLogRepository {
  /** 追加式写入；无 update/delete——历史事实不篡改。 */
  create(userId: string, input: ExecutionLogCreateInput): Promise<ExecutionLog>;

  findById(userId: string, logId: string): Promise<ExecutionLog | null>;

  /**
   * 窗口 + 筛选查询（occurredAt 降序、游标分页，limit ≤ 100 / 窗口 ≤ 92 天
   * 由用例层校验）。
   */
  list(userId: string, options: ListExecutionLogsOptions): Promise<ExecutionLogPage>;

  /** 今日聚合的 habits 打卡判定：某用户某窗口内的全部记录（窗口＝单日，量小）。 */
  listInWindow(userId: string, fromUtc: Date, toUtc: Date): Promise<readonly ExecutionLog[]>;

  /** 完成率统计（回看 ≤7 个有计划日）用的窗口查询。 */
  listOverlapping(
    userId: string,
    windowStartUtc: Date,
    windowEndUtc: Date,
  ): Promise<readonly ExecutionLog[]>;
}

export interface RecoveryState {
  readonly enabled: boolean;
  readonly since: string;
}

export interface RecoveryStateRepository {
  /** 每用户至多一行；从未设置过返回 null。 */
  get(userId: string): Promise<RecoveryState | null>;

  /** 单行 upsert（DB §4.17：主键即并发口径，无 version）。 */
  set(userId: string, enabled: boolean): Promise<RecoveryState>;
}
