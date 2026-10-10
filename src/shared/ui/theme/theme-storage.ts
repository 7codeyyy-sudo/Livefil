/**
 * 主题偏好的本地持久化（UI-012，《UI 页面规范》v0.29 §2.4）。
 *
 * ## 为什么和背景档位一样存本地
 *
 * 主题是**纯客户端的显示偏好**（与 §3.4 背景档位同一口径）：它只决定这一台
 * 浏览器画哪套颜色，与用户数据无关，也不需要跨设备一致。为它立服务端字段要
 * 连带同步、迁移与失效规则，代价远大于收益。
 *
 * ## 键名为什么带版本号
 *
 * `.v1` 是给未来的退路：主题若从两档扩为「跟随系统」等多档，旧值可能不再是
 * 合法取值。版本一变就是另一条 key，旧值自然被忽略，不必写迁移代码。
 *
 * 读写都 try/catch：隐私模式、配额耗尽、被策略禁用时 `localStorage` 会**抛异常**，
 * 而「存不下偏好」的表现应当只是「下次回到默认亮色」，绝不能让页面打不开。
 */

/** 主题偏好的存储键（带版本号，见文件说明）。根布局的防闪引导脚本也读这一条。 */
export const THEME_STORAGE_KEY = 'livefil.theme.v1';

/** 主题档位。两档即全量：亮色（默认）与暗色。 */
export type Theme = 'light' | 'dark';

/** 可选档位（顺序即设置页渲染顺序）。 */
export const THEME_CHOICES = ['light', 'dark'] as const;

/** 默认档：与其他偏好一致，默认落**已验收的浅色**。 */
export const DEFAULT_THEME: Theme = 'light';

/** 运行时类型守卫：`localStorage` 里的东西是不可信输入。 */
export function isTheme(value: unknown): value is Theme {
  return value === 'light' || value === 'dark';
}

/** 读主题。缺失、损坏（手工改坏 / 旧格式）或读不出来时一律返回默认档。 */
export function readTheme(): Theme {
  try {
    const raw = window.localStorage.getItem(THEME_STORAGE_KEY);
    return isTheme(raw) ? raw : DEFAULT_THEME;
  } catch {
    // localStorage 本身不可用（隐私模式等）：按默认档处理。
    return DEFAULT_THEME;
  }
}

/** 写主题；失败只影响「下次是否还记得这一档」。 */
export function writeTheme(theme: Theme): void {
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // 配额耗尽 / 存储被禁用：不中断当前交互（见文件说明）。
  }
}
