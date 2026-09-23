/**
 * 固定事项仓储端口（SCHED-002 / DB §4.16）。
 */
import type { FixedCommitment } from './schedule-block.ts';

/** 创建输入（三形态的字段全集；形态校验在领域 `assertFixedCommitmentInput`）。 */
export interface FixedCommitmentCreateInput {
  readonly title: string;
  readonly templateId: string | null;
  readonly localDate: string | null;
  readonly startsAtUtc: Date | null;
  readonly endsAtUtc: Date | null;
  readonly startsAtLocal: string | null;
  readonly durationMinutes: number;
  readonly timezone: string;
  readonly recurrenceRule: unknown;
}

export interface FixedCommitmentPatch {
  readonly title?: string | undefined;
  readonly startsAtUtc?: Date | undefined;
  readonly endsAtUtc?: Date | undefined;
  readonly startsAtLocal?: string | undefined;
  readonly durationMinutes?: number | undefined;
  readonly timezone?: string | undefined;
  readonly recurrenceRule?: unknown;
}

export interface FixedCommitmentRepository {
  findById(userId: string, id: string): Promise<FixedCommitment | null>;

  /** UTC 窗口内的**实例行**（模板行无 UTC 时刻，不在此列），升序。 */
  listInstancesOverlapping(
    userId: string,
    windowStartUtc: Date,
    windowEndUtc: Date,
  ): Promise<readonly FixedCommitment[]>;

  /** 当前用户的全部重复模板（未删除）。 */
  listTemplates(userId: string): Promise<readonly FixedCommitment[]>;

  /** 实例展开的幂等回读：同模板同日是否已有实例。 */
  findByTemplateAndDate(
    userId: string,
    templateId: string,
    localDate: string,
  ): Promise<FixedCommitment | null>;

  create(userId: string, input: FixedCommitmentCreateInput): Promise<FixedCommitment>;

  update(
    userId: string,
    id: string,
    expectedVersion: number,
    patch: FixedCommitmentPatch,
  ): Promise<FixedCommitment>;

  /** 软删；行不存在/已删返回 false。 */
  softDelete(userId: string, id: string): Promise<boolean>;
}
