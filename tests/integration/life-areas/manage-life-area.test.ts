// @vitest-environment node
/**
 * 生活领域管理（IAM-003，《详细设计说明书》§4.8）。
 *
 * 重点覆盖三件容易做错的事：**归档不是删除**、**重排的集合必须恰好相等**、
 * **所有查询都带用户作用域**。第三条在本地单用户环境里永远看不出问题——
 * 直到进入多用户才变成数据泄漏，所以必须在这里用第二个用户把它钉住。
 */
import { describe, expect, it } from 'vitest';

import { ManageLifeAreaUseCase } from '../../../src/modules/life-areas/application/manage-life-area.ts';
import {
  createLifeAreaSchema,
  reorderLifeAreasSchema,
  updateLifeAreaSchema,
} from '../../../src/modules/life-areas/application/life-area-dto.ts';
import { DEFAULT_LIFE_AREAS } from '../../../src/modules/life-areas/domain/default-life-areas.ts';
import {
  ConflictError,
  NotFoundError,
  ValidationError,
} from '../../../src/shared/errors/app-error.ts';
import {
  createFakeAuditLogger,
  createFakeDatabase,
  createFakeLifeAreaRepository,
  createFakeUserRepository,
} from '../../helpers/fake-repositories.ts';

/** 另一个用户的 id：用来验证"非本人数据不可见、不可改"。 */
const OTHER_USER_ID = 'user-other';

async function setup() {
  const database = createFakeDatabase();
  const users = createFakeUserRepository(database);
  const lifeAreas = createFakeLifeAreaRepository(database);
  const audit = createFakeAuditLogger();
  const { user } = await users.ensureLocalUser(DEFAULT_LIFE_AREAS);
  const useCase = new ManageLifeAreaUseCase({ lifeAreas, audit });

  return { database, users, lifeAreas, audit, useCase, userId: user.id };
}

const parseCreate = (body: unknown) => createLifeAreaSchema.parse(body);
const parseUpdate = (body: unknown) => updateLifeAreaSchema.parse(body);
const parseReorder = (body: unknown) => reorderLifeAreasSchema.parse(body);

describe('首启播种', () => {
  it('建用户时写入 §4.8 冻结的六个领域，顺序为 0~5', async () => {
    const { lifeAreas, userId } = await setup();

    const items = await lifeAreas.listByUser(userId, { includeArchived: false });

    expect(items.map((area) => area.name)).toEqual(DEFAULT_LIFE_AREAS.map((seed) => seed.name));
    expect(items.map((area) => area.sortOrder)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(items.every((area) => area.isDefault)).toBe(true);
  });
});

describe('创建', () => {
  it('排序号取当前末位 + 1，并写 DATA_CREATED 审计', async () => {
    const { useCase, audit, userId } = await setup();

    const created = await useCase.create(userId, parseCreate({ name: '阅读' }), 'req-create');

    expect(created.sortOrder).toBe(DEFAULT_LIFE_AREAS.length);
    expect(created.isArchived).toBe(false);
    expect(audit.events.at(-1)?.type).toBe('DATA_CREATED');
  });

  it('缺省颜色取 blue（接口文档的约定）', async () => {
    const { useCase, userId } = await setup();

    const created = await useCase.create(userId, parseCreate({ name: '阅读' }));

    expect(created.colorKey).toBe('blue');
  });

  it('名称会去掉首尾空白后再校验', () => {
    expect(parseCreate({ name: '  阅读  ' }).name).toBe('阅读');
  });

  it('空白名称与超长名称被拒绝', () => {
    expect(() => parseCreate({ name: '   ' })).toThrow();
    expect(() => parseCreate({ name: 'x'.repeat(61) })).toThrow();
  });

  it('不在六枚分类色内的 key 被拒绝', () => {
    expect(() => parseCreate({ name: '阅读', colorKey: 'black' })).toThrow();
  });

  it('与未归档领域同名 → 409', async () => {
    const { useCase, userId } = await setup();

    await expect(useCase.create(userId, parseCreate({ name: '工作' }))).rejects.toBeInstanceOf(
      ConflictError,
    );
  });

  it('归档之后可以用同一个名字再建', async () => {
    const { useCase, lifeAreas, userId } = await setup();
    const work = (await lifeAreas.listByUser(userId, { includeArchived: false })).find(
      (area) => area.name === '工作',
    );

    await useCase.update(userId, work?.id ?? '', parseUpdate({ isArchived: true }));
    const recreated = await useCase.create(userId, parseCreate({ name: '工作' }));

    expect(recreated.name).toBe('工作');
    expect(recreated.isArchived).toBe(false);
  });
});

describe('归档与恢复', () => {
  it('归档后不再出现在默认列表里，展开归档可见', async () => {
    const { useCase, lifeAreas, userId } = await setup();
    const target = (await lifeAreas.listByUser(userId, { includeArchived: false }))[0];

    await useCase.update(
      userId,
      target?.id ?? '',
      parseUpdate({ isArchived: true }),
      'req-archive',
    );

    const active = await lifeAreas.listByUser(userId, { includeArchived: false });
    const all = await lifeAreas.listByUser(userId, { includeArchived: true });

    expect(active.map((area) => area.id)).not.toContain(target?.id);
    expect(all.map((area) => area.id)).toContain(target?.id);
    // 归档**不是删除**：行还在，"这条内容当初属于哪个领域"因此仍可回答。
    expect(all).toHaveLength(DEFAULT_LIFE_AREAS.length);
  });

  it('归档写 DATA_DELETED、恢复写 DATA_RESTORED（不是笼统的 DATA_UPDATED）', async () => {
    const { useCase, lifeAreas, audit, userId } = await setup();
    const target = (await lifeAreas.listByUser(userId, { includeArchived: false }))[0];

    await useCase.update(userId, target?.id ?? '', parseUpdate({ isArchived: true }));
    expect(audit.events.at(-1)?.type).toBe('DATA_DELETED');

    await useCase.update(userId, target?.id ?? '', parseUpdate({ isArchived: false }));
    expect(audit.events.at(-1)?.type).toBe('DATA_RESTORED');
  });

  it('重复归档 / 未归档时恢复 → 422', async () => {
    const { useCase, lifeAreas, userId } = await setup();
    const target = (await lifeAreas.listByUser(userId, { includeArchived: false }))[0];
    const id = target?.id ?? '';

    await useCase.update(userId, id, parseUpdate({ isArchived: true }));

    await expect(
      useCase.update(userId, id, parseUpdate({ isArchived: true })),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      useCase.update(userId, id, parseUpdate({ isArchived: false })),
    ).resolves.toBeDefined();
    await expect(
      useCase.update(userId, id, parseUpdate({ isArchived: false })),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('空补丁被拒绝（否则用户会以为保存成功）', () => {
    expect(() => parseUpdate({})).toThrow();
  });
});

describe('重排', () => {
  it('按给定顺序写回索引作为 sortOrder', async () => {
    const { useCase, lifeAreas, userId } = await setup();
    const active = await lifeAreas.listByUser(userId, { includeArchived: false });
    const reversed = [...active].reverse().map((area) => area.id);

    const reordered = await useCase.reorder(
      userId,
      parseReorder({ orderedIds: reversed }).orderedIds,
    );

    expect(reordered.map((area) => area.id)).toEqual(reversed);
    expect(reordered.map((area) => area.sortOrder)).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it('少的、多的、重复的、他人的 id 全部被拒绝', async () => {
    const { useCase, lifeAreas, userId } = await setup();
    const active = await lifeAreas.listByUser(userId, { includeArchived: false });
    const ids = active.map((area) => area.id);

    const cases: readonly (readonly string[])[] = [
      ids.slice(1), // 少一个
      [...ids, 'area-not-mine'], // 多一个
      [ids[0] ?? '', ids[0] ?? '', ...ids.slice(1)], // 重复
    ];

    for (const orderedIds of cases) {
      await expect(useCase.reorder(userId, orderedIds)).rejects.toBeInstanceOf(ValidationError);
    }
  });

  it('归档项不参与重排（集合只算未归档）', async () => {
    const { useCase, lifeAreas, userId } = await setup();
    const active = await lifeAreas.listByUser(userId, { includeArchived: false });
    const archived = active[0];
    await useCase.update(userId, archived?.id ?? '', parseUpdate({ isArchived: true }));

    const remaining = active.slice(1).map((area) => area.id);
    // 仍带着已归档项的 id 会被拒绝——这正是"集合必须恰好相等"的意义。
    await expect(
      useCase.reorder(userId, [...remaining, archived?.id ?? '']),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(useCase.reorder(userId, remaining)).resolves.toHaveLength(remaining.length);
  });
});

describe('用户作用域', () => {
  it('列表不含他人的领域', async () => {
    const { useCase, lifeAreas, userId } = await setup();
    await lifeAreas.create(OTHER_USER_ID, { name: '别人的领域', colorKey: 'rose' });

    const mine = await useCase.list(userId, true);

    expect(mine.map((area) => area.name)).not.toContain('别人的领域');
  });

  it('按 id 操作他人的领域 → 404（不泄露存在性）', async () => {
    const { useCase, lifeAreas, userId } = await setup();
    const foreign = await lifeAreas.create(OTHER_USER_ID, { name: '别人的领域', colorKey: 'rose' });

    await expect(
      useCase.update(userId, foreign.id, parseUpdate({ name: '改名' })),
    ).rejects.toBeInstanceOf(NotFoundError);
    expect(await lifeAreas.findById(userId, foreign.id)).toBeNull();
  });

  it('不存在的 id → 404', async () => {
    const { useCase, userId } = await setup();

    await expect(
      useCase.update(userId, 'area-does-not-exist', parseUpdate({ name: '改名' })),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});
