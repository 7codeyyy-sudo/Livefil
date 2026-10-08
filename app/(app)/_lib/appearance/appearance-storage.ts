/**
 * 全站装饰性背景档位的本地持久化（UI-009）。
 *
 * ## 为什么存本地而不是服务端
 *
 * 背景档位是**纯客户端的视觉偏好**（《UI 页面规范》v0.24 §3.4 / §5 对同类偏好给出的
 * 口径）：它只决定"这一台浏览器画哪一款几何"，与用户数据无关，也不需要跨设备
 * 一致（换设备重挑一次不是损失）。为它立一张服务端表要连带同步、迁移与失效规则，
 * 代价远大于收益。
 *
 * ## 为什么要带版本号
 *
 * key 里的 `.v1` 是**给未来的自己留的退路**：可选档位一旦增删，旧值可能不再是
 * 合法取值。版本号变了就是另一条 key，旧值自然被忽略，不必写迁移代码。
 *
 * 读写都 try/catch：隐私模式、配额耗尽、被策略禁用时 `localStorage` 会**抛异常**，
 * 而"存不下偏好"的表现应当只是"下次回到默认档"，绝不能让页面打不开。
 */

import { isBackgroundChoice } from '@/shared/ui/layout/BackgroundField/BackgroundField.types';
import type { BackgroundChoice } from '@/shared/ui/layout/BackgroundField/BackgroundField.types';

/** 档位的存储键（带版本号，见文件说明）。 */
export const APPEARANCE_STORAGE_KEY = 'livefil.appearance.v1';

/** 默认档：默认就能看到背景，关闭由用户自己在设置里选。 */
export const DEFAULT_BACKGROUND_CHOICE: BackgroundChoice = 'tesseract';

/**
 * 读档位。
 *
 * 缺失、损坏（手工改坏 / 旧格式）或读不出来时一律返回默认档——`localStorage`
 * 里的东西是**不可信输入**，一个非法取值不该让背景渲染到未知状态。
 */
export function readBackgroundChoice(): BackgroundChoice {
  try {
    const raw = window.localStorage.getItem(APPEARANCE_STORAGE_KEY);
    return isBackgroundChoice(raw) ? raw : DEFAULT_BACKGROUND_CHOICE;
  } catch {
    // localStorage 本身不可用（隐私模式等）：按默认档处理。
    return DEFAULT_BACKGROUND_CHOICE;
  }
}

/** 写档位；失败只影响"下次是否还记得这一档"。 */
export function writeBackgroundChoice(choice: BackgroundChoice): void {
  try {
    window.localStorage.setItem(APPEARANCE_STORAGE_KEY, choice);
  } catch {
    // 配额耗尽 / 存储被禁用：不中断当前交互（见文件说明）。
  }
}
