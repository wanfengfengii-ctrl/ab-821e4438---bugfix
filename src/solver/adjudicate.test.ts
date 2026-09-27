import { describe, expect, it } from 'vitest';
import { adjudicate, EPS } from './adjudicate';
import type { Scenario } from './types';

const rails = (...defs: [string, number][]): Scenario['rails'] =>
  defs.map(([name, coordinate], i) => ({ id: `rail-${i}`, name, coordinate }));

const block = (
  name: string,
  mass: number,
  options: [number, number][], // [railIndex, cost]
): Scenario['blocks'][number] => ({
  id: `blk-${name}`,
  name,
  mass,
  options: options.map(([railIndex, cost]) => ({ railId: `rail-${railIndex}`, cost })),
});

const limits = (maxLoad: number, minTorque: number, maxTorque: number): Scenario['limits'] => ({
  maxLoad,
  minTorque,
  maxTorque,
});

describe('adjudicate · 可行方案与决胜规则', () => {
  it('基本求解：前缀均满足约束，代价/序号稳定决胜', () => {
    // 两块等质量配重，左右对称；四套可行方案余量与代价全同，按录入序号取字典序最小。
    const outcome = adjudicate({
      rails: rails(['L', -1], ['R', 1]),
      blocks: [block('b1', 4, [[0, 1], [1, 1]]), block('b2', 4, [[0, 1], [1, 1]])],
      limits: limits(100, -5, 5),
    });
    expect(outcome.feasible).toBe(true);
    if (!outcome.feasible) return;
    expect(outcome.plan.steps.map((s) => [s.blockIndex, s.railName])).toEqual([
      [0, 'L'],
      [1, 'R'],
    ]);
    expect(outcome.plan.totalCost).toBeCloseTo(2);
    expect(outcome.plan.minTorqueMargin).toBeCloseTo(1);
    // 每个前缀状态同时满足载荷与力矩限制
    for (const s of outcome.plan.steps) {
      expect(s.cumulativeMass).toBeLessThanOrEqual(100 + EPS);
      expect(s.cumulativeTorque).toBeGreaterThanOrEqual(-5 - EPS);
      expect(s.cumulativeTorque).toBeLessThanOrEqual(5 + EPS);
    }
  });

  it('纳米级代价差不得被容差抹平：四块均须取零代价的 #2 位置', () => {
    // 2 条零力臂导轨，4 块单位质量配重；#1 代价 1e-10，#2 代价 0。
    // 各方案力矩余量完全相同，严格最小总代价为 0（旧实现以 EPS=1e-9
    // 比较代价，误把 4e-10 与 0 当并列，按序号错选了 #1）。
    const outcome = adjudicate({
      rails: rails(['Z1', 0], ['Z2', 0]),
      blocks: [
        block('b1', 1, [[0, 1e-10], [1, 0]]),
        block('b2', 1, [[0, 1e-10], [1, 0]]),
        block('b3', 1, [[0, 1e-10], [1, 0]]),
        block('b4', 1, [[0, 1e-10], [1, 0]]),
      ],
      limits: limits(4, -1, 1),
    });
    expect(outcome.feasible).toBe(true);
    if (!outcome.feasible) return;
    const plan = outcome.plan;
    // 完整方案：四块各恰用一次，且全部采用位置录入序号 #2（optionIndex 1）
    expect(plan.steps).toHaveLength(4);
    expect(new Set(plan.steps.map((s) => s.blockIndex))).toEqual(new Set([0, 1, 2, 3]));
    expect(plan.steps.map((s) => s.optionIndex)).toEqual([1, 1, 1, 1]);
    expect(plan.steps.map((s) => s.railName)).toEqual(['Z2', 'Z2', 'Z2', 'Z2']);
    // 总代价严格为 0（不用 toBeCloseTo：容差会把缺陷掩盖掉）
    expect(plan.totalCost).toBe(0);
    // 对照：错选方案本会产生 4e-10 的可避免成本
    expect(4 * 1e-10).toBeGreaterThan(plan.totalCost);
    // 力矩余量与边界：零力臂使力矩恒为 0，余量为 1；载荷恰好到上限
    expect(plan.minTorqueMargin).toBe(1);
    plan.steps.forEach((s) => {
      expect(s.cumulativeTorque).toBe(0);
      expect(s.cumulativeMass).toBeLessThanOrEqual(4 + EPS);
    });
    expect(plan.steps[3].cumulativeMass).toBe(4);
  });

  it('真正同代价（含双零代价）时仍按位置录入序号稳定决胜', () => {
    // 两个位置代价都为 0：不存在成本差，序号决胜应选 #1（optionIndex 0）。
    const outcome = adjudicate({
      rails: rails(['Z1', 0], ['Z2', 0]),
      blocks: [
        block('b1', 1, [[0, 0], [1, 0]]),
        block('b2', 1, [[0, 0], [1, 0]]),
        block('b3', 1, [[0, 0], [1, 0]]),
        block('b4', 1, [[0, 0], [1, 0]]),
      ],
      limits: limits(4, -1, 1),
    });
    expect(outcome.feasible).toBe(true);
    if (!outcome.feasible) return;
    expect(outcome.plan.totalCost).toBe(0);
    expect(outcome.plan.steps.map((s) => s.optionIndex)).toEqual([0, 0, 0, 0]);
  });

  it('十进制等价总代价：0.1+0.2 与 0.3+0 视为同成本，按序号决胜取 0,0,0,0', () => {
    // 任务场景：4 块质量均为 1 的配重；导轨 P/N/Z1/Z2 力臂 1/-1/0/0；
    // 载荷上限 4，力矩区间 [-1,1]。b1@P+b2@N 与 b1@N+b2@P 均满足最终力矩
    // 要求且力矩余量相同，按录入的十进制值总代价都是 0.3；但二进制浮点下
    // 0.1+0.2 = 0.30000000000000004 > 0.3+0，旧实现据此误选 1,1,0,0。
    expect(0.1 + 0.2 === 0.3).toBe(false); // 佐证该场景在浮点下并不等价
    const outcome = adjudicate({
      rails: rails(['P', 1], ['N', -1], ['Z1', 0], ['Z2', 0]),
      blocks: [
        block('b1', 1, [[0, 0.1], [1, 0.3]]),
        block('b2', 1, [[1, 0.2], [0, 0]]),
        block('b3', 1, [[2, 0], [3, 0]]),
        block('b4', 1, [[2, 0], [3, 0]]),
      ],
      limits: limits(4, -1, 1),
    });
    expect(outcome.feasible).toBe(true);
    if (!outcome.feasible) return;
    const plan = outcome.plan;
    // 同成本须按序号决胜返回字典序最小的位置序号 0,0,0,0（b1@P → b2@N → b3@Z1 → b4@Z1）
    expect(plan.steps.map((s) => s.optionIndex)).toEqual([0, 0, 0, 0]);
    expect(plan.steps.map((s) => [s.blockIndex, s.railName])).toEqual([
      [0, 'P'],
      [1, 'N'],
      [2, 'Z1'],
      [3, 'Z1'],
    ]);
    // 总代价按十进制值精确为 0.3（不用 toBeCloseTo：容差会把缺陷掩盖掉）
    expect(plan.totalCost).toBe(0.3);
    // 力矩余量：挂装途中必然出现 |力矩| = 1 的前缀，余量为 0
    expect(plan.minTorqueMargin).toBe(0);
    // 载荷与力矩边界：最终载荷恰为上限 4，首步力矩恰为区间边界 +1
    expect(plan.finalMass).toBe(4);
    expect(plan.steps[0].cumulativeTorque).toBe(1);
    expect(plan.steps[3].loadMargin).toBe(0);
    for (const s of plan.steps) {
      expect(s.cumulativeMass).toBeLessThanOrEqual(4 + EPS);
      expect(s.cumulativeTorque).toBeGreaterThanOrEqual(-1 - EPS);
      expect(s.cumulativeTorque).toBeLessThanOrEqual(1 + EPS);
    }
  });

  it('十进制差额再小也严格优先较低成本（等价场景的双向对照）', () => {
    // 与上一场景同构，仅微调代价：差额 1e-10 是真实的十进制差额，不得被
    // 当作并列而落入序号决胜。
    const run = (b1AtP: number, b2AtP: number) =>
      adjudicate({
        rails: rails(['P', 1], ['N', -1], ['Z1', 0], ['Z2', 0]),
        blocks: [
          block('b1', 1, [[0, b1AtP], [1, 0.3]]),
          block('b2', 1, [[1, 0.2], [0, b2AtP]]),
          block('b3', 1, [[2, 0], [3, 0]]),
          block('b4', 1, [[2, 0], [3, 0]]),
        ],
        limits: limits(4, -1, 1),
      });

    // b1@N+b2@P 总代价 0.3000000001 严格更贵：仍须选 0,0,0,0（总代价 0.3）
    const cheaper = run(0.1, 1e-10);
    expect(cheaper.feasible).toBe(true);
    if (cheaper.feasible) {
      expect(cheaper.plan.totalCost).toBe(0.3);
      expect(cheaper.plan.steps.map((s) => s.optionIndex)).toEqual([0, 0, 0, 0]);
    }

    // b1@P+b2@N 总代价 0.3000000001 严格更贵：须改选 1,1,0,0（总代价 0.3）
    const dearer = run(0.1 + 1e-10, 0);
    expect(dearer.feasible).toBe(true);
    if (dearer.feasible) {
      expect(dearer.plan.totalCost).toBe(0.3);
      expect(dearer.plan.steps.map((s) => s.optionIndex)).toEqual([1, 1, 0, 0]);
      expect(dearer.plan.steps.map((s) => [s.blockIndex, s.railName])).toEqual([
        [0, 'N'],
        [1, 'P'],
        [2, 'Z1'],
        [3, 'Z1'],
      ]);
    }
  });

  it('录入原文的极细小十进制差异：0.10000000000000001 与 0.1 严格区分，选更便宜的 #2', () => {
    // 报告场景：两条力臂均为 0 的导轨，4 块质量均为 1 的配重，载荷上限 4、
    // 力矩区间 [-1,1]，所有位置均可选。b1 的 #1 录入 0.10000000000000001、
    // #2 录入 0.1，其余位置代价均为 0。两个录入值在双精度下舍入为同一个数
    // （Number('0.10000000000000001') === 0.1），若按舍入后的 number 比较会
    // 误判为同成本并按序号错选 #1（0,0,0,0）；必须按录入的十进制原文比较，
    // 让 b1 选代价更低的 #2，返回 1,0,0,0。
    expect(Number('0.10000000000000001')).toBe(0.1); // 佐证差异在双精度下会丢失
    const outcome = adjudicate({
      rails: rails(['Z1', 0], ['Z2', 0]),
      blocks: [
        {
          id: 'blk-b1',
          name: 'b1',
          mass: 1,
          options: [
            { railId: 'rail-0', cost: 0.10000000000000001, costText: '0.10000000000000001' },
            { railId: 'rail-1', cost: 0.1, costText: '0.1' },
          ],
        },
        block('b2', 1, [[0, 0], [1, 0]]),
        block('b3', 1, [[0, 0], [1, 0]]),
        block('b4', 1, [[0, 0], [1, 0]]),
      ],
      limits: limits(4, -1, 1),
    });
    expect(outcome.feasible).toBe(true);
    if (!outcome.feasible) return;
    const plan = outcome.plan;
    // b1 必须选代价更低的 #2（optionIndex 1），其余块真同代价按序号取 #1
    expect(plan.steps.map((s) => s.optionIndex)).toEqual([1, 0, 0, 0]);
    expect(plan.steps.map((s) => [s.blockIndex, s.railName])).toEqual([
      [0, 'Z2'],
      [1, 'Z1'],
      [2, 'Z1'],
      [3, 'Z1'],
    ]);
    // 总代价的精确十进制值为 0.1（舍入回双精度后仍是 0.1）
    expect(plan.totalCost).toBe(0.1);
    // 载荷/力矩边界：最终载荷恰为上限 4，零力臂使力矩恒为 0、余量为 1
    expect(plan.finalMass).toBe(4);
    expect(plan.minTorqueMargin).toBe(1);
    for (const s of plan.steps) {
      expect(s.cumulativeMass).toBeLessThanOrEqual(4 + EPS);
      expect(s.cumulativeTorque).toBe(0);
    }
  });

  it('录入原文总代价确实相等时，位置录入序号仍稳定决胜取字典序最小', () => {
    // 与上一场景同构，但 b1 两个位置录入的都是 0.1（真实相等）：
    // 序号决胜应选 #1（optionIndex 0），返回 0,0,0,0。
    const outcome = adjudicate({
      rails: rails(['Z1', 0], ['Z2', 0]),
      blocks: [
        {
          id: 'blk-b1',
          name: 'b1',
          mass: 1,
          options: [
            { railId: 'rail-0', cost: 0.1, costText: '0.1' },
            { railId: 'rail-1', cost: 0.1, costText: '0.1' },
          ],
        },
        block('b2', 1, [[0, 0], [1, 0]]),
        block('b3', 1, [[0, 0], [1, 0]]),
        block('b4', 1, [[0, 0], [1, 0]]),
      ],
      limits: limits(4, -1, 1),
    });
    expect(outcome.feasible).toBe(true);
    if (!outcome.feasible) return;
    expect(outcome.plan.totalCost).toBe(0.1);
    expect(outcome.plan.steps.map((s) => s.optionIndex)).toEqual([0, 0, 0, 0]);
  });

  it('亚纳米级力矩余量差不得被成本覆盖：严格更高余量的 S 优先于零代价的 R', () => {
    // 报告场景：4 块质量均为 1 的配重，4 条导轨。b1 可选 R（力臂 1、代价 0）
    // 或 S（力臂 0.9999999995、代价 1）；b2~b4 均可在两条力臂 0、代价 0 的导轨间
    // 选择。载荷上限 4、力矩区间 [-1,1]，所有位置均满足载荷与力矩闭区间。
    // 选 S 的首步力矩余量为 5e-10，严格大于选 R 的 0；旧实现以 EPS=1e-9 比较
    // 余量，把该差额当并列并按成本错选 R（0,0,0,0）。修复后须返回 1,0,0,0。
    const outcome = adjudicate({
      rails: rails(['R', 1], ['S', 0.9999999995], ['Z1', 0], ['Z2', 0]),
      blocks: [
        block('b1', 1, [[0, 0], [1, 1]]),
        block('b2', 1, [[2, 0], [3, 0]]),
        block('b3', 1, [[2, 0], [3, 0]]),
        block('b4', 1, [[2, 0], [3, 0]]),
      ],
      limits: limits(4, -1, 1),
    });
    expect(outcome.feasible).toBe(true);
    if (!outcome.feasible) return;
    const plan = outcome.plan;
    // 完整方案：四块各恰用一次，b1 选 S（位置录入序号 #2），其余按序号取 #1
    expect(plan.steps).toHaveLength(4);
    expect(new Set(plan.steps.map((s) => s.blockIndex))).toEqual(new Set([0, 1, 2, 3]));
    expect(plan.steps.map((s) => s.optionIndex)).toEqual([1, 0, 0, 0]);
    expect(plan.steps.map((s) => [s.blockIndex, s.railName])).toEqual([
      [0, 'S'],
      [1, 'Z1'],
      [2, 'Z1'],
      [3, 'Z1'],
    ]);
    // 总代价严格为 1（S 的代价；余量差优先，更高的代价必须被接受）
    expect(plan.totalCost).toBe(1);
    // 最小力矩余量严格为正，恰为 1 - 0.9999999995（5e-10 级，小于旧容差 EPS）
    expect(plan.minTorqueMargin).toBe(1 - 0.9999999995);
    expect(plan.minTorqueMargin).toBeGreaterThan(0);
    expect(plan.minTorqueMargin).toBeLessThan(EPS);
    // 载荷与力矩边界：最终载荷恰为上限 4，首步力矩 0.9999999995 落在 [-1,1] 内
    expect(plan.finalMass).toBe(4);
    expect(plan.steps[0].cumulativeTorque).toBe(0.9999999995);
    for (const s of plan.steps) {
      expect(s.cumulativeMass).toBeLessThanOrEqual(4 + EPS);
      expect(s.cumulativeTorque).toBeGreaterThanOrEqual(-1 - EPS);
      expect(s.cumulativeTorque).toBeLessThanOrEqual(1 + EPS);
    }
  });

  it('力矩余量真正相等时安装成本才参与决胜：同余量下选零代价的 R', () => {
    // 与上一场景同构，但 b1 两个位置的力臂都为 1（余量真正相等，均为 0）：
    // 成本决胜应选零代价的 R，返回 0,0,0,0。
    const outcome = adjudicate({
      rails: rails(['R', 1], ['S2', 1], ['Z1', 0], ['Z2', 0]),
      blocks: [
        block('b1', 1, [[0, 0], [1, 1]]),
        block('b2', 1, [[2, 0], [3, 0]]),
        block('b3', 1, [[2, 0], [3, 0]]),
        block('b4', 1, [[2, 0], [3, 0]]),
      ],
      limits: limits(4, -1, 1),
    });
    expect(outcome.feasible).toBe(true);
    if (!outcome.feasible) return;
    expect(outcome.plan.minTorqueMargin).toBe(0);
    expect(outcome.plan.totalCost).toBe(0);
    expect(outcome.plan.steps.map((s) => s.optionIndex)).toEqual([0, 0, 0, 0]);
    expect(outcome.plan.steps.map((s) => [s.blockIndex, s.railName])).toEqual([
      [0, 'R'],
      [1, 'Z1'],
      [2, 'Z1'],
      [3, 'Z1'],
    ]);
  });

  it('力矩余量最大优先于总代价最小', () => {
    // 便宜方案（代价 2）余量仅 1；居中方案（代价 20）余量 5，必须选后者。
    const outcome = adjudicate({
      rails: rails(['L', -2], ['M', 0], ['R', 2]),
      blocks: [block('b1', 2, [[1, 10], [2, 1]]), block('b2', 2, [[0, 1], [1, 10]])],
      limits: limits(100, -5, 5),
    });
    expect(outcome.feasible).toBe(true);
    if (!outcome.feasible) return;
    expect(outcome.plan.minTorqueMargin).toBeCloseTo(5);
    expect(outcome.plan.totalCost).toBeCloseTo(20);
    expect(outcome.plan.steps.map((s) => s.railName)).toEqual(['M', 'M']);
  });

  it('余量并列时取总代价最小，再按挂装顺序与位置录入序号决胜', () => {
    // 两条零力臂导轨 M1/M2：余量 5 的方案中，b1@M2 + b2@M1 代价 8 最小。
    const outcome = adjudicate({
      rails: rails(['L', -2], ['M1', 0], ['M2', 0], ['R', 2]),
      blocks: [
        block('b1', 2, [[1, 8], [2, 3], [3, 1]]),
        block('b2', 2, [[1, 5], [2, 6], [0, 1]]),
      ],
      limits: limits(100, -5, 5),
    });
    expect(outcome.feasible).toBe(true);
    if (!outcome.feasible) return;
    expect(outcome.plan.minTorqueMargin).toBeCloseTo(5);
    expect(outcome.plan.totalCost).toBeCloseTo(8);
    expect(outcome.plan.steps.map((s) => [s.blockIndex, s.railName])).toEqual([
      [0, 'M2'],
      [1, 'M1'],
    ]);
  });

  it('联合确定位置与次序：不得先选最终位置再事后排序', () => {
    // b4 挂 L（-6）时最终合力矩可为 0，但任何挂装次序都会在中途越界；
    // 只有 b4 挂 H（-3）且 b3 挂 L 并交错挂装才全程安全，且代价更高（9）。
    const outcome = adjudicate({
      rails: rails(['L', -1], ['H', -0.5], ['R', 1]),
      blocks: [
        block('b1', 2, [[2, 1]]),
        block('b2', 2, [[2, 1]]),
        block('b3', 2, [[2, 1], [0, 1]]),
        block('b4', 6, [[0, 1], [1, 9]]),
      ],
      limits: limits(100, -3, 3),
    });
    expect(outcome.feasible).toBe(true);
    if (!outcome.feasible) return;
    expect(outcome.plan.steps.map((s) => [s.blockIndex, s.railName])).toEqual([
      [0, 'R'],
      [2, 'L'],
      [1, 'R'],
      [3, 'H'],
    ]);
    expect(outcome.plan.totalCost).toBeCloseTo(12);
    expect(outcome.plan.minTorqueMargin).toBeCloseTo(1);
    for (const s of outcome.plan.steps) {
      expect(s.cumulativeTorque).toBeGreaterThanOrEqual(-3 - EPS);
      expect(s.cumulativeTorque).toBeLessThanOrEqual(3 + EPS);
    }
  });

  it('多块场景：每块恰用一次且结果确定（可重复）', () => {
    const scenario: Scenario = {
      rails: rails(['L2', -2], ['L1', -1], ['C', 0], ['R1', 1], ['R2', 2]),
      blocks: [
        block('b1', 20, [[1, 2], [3, 2]]),
        block('b2', 15, [[0, 3], [4, 3], [2, 5]]),
        block('b3', 25, [[1, 4], [4, 4]]),
        block('b4', 10, [[2, 1], [3, 2]]),
        block('b5', 30, [[0, 2], [3, 3], [4, 4]]),
      ],
      limits: limits(150, -100, 100),
    };
    const first = adjudicate(scenario);
    const second = adjudicate(scenario);
    expect(first).toEqual(second);
    expect(first.feasible).toBe(true);
    if (!first.feasible) return;
    expect(first.plan.steps).toHaveLength(5);
    expect(new Set(first.plan.steps.map((s) => s.blockIndex)).size).toBe(5);
    for (const s of first.plan.steps) {
      expect(s.cumulativeMass).toBeLessThanOrEqual(150 + EPS);
      expect(Math.abs(s.cumulativeTorque)).toBeLessThanOrEqual(100 + EPS);
      expect(s.loadMargin).toBeCloseTo(150 - s.cumulativeMass);
    }
  });
});

describe('adjudicate · 无可行方案的诊断', () => {
  it('第一步即不可挂：已选前缀为空，逐一列出触发的力矩限制', () => {
    const outcome = adjudicate({
      rails: rails(['L', -1], ['R', 1]),
      blocks: [block('b1', 3, [[0, 1], [1, 1]]), block('b2', 3, [[0, 1], [1, 1]])],
      limits: limits(100, -2, 2),
    });
    expect(outcome.feasible).toBe(false);
    if (outcome.feasible) return;
    expect(outcome.report.witnessPrefix).toHaveLength(0);
    expect(outcome.report.violations).toHaveLength(4);
    const kinds = new Map(outcome.report.violations.map((v) => [`${v.blockIndex}:${v.railName}`, v.kinds]));
    expect(kinds.get('0:L')).toEqual(['torque-low']);
    expect(kinds.get('0:R')).toEqual(['torque-high']);
    expect(kinds.get('1:L')).toEqual(['torque-low']);
    expect(kinds.get('1:R')).toEqual(['torque-high']);
  });

  it('最深前缀止步于载荷限制', () => {
    const outcome = adjudicate({
      rails: rails(['M', 0]),
      blocks: [block('b1', 3, [[0, 1]]), block('b2', 3, [[0, 1]]), block('b3', 3, [[0, 1]])],
      limits: limits(5, -10, 10),
    });
    expect(outcome.feasible).toBe(false);
    if (outcome.feasible) return;
    expect(outcome.report.witnessPrefix).toHaveLength(1);
    expect(outcome.report.witnessPrefix[0].blockIndex).toBe(0);
    expect(outcome.report.violations).toHaveLength(2);
    for (const v of outcome.report.violations) {
      expect(v.kinds).toEqual(['load']);
      expect(v.massAfter).toBeCloseTo(6);
    }
  });

  it('最深前缀按裁决优先级选取，并列选择同时触发载荷与力矩限制', () => {
    // 深度 1 的三个可行前缀余量分别为 2/1/0，须选余量最大的 b1。
    const outcome = adjudicate({
      rails: rails(['R', 1]),
      blocks: [block('b1', 3, [[0, 1]]), block('b2', 4, [[0, 1]]), block('b3', 5, [[0, 1]])],
      limits: limits(6, -5, 5),
    });
    expect(outcome.feasible).toBe(false);
    if (outcome.feasible) return;
    expect(outcome.report.witnessPrefix).toHaveLength(1);
    expect(outcome.report.witnessPrefix[0].blockIndex).toBe(0);
    expect(outcome.report.witnessPrefix[0].cumulativeTorque).toBeCloseTo(3);
    expect(outcome.report.violations).toHaveLength(2);
    for (const v of outcome.report.violations) {
      expect(v.kinds).toEqual(['load', 'torque-high']);
    }
  });
});
