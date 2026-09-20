/**
 * 界面语言集合（IAM-002）。
 *
 * ## 为什么在共享层，而不是模块的校验 schema 里
 *
 * 服务端校验与客户端表单**必须用同一份清单**，而客户端不能 import 模块的校验
 * schema——那会把 zod 整个打进客户端包，为了两个字符串不值得。清单因此下沉到
 * 两侧都能引用的共享层：服务端 schema 用 `z.enum(SUPPORTED_LOCALES)`，客户端的
 * `<select>` 直接用同一个数组。
 *
 * 这是**最小集**：产品当前只有中文界面，`en-US` 是为验证"locale 会被真正校验"
 * 而保留的第二个取值。真实的多语言支持（文案资源、日期与数字格式化）随 I18N
 * 需求扩展，届时这份清单应当从语言包索引推导，而不是手工维护。
 */

export const SUPPORTED_LOCALES = ['zh-CN', 'en-US'] as const;

export type SupportedLocale = (typeof SUPPORTED_LOCALES)[number];

/**
 * 语言的显示名。
 *
 * 类型写成 `Record<SupportedLocale, string>` 而不是普通对象：新增一个语言而忘记
 * 补显示名时**编译期就会失败**。用一个自由形状的对象，漏掉的那个会在界面上
 * 渲染成 `undefined`——而"某一行显示 undefined"只会在有人恰好切到那个语言时才
 * 被发现。
 */
export const LOCALE_LABELS: Readonly<Record<SupportedLocale, string>> = Object.freeze({
  'zh-CN': '简体中文',
  'en-US': 'English',
});

/** 判断任意字符串是否为受支持的界面语言。 */
export function isSupportedLocale(value: string): value is SupportedLocale {
  return (SUPPORTED_LOCALES as readonly string[]).includes(value);
}
