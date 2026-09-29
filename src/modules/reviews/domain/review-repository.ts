/**
 * 复盘仓储端口（REVIEW-001~003）。
 *
 * 三个端口而不是一个，因为它们的数据源不同：
 *
 * - `ReviewRepository`：`reviews` 表本身（日/周 upsert、快照物化、读取）；
 * - `ReviewFactsRepository`：跨表**只读聚合**（执行记录、任务、目标行动），
 *   产出快照的「事实」部分——它不写任何表，故不必伪装成"仓储"；
 * - `ReviewAdjustmentApplier`：`review_adjustments` + target 的**同事务**写入
 *   （预审裁定 6）。它与前两个分开，是因为它的职责是事务边界本身，
 *   而不是某张表的读写。
 */
import type {
  AdjustmentWrite,
  ReviewAdjustment,
  ReviewAdjustmentCreateInput,
} from './review-adjustment.ts';
import type { Review, DailyReviewUpsertInput } from './review.ts';
import type { WeeklyFacts, WeeklyPlanActual, WeeklySnapshot } from './weekly-snapshot.ts';

/** 统计窗口（按用户时区切出的左闭右开区间，`weekEnd` 不含）。 */
export interface WeekRange {
  readonly weekStart: string;
  readonly weekEnd: string;
  readonly timezone: string;
}

/** 日复盘的事实摘要（UI 规范 B1「完成/未完成计数与偏差要点行」）。 */
export interface DailyFacts {
  readonly planActual: WeeklyPlanActual;
  /** 完成＝执行状态 `completed` / `minimum_completed`。 */
  readonly completedCount: number;
  /** 未完成＝本周其余执行状态（partial / deferred / skipped）。 */
  readonly uncompletedCount: number;
}

export interface ReviewRepository {
  /** 按日历日读取日复盘；不存在返回 `null`（空态语义见接口 §10）。 */
  findDaily(userId: string, date: string): Promise<Review | null>;

  /** 按周读取周复盘；不存在返回 `null`。 */
  findWeekly(userId: string, weekStart: string): Promise<Review | null>;

  /**
   * 日复盘 upsert（唯一键 `(user_id, review_type, period_key)`，接口 §10）。
   *
   * 同日重复 PUT 命中同一行、自增 `version`，**不重复建行**——这是"可编辑与保存"
   * 的基础：客户端不必先查再决定新建还是更新。
   */
  upsertDaily(userId: string, date: string, input: DailyReviewUpsertInput): Promise<Review>;

  /**
   * 确保周复盘**行**存在（不带快照）。
   *
   * 「记录 + 执行」需要 `review_id`：用户在本周就要做下周调整时，该周快照尚未
   * 物化（周未结束不落库），此时必须能拿到一个稳定的 `review_id`——否则调整记录
   * 无处可挂。快照仍由 {@link ReviewRepository.materializeWeeklySnapshot} 按
   * 「周已结束」的时机补上。
   */
  ensureWeekly(userId: string, weekStart: string): Promise<Review>;

  /**
   * 惰性物化周快照（DB §4.11.2）。
   *
   * 行不存在则建行并写快照；行存在且**尚无快照**则补写快照；已有快照则原样返回
   * （写入后不变性，不重算）。
   */
  materializeWeeklySnapshot(
    userId: string,
    weekStart: string,
    snapshot: WeeklySnapshot,
  ): Promise<Review>;

  /** 某周复盘已确认的调整清单（按记录时间正序；只增不删，无分页需求）。 */
  listAdjustments(userId: string, reviewId: string): Promise<readonly ReviewAdjustment[]>;
}

export interface ReviewFactsRepository {
  /** 周复盘「事实」部分（取数口径见 `weekly-snapshot.ts` 文件头）。 */
  collectWeeklyFacts(userId: string, range: WeekRange): Promise<WeeklyFacts>;

  /** 日复盘事实摘要。 */
  collectDailyFacts(userId: string, date: string, timezone: string): Promise<DailyFacts>;
}

export interface ReviewAdjustmentApplier {
  /**
   * 记录 + 执行（同一事务）。
   *
   * @param expectedVersion 目标当前版本（乐观并发；`kind: 'none'` 时传 `null`）。
   * @throws {NotFoundError} 目标不存在 / 不属于当前用户 / 任务已软删。
   * @throws {ConflictError} 目标版本已前移（用户在别处改过）。
   */
  apply(
    userId: string,
    input: ReviewAdjustmentCreateInput,
    write: AdjustmentWrite,
    expectedVersion: number | null,
  ): Promise<ReviewAdjustment>;
}
