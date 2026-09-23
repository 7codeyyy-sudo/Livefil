/**
 * Phase 4 验收脚本（SCHED/ROUTINE/EXEC/UI-007）。结构断言，行为由
 * phase4-ui.spec.ts 与单测承接。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { join } from 'node:path';

const ROOT = new URL('../../', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

test('迁移：Phase 4 六表 + tasks.template_id 齐备', () => {
  const sql = read('drizzle/0002_robust_komodo.sql');
  for (const table of [
    'schedule_blocks',
    'routines',
    'routine_steps',
    'execution_logs',
    'fixed_commitments',
    'recovery_states',
  ]) {
    assert.ok(sql.includes(`CREATE TABLE "${table}"`), `缺少表 ${table}`);
  }
  assert.ok(/template_id/.test(sql), 'tasks 缺 template_id 列');
});

test('时间域：DST 安全换算与半开区间冲突', () => {
  const zoned = read('src/modules/scheduling/domain/zoned-time.ts');
  assert.ok(zoned.includes('longOffset'), '时区偏移未用 Intl longOffset（DST 不安全）');
  const conflict = read('src/modules/scheduling/domain/conflict.ts');
  assert.ok(conflict.includes('aStart < bEnd && bStart < aEnd'), '重叠判定不是半开区间');
});

test('端点：排程 2 + 固定事项 2 + today + 执行记录 + 恢复 + 例程 3', () => {
  const files = [
    'app/api/v1/schedule-blocks/route.ts',
    'app/api/v1/schedule-blocks/[blockId]/route.ts',
    'app/api/v1/fixed-commitments/route.ts',
    'app/api/v1/fixed-commitments/[commitmentId]/route.ts',
    'app/api/v1/today/route.ts',
    'app/api/v1/execution-logs/route.ts',
    'app/api/v1/recovery-mode/route.ts',
    'app/api/v1/routines/route.ts',
    'app/api/v1/routines/[routineId]/route.ts',
    'app/api/v1/routines/[routineId]/schedule/route.ts',
  ];
  for (const file of files) {
    readFileSync(join(ROOT, file), 'utf8');
  }
  const logs = read('app/api/v1/execution-logs/route.ts');
  assert.ok(logs.includes('Idempotency-Key'), '执行记录未强制幂等键');
  assert.ok(logs.includes('VALIDATION_ERROR'), '缺失幂等键应返回 400');
});

test('执行记录联动与恢复建议规则落 domain', () => {
  const domain = read('src/modules/execution/domain/execution-log.ts');
  assert.ok(domain.includes('minimum_completed'), '缺最低版本完成枚举');
  assert.ok(
    domain.includes('blockStatusForLog') && domain.includes('taskStatusForLog'),
    '缺联动规则',
  );
  const recovery = read('src/modules/execution/domain/recovery.ts');
  for (const code of ['SHRINK', 'MINIMUM', 'RESCHEDULE', 'PAUSE']) {
    assert.ok(recovery.includes(`'${code}'`), `缺建议码 ${code}`);
  }
});

test('例程：物化展开 + 同日幂等 + 步骤 diff', () => {
  const app = read('src/modules/routines/application/manage-routine.ts');
  assert.ok(app.includes("source: 'routine'"), '例程展开未标记 source=routine');
  assert.ok(app.includes('已安排，不能重复生成'), '缺同日幂等 409');
  const infra = read('src/modules/routines/infrastructure/routine-repository.drizzle.ts');
  assert.ok(infra.includes('keptIds'), '步骤 diff 缺"缺失者软删"分支');
});

test('今日页：一次聚合 + 行内完成 + 恢复卡片（v0.20 版式）', () => {
  const panel = read('app/(app)/today/TodayPanel.tsx');
  assert.ok(panel.includes('/api/v1/today'), '今日页未走聚合端点');
  assert.ok(panel.includes('/api/v1/execution-logs'), '块行内完成未接执行记录');
  assert.ok(panel.includes('Idempotency-Key'), '执行记录提交缺幂等键');
  assert.ok(panel.includes('恢复模式') || panel.includes('recovery'), '缺恢复区');
  assert.ok(panel.includes('过期'), '未安排列表缺过期标记');
});
