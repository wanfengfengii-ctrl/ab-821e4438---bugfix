import {
  DECIMAL_ZERO,
  decimalAdd,
  decimalCompare,
  decimalFromNumber,
  decimalFromText,
  decimalMultiply,
  decimalSubtract,
  decimalToNumber,
  type Decimal,
} from './decimal';
import type {
  AdjudicationOutcome,
  Limits,
  Plan,
  Scenario,
  StepRecord,
  Violation,
  ViolationKind,
} from './types';

/**
 * 边界判定容差：质量/力臂为浮点录入，仅用于载荷与力矩闭区间的可行性判定，
 * 吸收浮点舍入噪声（如 0.1+0.2 这类累计误差）。
 * 注意：决胜比较不使用此容差——力矩余量按计算值严格比较，任何严格存在
 * 的余量差（哪怕 5e-10）都优先于安装代价，只有余量真正相等成本才可参与；
 * 录入的物理量携带十进制原文时，余量改按原文的精确十进制值计算与比较，
 * 保留 0.99999999999999999 与 1 之间 1e-17 级的真实差异（见 decimalPhysics）；
 * 安装代价同样是逐位有意义的录入值，按十进制精确比较（见 ./decimal）。
 */
export const EPS = 1e-9;

interface FlatOption {
  optionIndex: number;
  railId: string;
  railName: string;
  coordinate: number;
  /** 力臂的精确十进制值（优先由录入原文恢复，见 enteredDecimalOf）。 */
  coordinateDecimal: Decimal;
  cost: number;
  /** 本选项代价的精确十进制值（优先由录入原文恢复，见 enteredDecimalOf）。 */
  costDecimal: Decimal;
}

interface FlatBlock {
  index: number;
  name: string;
  mass: number;
  /** 质量的精确十进制值（优先由录入原文恢复，见 enteredDecimalOf）。 */
  massDecimal: Decimal;
  options: FlatOption[];
}

/**
 * 取一个录入值的精确十进制：优先用录入原文（避免双精度舍入丢失
 * "0.10000000000000001" vs "0.1"、"0.99999999999999999" vs "1" 这类差异）；
 * 原文缺失或形态无法按十进制解析（Number() 还接受 0x10 这类写法）时，
 * 退回 number 的最短往返表示。
 */
function enteredDecimalOf(value: number, text: string | undefined): Decimal {
  if (text !== undefined) {
    try {
      return decimalFromText(text);
    } catch {
      // 落到下方按 number 恢复
    }
  }
  return decimalFromNumber(value);
}

/**
 * 候选方案：对外只暴露 Plan（totalCost 为精确十进制总和的正确舍入值，
 * minTorqueMargin 按场景的余量口径给出，见 adjudicate 内 decimalPhysics），
 * 内部另携带精确十进制总代价与两种口径的力矩余量，供决胜与分支限界严格比较。
 */
interface Candidate {
  plan: Plan;
  cost: Decimal;
  /** 浮点口径的最小力矩余量（尚无前缀时为 +∞）。 */
  marginFloat: number;
  /** 精确十进制口径的最小力矩余量（尚无前缀时为 null，视同 +∞）。 */
  marginDecimal: Decimal | null;
}

function torqueMarginOf(torque: number, limits: Limits): number {
  return Math.min(torque - limits.minTorque, limits.maxTorque - torque);
}

/** 两个精确十进制值取较小者。 */
function decimalMin(a: Decimal, b: Decimal): Decimal {
  return decimalCompare(a, b) <= 0 ? a : b;
}

/** 按 (块录入序号, 位置录入序号) 沿挂装次序逐位比较，保证稳定决胜。 */
function lexCompareSteps(a: StepRecord[], b: StepRecord[]): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a[i].blockIndex !== b[i].blockIndex) return a[i].blockIndex - b[i].blockIndex;
    if (a[i].optionIndex !== b[i].optionIndex) return a[i].optionIndex - b[i].optionIndex;
  }
  return a.length - b.length;
}

/**
 * 裁决：联合确定每块配重恰用一次的挂入位置与完整挂装次序。
 *
 * 搜索按挂装顺序逐步进行，每一个前缀状态都同时校验总载荷与力矩闭区间，
 * 因此绝不出现“先定最终位置再事后排序”的情况；力矩余量沿前缀单调不增、
 * 总代价单调不减（代价非负），据此对当前最优解做分支限界。
 *
 * 总代价以精确十进制累计：十进制加法可交换且与求和次序无关，同一组位置
 * 选择无论以何种次序挂装都得到逐位相同的总代价，真正同成本的方案才能
 * 稳定地落到序号决胜。
 *
 * 力矩余量有两种口径：任一物理量（力臂、质量、力矩端点）携带录入原文时，
 * 力矩与余量按原文的精确十进制值累计与比较——0.99999999999999999 经
 * Number() 会舍入为 1，它与 1 之间 1e-17 的真实余量差只能凭原文保留，
 * 成本不得覆盖这种实际存在的余量差；纯数值场景保持既有浮点口径，
 * 结果与旧实现逐位一致。
 */
export function adjudicate(scenario: Scenario): AdjudicationOutcome {
  const railById = new Map(scenario.rails.map((r) => [r.id, r]));
  const blocks: FlatBlock[] = scenario.blocks.map((b, i) => ({
    index: i,
    name: b.name,
    mass: b.mass,
    massDecimal: enteredDecimalOf(b.mass, b.massText),
    options: b.options.map((o, j) => {
      const rail = railById.get(o.railId);
      if (!rail) throw new Error(`未知导轨位置: ${o.railId}`);
      return {
        optionIndex: j,
        railId: rail.id,
        railName: rail.name,
        coordinate: rail.coordinate,
        coordinateDecimal: enteredDecimalOf(rail.coordinate, rail.coordinateText),
        cost: o.cost,
        costDecimal: enteredDecimalOf(o.cost, o.costText),
      };
    }),
  }));
  const n = blocks.length;
  const limits = scenario.limits;
  const minTorqueDecimal = enteredDecimalOf(limits.minTorque, limits.minTorqueText);
  const maxTorqueDecimal = enteredDecimalOf(limits.maxTorque, limits.maxTorqueText);
  /**
   * 力矩余量的计算/决胜/展示口径：任一物理量携带录入原文时走精确十进制，
   * 否则保持浮点（见函数 docstring）。
   */
  const decimalPhysics =
    scenario.rails.some((r) => r.coordinateText !== undefined) ||
    scenario.blocks.some((b) => b.massText !== undefined) ||
    limits.minTorqueText !== undefined ||
    limits.maxTorqueText !== undefined;

  const used = new Array<boolean>(n).fill(false);
  const steps: StepRecord[] = [];
  let best: Candidate | null = null;
  /**
   * 按声明类型读取 best。best 由下方 dfs 闭包赋值，TypeScript 的控制流分析
   * 不会把闭包内的赋值反映到调用点之后（直接引用会被窄化为 null），
   * 因此调用 dfs 后须经此函数边界读取。
   */
  const getBest = (): Candidate | null => best;
  /** 每个深度上按裁决优先级最优的可行前缀（用于无可行方案时的诊断）。 */
  const bestPartial: (Candidate | null)[] = new Array(n + 1).fill(null);

  /** 余量比较：按场景口径严格比较（十进制口径下 null 表示 +∞，即尚无前缀）。 */
  const marginCompare = (
    aFloat: number,
    aDecimal: Decimal | null,
    bFloat: number,
    bDecimal: Decimal | null,
  ): number => {
    if (decimalPhysics) {
      if (aDecimal === null || bDecimal === null) {
        return aDecimal === bDecimal ? 0 : aDecimal === null ? 1 : -1;
      }
      return decimalCompare(aDecimal, bDecimal);
    }
    return aFloat < bFloat ? -1 : aFloat > bFloat ? 1 : 0;
  };

  /**
   * 裁决优先级（依次）：
   * 1. 力矩余量（所有前缀中的最小值）最大者优先：按场景口径严格比较，
   *    任何严格存在的余量差（哪怕 5e-10，或录入原文保留的 1e-17）都直接
   *    决胜，不被成本覆盖；只有余量真正相等时才进入下一层；
   * 2. 总安装代价最小者优先（按录入的十进制值精确比较：0.1+0.2 与 0.3 视为同成本，
   *    而 1e-10 级的真实差额仍严格区分，序号决胜不得覆盖成本差）；
   * 3. 按挂装顺序的 (块录入序号, 位置录入序号) 序列字典序最小者优先。
   */
  const isBetter = (a: Candidate, b: Candidate | null): boolean => {
    if (b === null) return true;
    const marginOrder = marginCompare(a.marginFloat, a.marginDecimal, b.marginFloat, b.marginDecimal);
    if (marginOrder > 0) return true;
    if (marginOrder < 0) return false;
    const costOrder = decimalCompare(a.cost, b.cost);
    if (costOrder < 0) return true;
    if (costOrder > 0) return false;
    return lexCompareSteps(a.plan.steps, b.plan.steps) < 0;
  };

  const snapshot = (cost: Decimal, marginFloat: number, marginDecimal: Decimal | null): Candidate => ({
    plan: {
      steps: steps.map((s) => ({ ...s })),
      totalCost: decimalToNumber(cost),
      minTorqueMargin: decimalPhysics
        ? marginDecimal === null
          ? Number.POSITIVE_INFINITY
          : decimalToNumber(marginDecimal)
        : marginFloat,
      finalMass: steps.length > 0 ? steps[steps.length - 1].cumulativeMass : 0,
      finalTorque: steps.length > 0 ? steps[steps.length - 1].cumulativeTorque : 0,
    },
    cost,
    marginFloat,
    marginDecimal,
  });

  const dfs = (
    depth: number,
    mass: number,
    torque: number,
    torqueDecimal: Decimal,
    cost: Decimal,
    minMarginFloat: number,
    minMarginDecimal: Decimal | null,
  ): void => {
    const current = snapshot(cost, minMarginFloat, minMarginDecimal);
    if (isBetter(current, bestPartial[depth])) bestPartial[depth] = current;
    if (depth === n) {
      if (isBetter(current, best)) best = current;
      return;
    }
    for (let i = 0; i < n; i++) {
      if (used[i]) continue;
      const block = blocks[i];
      for (const opt of block.options) {
        const massAfter = mass + block.mass;
        if (massAfter > limits.maxLoad + EPS) continue;
        const torqueAfter = torque + block.mass * opt.coordinate;
        if (torqueAfter < limits.minTorque - EPS || torqueAfter > limits.maxTorque + EPS) continue;
        // 浮点口径余量（纯数值场景的比较与展示沿用此口径）。
        const marginFloat = torqueMarginOf(torqueAfter, limits);
        const nextMinMarginFloat = Math.min(minMarginFloat, marginFloat);
        // 精确十进制口径余量：力矩按录入的十进制物理值累计，保留
        // 0.99999999999999999 与 1 之间 1e-17 级的真实余量差。
        const torqueDecimalAfter = decimalAdd(
          torqueDecimal,
          decimalMultiply(block.massDecimal, opt.coordinateDecimal),
        );
        const marginDecimal = decimalMin(
          decimalSubtract(torqueDecimalAfter, minTorqueDecimal),
          decimalSubtract(maxTorqueDecimal, torqueDecimalAfter),
        );
        const nextMinMarginDecimal =
          minMarginDecimal === null ? marginDecimal : decimalMin(minMarginDecimal, marginDecimal);
        // 精确十进制累加本步代价（代价非负，规模 ≤7，开销可忽略）。
        const nextCost = decimalAdd(cost, opt.costDecimal);
        if (best) {
          // 力矩余量沿前缀单调不增：已严格劣于最优解时，任何完成都追不平，剪枝。
          // 严格比较（不容差）：再小的真实余量差（如 5e-10、1e-17）都不得被成本覆盖。
          if (
            marginCompare(nextMinMarginFloat, nextMinMarginDecimal, best.marginFloat, best.marginDecimal) < 0
          ) {
            continue;
          }
          // 余量最多只能并列最优，而代价（非负，继续挂装只会更高）已严格更贵，剪枝。
          // 精确十进制比较：哪怕只差 1e-10 也必须保留更便宜的分支。
          if (
            marginCompare(nextMinMarginFloat, nextMinMarginDecimal, best.marginFloat, best.marginDecimal) <= 0 &&
            decimalCompare(nextCost, best.cost) > 0
          ) {
            continue;
          }
        }
        used[i] = true;
        steps.push({
          blockIndex: i,
          blockName: block.name,
          optionIndex: opt.optionIndex,
          railId: opt.railId,
          railName: opt.railName,
          coordinate: opt.coordinate,
          mass: block.mass,
          cost: opt.cost,
          cumulativeMass: massAfter,
          cumulativeTorque: decimalPhysics ? decimalToNumber(torqueDecimalAfter) : torqueAfter,
          loadMargin: limits.maxLoad - massAfter,
          torqueMargin: decimalPhysics ? decimalToNumber(marginDecimal) : marginFloat,
        });
        dfs(
          depth + 1,
          massAfter,
          torqueAfter,
          torqueDecimalAfter,
          nextCost,
          nextMinMarginFloat,
          nextMinMarginDecimal,
        );
        steps.pop();
        used[i] = false;
      }
    }
  };

  dfs(0, 0, 0, DECIMAL_ZERO, DECIMAL_ZERO, Number.POSITIVE_INFINITY, null);

  const winner = getBest();
  if (winner) return { feasible: true, plan: winner.plan };

  // 无可行方案：定位最深的可行已选前缀（其下一步即最早无法继续挂装的位置）。
  let depth = n - 1;
  while (depth >= 0 && bestPartial[depth] === null) depth--;
  const witness = depth >= 0 ? bestPartial[depth] : null;
  const witnessSteps = witness ? witness.plan.steps : [];
  const usedBlocks = new Set(witnessSteps.map((s) => s.blockIndex));
  const baseMass = witness ? witness.plan.finalMass : 0;
  const baseTorque = witness ? witness.plan.finalTorque : 0;

  const violations: Violation[] = [];
  for (const block of blocks) {
    if (usedBlocks.has(block.index)) continue;
    for (const opt of block.options) {
      const massAfter = baseMass + block.mass;
      const torqueAfter = baseTorque + block.mass * opt.coordinate;
      const kinds: ViolationKind[] = [];
      if (massAfter > limits.maxLoad + EPS) kinds.push('load');
      if (torqueAfter < limits.minTorque - EPS) kinds.push('torque-low');
      if (torqueAfter > limits.maxTorque + EPS) kinds.push('torque-high');
      if (kinds.length > 0) {
        violations.push({
          blockIndex: block.index,
          blockName: block.name,
          optionIndex: opt.optionIndex,
          railId: opt.railId,
          railName: opt.railName,
          massAfter,
          torqueAfter,
          kinds,
        });
      }
    }
  }
  return { feasible: false, report: { witnessPrefix: witnessSteps, violations } };
}
