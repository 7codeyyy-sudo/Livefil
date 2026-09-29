import { describe, expect, test } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  parseAmountMinor,
  formatAmountMinor,
} from '../../../src/modules/expenses/domain/expense.ts';
import { parseHumanToMinor, formatMinorToHuman } from '../../../app/(app)/_lib/expense-api';

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    return entry.isDirectory() ? walk(full) : [full];
  });
}

function scanAmountMinorFloatViolations(): number {
  const root = join(process.cwd(), 'src/modules/expenses');
  const files = walk(root).filter((f) => f.endsWith('.ts'));
  let violations = 0;
  for (const file of files) {
    const content = readFileSync(file, 'utf8');
    if (/Number\s*\(\s*amountMinor\s*\)/.test(content)) violations++;
    if (/parseFloat\s*\(\s*amountMinor\s*\)/.test(content)) violations++;
    if (/Math\.round\s*\(\s*amountMinor\s*\*\s*100\s*\)/.test(content)) violations++;
  }
  return violations;
}

describe('金额跨线零 float（点 1）', () => {
  // --- 领域层：parseAmountMinor / formatAmountMinor ---
  test('parseAmountMinor 接受合法字符串并返回 bigint', () => {
    expect(parseAmountMinor('3600')).toBe(3600n);
    expect(parseAmountMinor('1')).toBe(1n);
    expect(parseAmountMinor('999999999999999999')).toBe(999999999999999999n);
  });

  test('parseAmountMinor 拒绝前导零、负号、小数、科学计数法', () => {
    expect(() => parseAmountMinor('0')).toThrow();
    expect(() => parseAmountMinor('00')).toThrow();
    expect(() => parseAmountMinor('-1')).toThrow();
    expect(() => parseAmountMinor('1.0')).toThrow();
    expect(() => parseAmountMinor('1e3')).toThrow();
    expect(() => parseAmountMinor('+36')).toThrow();
  });

  test('formatAmountMinor 往返不变', () => {
    expect(formatAmountMinor(parseAmountMinor('3600'))).toBe('3600');
    expect(formatAmountMinor(parseAmountMinor('1000000000000000000'))).toBe('1000000000000000000');
  });

  // --- 客户端：parseHumanToMinor / formatMinorToHuman ---
  test('parseHumanToMinor 两位小数边界：36.50 → 3650', () => {
    const r = parseHumanToMinor('36.50');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.minor).toBe('3650');
  });

  test('parseHumanToMinor 大额字符串不丢精度', () => {
    const raw = '9999999999999999.99';
    const r = parseHumanToMinor(raw);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.minor).toBe('999999999999999999');
  });

  test('formatMinorToHuman 补零与去零正确', () => {
    expect(formatMinorToHuman('3650')).toBe('36.50');
    expect(formatMinorToHuman('350')).toBe('3.50');
    expect(formatMinorToHuman('5')).toBe('0.05');
    expect(formatMinorToHuman('100')).toBe('1.00');
  });

  // --- 源码扫描：零 float 转换 ---
  test('源码扫描：expenses 模块无 Number(amountMinor)', () => {
    const violations = scanAmountMinorFloatViolations();
    expect(violations).toBe(0);
  });
});
