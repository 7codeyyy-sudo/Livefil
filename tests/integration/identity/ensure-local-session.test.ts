// @vitest-environment node
/**
 * 本地会话初始化（IAM-001，《详细设计说明书》§4.6）。
 *
 * 用内存仓储而不是数据库：本用例要验的是**用例层的判定**——什么时候复用
 * 会话、什么时候重新建立、播种发生几次。这些都和 PostgreSQL 无关，用真库
 * 跑只会让它们在没装数据库的机器上无法执行。
 */
import { describe, expect, it } from 'vitest';

import { createSessionSigner } from '../../../src/infrastructure/auth/session-signer.ts';
import { EnsureLocalSessionUseCase } from '../../../src/modules/identity/application/ensure-local-session.ts';
import { DEFAULT_LIFE_AREAS } from '../../../src/modules/life-areas/domain/default-life-areas.ts';
import {
  createFakeDatabase,
  createFakeLifeAreaRepository,
  createFakeUserRepository,
} from '../../helpers/fake-repositories.ts';

/** 测试密钥：长度必须满足签名器的下限（32）。它不是任何真实环境的密钥。 */
const TEST_SECRET = 'unit-test-session-secret-0123456789ab';
const FIXED_NOW = 1_760_000_000_000;

function setup() {
  const database = createFakeDatabase();
  const users = createFakeUserRepository(database);
  const lifeAreas = createFakeLifeAreaRepository(database);
  const signer = createSessionSigner({ secret: TEST_SECRET });
  const useCase = new EnsureLocalSessionUseCase({
    users,
    signer,
    lifeAreaSeeds: DEFAULT_LIFE_AREAS,
    now: () => FIXED_NOW,
  });

  return { database, users, lifeAreas, signer, useCase };
}

describe('无令牌时建立本地会话', () => {
  it('创建唯一本地用户，并在同一动作里播种默认领域', async () => {
    const { database, useCase } = setup();

    const result = await useCase.execute({ sessionToken: null });

    expect(result.created).toBe(true);
    expect(result.mode).toBe('local');
    expect(result.issuedToken).not.toBeNull();
    expect(database.users).toHaveLength(1);
    expect(database.lifeAreas).toHaveLength(DEFAULT_LIFE_AREAS.length);
    // 播种的领域都属于刚建出来的那个用户（不是"凭空多出六行"）。
    expect(database.lifeAreas.every((area) => area.userId === result.userId)).toBe(true);
  });

  it('下发的令牌可被自己的签名器验证，且载荷指向该用户', async () => {
    const { signer, useCase } = setup();

    const result = await useCase.execute({ sessionToken: null });
    const payload = signer.verify(result.issuedToken ?? '');

    expect(payload?.userId).toBe(result.userId);
    expect(payload?.issuedAt).toBe(FIXED_NOW);
  });
});

describe('已有有效令牌时复用会话', () => {
  it('不重复建用户，也不重设 Cookie', async () => {
    const { database, useCase } = setup();

    const first = await useCase.execute({ sessionToken: null });
    const second = await useCase.execute({ sessionToken: first.issuedToken });

    expect(second.userId).toBe(first.userId);
    expect(second.created).toBe(false);
    // `issuedToken: null` 的语义是"当前 Cookie 仍然有效，不必重设"。
    // 每次请求都重设会让每个响应都带上无意义的 Set-Cookie。
    expect(second.issuedToken).toBeNull();
    expect(database.users).toHaveLength(1);
  });
});

describe('坏令牌按「没有会话」处理', () => {
  it('签名被篡改的令牌不产生错误，只重新建立会话', async () => {
    const { useCase } = setup();
    const first = await useCase.execute({ sessionToken: null });

    const tampered = `${first.issuedToken ?? ''}x`;
    const second = await useCase.execute({ sessionToken: tampered });

    // 关键：坏 Cookie 是常态（清过站点数据、手工改过值），它必须走"重新建立"
    // 这条正常路径，而不是抛异常——把常态做成异常会让真正的异常被噪音淹没。
    expect(second.userId).toBe(first.userId);
    expect(second.issuedToken).not.toBeNull();
  });

  it('另一个密钥签的令牌同样不被接受', async () => {
    const { database, useCase } = setup();
    const otherSigner = createSessionSigner({ secret: 'another-secret-0123456789abcdefgh' });
    const forged = otherSigner.sign({ userId: 'someone-else', issuedAt: FIXED_NOW });

    const result = await useCase.execute({ sessionToken: forged });

    // 不是"someone-else"，而是本机的那个本地用户：一个签名不对的令牌
    // 绝不能决定"当前用户是谁"。
    expect(result.userId).not.toBe('someone-else');
    expect(result.created).toBe(true);
    expect(database.users.map((user) => user.id)).not.toContain('someone-else');
  });
});

describe('令牌指向已不存在的用户时重建会话', () => {
  it('签名有效但用户不在库里，则重新初始化而不是发一个指向空用户的会话', async () => {
    const { database, signer, useCase } = setup();
    // 先建出真实用户，再手工删掉它——模拟"库被重建过"（本地开发很常见）。
    const first = await useCase.execute({ sessionToken: null });
    database.users.length = 0;

    const payload = signer.verify(first.issuedToken ?? '');
    expect(payload).not.toBeNull();

    const result = await useCase.execute({ sessionToken: first.issuedToken });

    expect(result.created).toBe(true);
    expect(result.userId).not.toBe(first.userId);
    expect(database.users).toHaveLength(1);
  });
});

describe('幂等', () => {
  it('连续初始化两次仍然只有一个用户、一份领域', async () => {
    const { database, useCase } = setup();

    await useCase.execute({ sessionToken: null });
    await useCase.execute({ sessionToken: null });

    expect(database.users).toHaveLength(1);
    expect(database.lifeAreas).toHaveLength(DEFAULT_LIFE_AREAS.length);
  });

  it('并发初始化也只产生一个用户（内存实现下验证幂等判定）', async () => {
    const { database, useCase } = setup();

    const results = await Promise.all([
      useCase.execute({ sessionToken: null }),
      useCase.execute({ sessionToken: null }),
      useCase.execute({ sessionToken: null }),
    ]);

    expect(database.users).toHaveLength(1);
    expect(new Set(results.map((result) => result.userId)).size).toBe(1);
    // 真实并发（两个进程同时首启）由 schema 的部分唯一索引兜住，
    // 那一条在 `tests/db` 的真机用例里验证——内存实现无法证明它。
  });
});

describe('播种只发生一次', () => {
  it('用户把默认领域全部归档后再次初始化，默认项不会复活', async () => {
    const { database, lifeAreas, useCase } = setup();
    const first = await useCase.execute({ sessionToken: null });

    // 全部归档：这是用户做出的整理，重启不该把它撤销。
    for (const area of await lifeAreas.listByUser(first.userId, { includeArchived: false })) {
      await lifeAreas.update(first.userId, area.id, { isArchived: true });
    }

    await useCase.execute({ sessionToken: null });

    const all = await lifeAreas.listByUser(first.userId, { includeArchived: true });
    expect(all).toHaveLength(DEFAULT_LIFE_AREAS.length);
    expect(all.every((area) => area.isArchived)).toBe(true);
    expect(database.lifeAreas).toHaveLength(DEFAULT_LIFE_AREAS.length);
  });
});
