import { describe, expect, it } from 'vitest';
import {
  DECIMAL_ZERO,
  decimalAdd,
  decimalCompare,
  decimalFromNumber,
  decimalFromText,
  decimalToNumber,
  decimalToString,
} from './decimal';

const d = decimalFromNumber;
const t = decimalFromText;

describe('decimal · 精确十进制表示', () => {
  it('由录入值恢复十进制：0.1、1e-10、整数与科学计数法', () => {
    expect(decimalToString(d(0.1))).toBe('0.1');
    expect(decimalToString(d(0.3))).toBe('0.3');
    expect(decimalToString(d(1e-10))).toBe('0.0000000001');
    expect(decimalToString(d(4))).toBe('4');
    expect(decimalToString(d(0))).toBe('0');
    expect(decimalToString(d(1.5e-7))).toBe('0.00000015');
    expect(decimalToString(d(1e21))).toBe('1' + '0'.repeat(21));
    expect(decimalToString(d(0.1000000001))).toBe('0.1000000001');
  });

  it('非有限数值抛出错误', () => {
    expect(() => d(Number.NaN)).toThrow();
    expect(() => d(Number.POSITIVE_INFINITY)).toThrow();
  });

  it('十进制加法精确：0.1 + 0.2 严格等于 0.3', () => {
    // 二进制浮点下并不相等，这正是十进制累计要消除的误差来源
    expect(0.1 + 0.2 === 0.3).toBe(false);
    const sum = decimalAdd(d(0.1), d(0.2));
    expect(decimalCompare(sum, d(0.3))).toBe(0);
    expect(decimalToString(sum)).toBe('0.3');
    expect(decimalToNumber(sum)).toBe(0.3);
  });

  it('加法与次序无关：同一组代价任意次序求和结果逐位相同', () => {
    const terms = [0.1, 0.2, 0.3, 1e-10, 4, 0.0000000001];
    const forward = terms.reduce((acc, x) => decimalAdd(acc, d(x)), DECIMAL_ZERO);
    const reverse = terms.reduceRight((acc, x) => decimalAdd(acc, d(x)), DECIMAL_ZERO);
    expect(decimalCompare(forward, reverse)).toBe(0);
    expect(decimalToString(forward)).toBe('4.6000000002');
  });

  it('比较保持极小十进制差额：1e-10 与 0 严格有序', () => {
    expect(decimalCompare(d(1e-10), DECIMAL_ZERO)).toBe(1);
    expect(decimalCompare(DECIMAL_ZERO, d(1e-10))).toBe(-1);
    expect(decimalCompare(d(0.3000000001), d(0.3))).toBe(1);
    expect(decimalCompare(d(0.3), d(0.3))).toBe(0);
    // 四个 1e-10 的精确和为 4e-10，仍严格大于 0
    const four = decimalAdd(decimalAdd(d(1e-10), d(1e-10)), decimalAdd(d(1e-10), d(1e-10)));
    expect(decimalCompare(four, DECIMAL_ZERO)).toBe(1);
    expect(decimalToNumber(four)).toBe(4e-10);
  });

  it('转回双精度正确舍入，展示值与录入值一致', () => {
    expect(decimalToNumber(decimalAdd(d(0.1), d(0.2)))).toBe(0.3);
    expect(decimalToNumber(d(0))).toBe(0);
    expect(decimalToString(decimalAdd(d(0.1), d(0.2)))).toBe('0.3');
  });
});

describe('decimal · 录入原文精确解析（decimalFromText）', () => {
  it('保留超出双精度精度的录入差异：0.10000000000000001 严格大于 0.1', () => {
    // 双精度下两者舍入为同一个数，差异只能凭录入原文保留
    expect(Number('0.10000000000000001')).toBe(0.1);
    expect(decimalCompare(t('0.10000000000000001'), t('0.1'))).toBe(1);
    expect(decimalCompare(t('0.1'), t('0.10000000000000001'))).toBe(-1);
    expect(decimalToString(t('0.10000000000000001'))).toBe('0.10000000000000001');
    // 转回双精度会再次舍入为 0.1，但精确比较已在 Decimal 层完成
    expect(decimalToNumber(t('0.10000000000000001'))).toBe(0.1);
  });

  it('与 decimalFromNumber 对常规录入一致，并支持 .5 / 5. / 指数 / 前导零 / 空白', () => {
    expect(decimalCompare(t('0.1'), d(0.1))).toBe(0);
    expect(decimalCompare(t('0.3000000001'), d(0.3000000001))).toBe(0);
    expect(decimalToString(t('.5'))).toBe('0.5');
    expect(decimalToString(t('5.'))).toBe('5');
    expect(decimalToString(t('1e3'))).toBe('1000');
    expect(decimalToString(t('+2E-2'))).toBe('0.02');
    expect(decimalToString(t('000.10'))).toBe('0.1');
    expect(decimalToString(t('  0.25  '))).toBe('0.25');
    expect(decimalToString(t('-0.5'))).toBe('-0.5');
    expect(decimalCompare(t('0'), DECIMAL_ZERO)).toBe(0);
  });

  it('非法文本抛出错误', () => {
    expect(() => t('')).toThrow();
    expect(() => t('abc')).toThrow();
    expect(() => t('1.2.3')).toThrow();
    expect(() => t('e5')).toThrow();
  });
});