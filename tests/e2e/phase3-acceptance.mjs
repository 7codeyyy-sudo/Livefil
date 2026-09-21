/**
 * Phase 3 验收脚本（TASK-001~003、GOAL-001/002、UI-005/006）。
 *
 * 结构性断言：迁移与表、完整流转表、幂等（错误码仍是 10 个）、端点与页面文件、
 * fnd-004 契约清单同步、UI 前置小件（useCursorListQuery / Checkbox）。
 * 行为验证由 tests/unit/modules/phase3-use-cases.test.ts（fake 仓储）与
 * phase3-ui.spec.ts（浏览器，page.route mock）承接。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import test from 'node:test';
import { join } from 'node:path';

const PROJECT_ROOT = new URL('../../', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const read = (relativePath) => readFileSync(join(PROJECT_ROOT, relativePath), 'utf8');

test('迁移：四张表与关键索引齐全', () => {
  const migrationFiles = readdirSync(join(PROJECT_ROOT, 'drizzle')).filter((name) =>
    name.endsWith('.sql'),
  );
  const phase3 = migrationFiles.map((name) =>
    readFileSync(join(PROJECT_ROOT, 'drizzle', name), 'utf8'),
  );
  const combined = phase3.join('\n');
  for (const table of ['tasks', 'goals', 'actions', 'idempotency_keys']) {
    assert.ok(combined.includes(`CREATE TABLE "${table}"`), `迁移缺少表 ${table}`);
  }
  // tasks 的三个索引（DB §4.5）。
  assert.ok(
    /CREATE (UNIQUE )?INDEX.*user_id.*status/.test(combined),
    '缺少 (user_id,status,...) 索引',
  );
  assert.ok(
    /CREATE (UNIQUE )?INDEX.*user_id.*due_date/.test(combined),
    '缺少 (user_id,due_date) 索引',
  );
  assert.ok(
    /CREATE (UNIQUE )?INDEX.*user_id.*deleted_at/.test(combined),
    '缺少 (user_id,deleted_at) 索引',
  );
  // 幂等键的唯一约束 (user_id, key)（DB §4.15）。
  assert.ok(/UNIQUE.*user_id.*key|"user_id".*"key"/.test(combined), '缺少幂等键唯一约束');
});

test('完整流转表：正向 + 重开/恢复，inbox 不得直接进 in_progress（DB §4.5）', () => {
  const source = read('src/modules/tasks/domain/task.ts');
  assert.ok(source.includes("inbox: ['planned', 'archived']"), 'inbox 的合法出边不符');
  assert.ok(source.includes("completed: ['planned', 'archived']"), '缺少 completed → planned 重开');
  assert.ok(source.includes("archived: ['inbox', 'planned']"), '缺少 archived 恢复边');
  // 反证：inbox 的出边里没有 in_progress。
  const inboxLine = source.split('\n').find((line) => line.trim().startsWith('inbox: ['));
  assert.ok(
    inboxLine !== undefined && !inboxLine.includes('in_progress'),
    'inbox 不应直接进 in_progress',
  );
});

test('错误码仍是 10 个（IDEMPOTENCY_REPLAY 已在表内，不是新增契约）', () => {
  const source = read('src/shared/errors/error-code.ts');
  const codes = source.match(/^\s+[A-Z_]+: \d+/gm) ?? [];
  assert.equal(codes.length, 10, `错误码应为 10 个，实际 ${String(codes.length)}`);
  assert.ok(
    codes.some((code) => code.includes('IDEMPOTENCY_REPLAY')),
    '缺少 IDEMPOTENCY_REPLAY',
  );
});

test('幂等编排：占位/重放/释放语义齐备', () => {
  const orchestration = read('app/_lib/idempotency.ts');
  assert.ok(orchestration.includes("headers.get('Idempotency-Key')"), '未读取幂等键头');
  assert.ok(orchestration.includes('IDEMPOTENCY_REPLAY'), '重放未返回 IDEMPOTENCY_REPLAY');
  assert.ok(orchestration.includes('store.release'), '失败路径未释放占位');
  assert.ok(orchestration.includes('sha256'), '缺少请求指纹');
  const store = read('src/infrastructure/idempotency/idempotency-store.drizzle.ts');
  assert.ok(store.includes('23505'), '占位未依赖唯一约束冲突');
});

test('端点文件：tasks 6 个路由 + goals 3 个 + actions 1 个', () => {
  const files = [
    'app/api/v1/tasks/route.ts',
    'app/api/v1/tasks/[taskId]/route.ts',
    'app/api/v1/tasks/[taskId]/status/route.ts',
    'app/api/v1/tasks/[taskId]/convert-to-action/route.ts',
    'app/api/v1/tasks/[taskId]/archive/route.ts',
    'app/api/v1/tasks/batch/route.ts',
    'app/api/v1/goals/route.ts',
    'app/api/v1/goals/[goalId]/route.ts',
    'app/api/v1/goals/[goalId]/actions/route.ts',
    'app/api/v1/actions/[actionId]/route.ts',
  ];
  for (const file of files) {
    assert.ok(readFileSync(join(PROJECT_ROOT, file), 'utf8').length > 0, `缺少端点 ${file}`);
  }
  // 写端点都过幂等编排（POST 语义；PATCH 走乐观并发、天然幂等，不在此列）。
  for (const file of files) {
    const source = readFileSync(join(PROJECT_ROOT, file), 'utf8');
    if (source.includes('export const POST')) {
      assert.ok(source.includes('withIdempotency'), `${file} 的写操作未过幂等编排`);
    }
  }
});

test('fnd-004 契约清单已同步 idempotency 目录', () => {
  const source = read('tests/e2e/fnd-004-acceptance.mjs');
  assert.ok(
    /EXPECTED_INFRASTRUCTURE_AREAS\s*=\s*\[[^\]]*'idempotency'/s.test(source),
    'fnd-004 的基础设施清单缺少 idempotency',
  );
});

test('UI 前置小件：useCursorListQuery 累积语义 + Checkbox（§4.8）', () => {
  const hook = read('src/shared/ui/components/AsyncState/use-cursor-list-query.ts');
  assert.ok(hook.includes('loadMore'), '缺少 loadMore');
  assert.ok(hook.includes('...previous'), 'loadMore 未做累积（应追加而非替换）');
  assert.ok(hook.includes('loadMoreError'), '缺少加载更多失败态');
  const checkbox = read('src/shared/ui/components/Checkbox/Checkbox.tsx');
  assert.ok(checkbox.includes('type="checkbox"'), 'Checkbox 未用原生 input');
  assert.ok(checkbox.includes('indeterminate'), 'Checkbox 缺少半选态');
  const index = read('src/shared/ui/components/index.ts');
  assert.ok(index.includes('export { Checkbox }'), 'Checkbox 未进组件出口');
  assert.ok(index.includes('useCursorListQuery'), 'useCursorListQuery 未进组件出口');
});

test('页面：收件箱真实页 + 目标列表 + 独立详情路由', () => {
  const inbox = read('app/(app)/inbox/InboxPanel.tsx');
  assert.ok(inbox.includes('加载更多'), '收件箱缺少加载更多');
  assert.ok(inbox.includes('批量'), '收件箱缺少批量操作');
  assert.ok(inbox.includes('#quick-add'), '收件箱未处理快速添加 hash');
  const goals = read('app/(app)/goals/GoalsPanel.tsx');
  assert.ok(goals.includes('/goals/'), '目标列表缺少详情链接');
  const detail = read('app/(app)/goals/[goalId]/page.tsx');
  assert.ok(detail.includes('goalId'), '详情路由参数缺失');
  const topbar = read('src/shared/ui/layout/Topbar/Topbar.tsx');
  assert.ok(topbar.includes('/inbox#quick-add'), '顶栏快速添加未接线');
});
