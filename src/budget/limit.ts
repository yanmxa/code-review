/**
 * The budget's unit.
 *
 * Money and tokens are both legitimate limits, and which one is honest depends
 * on how you pay. An API key bills dollars, so a money limit measures the real
 * constraint. A subscription bills nothing per call, so the only quantity that
 * actually moves is tokens — budgeting money there would mean inventing a price.
 */
export type BudgetUnit = "CNY" | "USD" | "tokens";

export interface BudgetLimit {
  amount: number;
  unit: BudgetUnit;
}

const SUFFIXES: { pattern: RegExp; unit: BudgetUnit }[] = [
  { pattern: /^(?:¥|cny|rmb|元)$/i, unit: "CNY" },
  { pattern: /^(?:\$|usd)$/i, unit: "USD" },
  { pattern: /^(?:tok|toks|token|tokens|t)$/i, unit: "tokens" },
];

/**
 * Parse a budget the way a person writes one.
 *
 * `¥10`, `10cny`, `$1.50`, `800k tokens`, `1.2M tokens`. A bare number takes
 * `fallback`, which is where the configured default currency comes in — so
 * `--budget 10` still means something, and always means something stated.
 */
export function parseBudgetLimit(input: string, fallback: BudgetUnit = "CNY"): BudgetLimit {
  const text = input.trim();
  if (text.length === 0) throw new Error("Budget is empty");

  const match = text.match(/^([¥$]?)\s*([0-9]*\.?[0-9]+)\s*([kKmM]?)\s*([A-Za-z¥$元]*)$/);
  if (!match) {
    throw new Error(
      `Cannot read "${input}" as a budget. Try: 10, ¥10, $1.50, 800k tokens.`,
    );
  }

  const [, prefix, digits, magnitude, suffix] = match;
  let amount = Number(digits);
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error(`Budget must be a positive number, got "${input}"`);
  }
  if (magnitude?.toLowerCase() === "k") amount *= 1_000;
  if (magnitude?.toLowerCase() === "m") amount *= 1_000_000;

  const symbol = prefix || suffix || "";
  if (symbol.length === 0) return { amount, unit: fallback };

  for (const candidate of SUFFIXES) {
    if (candidate.pattern.test(symbol)) return { amount, unit: candidate.unit };
  }
  throw new Error(`Unknown budget unit "${symbol}". Use ¥/CNY, $/USD, or tokens.`);
}

/** Render a limit the way it was written, so it round-trips visibly. */
export function formatBudget(amount: number, unit: BudgetUnit): string {
  switch (unit) {
    case "CNY":
      return `¥${amount.toFixed(2)}`;
    case "USD":
      return `$${amount.toFixed(2)}`;
    case "tokens":
      return `${formatTokenCount(amount)} tokens`;
  }
}

/** Compact token counts: 1.2M, 800k, 512. */
export function formatTokenCount(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(count >= 10_000_000 ? 0 : 1)}M`;
  if (count >= 1_000) return `${(count / 1_000).toFixed(count >= 100_000 ? 0 : 1)}k`;
  return String(Math.round(count));
}

/** Round-trips through {@link parseBudgetLimit}, so config files stay readable. */
export function serializeBudgetLimit(limit: BudgetLimit): string {
  return formatBudget(limit.amount, limit.unit);
}
