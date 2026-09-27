/**
 * 一次性冒烟脚本（verify 服务）：
 *  1. 对裁决业务模块跑确定性用例（可行 / 不可行）；
 *  2. 探测已启动页面的健康端点 /healthz；
 *  3. 探测首页可访问。
 * 全部通过以退出码 0 结束，否则退出码 1。
 */
import { adjudicate } from '../src/solver/adjudicate';
import type { Scenario } from '../src/solver/types';

const base = `http://${process.env.WEB_HOST ?? 'web'}:${process.env.WEB_PORT ?? '8080'}`;

let failures = 0;
const check = (cond: boolean, msg: string) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`);
  if (!cond) failures++;
};

// ---------- 1. 裁决业务模块冒烟 ----------

// 可行场景：余量 5 的方案中 b1@M2 + b2@M1 总代价 8 最小，次序按录入序号决胜。
const feasibleScenario: Scenario = {
  rails: [
    { id: 'L', name: 'L', coordinate: -2 },
    { id: 'M1', name: 'M1', coordinate: 0 },
    { id: 'M2', name: 'M2', coordinate: 0 },
    { id: 'R', name: 'R', coordinate: 2 },
  ],
  blocks: [
    { id: 'b1', name: 'b1', mass: 2, options: [{ railId: 'M1', cost: 8 }, { railId: 'M2', cost: 3 }, { railId: 'R', cost: 1 }] },
    { id: 'b2', name: 'b2', mass: 2, options: [{ railId: 'M1', cost: 5 }, { railId: 'M2', cost: 6 }, { railId: 'L', cost: 1 }] },
  ],
  limits: { maxLoad: 100, minTorque: -5, maxTorque: 5 },
};

const r1 = adjudicate(feasibleScenario);
check(r1.feasible, '裁决模块：可行场景应判定为可行');
if (r1.feasible) {
  check(r1.plan.steps.length === 2, '裁决模块：方案应覆盖全部配重（每块恰用一次）');
  check(
    r1.plan.steps.every((s) => Math.abs(s.cumulativeTorque) <= 5 + 1e-9 && s.cumulativeMass <= 100 + 1e-9),
    '裁决模块：每个前缀状态均满足载荷与力矩限制',
  );
  check(Math.abs(r1.plan.totalCost - 8) < 1e-9, `裁决模块：总安装代价应为 8（实际 ${r1.plan.totalCost}）`);
  check(Math.abs(r1.plan.minTorqueMargin - 5) < 1e-9, `裁决模块：力矩余量应为 5（实际 ${r1.plan.minTorqueMargin}）`);
  check(
    r1.plan.steps[0].railId === 'M2' && r1.plan.steps[1].railId === 'M1',
    '裁决模块：挂装位置与次序应符合决胜规则（b1@M2 → b2@M1）',
  );
}

// 纳米级代价差场景：#1 代价 1e-10、#2 代价 0；力矩余量全同，
// 严格最低总代价为 0，四块均须采用位置录入序号 #2（optionIndex 1）。
const nanoCostScenario: Scenario = {
  rails: [
    { id: 'Z1', name: 'Z1', coordinate: 0 },
    { id: 'Z2', name: 'Z2', coordinate: 0 },
  ],
  blocks: [1, 2, 3, 4].map((k) => ({
    id: `b${k}`,
    name: `b${k}`,
    mass: 1,
    options: [
      { railId: 'Z1', cost: 1e-10 },
      { railId: 'Z2', cost: 0 },
    ],
  })),
  limits: { maxLoad: 4, minTorque: -1, maxTorque: 1 },
};

const r0 = adjudicate(nanoCostScenario);
check(r0.feasible, '裁决模块：纳米代价场景应判定为可行');
if (r0.feasible) {
  const p = r0.plan;
  check(p.steps.length === 4, '纳米代价：完整方案应覆盖四块配重');
  check(
    p.steps.every((s) => s.optionIndex === 1 && s.railId === 'Z2'),
    '纳米代价：四块均须采用零代价的位置 #2（Z2）',
  );
  check(p.totalCost === 0, `纳米代价：总代价须严格为 0（实际 ${p.totalCost}）`);
}

// 十进制等价成本场景：b1@P+b2@N（0.1+0.2）与 b1@N+b2@P（0.3+0）按录入的
// 十进制值总代价都是 0.3、力矩余量相同，须判为同成本并按序号决胜返回
// 0,0,0,0（二进制浮点下 0.1+0.2 ≠ 0.3，旧实现会误选 1,1,0,0）。
const decimalTieScenario: Scenario = {
  rails: [
    { id: 'P', name: 'P', coordinate: 1 },
    { id: 'N', name: 'N', coordinate: -1 },
    { id: 'Z1', name: 'Z1', coordinate: 0 },
    { id: 'Z2', name: 'Z2', coordinate: 0 },
  ],
  blocks: [
    { id: 'b1', name: 'b1', mass: 1, options: [{ railId: 'P', cost: 0.1 }, { railId: 'N', cost: 0.3 }] },
    { id: 'b2', name: 'b2', mass: 1, options: [{ railId: 'N', cost: 0.2 }, { railId: 'P', cost: 0 }] },
    { id: 'b3', name: 'b3', mass: 1, options: [{ railId: 'Z1', cost: 0 }, { railId: 'Z2', cost: 0 }] },
    { id: 'b4', name: 'b4', mass: 1, options: [{ railId: 'Z1', cost: 0 }, { railId: 'Z2', cost: 0 }] },
  ],
  limits: { maxLoad: 4, minTorque: -1, maxTorque: 1 },
};

const r3 = adjudicate(decimalTieScenario);
check(r3.feasible, '裁决模块：十进制等价成本场景应判定为可行');
if (r3.feasible) {
  const p = r3.plan;
  check(p.totalCost === 0.3, `十进制等价：总代价应为 0.3（实际 ${p.totalCost}）`);
  check(
    p.steps.map((s) => s.optionIndex).join(',') === '0,0,0,0',
    `十进制等价：同成本应按序号决胜返回 0,0,0,0（实际 ${p.steps.map((s) => s.optionIndex).join(',')}）`,
  );
  check(
    p.steps.map((s) => `${s.blockIndex}@${s.railId}`).join(' ') === '0@P 1@N 2@Z1 3@Z1',
    '十进制等价：挂装位置与次序应为 b1@P → b2@N → b3@Z1 → b4@Z1',
  );
  check(
    p.steps.every((s) => s.cumulativeMass <= 4 + 1e-9 && Math.abs(s.cumulativeTorque) <= 1 + 1e-9),
    '十进制等价：每个前缀状态均满足载荷与力矩限制',
  );
  check(p.finalMass === 4, '十进制等价：最终载荷应恰为上限 4（载荷边界）');
  check(p.steps[0].cumulativeTorque === 1, '十进制等价：首步力矩应恰为区间边界 +1（力矩边界）');
}

// 真实不等成本对照：b2@P 代价 1e-10 使 b1@N+b2@P 总代价 0.3000000001 严格更贵，
// 仍须选 0,0,0,0（总代价 0.3），极小十进制差额不得被当作并列。
const unequalCostScenario: Scenario = {
  ...decimalTieScenario,
  blocks: decimalTieScenario.blocks.map((b) =>
    b.id === 'b2' ? { ...b, options: [{ railId: 'N', cost: 0.2 }, { railId: 'P', cost: 1e-10 }] } : b,
  ),
};

const r4 = adjudicate(unequalCostScenario);
check(r4.feasible, '裁决模块：真实不等成本场景应判定为可行');
if (r4.feasible) {
  check(r4.plan.totalCost === 0.3, `真实不等成本：总代价应为 0.3（实际 ${r4.plan.totalCost}）`);
  check(
    r4.plan.steps.map((s) => s.optionIndex).join(',') === '0,0,0,0',
    `真实不等成本：仍须选 0,0,0,0（实际 ${r4.plan.steps.map((s) => s.optionIndex).join(',')}）`,
  );
}

// 超双精度精度的极细小十进制差额：b1 位置 #1 录入 0.10000000000000001、位置 #2
// 录入 0.1，其余三块两个位置代价均为 0。两者经 Number() 舍入为同一个双精度数
// （Number('0.10000000000000001') === 0.1），必须凭录入原文严格区分：b1 选 #2，
// 返回位置序号 1,0,0,0；真同代价时序号决胜才取 0,0,0,0。
const ultraFineScenario: Scenario = {
  rails: [
    { id: 'Z1', name: 'Z1', coordinate: 0 },
    { id: 'Z2', name: 'Z2', coordinate: 0 },
  ],
  blocks: [
    {
      id: 'b1',
      name: 'b1',
      mass: 1,
      options: [
        { railId: 'Z1', cost: 0.10000000000000001, costText: '0.10000000000000001' },
        { railId: 'Z2', cost: 0.1, costText: '0.1' },
      ],
    },
    { id: 'b2', name: 'b2', mass: 1, options: [{ railId: 'Z1', cost: 0 }, { railId: 'Z2', cost: 0 }] },
    { id: 'b3', name: 'b3', mass: 1, options: [{ railId: 'Z1', cost: 0 }, { railId: 'Z2', cost: 0 }] },
    { id: 'b4', name: 'b4', mass: 1, options: [{ railId: 'Z1', cost: 0 }, { railId: 'Z2', cost: 0 }] },
  ],
  limits: { maxLoad: 4, minTorque: -1, maxTorque: 1 },
};

const r5 = adjudicate(ultraFineScenario);
check(r5.feasible, '裁决模块：极细小十进制差额场景应判定为可行');
if (r5.feasible) {
  const p = r5.plan;
  check(p.steps.length === 4, '极细小差额：完整方案应覆盖四块配重');
  check(
    p.steps.map((s) => s.optionIndex).join(',') === '1,0,0,0',
    `极细小差额：b1 须选代价 0.1 的位置 #2，返回 1,0,0,0（实际 ${p.steps.map((s) => s.optionIndex).join(',')}）`,
  );
  check(p.steps[0].railId === 'Z2', '极细小差额：首块 b1 应挂在 Z2');
  check(p.totalCost === 0.1, `极细小差额：总代价应为 0.1（实际 ${p.totalCost}）`);
  check(p.finalMass === 4, '极细小差额：最终载荷应恰为上限 4（载荷边界）');
  check(
    p.steps.every((s) => s.cumulativeTorque === 0 && s.cumulativeMass <= 4),
    '极细小差额：每个前缀满足载荷与力矩限制（零力臂力矩恒为 0，落在 [-1,1]）',
  );
}

// 极细小差额的并列对照：b1 两个位置都录入 0.1（真正相等），序号决胜应取 #1。
const ultraFineTieScenario: Scenario = {
  ...ultraFineScenario,
  blocks: ultraFineScenario.blocks.map((b) =>
    b.id === 'b1'
      ? { ...b, options: [{ railId: 'Z1', cost: 0.1, costText: '0.1' }, { railId: 'Z2', cost: 0.1, costText: '0.1' }] }
      : b,
  ),
};
const r6 = adjudicate(ultraFineTieScenario);
check(r6.feasible, '裁决模块：极细小差额的并列对照场景应判定为可行');
if (r6.feasible) {
  check(
    r6.plan.steps.map((s) => s.optionIndex).join(',') === '0,0,0,0',
    `极细小差额并列：真同代价应按序号决胜返回 0,0,0,0（实际 ${r6.plan.steps.map((s) => s.optionIndex).join(',')}）`,
  );
}

// 亚纳米级力矩余量差场景：b1 的 R 力臂 1 代价 0、S 力臂 0.9999999995 代价 1，
// b2~b4 在两条零力臂零代价导轨间选择；载荷上限 4、力矩区间 [-1,1]，所有位置
// 均满足载荷与力矩闭区间。选 S 的首步力矩余量 5e-10 严格大于选 R 的 0：
// 余量差再小也优先于成本，必须选 S，返回位置序号 1,0,0,0（旧实现以 EPS=1e-9
// 抹平余量差，按成本错选 R 返回 0,0,0,0）。
const nanoMarginScenario: Scenario = {
  rails: [
    { id: 'R', name: 'R', coordinate: 1 },
    { id: 'S', name: 'S', coordinate: 0.9999999995 },
    { id: 'Z1', name: 'Z1', coordinate: 0 },
    { id: 'Z2', name: 'Z2', coordinate: 0 },
  ],
  blocks: [
    { id: 'b1', name: 'b1', mass: 1, options: [{ railId: 'R', cost: 0 }, { railId: 'S', cost: 1 }] },
    { id: 'b2', name: 'b2', mass: 1, options: [{ railId: 'Z1', cost: 0 }, { railId: 'Z2', cost: 0 }] },
    { id: 'b3', name: 'b3', mass: 1, options: [{ railId: 'Z1', cost: 0 }, { railId: 'Z2', cost: 0 }] },
    { id: 'b4', name: 'b4', mass: 1, options: [{ railId: 'Z1', cost: 0 }, { railId: 'Z2', cost: 0 }] },
  ],
  limits: { maxLoad: 4, minTorque: -1, maxTorque: 1 },
};

const r7 = adjudicate(nanoMarginScenario);
check(r7.feasible, '裁决模块：亚纳米余量差场景应判定为可行');
if (r7.feasible) {
  const p = r7.plan;
  check(p.steps.length === 4, '亚纳米余量：完整方案应覆盖四块配重（每块恰用一次）');
  check(
    p.steps.map((s) => s.optionIndex).join(',') === '1,0,0,0',
    `亚纳米余量：b1 须选余量严格更高的 S，返回 1,0,0,0（实际 ${p.steps.map((s) => s.optionIndex).join(',')}）`,
  );
  check(
    p.steps.map((s) => `${s.blockIndex}@${s.railId}`).join(' ') === '0@S 1@Z1 2@Z1 3@Z1',
    '亚纳米余量：挂装位置与次序应为 b1@S → b2@Z1 → b3@Z1 → b4@Z1',
  );
  check(p.totalCost === 1, `亚纳米余量：总代价应为 1（实际 ${p.totalCost}）`);
  check(
    p.minTorqueMargin > 0 && p.minTorqueMargin === 5e-10,
    `亚纳米余量：最小力矩余量应严格为正且为按录入值计算的 5e-10（实际 ${p.minTorqueMargin}）`,
  );
  check(
    p.steps.every((s) => s.cumulativeMass <= 4 && s.cumulativeTorque >= -1 && s.cumulativeTorque <= 1),
    '亚纳米余量：每个前缀状态均满足载荷与力矩闭区间',
  );
}

// 余量真正相等的对照：b1 两个位置力臂均为 1（余量都是 0），成本决胜须选零代价
// 的 R，返回 0,0,0,0。
const trueTieMarginScenario: Scenario = {
  ...nanoMarginScenario,
  rails: nanoMarginScenario.rails.map((r) => (r.id === 'S' ? { ...r, coordinate: 1 } : r)),
};
const r8 = adjudicate(trueTieMarginScenario);
check(r8.feasible, '裁决模块：余量真相等对照场景应判定为可行');
if (r8.feasible) {
  check(
    r8.plan.steps.map((s) => s.optionIndex).join(',') === '0,0,0,0' && r8.plan.totalCost === 0,
    `余量真相等：成本决胜须选零代价的 R，返回 0,0,0,0（实际 ${r8.plan.steps
      .map((s) => s.optionIndex)
      .join(',')}，代价 ${r8.plan.totalCost}）`,
  );
}

// 接近双精度边界的高精度力臂场景：R 力臂录入 1、代价 0；S 力臂录入
// 0.99999999999999999、代价 1；b2~b4 在两条零力臂零代价导轨间选择；载荷上限
// 4、力矩区间 [-1,1]，所有位置均满足闭区间。Number('0.99999999999999999') === 1，
// 双精度视图下首步余量差（严格 1e-17）已被抹掉；必须凭录入原文按十进制精确
// 比较余量：选 S 首步余量严格为正，优先于零代价的 R，返回 1,0,0,0。
const highPrecisionArmScenario: Scenario = {
  rails: [
    { id: 'R', name: 'R', coordinate: 1, coordinateText: '1' },
    { id: 'S', name: 'S', coordinate: 1, coordinateText: '0.99999999999999999' },
    { id: 'Z1', name: 'Z1', coordinate: 0, coordinateText: '0' },
    { id: 'Z2', name: 'Z2', coordinate: 0, coordinateText: '0' },
  ],
  blocks: [
    { id: 'b1', name: 'b1', mass: 1, options: [{ railId: 'R', cost: 0 }, { railId: 'S', cost: 1 }] },
    { id: 'b2', name: 'b2', mass: 1, options: [{ railId: 'Z1', cost: 0 }, { railId: 'Z2', cost: 0 }] },
    { id: 'b3', name: 'b3', mass: 1, options: [{ railId: 'Z1', cost: 0 }, { railId: 'Z2', cost: 0 }] },
    { id: 'b4', name: 'b4', mass: 1, options: [{ railId: 'Z1', cost: 0 }, { railId: 'Z2', cost: 0 }] },
  ],
  limits: { maxLoad: 4, minTorque: -1, maxTorque: 1 },
};

const r9 = adjudicate(highPrecisionArmScenario);
check(r9.feasible, '裁决模块：高精度力臂场景应判定为可行');
if (r9.feasible) {
  const p = r9.plan;
  check(p.steps.length === 4, '高精度力臂：完整方案应覆盖四块配重（每块恰用一次）');
  check(
    p.steps.map((s) => s.optionIndex).join(',') === '1,0,0,0',
    `高精度力臂：b1 须选余量严格更高（1e-17）的 S，返回 1,0,0,0（实际 ${p.steps
      .map((s) => s.optionIndex)
      .join(',')}）`,
  );
  check(
    p.steps.map((s) => `${s.blockIndex}@${s.railId}`).join(' ') === '0@S 1@Z1 2@Z1 3@Z1',
    '高精度力臂：挂装位置与次序应为 b1@S → b2@Z1 → b3@Z1 → b4@Z1',
  );
  check(p.totalCost === 1, `高精度力臂：余量差优先，总代价应为 1（实际 ${p.totalCost}）`);
  check(
    p.minTorqueMargin > 0 && p.minTorqueMargin === 1e-17,
    `高精度力臂：最小力矩余量应严格为按录入值计算的 1e-17（实际 ${p.minTorqueMargin}）`,
  );
  check(
    p.steps.every((s) => s.cumulativeMass <= 4 && s.cumulativeTorque >= -1 && s.cumulativeTorque <= 1),
    '高精度力臂：每个前缀状态均满足载荷与力矩闭区间',
  );
}

// 高精度力臂的并列对照：R、S 力臂都录入 1（余量真正相等，均为 0），
// 成本决胜须选零代价的 R，返回 0,0,0,0。
const highPrecisionArmTieScenario: Scenario = {
  ...highPrecisionArmScenario,
  rails: highPrecisionArmScenario.rails.map((r) =>
    r.id === 'S' ? { ...r, coordinateText: '1' } : r,
  ),
};
const r10 = adjudicate(highPrecisionArmTieScenario);
check(r10.feasible, '裁决模块：高精度力臂并列对照场景应判定为可行');
if (r10.feasible) {
  check(
    r10.plan.steps.map((s) => s.optionIndex).join(',') === '0,0,0,0' && r10.plan.totalCost === 0,
    `高精度力臂并列：余量真相等时成本决胜须选零代价的 R，返回 0,0,0,0（实际 ${r10.plan.steps
      .map((s) => s.optionIndex)
      .join(',')}，代价 ${r10.plan.totalCost}）`,
  );
}

// 不可行场景：深度 1 即止步，最深前缀为 b1@R（余量最大），剩余选择同时触发载荷与力矩限制。
const infeasibleScenario: Scenario = {
  rails: [{ id: 'R', name: 'R', coordinate: 1 }],
  blocks: [
    { id: 'b1', name: 'b1', mass: 3, options: [{ railId: 'R', cost: 1 }] },
    { id: 'b2', name: 'b2', mass: 4, options: [{ railId: 'R', cost: 1 }] },
    { id: 'b3', name: 'b3', mass: 5, options: [{ railId: 'R', cost: 1 }] },
  ],
  limits: { maxLoad: 6, minTorque: -5, maxTorque: 5 },
};

const r2 = adjudicate(infeasibleScenario);
check(!r2.feasible, '裁决模块：不可行场景应判定为不可行');
if (!r2.feasible) {
  check(r2.report.witnessPrefix.length === 1, '裁决模块：应给出最深可行已选前缀（长度 1）');
  check(
    r2.report.witnessPrefix[0]?.blockIndex === 0,
    '裁决模块：已选前缀应取余量最大的 b1',
  );
  check(
    r2.report.violations.length === 2 &&
      r2.report.violations.every((v) => v.kinds.includes('load') && v.kinds.includes('torque-high')),
    '裁决模块：应列出剩余选择触发的载荷/力矩限制',
  );
}

// ---------- 2. 已启动页面健康端点冒烟 ----------

const deadline = Date.now() + 60_000;
let health: { status?: string } | null = null;
while (Date.now() < deadline) {
  try {
    const res = await fetch(`${base}/healthz`);
    if (res.ok) {
      health = (await res.json()) as { status?: string };
      break;
    }
  } catch {
    // 页面尚未就绪，继续等待
  }
  await new Promise((r) => setTimeout(r, 1000));
}
check(health !== null && health.status === 'ok', `健康端点 ${base}/healthz 应返回 status=ok`);

// ---------- 3. 首页可访问 ----------

try {
  const res = await fetch(`${base}/`);
  const html = await res.text();
  check(res.ok && html.includes('id="root"'), `首页 ${base}/ 应返回包含挂载点的 HTML`);
} catch {
  check(false, `首页 ${base}/ 请求失败`);
}

if (failures > 0) {
  console.error(`\nsmoke: ${failures} 项未通过`);
  process.exit(1);
}
console.log('\nsmoke: 全部通过');
