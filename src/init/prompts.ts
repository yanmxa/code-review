import type { Models } from "@earendil-works/pi-ai";
import { DEFAULT_CONFIG, type ConfigOverrides, type Language, parseModelRef } from "../config.js";
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
 * The rungs to tick by default: cheaper members of the same family, or nothing.
 *
 * Staying within a family means the prompt behaves the same way at each rung
 * and only the price changes — that is what makes a ladder a ladder rather than
 * a change of reviewer halfway through a run.
 *
 * When a family has no cheaper sibling this suggests *nothing*, which is a
 * change from picking the two next-cheapest. Those were routinely a different
 * family at nearly the same price — `gpt-5.2` proposed `gpt-5` and `gpt-5.1`,
 * both $1.25 against its $1.75, so the "downgrade" changed the reviewer to save
 * a third. Every candidate is one keypress away in the list; guessing on the
 * user's behalf is not worth doing badly.
 */
export function suggestLadder(primary: ModelRef, candidates: ModelChoice[]): ModelRef[] {
  const family = primary.id.replace(/-(mini|nano|pro|turbo|flash|lite|spark|high(speed)?)$/, "");
  // Drawn from every candidate, not the shortened picker list: the cheaper
  // members of a family are exactly the rungs wanted, and sampling for display
  // routinely leaves them out.
  return ladderCandidates(primary, candidates)
    .filter((c) => c.ref.provider === primary.provider && c.ref.id.startsWith(family))
    .map((c) => c.ref);
}

/**
 * Every model the run could legally fall back to, cheapest last.
 *
 * Crossing providers is allowed — a plan and a cheap key from someone else are
 * a perfectly sensible pair, and the config file has always been able to say
 * so. Crossing *billing kinds* is not. The run decides what its budget counts
 * once, from the primary: a subscription primary makes the limit a token count,
 * a metered one makes it money. A ladder that mixed the two would spend real
 * money against a token limit, or stop the money rising and leave the guard
 * looking like it worked. Same kind, any provider, always cheaper.
 */
export function ladderCandidates(primary: ModelRef, candidates: ModelChoice[]): ModelChoice[] {
  const chosen = candidates.find((c) => c.ref.provider === primary.provider && c.ref.id === primary.id);
  const limit = chosen?.inputCost ?? Infinity;
  const kind = chosen?.subscription ?? false;

  return candidates
    .filter(
      (c) =>
        c.subscription === kind &&
        c.inputCost < limit &&
        !(c.ref.provider === primary.provider && c.ref.id === primary.id),
    )
    .sort((a, b) => b.inputCost - a.inputCost);
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
 * The config these answers imply, laid over whatever was already there.
 *
 * The wizard asks about four things and the file can hold a dozen — project
 * rules, a reviewer focus, disabled tools. Re-running it replaces what it asked
 * about and leaves the rest alone; otherwise one pass through the questions
 * would silently delete a custom rule someone wrote by hand.
 *
 * Within its own four the answers win outright: choosing the default model
 * *removes* a `budget.models` line rather than leaving the old one, because
 * "keep what I picked" and "go back to the default" both have to be sayable. A
 * blank text field is the exception — that is what pressing enter on a
 * placeholder looks like, and it means leave this one as it is.
 */
export function applyInitAnswers(current: ConfigOverrides, answers: InitAnswers): ConfigOverrides {
  const next: ConfigOverrides = structuredClone(current);

  if (answers.lang === DEFAULT_CONFIG.lang) delete next.lang;
  else next.lang = answers.lang;

  // `budget` is deliberately loose on disk, so it is read and written as a
  // plain record here rather than the resolved shape.
  const budget: Record<string, unknown> = { ...(next.budget ?? {}) };
  const typed = answers.budget.trim();
  if (typed) {
    try {
      const parsed = serializeBudgetLimit(parseBudgetLimit(typed));
      if (parsed === serializeBudgetLimit(DEFAULT_CONFIG.budget.limit)) delete budget.limit;
      else budget.limit = parsed;
    } catch {
      // Left as it was rather than guessed at: the preview is live and the row
      // says it could not read the amount.
    }
  }
  if (answers.model) {
    const ladder = [answers.model, ...answers.ladder].map(refSpec);
    // Compared as specs on both sides. The default ladder holds `ModelRef`
    // objects, so joining it against a list of strings never matched and the
    // key was written even when the answer was the built-in default.
    if (ladder.join() === DEFAULT_CONFIG.budget.models.map(refSpec).join()) delete budget.models;
    else budget.models = ladder;
  }
  if (Object.keys(budget).length > 0) next.budget = budget;
  else delete next.budget;

  const review = { ...(next.review ?? {}) };
  const topics = answers.ignore
    .split(/[,，]/)
    .map((topic) => topic.trim())
    .filter(Boolean);
  if (topics.length > 0) review.ignore = topics;
  else delete review.ignore;
  if (Object.keys(review).length > 0) next.review = review;
  else delete next.review;

  return next;
}

function refSpec(ref: ModelRef): string {
  return `${ref.provider}/${ref.id}`;
}

/** What the wizard starts from: the file's own values, where it has them. */
export function answersFrom(current: ConfigOverrides): InitAnswers {
  const budget = (current.budget ?? {}) as { limit?: unknown; models?: unknown };
  const models = Array.isArray(budget.models)
    ? budget.models.filter((spec): spec is string => typeof spec === "string")
    : [];
  const refs = models.map((spec) => parseModelRef(spec));

  const answers: InitAnswers = {
    lang: current.lang ?? DEFAULT_CONFIG.lang,
    budget: typeof budget.limit === "string" ? budget.limit : "",
    ladder: refs.slice(1),
    ignore: (current.review?.ignore ?? []).join(", "),
  };
  if (refs[0]) answers.model = refs[0];
  return answers;
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
  ladderHint: string;
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
    ladderHint: "空格勾选，可跨 provider；按上面的顺序依次降级",
    ignore: "评审时忽略哪些话题？",
    ignoreHint: "写进评审员指令，让它别再提这些。逗号分隔，如：命名风格, 注释格式",
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
    ladderHint: "Space to tick, any provider; they are stepped through in the order above",
    ignore: "Which topics should the review ignore?",
    ignoreHint: "Told to the reviewer as never-raise. e.g. naming, comment style",
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
