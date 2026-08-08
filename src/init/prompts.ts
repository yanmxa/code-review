import type { Models } from "@earendil-works/pi-ai";
import { createInterface } from "node:readline/promises";
import type { Language } from "../config.js";
import { theme } from "../tui/theme.js";
import type { ModelRef } from "../types.js";

export interface ModelChoice {
  ref: ModelRef;
  label: string;
  /** USD per million tokens, for ordering and display. */
  inputCost: number;
  outputCost: number;
}

/**
 * Models worth offering for a review.
 *
 * The registry holds dozens — `gpt-4`, `o1-pro` at $150 per million, realtime
 * variants. Listing all of them turns a choice into a search. The filter keeps
 * reasoning-capable models at a price a review could plausibly run on, and the
 * spread keeps the list short without collapsing it to the expensive end: a
 * ladder needs cheap rungs, so they have to be visible.
 */
export function allModelCandidates(models: Models): ModelChoice[] {
  return models
    .getProviders()
    .flatMap((provider) =>
      models
        .getModels(provider.id)
        .filter((model) => model.reasoning && model.cost.input > 0 && model.cost.input <= 6)
        .map((model) => ({
          ref: { provider: provider.id, id: model.id },
          label: `${provider.id}/${model.id}`,
          inputCost: model.cost.input,
          outputCost: model.cost.output,
        })),
    )
    .sort((a, b) => b.inputCost - a.inputCost);
}

/** A short, price-spread subset to show in the picker. */
export function modelChoices(candidates: ModelChoice[], defaultRef: ModelRef, limit = 8): ModelChoice[] {
  if (candidates.length <= limit) return candidates;

  // Take an even spread across the price range rather than the top N, then put
  // the default back if sampling dropped it.
  const step = (candidates.length - 1) / (limit - 1);
  const picked = new Map<string, ModelChoice>();
  for (let i = 0; i < limit; i++) {
    const choice = candidates[Math.round(i * step)];
    if (choice) picked.set(choice.label, choice);
  }
  const defaultLabel = `${defaultRef.provider}/${defaultRef.id}`;
  if (!picked.has(defaultLabel)) {
    const fallback = candidates.find((c) => c.label === defaultLabel);
    if (fallback) picked.set(defaultLabel, fallback);
  }
  return [...picked.values()].sort((a, b) => b.inputCost - a.inputCost);
}

/**
 * Cheaper models the run can fall back to, preferring the same family.
 *
 * Staying within a family means the prompt behaves the same way at each rung —
 * only the price changes. Falling across families would alter the review's
 * character partway through a run for reasons the user never asked for.
 */
export function suggestLadder(primary: ModelRef, candidates: ModelChoice[]): ModelRef[] {
  const family = primary.id.replace(/-(mini|nano|pro|turbo|flash|lite|spark|high(speed)?)$/, "");
  // Drawn from every candidate, not the shortened picker list: the cheaper
  // members of a family are exactly the rungs wanted, and sampling for display
  // routinely leaves them out.
  const primaryCost = candidates.find((c) => c.ref.id === primary.id)?.inputCost ?? Infinity;
  // Cheaper, always. Family membership decides the order of preference, never
  // the direction: a "fallback" that costs more than what it replaces is not a
  // fallback, and picking the cheapest model should suggest nothing at all.
  const cheaper = candidates.filter(
    (c) =>
      c.ref.provider === primary.provider &&
      c.ref.id !== primary.id &&
      c.inputCost < primaryCost,
  );

  const sameFamily = cheaper
    .filter((c) => c.ref.id.startsWith(family))
    .sort((a, b) => b.inputCost - a.inputCost);
  if (sameFamily.length > 0) return sameFamily.map((c) => c.ref);

  return cheaper
    .sort((a, b) => b.inputCost - a.inputCost)
    .slice(0, 2)
    .map((c) => c.ref);
}

export interface Asker {
  line(question: string, fallback: string): Promise<string>;
  choice(question: string, options: string[], defaultIndex: number): Promise<number>;
  close(): void;
}

/** Terminal prompts. Numbered rather than arrow-driven: this is a short form, not an app. */
export function createAsker(): Asker {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return {
    async line(question, fallback) {
      const hint = fallback ? theme.dim(` [${fallback}]`) : theme.dim(" [skip]");
      const answer = (await rl.question(`  ${question}${hint} › `)).trim();
      return answer || fallback;
    },
    async choice(question, options, defaultIndex) {
      process.stdout.write(`  ${question}\n\n`);
      options.forEach((option, index) => {
        const mark = index === defaultIndex ? theme.accent("›") : " ";
        process.stdout.write(`   ${mark} ${theme.accent(String(index + 1).padStart(2))}. ${option}\n`);
      });
      const answer = (
        await rl.question(`\n  ${theme.dim(`[${defaultIndex + 1}]`)} › `)
      ).trim();
      if (!answer) return defaultIndex;
      const picked = Number(answer);
      return Number.isInteger(picked) && picked >= 1 && picked <= options.length
        ? picked - 1
        : defaultIndex;
    },
    close() {
      rl.close();
    },
  };
}

export const INIT_TEXT = {
  zh: {
    intro: "回车即接受方括号里的默认值。",
    language: "评审意见和报告用什么语言？",
    languageOptions: ["中文", "English"],
    budget: "每次评审的预算上限",
    model: "从哪个模型开始评审？（价格为每百万 token 输入/输出）",
    ladder: "预计会超支时，依次降级到",
    ladderHint: "回车接受，或输入以逗号分隔的编号",
    ignore: "有什么是它不用提的？比如你们已经定好的命名风格、注释格式",
    wrote: "只写下了和默认值不同的部分。",
    nothing: "目前没有任何一项和默认值不同——直接编辑这个文件即可修改。",
    seeAll: "全部字段见 docs/configuration.zh.md · 查看合并结果：code-review config",
  },
  en: {
    intro: "Enter accepts the default in brackets.",
    language: "Language for findings and the report",
    languageOptions: ["中文", "English"],
    budget: "Budget per review",
    model: "Which model should reviews start on? (USD per million in/out)",
    ladder: "When projected to overrun, step down to",
    ladderHint: "Enter to accept, or give comma-separated numbers",
    ignore: "Anything it should not raise? Settled arguments, e.g. naming or comment style",
    wrote: "Only what differs from the defaults is written.",
    nothing: "Nothing differs from the defaults yet — edit the file to change something.",
    seeAll: "Every field: docs/configuration.zh.md · check the result: code-review config",
  },
} satisfies Record<Language, Record<string, string | string[]>>;
