/**
 * 背景几何档位的**词汇表**（UI-009）。
 *
 * 五个档位一档对一款几何（`none` = 关闭背景），切换入口在设置页的「外观」分区。
 * 之所以把它单独放一个文件、而不是写在组件里：这个联合类型同时被共享层的
 * `BackgroundField`、应用层的偏好存储与设置页消费，任何一处「另立一份清单」都会
 * 在下次增删档位时漂移出一份不完整的分支。
 */

/** 可选档位；顺序即设置页里的展示顺序。 */
export const BACKGROUND_CHOICES = ['tesseract', 'cell24', 'clifford', 'hopf', 'none'] as const;

export type BackgroundChoice = (typeof BACKGROUND_CHOICES)[number];

/** 把一段不可信的值（`localStorage`）收成档位；不在清单里的一律为 `false`。 */
export function isBackgroundChoice(value: unknown): value is BackgroundChoice {
  return typeof value === 'string' && (BACKGROUND_CHOICES as readonly string[]).includes(value);
}
