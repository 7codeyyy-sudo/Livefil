/**
 * 用户领域类型（DB-001 / IAM-001，《数据库设计文档》§4.1）。
 *
 * 领域层不依赖 Next.js、HTTP 或 PostgreSQL（《概要设计》§4.4），因此这里的类型
 * 是**纯数据结构 + 业务约束**：没有 Drizzle 的行类型、没有请求/响应形状。
 * 从数据库行到本类型的映射由 `infrastructure` 负责，反向亦然。
 */

/** 数据模式。本批只写入 `local`；`cloud` 随云端批次（决策 T-006 挂账）。 */
export type UserMode = 'local' | 'cloud';

/**
 * 用户设置（IAM-002 的可编辑字段集）。
 *
 * `null` 与"未设置"是同一件事：`defaultTaskDurationMinutes` 这类列在库里允许为
 * 空（用户没确认过自己的习惯），而 0 是有意义的取值（"不需要缓冲"），所以
 * 不能用 0 代替缺省。
 */
export interface UserSettings {
  readonly locale: string;
  readonly timezone: string;
  readonly currencyCode: string;
  /** 周起始日，0（周日）– 6（周六）。 */
  readonly weekStartsOn: number;
  readonly defaultTaskDurationMinutes: number | null;
  readonly defaultBufferMinutes: number | null;
  readonly aiEnabled: boolean;
  readonly aiDataConsent: boolean;
  readonly reminderEnabled: boolean;
  /** 安静时段起止，`HH:MM:SS`（`time` 列的字符串形态）。两者同为空或同有值。 */
  readonly quietHoursStart: string | null;
  readonly quietHoursEnd: string | null;
}

/** 用户实体。 */
export interface User {
  readonly id: string;
  readonly mode: UserMode;
  readonly displayName: string | null;
  readonly settings: UserSettings;
  /**
   * 乐观并发版本（`PATCH /me` 用）。
   *
   * 由仓储在每次写入时自增；读取方拿到的旧版本再提交，就会得到冲突而不是
   * 静默覆盖——两台设备同时改设置时，这一点决定了改动是"丢失"还是"被发现"。
   */
  readonly version: number;
}

/**
 * 设置补丁：键存在即"要改这一项"。
 *
 * 值类型显式带上 `| undefined`（而不是用 `Partial<UserSettings>`）：项目开启了
 * `exactOptionalPropertyTypes`，那里"可选属性"与"可能为 undefined 的属性"是两回事。
 * 校验层（Zod）产出的可选字段天然带 `undefined`，而补丁的语义也确实接受它——
 * 显式传 `undefined` 与不传同样表示"不改这一项"。写成 `Partial` 会让每个调用点
 * 都要手工剥掉 undefined 键，那是一段没有表达力的噪音。
 */
export type UserSettingsPatch = {
  readonly [K in keyof UserSettings]?: UserSettings[K] | undefined;
};

/**
 * 首启播种一个生活领域所需的最小信息。
 *
 * 结构上与 `life-areas` 领域的 `LifeAreaSeed` 一致（TS 的结构类型让两者可以直接
 * 互传），但**刻意不在两边互相 import**：种子是"建用户时顺带写下去的附属数据"，
 * 让它成为两个领域模块之间的编译期依赖，会把一次引导动作变成长期的模块耦合。
 * 名单本身归 `life-areas` 领域（`default-life-areas.ts`）。
 */
export interface LocalUserSeedArea {
  readonly name: string;
  readonly colorKey: string;
  readonly sortOrder: number;
}
