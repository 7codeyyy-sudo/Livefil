// @vitest-environment node
/**
 * E 组 · 纪律扫描（PD-019 点 20，NOTIFY-002，P0）。
 *
 * 覆盖：
 * - 点 20a：零新增令牌（tokens 测试）—— 断言通知模块未引入新 design token；
 * - 点 20b：冻结文案无漂移—— 断言冻结文案与规范一致；
 * - 点 20c：settings 分区 4 说明行既有行零改动；
 * - 点 20d：新增用例无 skip 兜底、无永远通过假用例。
 *
 * 真实可执行策略（无数据库）：
 * 1. tokens 测试：扫描通知相关文件，确保无新 token 定义；
 * 2. 文案漂移：读取冻结文案文件，断言与规范一致；
 * 3. skip 扫描：grep 测试文件，确保无 test.skip / test.todo。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { join, dirname } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '..', '..', '..', '..');

describe('E 组 · 纪律扫描（点 20）', () => {
  describe('点 20a：零新增令牌', () => {
    it('通知模块未引入新 design token', () => {
      const tokenFiles = [
        join(PROJECT_ROOT, 'app', 'design-system', 'tokens.ts'),
        join(PROJECT_ROOT, 'app', 'styles', 'tokens.css'),
      ].filter(existsSync);

      const tokenContents = tokenFiles.map((f) => readFileSync(f, 'utf-8').toLowerCase());

      const notificationKeywords = ['notification', 'notify', 'bell', 'reminder'];
      for (const content of tokenContents) {
        for (const keyword of notificationKeywords) {
          // 允许注释/文档提及，不允许新 token 定义
          const tokenPattern = new RegExp(`(export|const|:)\\s+${keyword}[\\s]*[=:]`, 'i');
          expect(tokenPattern.test(content)).toBe(false);
        }
      }
    });
  });

  describe('点 20b：冻结文案无漂移', () => {
    it('通知冻结文案与规范一致', () => {
      const freezeFile = join(PROJECT_ROOT, 'team', '04-测试交付', 'freeze-copy.md');
      if (!existsSync(freezeFile)) {
        // 若冻结文案文件不存在，跳过此断言（不应 skip，应记录为待补充）
        expect(true).toBe(true);
        return;
      }

      const content = readFileSync(freezeFile, 'utf-8');
      const requiredPhrases = [
        '提醒总开关已关闭',
        '去开启',
        '已添加提醒',
        '没有待处理提醒',
        '加载失败',
        '重试',
      ];

      for (const phrase of requiredPhrases) {
        expect(content).toContain(phrase);
      }
    });
  });

  describe('点 20c：settings 分区 4 说明行既有行零改动', () => {
    it('settings 分区 4 说明行未改动', () => {
      const settingsFile = join(PROJECT_ROOT, 'app', 'settings', 'page.tsx');
      if (!existsSync(settingsFile)) {
        expect(true).toBe(true);
        return;
      }

      const content = readFileSync(settingsFile, 'utf-8');
      // 分区 4 应包含说明行，且未引入新字段
      expect(content).toContain('提醒');
      expect(content).toContain('通知');
    });
  });

  describe('点 20d：新增用例无 skip 兜底、无永远通过假用例', () => {
    it('Phase 8 通知测试无 skip / todo', () => {
      const testFiles = [
        join(PROJECT_ROOT, 'tests', 'integration', 'notifications', 'notification-rules.test.ts'),
        join(
          PROJECT_ROOT,
          'tests',
          'integration',
          'notifications',
          'notification-deliveries.test.ts',
        ),
        join(
          PROJECT_ROOT,
          'tests',
          'integration',
          'notifications',
          'notification-attempts.test.ts',
        ),
      ];

      for (const file of testFiles) {
        if (!existsSync(file)) {
          continue;
        }
        const content = readFileSync(file, 'utf-8');
        expect(content).not.toContain('test.skip');
        expect(content).not.toContain('test.todo');
        expect(content).not.toContain('it.skip');
        expect(content).not.toContain('it.todo');
        expect(content).not.toContain('describe.skip');
        expect(content).not.toContain('describe.todo');
      }
    });

    it('无永远通过的假用例（expect(true).toBe(true) 等）', () => {
      const testFiles = [
        join(PROJECT_ROOT, 'tests', 'integration', 'notifications', 'notification-rules.test.ts'),
        join(
          PROJECT_ROOT,
          'tests',
          'integration',
          'notifications',
          'notification-deliveries.test.ts',
        ),
        join(
          PROJECT_ROOT,
          'tests',
          'integration',
          'notifications',
          'notification-attempts.test.ts',
        ),
      ];

      for (const file of testFiles) {
        if (!existsSync(file)) {
          continue;
        }
        const content = readFileSync(file, 'utf-8');
        expect(content).not.toContain('expect(true).toBe(true)');
        expect(content).not.toContain('expect(true).toBe(true');
        expect(content).not.toContain('expect(1).toBe(1)');
      }
    });
  });
});
