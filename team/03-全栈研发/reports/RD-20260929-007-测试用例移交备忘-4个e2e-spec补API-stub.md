---
编号: RD-20260929-007
日期: 2026-09-29
来源: 全栈研发
去向: 测试交付岗（经项目总监转发）
类型: 移交备忘（无产品代码改动）
状态: 已转交·待销账（期限：Phase 8 测试轮启动前）
关联: 项目总监 2026-09-29 处置裁定第 3 项；commit `b9632ea`（暂缓纳入留痕）；QA-20260929-002 用例清单表第 11–14 行；`tests/e2e/support/api-stub.ts`（既有 stub 先例）；`.github/workflows/ci.yml`（browser-e2e 无 services / 无 DATABASE_URL）
---

## 一、转交依据

项目总监 2026-09-29 处置裁定第 3 项原文：

> 维持留置，退回测试交付岗：补 API stub → 4 spec 转绿 → 单独小 PR 入库。期限 = Phase 8 测试轮启动前销账；若 QA 判定已被 623 基线覆盖替代，则书面作废留痕（二选一必须闭环，不许无限期挂着）。tests/ 红线：只有测试交付岗能改，经您转发该小任务。

研发侧据此出本备忘完成转交。**`tests/` 归测试交付岗维护（岗位红线 24），研发不改动其中任何文件**，故不代为修补。

## 二、转交对象（4 个文件，工作区未跟踪、位置不变）

| # | 文件 | 关联用例（QA-20260929-002 清单表） | 条数 |
|---|---|---|---|
| 1 | `tests/e2e/category-management-a6.spec.ts` | 第 12 行「A6 分类管理交互」 | 3 |
| 2 | `tests/e2e/review-b1b2-morphology.spec.ts` | 第 13 行「B1/B2 形态」 | 4 |
| 3 | `tests/e2e/review-skip-freeze.spec.ts` | 第 11 行「UI 补节冻结文本」 | 3 |
| 4 | `tests/e2e/week-view-b4-link.spec.ts` | 第 14 行「week 视图与 B4 链接」 | 4 |

合计 14 例。

## 三、缺 stub 证据（研发独立复核，结论与总监复核一致）

- 关键词检索 `stub|useApiStub|installApiStub|mockApi`（不区分大小写）命中 `tests/e2e/` 共 **11 个文件**：4 个支撑件（`support/api-stub.ts`、`support/settings-api-stub.ts`、`support/sync-stub.ts`、`support/fake-sync-server.ts`）+ **7 个 spec**（`home` / `settings` / `page-state` / `tokens` / `sync-lan` / `sync-offline` / `sync-status`）。
- 上述 4 个留置 spec **零命中**——直接打真实接口，未采用既有 `page.route` 拦截模式。
- `commit b9632ea` 已留痕：
  > 四个 spec 直接打真实接口，未采用既有 `tests/e2e/support/*-stub.ts` 的拦截模式。证据：本机 5432/5433 未监听、所有 DB 路由返回 500 → desktop 段 5 例失败……
- CI 事实（`.github/workflows/ci.yml`）：`browser-e2e` 无 `services:`、不注入 `DATABASE_URL`，仅注入 `AUTH_SECRET`——即 CI 环境同样无库，直接纳入这 4 个 spec 会使 `browser-e2e` 转红。

## 四、销账条件（二选一，必须闭环）

- **A 修复路径（推荐）**：按既有 stub 模式补齐拦截 → 4 spec 转绿 → **单独小 PR** 入库。因 `tests/` 归测试交付岗，故须独立于研发的 docs/代码 PR。
- **B 作废路径**：若 QA 判定该 4 项已被 623 基线覆盖替代 → **书面作废留痕**，注明作废理由与被替代的覆盖关系。

**期限**：Phase 8 测试轮启动前销账。

## 五、研发侧边界与现状

- 研发**未改动** `tests/` 下任何文件；本备忘为研发侧唯一产出（纯文档）。
- 4 个文件保持工作区未跟踪、位置不变（`b9632ea` 已留痕）。
- 产品代码（`src/`、`app/`、`drizzle/`、`scripts/`）零改动。
- 本备忘随「下批」docs 批次入库，与 `doc/04`（UI 页面规范 v0.22 冻结）、`PD-20260929-016`（总监预览稿）同批提交。

## 六、可复用线索（供测试岗起步，不构成改动）

- stub 写法：`page.route('**/api/v1/<path>*', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(信封) }))`，**必须在 `page.goto` 之前注册**（`page.route` 只对注册后发出的请求生效，页面挂载即取数——见 `tests/e2e/support/api-stub.ts` 头注）。
- 信封形状：接口文档 §1.3（`data` + `meta.hasMore`）；空结果即 `{ data: [], meta: { hasMore: false } }`。
- 本备忘不预设各 spec 所需端点清单，由测试交付岗按用例实际请求补齐。