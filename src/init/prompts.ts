import type { Models } from "@earendil-works/pi-ai";
import { DEFAULT_CONFIG, type ConfigOverrides, type Language } from "../config.js";
import { parseBudgetLimit, serializeBudgetLimit } from "../budget/limit.js";
import type { ModelRef } from "../types.js";

export interface ModelChoice {
  ref: ModelRef;
  label: string;
  /** USD per million tokens, for ordering and display. */
  inputCost: number;
  outputCost: number;
  /**
   * Billed through a plan rather than per token. The list price still orders
   * the ladder — a subscription rations capability, not money — but showing it
   * as a price would be a lie about what the run costs.
   */
  subscription: boolean;
}

/**
 * Model families that answer a prompt with reasoning.
 *
 * `reasoning` is set on realtime and audio variants too — `gpt-realtime` is a
 * speech model that happens to reason — and one of them was cheap enough to be
 * offered as a review fallback. Reviewing code with a voice model is not a
 * degraded review, it is a different product.
 */
const NOT_FOR_REVIEW = /realtime|audio|transcribe|tts|image|embed|search-preview|moderation/;

/**
 * Models worth offering for a review.
 *
 * The registry holds dozens — `gpt-4`, `o1-pro` at $150 per million. Listing
 * all of them turns a choice into a search. The filter keeps reasoning-capable
 * chat models at a price a review could plausibly run on.
 */
export function allModelCandidates(models: Models, subscriptionProviders = new Set<string>()): ModelChoice[] {
  return models
    .getProviders()
    .flatMap((provider) =>
      models
        .getModels(provider.id)
        .filter(
          (model) =>
            model.reasoning &&
            model.cost.input > 0 &&
            model.cost.input <= 6 &&
            !NOT_FOR_REVIEW.test(model.id),
        )
        .map((model) => ({
          ref: { provider: provider.id, id: model.id },
          label: `${provider.id}/${model.id}`,
          inputCost: model.cost.input,
          outputCost: model.cost.output,
          subscription: subscriptionProviders.has(provider.id),
        })),
    )
    .sort((a, b) => b.inputCost - a.inputCost);
}

/**
 * What the picker shows: every subscription model, plus a price-spread sample
 * of the metered ones.
 *
 * Subscription models are never sampled away. They cost nothing extra to run
 * and the user went through an OAuth flow to get them — burying them under a
 * sampling rule they cannot see would make the login look like it did nothing.
 * Metered models are sampled across the price range rather than taken from the
 * top, because a downgrade ladder needs cheap rungs to be visible.
 */
export function modelChoices(candidates: ModelChoice[], defaultRef: ModelRef, limit = 8): ModelChoice[] {
  const subscription = candidates.filter((c) => c.subscription);
  const metered = candidates.filter((c) => !c.subscription);
  const picked = new Map<string, ModelChoice>();

  if (metered.length <= limit) {
    for (const choice of metered) picked.set(choice.label, choice);
  } else {
    const step = (metered.length - 1) / (limit - 1);
    for (let i = 0; i < limit; i++) {
      const choice = metered[Math.round(i * step)];
      if (choice) picked.set(choice.label, choice);
    }
  }

  const defaultLabel = `${defaultRef.provider}/${defaultRef.id}`;
  if (!picked.has(defaultLabel)) {
    const fallback = metered.find((c) => c.label === defaultLabel);
    if (fallback) picked.set(defaultLabel, fallback);
  }

  return [...subscription, ...[...picked.values()].sort((a, b) => b.inputCost - a.inputCost)];
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
    (c) => c.ref.provider === primary.provider && c.ref.id !== primary.id && c.inputCost < primaryCost,
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

export interface InitAnswers {
  lang: Language;
  /** Raw budget text as typed, e.g. `"¥20"`. */
  budget: string;
  model?: ModelRef;
  ladder: ModelRef[];
  /** Raw comma-separated topics as typed. */
  ignore: string;
}

/**
 * The config an answer set implies — only what differs from the defaults.
 *
 * A config that restates the defaults is worse than no config: a reader cannot
 * tell what the project chose from what nobody got round to deleting. This is
 * one function so the live preview and the file that gets written cannot
 * disagree about what "differs" means.
 */
export function buildInitConfig(answers: InitAnswers): ConfigOverrides {
  const chosen: ConfigOverrides = {};
  if (answers.lang !== DEFAULT_CONFIG.lang) chosen.lang = answers.lang;

  const defaultLimit = serializeBudgetLimit(DEFAULT_CONFIG.budget.limit);
  const budget: { limit?: string; models?: string[] } = {};
  const typed = answers.budget.trim();
  if (typed && typed !== defaultLimit) {
    try {
      budget.limit = serializeBudgetLimit(parseBudgetLimit(typed));
    } catch {
      // Left out rather than guessed at: the wizard shows the preview live, so
      // an unparseable amount simply fails to appear and says so on the row.
    }
  }

  if (answers.model) {
    const ladder = [answers.model, ...answers.ladder].map((ref) => `${ref.provider}/${ref.id}`);
    if (ladder.join() !== DEFAULT_CONFIG.budget.models.join()) budget.models = ladder;
  }
  if (Object.keys(budget).length > 0) chosen.budget = budget;

  const topics = answers.ignore
    .split(/[,，]/)
    .map((topic) => topic.trim())
    .filter(Boolean);
  if (topics.length > 0) chosen.review = { ignore: topics };

  return chosen;
}

export interface InitStrings {
  title: string;
  steps: readonly string[];
  language: string;
  languageOptions: readonly [string, string];
  budget: string;
  budgetHint: string;
  budgetBad: string;
  model: string;
  modelSubscription: string;
  modelMetered: string;
  modelNone: string;
  ladder: string;
  ladderEmpty: string;
  ladderSubscription: string;
  ignore: string;
  ignoreHint: string;
  preview: string;
  previewEmpty: string;
  done: string;
  wrote: string;
  nothing: string;
  seeAll: string;
  keys: { move: string; toggle: string; accept: string; back: string; cancel: string };
  skip: string;
}

export const INIT_TEXT: Record<Language, InitStrings> = {
  zh: {
    title: "初始化",
    steps: ["语言", "预算", "模型", "降级", "忽略"],
    language: "评审意见和报告用什么语言？",
    languageOptions: ["中文", "English"],
    budget: "每次评审最多花多少？",
    budgetHint: "可写 ¥10、$1.50 或 800k tokens",
    budgetBad: "看不懂这个金额，先不写入",
    model: "从哪个模型开始评审？",
    modelSubscription: "订阅覆盖 · 不按 token 计费",
    modelMetered: "按量计费 · 每百万 token 输入 / 输出",
    modelNone: "没有可用凭据，跳过这一步",
    ladder: "预算快用完时，依次降级到",
    ladderEmpty: "没有更便宜的同类模型，不降级",
    ladderSubscription: "订阅按 token 限额，换便宜模型并不会少花 token —— 默认不降级",
    ignore: "有什么是它不用提的？",
    ignoreHint: "已经吵完的话题，逗号分隔。比如：命名风格, 注释格式",
    preview: "将写入 review.config.json",
    previewEmpty: "没有一项和默认值不同 —— 会写一个空对象",
    done: "已写入",
    wrote: "只记录了和默认值不同的部分。",
    nothing: "目前没有任何一项和默认值不同 —— 直接编辑这个文件即可修改。",
    seeAll: "全部字段见 docs/configuration.zh.md · 查看合并结果：code-review config",
    keys: { move: "选择", toggle: "勾选", accept: "确认", back: "上一步", cancel: "取消" },
    skip: "留空跳过",
  },
  en: {
    title: "setup",
    steps: ["Language", "Budget", "Model", "Fallback", "Ignore"],
    language: "Language for findings and the report",
    languageOptions: ["中文", "English"],
    budget: "How much may one review spend?",
    budgetHint: "¥10, $1.50 or 800k tokens",
    budgetBad: "Cannot read that amount — it will not be written",
    model: "Which model should reviews start on?",
    modelSubscription: "Covered by a subscription · not billed per token",
    modelMetered: "Metered · USD per million tokens, in / out",
    modelNone: "No credentials available — skipping this step",
    ladder: "When the budget runs short, step down to",
    ladderEmpty: "Nothing cheaper of the same kind — no ladder",
    ladderSubscription: "A plan is capped in tokens, and a cheaper model does not use fewer — left unticked",
    ignore: "Anything it should not raise?",
    ignoreHint: "Settled arguments, comma-separated. e.g. naming, comment style",
    preview: "will be written to review.config.json",
    previewEmpty: "Nothing differs from the defaults — an empty object will be written",
    done: "written",
    wrote: "Only what differs from the defaults is recorded.",
    nothing: "Nothing differs from the defaults yet — edit the file to change something.",
    seeAll: "Every field: docs/configuration.zh.md · check the result: code-review config",
    keys: { move: "move", toggle: "toggle", accept: "accept", back: "back", cancel: "cancel" },
    skip: "empty to skip",
  },
};
