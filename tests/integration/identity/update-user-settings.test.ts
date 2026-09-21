// @vitest-environment node
/**
 * 更新用户设置（IAM-002，《详细设计说明书》§4.7）。
 *
 * 覆盖三类规则：乐观并发（409）、跨字段约束（AI 同意、安静时段）、以及
 * **显式清空**与"未提供"的区别——最后这一类最容易写错，因为它只在下一次读取时
 * 才暴露（用户点了"关闭安静时段"，服务端却把原值恢复回来）。
 */
import { describe, expect, it } from 'vitest';

import { UpdateUserSettingsUseCase } from '../../../src/modules/identity/application/update-user-settings.ts';
import { updateUserSettingsSchema } from '../../../src/modules/identity/application/user-settings-schema.ts';
import {
  ConflictError,
  NotFoundError,
  ValidationError,
} from '../../../src/shared/errors/app-error.ts';
import {
  createFakeAuditLogger,
  createFakeDatabase,
  createFakeUserRepository,
} from '../../helpers/fake-repositories.ts';

async function setup() {
  const database = createFakeDatabase();
  const users = createFakeUserRepository(database);
  const audit = createFakeAuditLogger();
  const { user } = await users.ensureLocalUser([]);
  const useCase = new UpdateUserSettingsUseCase({ users, audit });

  return { database, users, audit, useCase, userId: user.id, user };
}

/**
 * 走一遍真实的校验层，再用例层执行。
 *
 * 这样做而不是直接构造对象：`PATCH /me` 的实际链路是「Zod 校验 → 用例」，
 * 绕过校验等于测了一个生产上不存在的输入面。
 */
function parse(body: unknown) {
  return updateUserSettingsSchema.parse(body);
}

describe('正常路径', () => {
  it('更新单个字段并自增版本', async () => {
    const { useCase, userId, user } = await setup();

    const updated = await useCase.execute(
      userId,
      parse({ timezone: 'Asia/Tokyo', version: user.version }),
    );

    expect(updated.settings.timezone).toBe('Asia/Tokyo');
    expect(updated.version).toBe(user.version + 1);
    // 未提及的字段保持不变（补丁语义）。
    expect(updated.settings.currencyCode).toBe(user.settings.currencyCode);
  });

  it('写入成功会留下一条 DATA_UPDATED 审计事件，且不含字段明细', async () => {
    const { useCase, userId, user, audit } = await setup();

    await useCase.execute(userId, parse({ locale: 'en-US', version: user.version }), 'req-1');

    expect(audit.events).toHaveLength(1);
    expect(audit.events[0]?.type).toBe('DATA_UPDATED');
    expect(audit.events[0]?.requestId).toBe('req-1');
    // 审计事件的结构里根本没有"改了哪些字段"的位置（SRS §6.7）——
    // 设置里有 AI 数据同意这类隐私项，不该被复制进另一份长期留存的数据。
    expect(Object.keys(audit.events[0] ?? {})).not.toContain('fields');
  });

  it('显式传 null 会真的清空安静时段（不被"未提供"吞掉）', async () => {
    const { useCase, userId, user } = await setup();

    const withQuietHours = await useCase.execute(
      userId,
      parse({ quietHoursStart: '22:00', quietHoursEnd: '07:00', version: user.version }),
    );
    expect(withQuietHours.settings.quietHoursStart).toBe('22:00');

    const cleared = await useCase.execute(
      userId,
      parse({ quietHoursStart: null, quietHoursEnd: null, version: withQuietHours.version }),
    );

    expect(cleared.settings.quietHoursStart).toBeNull();
    expect(cleared.settings.quietHoursEnd).toBeNull();
  });
});

describe('乐观并发', () => {
  it('版本不符时抛 409，且不写入任何改动', async () => {
    const { useCase, userId, user, users } = await setup();

    await useCase.execute(userId, parse({ locale: 'en-US', version: user.version }));

    await expect(
      useCase.execute(userId, parse({ currencyCode: 'USD', version: user.version })),
    ).rejects.toBeInstanceOf(ConflictError);

    // 冲突之后库里应当仍是第一次写入的结果，而不是"部分成功"。
    const current = await users.findById(userId);
    expect(current?.settings.currencyCode).toBe('CNY');
    expect(current?.settings.locale).toBe('en-US');
  });
});

describe('跨字段约束', () => {
  it('开启 AI 但未同意数据发送 → 422', async () => {
    const { useCase, userId, user } = await setup();

    await expect(
      useCase.execute(userId, parse({ aiEnabled: true, version: user.version })),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('同时开启 AI 与同意 → 通过', async () => {
    const { useCase, userId, user } = await setup();

    const updated = await useCase.execute(
      userId,
      parse({ aiEnabled: true, aiDataConsent: true, version: user.version }),
    );

    expect(updated.settings.aiEnabled).toBe(true);
    expect(updated.settings.aiDataConsent).toBe(true);
  });

  it('已同意后只开关 AI 是允许的（约束看的是合并后的状态，不是补丁）', async () => {
    const { useCase, userId, user } = await setup();

    const consented = await useCase.execute(
      userId,
      parse({ aiDataConsent: true, version: user.version }),
    );
    const enabled = await useCase.execute(
      userId,
      parse({ aiEnabled: true, version: consented.version }),
    );

    expect(enabled.settings.aiEnabled).toBe(true);
  });

  it('安静时段只给开始或只给结束 → 422', async () => {
    const { useCase, userId, user } = await setup();

    await expect(
      useCase.execute(userId, parse({ quietHoursStart: '22:00', version: user.version })),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('安静时段起止相同 → 422（零长度与整天都能解释，与其猜不如拒绝）', async () => {
    const { useCase, userId, user } = await setup();

    await expect(
      useCase.execute(
        userId,
        parse({ quietHoursStart: '22:00', quietHoursEnd: '22:00', version: user.version }),
      ),
    ).rejects.toBeInstanceOf(ValidationError);
  });
});

describe('非法输入', () => {
  it('未知字段被拒绝（拼错字段名不该得到 200）', () => {
    expect(() => parse({ currency: 'USD', version: 1 })).toThrow();
  });

  it('缺少 version 被拒绝（乐观并发的前提）', () => {
    expect(() => parse({ locale: 'en-US' })).toThrow();
  });

  it('不在受支持集合内的时区被拒绝', () => {
    expect(() => parse({ timezone: 'Mars/Olympus', version: 1 })).toThrow();
  });

  it('货币代码必须是三位大写字母', () => {
    expect(() => parse({ currencyCode: 'cny', version: 1 })).toThrow();
  });

  it('非正数的默认时长被拒绝', () => {
    expect(() => parse({ defaultTaskDurationMinutes: 0, version: 1 })).toThrow();
    expect(() => parse({ defaultBufferMinutes: -1, version: 1 })).toThrow();
  });

  it('周起始日只接受 0~6', () => {
    expect(() => parse({ weekStartsOn: 7, version: 1 })).toThrow();
  });
});

describe('用户不存在', () => {
  it('抛 NotFoundError 而不是静默建一份设置', async () => {
    const { useCase } = await setup();

    await expect(
      useCase.execute('user-does-not-exist', parse({ locale: 'en-US', version: 1 })),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});
