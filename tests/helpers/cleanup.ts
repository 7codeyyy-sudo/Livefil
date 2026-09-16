/**
 * 测试数据清理契约（FND-003）。
 *
 * 当前阶段项目尚未接入数据库（建表属于 TASK-001、云端仓储属于 SYNC-001），
 * 因此本模块**只交付契约**：定义清理器接口，并给出一个显式抛错的「不可用」实现。
 *
 * 为什么不做成「什么都不做、静默返回」的空实现：那样调用方会以「清理已完成」的
 * 姿态继续执行，真正需要清理时问题才暴露，而那时数据已经写进库了。宁可让调用点
 * 明确知道当前不具备清理能力，也不要制造虚假的安心
 * （对应 universal-code-quality 的「禁止静默吞错」）。
 */
import type { FactoryContext } from '../factories/types.ts';

/** 待清理的数据引用。 */
export interface DataReference {
  /** 数据库表名。 */
  readonly table: string;
  /** 行主键（`id`）。 */
  readonly id: string;
}

/** 测试数据清理器契约。 */
export interface TestDataCleaner {
  /** 当前运行环境是否具备清理能力。 */
  readonly isAvailable: boolean;
  /** 返回已登记引用的副本，避免调用方绕过 {@link TestDataCleaner.register} 直接改动内部状态。 */
  readonly pendingReferences: () => readonly DataReference[];
  /** 登记一条待清理数据。 */
  readonly register: (reference: DataReference) => void;
  /**
   * 执行清理。
   *
   * @returns 清理完成后的 Promise。
   * @throws {CleanupUnavailableError} 当前环境不具备清理能力时抛出。
   */
  readonly clean: () => Promise<void>;
}

/** 在尚未接入数据库的环境里请求清理时抛出的错误。 */
export class CleanupUnavailableError extends Error {
  /**
   * @param reason 不具备清理能力的具体原因，用于在失败信息里给出可执行的线索。
   */
  constructor(reason: string) {
    super(`测试数据清理不可用：${reason}`);
    this.name = 'CleanupUnavailableError';
  }
}

/**
 * 创建「不可用」清理器。
 *
 * 它仍然会登记数据引用（供调试时观察本次测试写了哪些行），但 {@link TestDataCleaner.clean}
 * 一定会失败——把「尚未实现」暴露成错误，而不是伪装成成功。
 *
 * @param reason 不具备清理能力的原因，例如「项目尚未接入数据库（TASK-001）」。
 * @returns 不可用的清理器；已冻结。
 */
export function createUnavailableCleaner(reason: string): TestDataCleaner {
  const references: DataReference[] = [];

  const register = (reference: DataReference): void => {
    if (reference.table.trim() === '' || reference.id.trim() === '') {
      throw new TypeError(
        `数据引用必须同时提供非空的 table 与 id，实际收到 table=${JSON.stringify(reference.table)}、id=${JSON.stringify(reference.id)}`,
      );
    }
    references.push(Object.freeze({ table: reference.table, id: reference.id }));
  };

  return Object.freeze({
    isAvailable: false,
    pendingReferences: () => [...references],
    register,
    clean: () => Promise.reject(new CleanupUnavailableError(reason)),
  });
}

/**
 * 当前阶段的清理器实例。
 *
 * 原因写死在构造函数里而不是让调用方各自解释：清理不可用的根源是项目还没有数据库，
 * 这一点在 TASK-001 落地之前不会改变。
 *
 * @param _context 预留的工厂上下文，用于将来接入数据库后构造「可清理」的实现。
 *   当前实现不使用它——缺少数据库连接时，任何基于上下文的清理动作都无从谈起。
 * @returns 不可用的清理器。
 */
export function createTestDataCleaner(_context: FactoryContext): TestDataCleaner {
  return createUnavailableCleaner('项目尚未接入数据库（建表属于 TASK-001，云端仓储属于 SYNC-001）');
}
