/**
 * 设置页的 API 桩（IAM-002 / IAM-003 的浏览器用例用）。
 *
 * ## 为什么用 `page.route` 而不是浏览器端 MSW
 *
 * 项目明确不使用浏览器端 MSW（只把它当 Node 侧的集成测试工具）。`page.route`
 * 在**网络边界**上工作：被拦下的请求对页面而言与真实请求没有区别，因此
 * "取数失败 → 错误态 → 重试"这条链路是真的在跑，而不是被 mock 掉。
 *
 * ## 为什么是"状态化"的
 *
 * 桩内部维护一份内存数据（与真实端点的语义一致：版本自增、同名冲突、归档不占
 * 名字）。这样"保存后再刷新，值还在""归档后同名可以再建"这些**跨请求**的行为
 * 才能被验证——一个只会返回固定 JSON 的桩，会让所有写操作看起来都成功了。
 */
import type { Page, Route } from '@playwright/test';

/** 与 `UserDto` 同形的初始用户。 */
export interface StubProfile {
  id: string;
  mode: string;
  displayName: string | null;
  locale: string;
  timezone: string;
  currencyCode: string;
  weekStartsOn: number;
  defaultTaskDurationMinutes: number | null;
  defaultBufferMinutes: number | null;
  aiEnabled: boolean;
  aiDataConsent: boolean;
  reminderEnabled: boolean;
  quietHoursStart: string | null;
  quietHoursEnd: string | null;
  version: number;
}

export interface StubLifeArea {
  id: string;
  name: string;
  colorKey: string;
  sortOrder: number;
  isDefault: boolean;
  isArchived: boolean;
  version: number;
}

/** 下一次写请求要不要失败（用例通过它制造错误态）。 */
export type StubFailure = 'none' | 'server-error' | 'version-conflict';

export interface SettingsStub {
  profile: StubProfile;
  lifeAreas: StubLifeArea[];
  /** 收到过多少次 `PATCH /me`（用来断言"没有重复提交"）。 */
  patchCount: number;
  /** 下一次 `PATCH /me` 的行为。 */
  nextFailure: StubFailure;
}

/** 可写字段清单（与服务端 schema 的字段名一一对应）。 */
const SETTINGS_FIELDS = [
  'locale',
  'timezone',
  'currencyCode',
  'weekStartsOn',
  'defaultTaskDurationMinutes',
  'defaultBufferMinutes',
  'aiEnabled',
  'aiDataConsent',
  'reminderEnabled',
  'quietHoursStart',
  'quietHoursEnd',
] as const;

const INITIAL_PROFILE: StubProfile = {
  id: 'user-0001',
  mode: 'local',
  displayName: null,
  locale: 'zh-CN',
  timezone: 'Asia/Shanghai',
  currencyCode: 'CNY',
  weekStartsOn: 1,
  defaultTaskDurationMinutes: null,
  defaultBufferMinutes: null,
  aiEnabled: false,
  aiDataConsent: false,
  reminderEnabled: true,
  quietHoursStart: null,
  quietHoursEnd: null,
  version: 1,
};

const INITIAL_LIFE_AREAS: readonly Omit<StubLifeArea, 'id'>[] = [
  { name: '工作', colorKey: 'blue', sortOrder: 0, isDefault: true, isArchived: false, version: 1 },
  { name: '健康', colorKey: 'green', sortOrder: 1, isDefault: true, isArchived: false, version: 1 },
];

function json(route: Route, data: unknown, status = 200): Promise<void> {
  return route.fulfill({
    status,
    contentType: 'application/json',
    body: JSON.stringify({ data, meta: { requestId: 'stub' } }),
  });
}

function failure(route: Route, status: number, code: string, message: string): Promise<void> {
  return route.fulfill({
    status,
    contentType: 'application/json',
    body: JSON.stringify({ error: { code, message, requestId: 'stub' } }),
  });
}

/** 从请求体里挑出设置字段（多余的键一律忽略，与服务端的严格校验相反方向安全）。 */
function pickSettings(body: Record<string, unknown>): Partial<StubProfile> {
  const picked: Record<string, unknown> = {};
  for (const field of SETTINGS_FIELDS) {
    if (field in body) {
      picked[field] = body[field];
    }
  }
  return picked as Partial<StubProfile>;
}

/**
 * 安装桩并返回可变状态。
 *
 * @param page Playwright 页面。
 * @param overrides 初始覆盖（例如预置一个已归档领域）。
 */
export async function installSettingsStub(
  page: Page,
  overrides: {
    readonly profile?: Partial<StubProfile>;
    readonly lifeAreas?: readonly StubLifeArea[];
  } = {},
): Promise<SettingsStub> {
  const state: SettingsStub = {
    profile: { ...INITIAL_PROFILE, ...overrides.profile },
    lifeAreas:
      overrides.lifeAreas === undefined
        ? INITIAL_LIFE_AREAS.map((area, index) => ({ ...area, id: `area-${String(index + 1)}` }))
        : overrides.lifeAreas.map((area) => ({ ...area })),
    patchCount: 0,
    nextFailure: 'none',
  };

  let sequence = state.lifeAreas.length;

  await page.route('**/api/v1/**', async (route) => {
    const request = route.request();
    const method = request.method();
    const path = new URL(request.url()).pathname;
    const body =
      request.postData() === null
        ? {}
        : (JSON.parse(request.postData() ?? '{}') as Record<string, unknown>);

    // ---- /me ----
    if (path === '/api/v1/me' && method === 'GET') {
      return json(route, state.profile);
    }

    if (path === '/api/v1/me' && method === 'PATCH') {
      if (state.nextFailure === 'server-error') {
        state.nextFailure = 'none';
        return failure(route, 500, 'DEPENDENCY_UNAVAILABLE', '服务端暂时不可用');
      }
      if (state.nextFailure === 'version-conflict') {
        state.nextFailure = 'none';
        return failure(route, 409, 'CONFLICT', '设置已被其他操作修改，请刷新后重试');
      }
      if (body.version !== state.profile.version) {
        return failure(route, 409, 'CONFLICT', '设置已被其他操作修改，请刷新后重试');
      }

      state.patchCount += 1;
      state.profile = {
        ...state.profile,
        ...pickSettings(body),
        version: state.profile.version + 1,
      };
      return json(route, state.profile);
    }

    // ---- /life-areas ----
    if (path === '/api/v1/life-areas' && method === 'GET') {
      return json(route, { items: [...state.lifeAreas].sort((a, b) => a.sortOrder - b.sortOrder) });
    }

    if (path === '/api/v1/life-areas' && method === 'POST') {
      const name = typeof body.name === 'string' ? body.name : '';
      const colorKey = typeof body.colorKey === 'string' ? body.colorKey : 'blue';
      const clash = state.lifeAreas.some((area) => !area.isArchived && area.name === name);
      if (clash) {
        return failure(route, 409, 'CONFLICT', `已存在同名的未归档领域：${name}`);
      }
      sequence += 1;
      const created: StubLifeArea = {
        id: `area-${String(sequence)}`,
        name,
        colorKey,
        sortOrder: state.lifeAreas.reduce((max, area) => Math.max(max, area.sortOrder), -1) + 1,
        isDefault: false,
        isArchived: false,
        version: 1,
      };
      state.lifeAreas.push(created);
      return json(route, created);
    }

    if (path === '/api/v1/life-areas/reorder' && method === 'POST') {
      const orderedIds = Array.isArray(body.orderedIds) ? (body.orderedIds as string[]) : [];
      orderedIds.forEach((id, index) => {
        const area = state.lifeAreas.find((item) => item.id === id);
        if (area !== undefined) {
          area.sortOrder = index;
          area.version += 1;
        }
      });
      return json(route, {
        items: state.lifeAreas
          .filter((area) => !area.isArchived)
          .sort((a, b) => a.sortOrder - b.sortOrder),
      });
    }

    const itemMatch = /^\/api\/v1\/life-areas\/([^/]+)$/.exec(path);
    if (itemMatch !== null && method === 'PATCH') {
      const id = itemMatch[1] ?? '';
      const area = state.lifeAreas.find((item) => item.id === id);
      if (area === undefined) {
        return failure(route, 404, 'NOT_FOUND', '生活领域不存在');
      }
      if (typeof body.name === 'string') {
        area.name = body.name;
      }
      if (typeof body.colorKey === 'string') {
        area.colorKey = body.colorKey;
      }
      if (typeof body.isArchived === 'boolean') {
        area.isArchived = body.isArchived;
      }
      area.version += 1;
      return json(route, area);
    }

    // 其它端点（如 /goals）本批不存在——按真实兜底返回结构化 404。
    return failure(route, 404, 'NOT_FOUND', '资源不存在');
  });

  return state;
}
