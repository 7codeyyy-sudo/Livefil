/**
 * Phase 9 §4.13 迁移文本断言（PD-020 点 7 / 点 8）。
 *
 * ## 为什么用「读 SQL 文本」而不是真机跑迁移
 *
 * 迁移文件的**行为**就是它生成出来的 SQL——这条先例来自
 * [phase2-acceptance.mjs](../../e2e/phase2-acceptance.mjs) 的「数据库迁移已入库且只向前」
 * 与「首个迁移建出两张表与关键约束」：在不需要 PG 实例的前提下，把「表/索引/约束
 * 是否真的写进了版本化迁移」变成会让构建失败的可执行检查。真机迁移验证（空库重建、
 * 事务回滚）另由 `tests/db/phase2.db.test.mjs` 在具备数据库的环境承接。
 *
 * ## 覆盖的口径（PD-020 点 7 / 点 8）
 *
 * - 点 7：`0007` 存在且是**追加**（forward-only：日志条目与 SQL 文件数一致、idx 连续）；
 *   `ai_drafts` + `ai_usage` 两表与全部索引齐。
 * - 点 8：§4.13 CHECK 三枚逐字在位；`draft_type` 四值闭合；`status='failed'` 与
 *   `error_code` 的联动约束（RD-009 裁定 4）；**确无 `version` / `deleted_at` 列**
 *   （RD-009 裁定 5——本表不参与同步，故不设乐观并发列与软删列）。
 *
 * 说明：「既有迁移零改动」属代码审阅事实（diff 空），不落为文本断言——文本断言
 * 检不出「把 0003 里的列名改了」这类改写，硬写只会得到一条永远通过的空检查。
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/** 项目根（`tests/unit/architecture` 向上三层）。 */
const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const DRIZZLE_DIR = path.join(PROJECT_ROOT, 'drizzle');
const META_DIR = path.join(DRIZZLE_DIR, 'meta');

/** Phase 9 的迁移文件名（`drizzle-kit generate` 产物）。 */
const MIGRATION_FILE = '0007_jittery_pet_avengers.sql';

/** 读迁移 SQL；文件缺失时直接抛错，让用例红在「文件不在」这一步。 */
function readMigration(): string {
  const file = path.join(DRIZZLE_DIR, MIGRATION_FILE);
  if (!existsSync(file)) {
    throw new Error(`缺少 Phase 9 迁移文件：${file}`);
  }
  return readFileSync(file, 'utf8');
}

/** 版本化 SQL 迁移文件名（升序）。 */
function listMigrationFiles(): readonly string[] {
  return readdirSync(DRIZZLE_DIR)
    .filter((name) => /^\d{4}_.*\.sql$/.test(name))
    .sort();
}

describe('点 7 · 迁移 0007（forward-only + 两表两索引）', () => {
  it('0007 已入库，且迁移日志与 SQL 文件数一致、idx 连续（只向前）', () => {
    const sqlFiles = listMigrationFiles();
    expect(sqlFiles, 'drizzle/ 下没有任何版本化 SQL 迁移').toContain(MIGRATION_FILE);

    const journalPath = path.join(META_DIR, '_journal.json');
    expect(existsSync(journalPath), `缺少迁移日志：${journalPath}`).toBe(true);

    const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as {
      entries?: readonly { idx: number }[];
    };
    const entries = journal.entries ?? [];

    expect(entries.length, '迁移日志条目数应与 SQL 文件数一致（不一致说明有迁移没被登记）').toBe(
      sqlFiles.length,
    );

    for (const [index, entry] of entries.entries()) {
      expect(
        entry.idx,
        `迁移日志 idx 应连续递增，第 ${String(index)} 项为 ${String(entry.idx)}`,
      ).toBe(index);
    }
  });

  it('两表（ai_drafts / ai_usage）与四枚索引齐', () => {
    const sql = readMigration();

    expect(sql, '应建出 ai_drafts 表').toMatch(/CREATE TABLE "ai_drafts"/);
    expect(sql, '应建出 ai_usage 表').toMatch(/CREATE TABLE "ai_usage"/);

    for (const index of [
      'ai_drafts_user_status_created_idx',
      'ai_drafts_user_expires_idx',
      'ai_drafts_user_input_hash_created_idx',
      'ai_usage_user_created_idx',
    ]) {
      expect(sql, `迁移应建出索引 ${index}`).toContain(`CREATE INDEX "${index}"`);
    }
  });
});

describe('点 8 · §4.13 CHECK 三枚 + 无 version/deleted_at 列', () => {
  it('三枚 CHECK 逐字在位（result_json / error_code / draft_type）', () => {
    const sql = readMigration();

    // 总监补正等价：非 failed 必非空、failed 可空。
    expect(sql).toContain(
      'CHECK ("ai_drafts"."status" = \'failed\' OR "ai_drafts"."result_json" IS NOT NULL)',
    );
    // RD-009 裁定 4：failed 必须有 error_code。
    expect(sql).toContain(
      'CHECK ("ai_drafts"."status" <> \'failed\' OR "ai_drafts"."error_code" IS NOT NULL)',
    );
    // draft_type 四值闭合。
    expect(sql).toContain(
      "CHECK (\"ai_drafts\".\"draft_type\" IN ('task_breakdown', 'schedule_suggestion', 'expense_parse', 'review_summary'))",
    );
  });

  it('现无 version / deleted_at 列（本表不参与同步，RD-009 裁定 5）', () => {
    const sql = readMigration();

    expect(sql, '本表不参与同步，不应设乐观并发列').not.toMatch(/"version"/);
    expect(sql, '本表不参与同步，不应设软删列').not.toMatch(/"deleted_at"/);
  });

  it('外键指向 users 且为 cascade（用户删除即回收草稿与用量）', () => {
    const sql = readMigration();

    expect(sql).toMatch(
      /ALTER TABLE "ai_drafts" ADD CONSTRAINT "ai_drafts_user_id_users_id_fk" FOREIGN KEY \("user_id"\) REFERENCES "public"\."users"\("id"\) ON DELETE cascade/,
    );
    expect(sql).toMatch(
      /ALTER TABLE "ai_usage" ADD CONSTRAINT "ai_usage_user_id_users_id_fk" FOREIGN KEY \("user_id"\) REFERENCES "public"\."users"\("id"\) ON DELETE cascade/,
    );
  });
});
