/**
 * 例程仓储端口（ROUTINE-001）。步骤集合的 diff 语义见接口 §8 PATCH。
 */
import type {
  RoutineCreateInput,
  RoutineDetail,
  RoutinePatch,
  RoutineStepPatch,
} from './routine.ts';

export interface RoutineRepository {
  /** 详情（含按 position 升序的未删除步骤）；不存在/已删返回 null。 */
  findDetail(userId: string, routineId: string): Promise<RoutineDetail | null>;

  /** 全部未删除例程（name 升序，含步骤）。 */
  listAll(userId: string): Promise<readonly RoutineDetail[]>;

  /** 创建：例程行 + 步骤行同事务。 */
  create(userId: string, input: RoutineCreateInput): Promise<RoutineDetail>;

  /**
   * 更新：定义字段 + 步骤集合 diff（带 id 更新、缺 id 新增、缺失软删、
   * position 重排为 0..n 连续），同事务；version 冲突抛 ConflictError。
   */
  update(
    userId: string,
    routineId: string,
    expectedVersion: number,
    patch: RoutinePatch,
    steps: readonly RoutineStepPatch[],
  ): Promise<RoutineDetail>;

  /** 软删例程（已生成块保留）；重复删除返回 false。 */
  softDelete(userId: string, routineId: string): Promise<boolean>;
}
