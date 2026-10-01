/**
 * 新手引导进度的本地持久化（《UI 页面规范》v0.22 §5 A，AI-001）。
 *
 * ## 为什么存本地而不是服务端
 *
 * §5 A 把引导进度定义为**纯客户端**的一件小事：它只影响"这一台浏览器要不要
 * 自动显示引导条"，与用户数据无关，也不需要跨设备一致（换设备重看一遍不是
 * 损失）。为它立一张服务端表要连带同步、迁移与失效规则，代价远大于收益。
 *
 * ## 为什么要带版本号
 *
 * key 里的 `.v1` 是**给未来的自己留的退路**：四步文案与判定口径一旦改动，旧值
 * 可能语义不同（例如 `step` 的序号含义变了）。版本号变了就是另一条 key，旧值
 * 自然被忽略，不必写迁移代码。读写都 try/catch：隐私模式、配额耗尽、被策略
 * 禁用时 `localStorage` 会**抛异常**，而"存不下进度"的表现应当只是"下次再看
 * 一遍引导"，绝不能让 `/today` 打不开。
 */

/** 进度的存储键（带版本号，见文件说明）。 */
export const GUIDE_STORAGE_KEY = 'livefil.guide.v1';

/** 引导进度。 */
export type GuideState = {
  /** 四步全部走完。 */
  readonly completed: boolean;
  /** 用户按过「跳过」或「×」——停止自动出现，进度保留。 */
  readonly dismissed: boolean;
  /** 已完成的前缀长度（0–4）：`step = n` 表示前 n 步判定通过。 */
  readonly step: number;
};

/** 初始进度：没看过、四步都没走。 */
export const INITIAL_GUIDE_STATE: GuideState = {
  completed: false,
  dismissed: false,
  step: 0,
};

/**
 * 读进度。
 *
 * 缺失、损坏（手工改坏 / 旧格式）或读不出来时一律返回初始值——`localStorage`
 * 里的东西是**不可信输入**，一个形状不符的值不该让引导进入"第 NaN / 4 步"。
 */
export function readGuideState(): GuideState {
  try {
    const raw = window.localStorage.getItem(GUIDE_STORAGE_KEY);
    if (raw === null) {
      return INITIAL_GUIDE_STATE;
    }
    return parseGuideState(JSON.parse(raw));
  } catch {
    // JSON 坏了、或 localStorage 本身不可用（隐私模式等）：按"从没看过"处理。
    return INITIAL_GUIDE_STATE;
  }
}

/** 写进度；失败只影响"下次是否还要再看一遍"。 */
export function writeGuideState(state: GuideState): void {
  try {
    window.localStorage.setItem(GUIDE_STORAGE_KEY, JSON.stringify(state));
  } catch {
    // 配额耗尽 / 存储被禁用：不中断当前交互（见文件说明）。
  }
}

/** 把一段未知值收成进度形状；任一字段不是预期类型时退回该字段的初始值。 */
function parseGuideState(value: unknown): GuideState {
  if (typeof value !== 'object' || value === null) {
    return INITIAL_GUIDE_STATE;
  }

  const { completed, dismissed, step } = value as Readonly<Record<string, unknown>>;

  return {
    completed: completed === true,
    dismissed: dismissed === true,
    step: typeof step === 'number' && Number.isInteger(step) && step >= 0 ? step : 0,
  };
}
