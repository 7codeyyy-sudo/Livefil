/**
 * 默认生活领域名单（IAM-003，《详细设计说明书》§4.8 的冻结表）。
 *
 * 名单取自 SRS 术语表对「生活领域」的六类举例，名称、color_key 与 `sortOrder`
 * 都是**冻结值**：改名会让已播种的用户与新用户看到两套分类，而分类的价值恰恰
 * 来自"大家指的是同一件事"。
 *
 * ## 播种条件（同样冻结）
 *
 * §4.8 明确：条件是该用户在 `life_areas` 中**一行都没有**（含已归档）时
 * **整体写入**六行——这是「首启播种」而不是「逐项补齐」。用户改名、归档、
 * 甚至把六个领域全部归档后重启，默认项都**不会复活**：复活会覆盖用户已经
 * 做出的整理，而整理本身正是这个功能存在的意义。
 *
 * 也正因如此，本文件不需要（也刻意不引入）任何 `seed_key` 列：判据是
 * 「行数为 0」，不是「这个名字还没有」。
 */
import type { LifeAreaSeed } from './life-area.ts';

export const DEFAULT_LIFE_AREAS: readonly LifeAreaSeed[] = Object.freeze([
  { sortOrder: 0, name: '工作', colorKey: 'blue' },
  { sortOrder: 1, name: '健康', colorKey: 'green' },
  { sortOrder: 2, name: '财务', colorKey: 'amber' },
  { sortOrder: 3, name: '关系', colorKey: 'rose' },
  { sortOrder: 4, name: '兴趣', colorKey: 'violet' },
  { sortOrder: 5, name: '家务', colorKey: 'teal' },
]);
