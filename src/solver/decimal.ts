/**
 * 精确十进制数：value = coefficient × 10^exponent（coefficient 为任意精度整数）。
 *
 * 安装代价与物理录入量（力臂、质量、力矩、力矩余量）都是逐位有意义的录入值，
 * 其累计与比较必须按录入的十进制值进行：0.1 + 0.2 与 0.3 在十进制下相等，
 * 必须判为同值；而 1e-10（乃至 1e-17）与 0 这类极小但真实的十进制差额又必须
 * 保持严格有序。二进制浮点累加两者都做不到（0.1+0.2 === 0.30000000000000004，
 * Number('0.99999999999999999') === 1），因此代价的求和比较、力矩的累加与
 * 力矩余量的决胜全部在此十进制表示上完成。唯一的例外是载荷/力矩闭区间的
 * 可行性判定：仍走双精度 + EPS 容差以吸收无原文时的浮点舍入噪声
 * （见 ./adjudicate），但该容差绝不参与余量决胜。
 */
export interface Decimal {
  readonly coefficient: bigint;
  readonly exponent: number;
}

export const DECIMAL_ZERO: Decimal = { coefficient: 0n, exponent: 0 };

/** 十进制文本：可选符号、整数/小数部分（允许 .5 或 5.）、可选十进制指数。 */
const DECIMAL_TEXT = /^([+-]?)(?:(\d+)(?:\.(\d*))?|\.(\d+))(?:[eE]([+-]?\d+))?$/;

/** 把一段十进制文本解析为（符号, 数字串, 小数位数, 指数值）；无法解析返回 null。 */
function parseDecimalText(text: string): [sign: 1n | -1n, digits: string, fracLength: number, exp: number] | null {
  const m = DECIMAL_TEXT.exec(text.trim());
  if (!m) return null;
  const signText = m[1];
  // 整数部分存在（含 "5." 这种）时小数取第 3 组，否则是 ".5" 形式取第 4 组。
  const fracPart = m[2] !== undefined ? m[3] ?? '' : m[4] ?? '';
  const digits = (m[2] ?? '') + fracPart; // BigInt 可直接处理前导 0
  const exponent = (m[5] === undefined ? 0 : Number(m[5])) - fracPart.length;
  return [signText === '-' ? -1n : 1n, digits, fracPart.length, exponent];
}

/**
 * 直接按录入的十进制文本恢复精确值，不经过双精度浮点。
 *
 * 这是代价精确性的关键入口：两个不同的录入值可能在 Number() 舍入后变成
 * 同一个双精度数（如 "0.10000000000000001" 与 "0.1" 都会舍入为 0.1），
 * 一旦先经过 Number()，差异就不可逆地丢失，decimalFromNumber 也无法恢复。
 * 因此凡能拿到录入原文时都应走本函数。
 */
export function decimalFromText(text: string): Decimal {
  const parsed = parseDecimalText(text);
  if (!parsed) throw new Error(`无法解析的十进制数值: ${text}`);
  const [sign, digits, , exponent] = parsed;
  const coefficient = BigInt(digits);
  return normalize({ coefficient: sign * coefficient, exponent });
}

/**
 * 以 number 的最短往返表示恢复其十进制值。适用于只有 number 而无录入原文
 * （如编程式构造的场景）。String(number) 会给出能往返同一双精度的最短
 * 十进制串（如 0.1 → "0.1"，1e-10 → "1e-10"），但无法恢复已被双精度
 * 舍入抹掉的差异——那种情况必须使用 decimalFromText。
 */
export function decimalFromNumber(x: number): Decimal {
  if (!Number.isFinite(x)) throw new Error(`十进制代价须为有限数值: ${x}`);
  const parsed = parseDecimalText(String(x));
  if (!parsed) throw new Error(`无法解析的十进制数值: ${String(x)}`);
  const [sign, digits, , exponent] = parsed;
  return normalize({ coefficient: sign * BigInt(digits), exponent });
}

/** 去掉系数末尾的 0（并把零规范化为 0 × 10^0），保持表示紧凑。 */
function normalize(d: Decimal): Decimal {
  let { coefficient, exponent } = d;
  if (coefficient === 0n) return DECIMAL_ZERO;
  while (coefficient % 10n === 0n) {
    coefficient /= 10n;
    exponent += 1;
  }
  return { coefficient, exponent };
}

/** 精确加法（可交换、可结合，与求和次序无关）。 */
export function decimalAdd(a: Decimal, b: Decimal): Decimal {
  const exponent = Math.min(a.exponent, b.exponent);
  const coefficient =
    a.coefficient * 10n ** BigInt(a.exponent - exponent) +
    b.coefficient * 10n ** BigInt(b.exponent - exponent);
  return normalize({ coefficient, exponent });
}

/** 精确减法。 */
export function decimalSubtract(a: Decimal, b: Decimal): Decimal {
  const exponent = Math.min(a.exponent, b.exponent);
  const coefficient =
    a.coefficient * 10n ** BigInt(a.exponent - exponent) -
    b.coefficient * 10n ** BigInt(b.exponent - exponent);
  return normalize({ coefficient, exponent });
}

/** 精确乘法（力矩 = 质量 × 力臂等）。 */
export function decimalMultiply(a: Decimal, b: Decimal): Decimal {
  if (a.coefficient === 0n || b.coefficient === 0n) return DECIMAL_ZERO;
  return normalize({
    coefficient: a.coefficient * b.coefficient,
    exponent: a.exponent + b.exponent,
  });
}

/** 精确最小值（沿挂装前缀取最小力矩余量）。 */
export function decimalMin(a: Decimal, b: Decimal): Decimal {
  return decimalCompare(a, b) <= 0 ? a : b;
}

/** 精确比较：a < b 返回 -1，a === b 返回 0，a > b 返回 1。 */
export function decimalCompare(a: Decimal, b: Decimal): number {
  const exponent = Math.min(a.exponent, b.exponent);
  const diff =
    a.coefficient * 10n ** BigInt(a.exponent - exponent) -
    b.coefficient * 10n ** BigInt(b.exponent - exponent);
  return diff < 0n ? -1 : diff > 0n ? 1 : 0;
}

/** 规范十进制文本（不带指数），供展示与精确转回双精度。 */
export function decimalToString(d: Decimal): string {
  if (d.coefficient === 0n) return '0';
  const negative = d.coefficient < 0n;
  const digits = (negative ? -d.coefficient : d.coefficient).toString();
  const point = digits.length + d.exponent;
  let text: string;
  if (d.exponent >= 0) {
    text = digits + '0'.repeat(d.exponent);
  } else if (point > 0) {
    text = `${digits.slice(0, point)}.${digits.slice(point)}`;
  } else {
    text = `0.${'0'.repeat(-point)}${digits}`;
  }
  return negative ? `-${text}` : text;
}

/** 转回双精度（经规范十进制文本解析，正确舍入到最近的双精度值）。 */
export function decimalToNumber(d: Decimal): number {
  return Number(decimalToString(d));
}
