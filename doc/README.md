# Livefil 文档目录

Livefil 是一个面向个人用户的生活管理与自律系统，覆盖排程、目标、习惯、执行记录、开销和复盘。

## 文档结构

```text
doc/
├─ 01-research/              # 业务、用户、行为科学和竞品调研
├─ 02-project-initiation/    # 项目立项、目标、预算、工期和风险
├─ 03-requirements/          # 需求规格说明书 SRS
├─ 04-product-design/        # 产品流程、交互和 UI 页面规范
├─ 05-technical-design/      # 架构、详细设计、数据库和接口
└─ 06-development-plan/      # 分阶段开发任务、环境规范和 AI 执行规则
```

## 推荐阅读顺序

1. [业务调研报告](./01-research/生活自律与生活管理产品调研报告.md)
2. [项目立项书](./02-project-initiation/项目立项书.md)
3. [需求规格说明书 SRS](./03-requirements/需求规格说明书_SRS.md)
4. [产品设计说明书](./04-product-design/产品设计说明书.md)
5. [UI 页面规范](./04-product-design/UI页面规范.md)
6. [产品与技术设计决策清单](./05-technical-design/产品与技术设计决策清单.md)
7. [概要设计说明书](./05-technical-design/概要设计说明书.md)
8. [详细设计说明书](./05-technical-design/详细设计说明书.md)
9. [数据库设计文档](./05-technical-design/数据库设计文档.md)
10. [接口文档](./05-technical-design/接口文档.md)
11. [开发任务清单](./06-development-plan/开发任务清单.md)
12. [开发环境规范](./06-development-plan/开发环境规范.md)

## 原型

PC Web 原型位于项目目录下：

[prototype/index.html](../prototype/index.html)

## 文档状态

- 调研、立项和需求阶段：已形成第一版文档。
- 产品和技术设计：已形成第一版设计文档。
- UI：浅色主题第一版；深色主题、多语言、多时区和移动端作为后续扩展。
- 技术：Next.js + TypeScript + API-first 模块化单体 + PostgreSQL + 云端草稿同步。
