/**
 * 测试数据工厂单元测试（FND-003）。
 *
 * 工厂本身也是代码，同样需要被测试——否则「工厂悄悄产出非法数据」会让所有
 * 依赖它的用例一起失去意义。这里重点覆盖：可复现性、非空外键补齐、
 * 默认值语义与不可变性。
 */
import { describe, expect, it } from 'vitest';

import { createFactories } from '../../factories/index.ts';

/** UUID v4 的形态，与 `tests/factories/ids.ts` 的产出约定一致。 */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** `date` 列的形态。 */
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** 一分钟的毫秒数，用于时钟推进断言。 */
const ONE_MINUTE_MS = 60_000;

describe('工厂的可复现性', () => {
  it('同一 seed 产出完全相同的实体', () => {
    const left = createFactories({ seed: 'same-seed' });
    const right = createFactories({ seed: 'same-seed' });

    expect(left.task()).toEqual(right.task());
    expect(left.user()).toEqual(right.user());
  });

  it('不同 seed 产出不同实体', () => {
    const left = createFactories({ seed: 'seed-one' });
    const right = createFactories({ seed: 'seed-two' });

    expect(left.task().id).not.toBe(right.task().id);
  });
});

describe('用户工厂', () => {
  it('邮箱落在 RFC 2606 保留域且互不重复', () => {
    const factories = createFactories({ seed: 3 });
    const users = Array.from({ length: 20 }, () => factories.user());

    const emails = users.map((user) => user.email);
    expect(new Set(emails).size).toBe(emails.length);

    for (const email of emails) {
      // 使用保留域，确保测试数据永远不会命中真实收件方。
      expect(email).toMatch(/@example\.com$/);
    }
  });

  it('默认是本地模式，不假设已接入云端账号', () => {
    const factories = createFactories({ seed: 4 });
    const user = factories.user();

    expect(user.mode).toBe('local');
    expect(user.locale).toBe('zh-CN');
    expect(user.currency_code).toBe('CNY');
    expect(user.timezone).toBe('Asia/Shanghai');
  });
});

describe('非空外键的补齐', () => {
  it('任务默认处于收件箱状态且无归属', () => {
    const factories = createFactories({ seed: 5 });
    const task = factories.task();

    expect(task.status).toBe('inbox');
    expect(task.life_area_id).toBeNull();
    expect(task.goal_id).toBeNull();
    expect(task.action_id).toBeNull();
  });

  it('目标在未指定领域时自动补齐非空外键', () => {
    const factories = createFactories({ seed: 7 });
    const goal = factories.goal();

    // goals.life_area_id 是非空外键：工厂必须补出一个合法值，
    // 否则产出的行在形状上就不合法。
    expect(goal.life_area_id).toMatch(UUID_PATTERN);
    expect(goal.user_id).toMatch(UUID_PATTERN);
  });

  it('开销在未指定分类时自动补齐非空外键', () => {
    const factories = createFactories({ seed: 9 });
    const expense = factories.expense();

    expect(expense.category_id).toMatch(UUID_PATTERN);
    expect(expense.user_id).toMatch(UUID_PATTERN);
  });

  it('显式传入的归属会覆盖自动补齐', () => {
    const factories = createFactories({ seed: 10 });
    const user = factories.user();
    const lifeArea = factories.lifeArea({ user_id: user.id });
    const goal = factories.goal({ user_id: user.id, life_area_id: lifeArea.id });

    expect(goal.user_id).toBe(user.id);
    expect(goal.life_area_id).toBe(lifeArea.id);
  });
});

describe('金额与时间的表示', () => {
  it('开销金额使用最小货币单位的整数', () => {
    const factories = createFactories({ seed: 11 });
    const expense = factories.expense();

    expect(Number.isInteger(expense.amount_minor)).toBe(true);
    expect(expense.amount_minor).toBeGreaterThan(0);
    expect(expense.currency_code).toBe('CNY');
  });

  it('日期列输出 YYYY-MM-DD，时间列输出 UTC ISO 字符串', () => {
    const factories = createFactories({ seed: 12 });
    const expense = factories.expense();
    const task = factories.task();

    expect(expense.occurred_on).toMatch(DATE_PATTERN);
    expect(task.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  it('时间块的结束时间晚于开始时间', () => {
    const factories = createFactories({ seed: 13 });
    const block = factories.scheduleBlock();

    expect(new Date(block.ends_at_utc).getTime()).toBeGreaterThan(
      new Date(block.starts_at_utc).getTime(),
    );
  });
});

describe('时钟', () => {
  it('推进后新行的时间戳随之变化，既有行不受影响', () => {
    const factories = createFactories({ seed: 14 });
    const before = factories.task();

    factories.clock.advance(ONE_MINUTE_MS);

    const after = factories.task();

    expect(new Date(after.created_at).getTime() - new Date(before.created_at).getTime()).toBe(
      ONE_MINUTE_MS,
    );
    // 先创建的行是在推进之前冻结的，不应被后续推进改写。
    expect(before.created_at).not.toBe(after.created_at);
  });
});

describe('产出对象的不可变性', () => {
  it('所有实体行均被冻结', () => {
    const factories = createFactories({ seed: 15 });

    const rows = [
      factories.user(),
      factories.lifeArea(),
      factories.goal(),
      factories.task(),
      factories.scheduleBlock(),
      factories.expenseCategory(),
      factories.expense(),
      factories.review(),
    ];

    for (const row of rows) {
      expect(Object.isFrozen(row)).toBe(true);
    }
  });
});

describe('复盘工厂的骨架边界', () => {
  it('只产出设计文档已明确的字段，不臆造结构', () => {
    const factories = createFactories({ seed: 16 });
    const review = factories.review();

    expect(review.period).toBe('daily');
    expect(review.period_start).toMatch(DATE_PATTERN);
    expect(review.snapshot).toBeNull();
    expect(review.snapshot_schema_version).toBe(1);
  });
});
