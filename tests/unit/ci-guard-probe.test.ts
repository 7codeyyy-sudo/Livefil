import { expect, test } from 'vitest';

// CI 阻断探针：故意失败的测试，仅用于验证分支保护会阻止红检查合并。
// 验证完成后随 ci/guard-probe 分支一并删除，绝不合入 main。
test('CI 阻断探针：故意失败', () => {
  expect(1).toBe(2);
});
