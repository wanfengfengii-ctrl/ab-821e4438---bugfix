import {
  DECIMAL_ZERO,
  decimalAdd,
  decimalCompare,
  decimalFromNumber,
  decimalFromText,
  decimalMin,
  decimalMultiply,
  decimalSubtract,
  decimalToNumber,
  type Decimal,
} from './decimal';
import type {
  AdjudicationOutcome,
  Plan,
  Scenario,
  StepRecord,
  Violation,
  ViolationKind,
} from './types';

/**
 * 边界判定容差：质量/力臂为浮点录入且可能没有录入原文，仅用于载荷与力矩
 * 闭区间的可行性判定，吸收无原文时的双精度舍入噪声（如 0.1+0.2 这类累计误差）。
 * 注意：决胜比较绝不使用此容差——力矩余量按录入的十进制值精确比较
 * （质量 × 力臂、力矩累加、余量计算全部走任意精度十进制），任何严格存在
 * 的余量差（哪怕 1e-17）都优先于安装代价，只有余量按十进制值真正相等时
 * 成本才可参与；安装代价同样按十进制精确比较（见 ./decimal）。
 */
export const EPS = 1e-9;

interface FlatOption {
  optionIndex: number;
  railId: string;
  railName: string;
  /** 双精度视图：闭区间可行性判定与界面展示。 */
  coordinate: number;
  /** 本选项力臂的精确十进制值（优先由录入原文恢复，见 coordinateDecimalOf）。 */
  coordinateDecimal: Decimal;
  cost: number;
  /** 本选项代价的精确十进制值（优先由录入原文恢复，见 costDecimalOf）。 */
  costDecimal: Decimal;
}

interface FlatBlock {
  index: number;
  name: string;
  mass: number;
  massDecimal: Decimal;
  options: FlatOption[];
}

/**
 * 取一个选项代价的精确十进制值：优先用录入原文（避免双精度舍入丢失
 * "0.10000000000000001" vs "0.1" 这类差异）；原文形态无法按十进制解析
 * （Number() 还接受 0x10 这类写法）时退回 number 的最短往返表示。
 */
function costDecimalOf(o: { cost: number; costText?: string }): Decimal {
  if (o.costText !== undefined) {
    try {
      return decimalFromText(o.costText);
    } catch {
      // 落到下方按 number 恢复
    }
  }
  return decimalFromNumber(o.cost);
}

/**
 * 取一条导轨力臂的精确十进制值：优先用录入原文。这是高精度力臂场景的
 * 关键入口——Number('0.99999999999999999') === 1，双精度视图已不可逆地
 * 丢掉 1e-17 的差异，只有原文能让选 S 的首步余量严格大于选 R 的 0。
 */
function coordinateDecimalOf(r: { coordinate: number; coordinateText?: string }): Decimal {
  if (r.coordinateText !== undefined) {
    try {
      return decimalFromText(r.coordinateText);
    } catch {
      // 落到下方按 number 恢复
    }
  }
  return decimalFromNumber(r.coordinate);
}

/**
 * 候选方案：对外只暴露 Plan（totalCost / minTorqueMargin 为精确十进制值的
 * 正确舍入视图），内部另携带精确十进制总代价与余量，供决胜与分支限界严格比较。
 * margin 为 null 表示尚未挂任何配重（余量 +∞，仅出现在空前缀）。
 */
interface Candidate {
  plan: Plan;
  cost: Decimal;
  margin: Decimal | null;
}

/** 力矩余量 = min(力矩 - 下限, 上限 - 力矩)，按录入十进制值精确计算。 */
function torqueMarginOf(torque: Decimal, minTorque: Decimal, maxTorque: Decimal): Decimal {
  return decimalMin(decimalSubtract(torque, minTorque), decimalSubtract(maxTorque, torque));
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
 * 裁决优先级（依次）：
 * 1. 力矩余量（所有前缀中的最小值）最大者优先：按录入的十进制值精确比较，
 *    任何严格存在的余量差（哪怕 1e-17）都直接决胜，不被成本覆盖；
 *    只有余量真正相等时才进入下一层；
 * 2. 总安装代价最小者优先（按录入的十进制值精确比较：0.1+0.2 与 0.3 视为同成本，
 *    而 1e-10 级的真实差额仍严格区分，序号决胜不得覆盖成本差）；
 * 3. 按挂装顺序的 (块录入序号, 位置录入序号) 序列字典序最小者优先。
 */
function isBetter(a: Candidate, b: Candidate | null): boolean {
  if (b === null) return true;
  if (a.margin === null || b.margin === null) {
    // 空前缀余量为 +∞：两个空前缀之间继续按代价/序号比较
    if (a.margin !== b.margin) return a.margin === null;
  } else {
    const marginOrder = decimalCompare(a.margin, b.margin);
    if (marginOrder > 0) return true;
    if (marginOrder < 0) return false;
  }
  const costOrder = decimalCompare(a.cost, b.cost);
  if (costOrder < 0) return true;
  if (costOrder > 0) return false;
  return lexCompareSteps(a.plan.steps, b.plan.steps) < 0;
}

/**
 * 裁决：联合确定每块配重恰用一次的挂入位置与完整挂装次序。
 *
 * 搜索按挂装顺序逐步进行，每一个前缀状态都同时校验总载荷与力矩闭区间，
 * 因此绝不出现“先定最终位置再事后排序”的情况；力矩余量沿前缀单调不增、
 * 总代价单调不减（代价非负），据此对当前最优解做分支限界。
 *
 * 力矩（质量 × 力臂）与力矩余量全程以精确十进制累计：十进制加法可交换且与
 * 求和次序无关，同一组位置选择无论以何种次序挂装都得到逐位相同的余量与
 * 总代价，真正同余量、同成本的方案才能稳定地落到序号决胜。闭区间可行性
 * 判定仍取精确值的双精度舍入视图配合 EPS 容差，避免无原文录入的舍入噪声
 * 把恰好压在边界上的方案误判为不可行。
 */
export function adjudicate(scenario: Scenario): AdjudicationOutcome {
  const railById = new Map(scenario.rails.map((r) => [r.id, r]));
  const blocks: FlatBlock[] = scenario.blocks.map((b, i) => ({
    index: i,
    name: b.name,
    mass: b.mass,
    massDecimal: decimalFromNumber(b.mass),
    options: b.options.map((o, j) => {
      const rail = railById.get(o.railId);
      if (!rail) throw new Error(`未知导轨位置: ${o.railId}`);
      return {
        optionIndex: j,
        railId: rail.id,
        railName: rail.name,
        coordinate: rail.coordinate,
        coordinateDecimal: coordinateDecimalOf(rail),
        cost: o.cost,
        costDecimal: costDecimalOf(o),
      };
    }),
  }));
  const n = blocks.length;
  const limits = scenario.limits;
  const minTorqueDecimal = decimalFromNumber(limits.minTorque);
  const maxTorqueDecimal = decimalFromNumber(limits.maxTorque);

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

  const snapshot = (cost: Decimal, margin: Decimal | null): Candidate => ({
    plan: {
      steps: steps.map((s) => ({ ...s })),
      totalCost: decimalToNumber(cost),
      minTorqueMargin: margin === null ? Number.POSITIVE_INFINITY : decimalToNumber(margin),
      finalMass: steps.length > 0 ? steps[steps.length - 1].cumulativeMass : 0,
      finalTorque: steps.length > 0 ? steps[steps.length - 1].cumulativeTorque : 0,
    },
    cost,
    margin,
  });

  const dfs = (
    depth: number,
    mass: Decimal,
    torque: Decimal,
    cost: Decimal,
    minMargin: Decimal | null,
  ): void => {
    const current = snapshot(cost, minMargin);
    if (isBetter(current, bestPartial[depth])) bestPartial[depth] = current;
    if (depth === n) {
      if (isBetter(current, best)) best = current;
      return;
    }
    for (let i = 0; i < n; i++) {
      if (used[i]) continue;
      const block = blocks[i];
      for (const opt of block.options) {
        const massAfter = decimalAdd(mass, block.massDecimal);
        const massAfterNum = decimalToNumber(massAfter);
        if (massAfterNum > limits.maxLoad + EPS) continue;
        const torqueAfter = decimalAdd(torque, decimalMultiply(block.massDecimal, opt.coordinateDecimal));
        const torqueAfterNum = decimalToNumber(torqueAfter);
        if (torqueAfterNum < limits.minTorque - EPS || torqueAfterNum > limits.maxTorque + EPS) continue;
        // 余量按录入的十进制值精确计算：任何真实差额（哪怕 1e-17）都保留下来。
        const margin = torqueMarginOf(torqueAfter, minTorqueDecimal, maxTorqueDecimal);
        const nextMinMargin = minMargin === null ? margin : decimalMin(minMargin, margin);
        // 精确十进制累加本步代价（代价非负，规模 ≤7，开销可忽略）。
        const nextCost = decimalAdd(cost, opt.costDecimal);
        if (best && best.margin !== null) {
          // 力矩余量沿前缀单调不增：已严格劣于最优解时，任何完成都追不平，剪枝。
          // 精确十进制比较（不容差）：再小的真实余量差（如 1e-17）都不得被成本覆盖。
          if (decimalCompare(nextMinMargin, best.margin) < 0) continue;
          // 余量最多只能并列最优，而代价（非负，继续挂装只会更高）已严格更贵，剪枝。
          // 精确十进制比较：哪怕只差 1e-10 也必须保留更便宜的分支。
          if (decimalCompare(nextMinMargin, best.margin) <= 0 && decimalCompare(nextCost, best.cost) > 0) {
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
          cumulativeMass: massAfterNum,
          cumulativeTorque: torqueAfterNum,
          loadMargin: limits.maxLoad - massAfterNum,
          torqueMargin: decimalToNumber(margin),
        });
        dfs(depth + 1, massAfter, torqueAfter, nextCost, nextMinMargin);
        steps.pop();
        used[i] = false;
      }
    }
  };

  dfs(0, DECIMAL_ZERO, DECIMAL_ZERO, DECIMAL_ZERO, null);

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
