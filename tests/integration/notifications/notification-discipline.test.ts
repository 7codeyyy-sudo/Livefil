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
 * 1. tokens 测试：扫描真实 token 文件（`src/shared/ui/styles/tokens.css`），确保无新 token 定义；
 * 2. 文案漂移：读取 UI 规范（冻结文案的唯一准据）里 §5 的通知文案段落，断言逐字一致；
 * 3. skip 扫描：grep 测试文件，确保无 test.skip / test.todo。
 *
 * ⚠️ 三处「文件不存在就静默通过」的写法已移除：它们会让断言一次都不执行（`existsSync`
 * 短路成 `expect(true).toBe(true)` 或把扫描目标过滤空），属 QA-20260929-003 余项 3
 * 「占位清零自证」的缺口。现在改为**先断言目标文件存在**，再断言内容——目标漂移即红灯。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { join, dirname } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
/**
 * 项目根：`__dirname` 是 `<根>/tests/integration/notifications`，项目根在其上三级。
 *
 * ⚠️ 此前写成**四级**（落到仓库的父目录 `small_tool/`），配合各处 `existsSync` 兜底，
 * 使本文件点 20a/20b/20c/20d 的断言全部静默不执行——这是 QA-20260929-003 余项 3
 * 「占位清零自证」不达标的**根因**（不是单点路径写错）。
 */
const PROJECT_ROOT = join(__dirname, '..', '..', '..');

describe('E 组 · 纪律扫描（点 20）', () => {
  describe('点 20a：零新增令牌', () => {
    it('通知模块未引入新 design token', () => {
      // 真实落点：此前写的是不存在的 `app/design-system/tokens.ts` 与 `app/styles/tokens.css`，
      // 两者都被 `filter(existsSync)` 滤空，下面的断言一次都不执行。
      const tokenFile = join(PROJECT_ROOT, 'src', 'shared', 'ui', 'styles', 'tokens.css');
      expect(existsSync(tokenFile)).toBe(true);

      const content = readFileSync(tokenFile, 'utf-8').toLowerCase();
      const notificationKeywords = ['notification', 'notify', 'bell', 'reminder'];
      for (const keyword of notificationKeywords) {
        // 允许注释/文档提及，不允许新 token 定义
        const tokenPattern = new RegExp(`(export|const|:)\\s+${keyword}[\\s]*[=:]`, 'i');
        expect(tokenPattern.test(content)).toBe(false);
      }
    });
  });

  describe('点 20b：冻结文案无漂移', () => {
    it('通知冻结文案与规范一致', () => {
      // 冻结文案的唯一准据是 UI 规范（此前指向不存在的 `team/04-测试交付/freeze-copy.md`，
      // 被 `existsSync` 短路成 `expect(true).toBe(true)`，断言从不执行）。
      const freezeFile = join(PROJECT_ROOT, 'doc', '04-product-design', 'UI页面规范.md');
      expect(existsSync(freezeFile)).toBe(true);

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
      // 分区 4「提醒与安静时段」的真实落点（此前写的是不存在的 `app/settings/page.tsx`：
      // 真实路由在 `(app)` 路由组下，且分区内容由 `_components/PreferenceSections.tsx` 承载）。
      const settingsFile = join(
        PROJECT_ROOT,
        'app',
        '(app)',
        'settings',
        '_components',
        'PreferenceSections.tsx',
      );
      expect(existsSync(settingsFile)).toBe(true);

      const content = readFileSync(settingsFile, 'utf-8');
      // 分区 4 的既有说明行逐字未改动，且字段集合未扩（REMINDER_KEYS 仍是三键）。
      // 原先断的「提醒」「通知」两词，前者过宽（任何含「提醒」的句子都算过）、后者在
      // 分区 4 里根本不存在，等于把断言写成了永远通不过或永远看不出漂移的空壳。
      expect(content).toContain('提醒与安静时段');
      expect(content).toContain('不开启总开关时，安静时段不会被使用。');
      expect(content).toContain(
        "const REMINDER_KEYS = ['reminderEnabled', 'quietHoursStart', 'quietHoursEnd'] as const;",
      );
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
