/**
 * 时间块仓储端口（SCHED-001）。端口放 domain 的理由与 tasks/goals 相同。
 */
import type {
  ScheduleBlock,
  ScheduleBlockCreateInput,
  ScheduleBlockPatch,
} from './schedule-block.ts';

export interface ScheduleBlockRepository {
  findById(userId: string, blockId: string): Promise<ScheduleBlock | null>;

  /**
   * UTC 窗口查询（含端点重叠）。返回该用户窗口内有重叠的**全部**块
   * （含 cancelled——过滤是调用方语义：列表默认排除、冲突检测排除、
   * 今日聚合排除），按 startsAtUtc 升序。
   */
  listOverlapping(
    userId: string,
    windowStartUtc: Date,
    windowEndUtc: Date,
  ): Promise<readonly ScheduleBlock[]>;

  /** 单条创建（归属校验由用例先行；例程展开走 bulkCreate）。 */
  create(userId: string, input: ScheduleBlockCreateInput): Promise<ScheduleBlock>;

  /** 例程展开等批量场景：与 bulk 写同库即可，无需事务包装——失败由调用方决定。 */
  bulkCreate(
    userId: string,
    inputs: readonly ScheduleBlockCreateInput[],
  ): Promise<readonly ScheduleBlock[]>;

  /**
   * 乐观并发更新（接口 §6 PATCH 需 version；状态迁移含 completed/adjusted/
   * cancelled 由用例在 patch 里显式给）。找不到行抛 NotFoundError，版本冲突
   * 抛 ConflictError。
   */
  update(
    userId: string,
    blockId: string,
    expectedVersion: number,
    patch: ScheduleBlockPatch & {
      readonly status?: ScheduleBlock['status'];
      readonly conflictState?: ScheduleBlock['conflictState'];
    },
  ): Promise<ScheduleBlock>;
}
