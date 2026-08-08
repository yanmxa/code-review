import type { Language } from "../config.js";
import { addedLines } from "../platform/diff.js";
import type { Redactor } from "../security/redactor.js";
import type { ReviewUnit, Severity } from "../types.js";

export interface RuleHit {
  ruleId: string;
  path: string;
  line: number;
  excerpt: string;
  severity: Severity;
  title: string;
  body: string;
}

interface Rule {
  id: string;
  severity: Severity;
  /** Only fires on files matching this, when present. */
  files?: RegExp;
  pattern: RegExp;
  /** A second pattern that must also match. Keeps compound rules readable. */
  requires?: RegExp;
  /** Suppress on lines matching this — the cheap way to kill known false positives. */
  unless?: RegExp;
  title: { zh: string; en: string };
  body: { zh: string; en: string };
}

/**
 * Deterministic checks.
 *
 * These are the backbone of confidence grading: a rule hit is reproducible by
 * anyone with the diff and this file, so a finding carrying one is presented as
 * directly adoptable. They deliberately stay narrow — a rule that needs judgment
 * is not a rule, it is a prompt.
 *
 * Every rule fires only on lines the PR *adds*. Flagging pre-existing code would
 * make the review about the repository rather than the change.
 */
const RULES: Rule[] = [
  {
    id: "leftover-debugger",
    severity: "major",
    files: /\.(m|c)?(ts|tsx|js|jsx)$/,
    pattern: /^\s*debugger\s*;?\s*$/,
    title: { zh: "遗留的 debugger 语句", en: "Leftover `debugger` statement" },
    body: {
      zh: "`debugger` 会让生产环境在有开发者工具时暂停执行。合并前请删除。",
      en: "A `debugger` statement halts execution wherever devtools are attached. Remove it before merging.",
    },
  },
  {
    id: "console-log",
    severity: "minor",
    files: /\.(m|c)?(ts|tsx|js|jsx)$/,
    pattern: /(^|[^.\w])console\.(log|debug)\s*\(/,
    unless: /\/\/\s*eslint-disable|test|spec|scripts?\//,
    title: { zh: "新增了 console 日志", en: "New `console` logging" },
    body: {
      zh: "新增的 `console.log`/`console.debug` 通常是调试残留。若确实需要日志，请使用项目的 logger。",
      en: "A new `console.log`/`console.debug` is usually debugging residue. Use the project's logger if the output is intended.",
    },
  },
  {
    id: "loose-equality",
    severity: "minor",
    files: /\.(m|c)?(ts|tsx|js|jsx)$/,
    // Excludes `== null`, which is the idiomatic null-or-undefined check.
    pattern: /[^=!<>]\s(==|!=)\s(?!null\b)/,
    unless: /^\s*(\/\/|\*|#)/,
    title: { zh: "使用了宽松相等比较", en: "Loose equality comparison" },
    body: {
      zh: "`==` / `!=` 会做类型转换，容易产生意外结果（如 `0 == \"\"` 为真）。除 `== null` 外请使用 `===` / `!==`。",
      en: "`==` / `!=` coerce types and produce surprising results (`0 == \"\"` is true). Prefer `===` / `!==` outside the `== null` idiom.",
    },
  },
  {
    id: "swallowed-error",
    severity: "major",
    pattern: /catch\s*(\([^)]*\))?\s*\{\s*\}|except\s*[\w.]*\s*:\s*pass\b/,
    title: { zh: "异常被静默吞掉", en: "Silently swallowed exception" },
    body: {
      zh: "空的 catch/except 会让故障无声消失，事故排查时无从下手。至少记录日志，或注释说明为何可以忽略。",
      en: "An empty catch/except makes failures vanish silently and leaves nothing to debug during an incident. Log it, or comment why ignoring is safe.",
    },
  },
  {
    id: "insecure-random",
    severity: "major",
    pattern: /(Math\.random\s*\(\s*\)|random\.(random|randint|choice)\s*\()/,
    // Either an explicit credential word, or the `toString(36)` idiom that is
    // used almost exclusively to mint ids. The credential word is frequently on
    // the enclosing function's line rather than this one, which is why the
    // idiom carries the rule on its own.
    requires: /(token|secret|password|passwd|nonce|salt|session|otp|api[_-]?key|\.toString\s*\(\s*(16|36)\s*\))/i,
    unless: /\btest|spec|mock|jitter|backoff|sample|shuffle\b/i,
    title: { zh: "用非密码学随机数生成标识符", en: "Non-cryptographic randomness for an identifier" },
    body: {
      zh: "`Math.random()` / `random` 模块的输出是可预测的。如果这个值被用作 session token、密码、nonce 或 salt，攻击者可以推算出它——请改用 `crypto.randomUUID()`、`crypto.getRandomValues()` 或 Python 的 `secrets`。若仅作非安全用途的标识符，可以忽略本条。",
      en: "`Math.random()` and the `random` module produce predictable output. If this value is used as a session token, password, nonce, or salt, an attacker can derive it — use `crypto.randomUUID()`, `crypto.getRandomValues()`, or Python's `secrets`. Ignore this if the value is only a non-security identifier.",
    },
  },
  {
    id: "sql-string-concat",
    severity: "blocker",
    // The character class must allow quotes: real concatenation always closes a
    // string literal before the `+`, so excluding quotes made this rule match
    // nothing it was written for.
    pattern:
      /(SELECT|INSERT\s+INTO|UPDATE|DELETE\s+FROM|WHERE)\b[^;]{0,200}?(["'`]\s*(\+|\.)\s*\w|\$\{|%\s*\(?\s*\w|\.format\s*\()/i,
    unless: /^\s*(\/\/|\*|#|--)/,
    title: { zh: "SQL 语句拼接变量", en: "SQL built by string concatenation" },
    body: {
      zh: "把变量拼进 SQL 会引入注入风险。请使用参数化查询（占位符 + 参数数组），而不是字符串拼接或模板串。",
      en: "Interpolating a variable into SQL opens an injection hole. Use a parameterized query with placeholders instead of concatenation or template literals.",
    },
  },
  {
    id: "shell-injection",
    severity: "blocker",
    pattern: /\b(exec|execSync|os\.system|subprocess\.(call|run|Popen))\s*\(\s*[`"'][^`"']*(\$\{|\+\s*\w|%s)/,
    title: { zh: "shell 命令中拼接了变量", en: "Variable interpolated into a shell command" },
    body: {
      zh: "把变量拼进 shell 命令会导致命令注入。请改用参数数组形式（如 `execFile(cmd, [args])`、`subprocess.run([...], shell=False)`）。",
      en: "Interpolating a variable into a shell string enables command injection. Pass an argument array instead (`execFile(cmd, [args])`, `subprocess.run([...], shell=False)`).",
    },
  },
  {
    id: "todo-added",
    severity: "nit",
    pattern: /(^|[^\w])(TODO|FIXME|XXX|HACK)\b/,
    title: { zh: "新增了 TODO/FIXME 标记", en: "New TODO/FIXME marker" },
    body: {
      zh: "这行引入了一个未完成标记。若打算在本次合并中解决请补上，否则建议关联一个 issue 以免被遗忘。",
      en: "This line introduces an unfinished marker. Resolve it in this PR, or link an issue so it does not get lost.",
    },
  },
  {
    id: "disabled-tls-verification",
    severity: "blocker",
    pattern:
      /(rejectUnauthorized\s*:\s*false|NODE_TLS_REJECT_UNAUTHORIZED\s*=\s*['"]?0|verify\s*=\s*False|InsecureSkipVerify\s*:\s*true)/,
    title: { zh: "关闭了 TLS 证书校验", en: "TLS certificate verification disabled" },
    body: {
      zh: "关闭证书校验会让连接可被中间人攻击。若是为了本地自签证书，请改为显式信任该 CA，并确保配置不会进入生产。",
      en: "Disabling certificate verification exposes the connection to man-in-the-middle attacks. If this is for a local self-signed cert, trust that CA explicitly and keep the setting out of production.",
    },
  },
];

/**
 * Run the deterministic pass over a unit.
 *
 * Secrets are handled separately: by the time a diff reaches here the redactor
 * has already replaced them, so we look for its placeholders rather than
 * re-implementing detection — a `[REDACTED:...]` marker on an added line is
 * proof a credential was committed.
 */
export function runRules(unit: ReviewUnit, lang: Language): RuleHit[] {
  const hits: RuleHit[] = [];

  for (const { line, text } of addedLines(unit.hunks)) {
    const secret = text.match(/\[REDACTED:([a-z0-9-]+):[a-f0-9]{4}\]/);
    if (secret && secret[1] !== "runtime-credential") {
      hits.push({
        ruleId: "secret-in-diff",
        path: unit.path,
        line,
        excerpt: text.trim(),
        severity: "blocker",
        title: lang === "zh" ? "提交中包含疑似密钥" : "Credential committed in this change",
        body:
          lang === "zh"
            ? `这一行被密钥扫描器判定为 \`${secret[1]}\`（内容已在传给模型前脱敏）。请从代码中移除，改用环境变量或密钥管理服务，并**轮换该凭据**——它已经进入了 git 历史。`
            : `The secret scanner classified this line as \`${secret[1]}\` (the value was masked before any model saw it). Remove it from the code, move it to an environment variable or secret manager, and **rotate the credential** — it is already in git history.`,
      });
    }

    for (const rule of RULES) {
      if (rule.files && !rule.files.test(unit.path)) continue;
      if (rule.unless?.test(text)) continue;
      rule.pattern.lastIndex = 0;
      if (!rule.pattern.test(text)) continue;
      if (rule.requires) {
        rule.requires.lastIndex = 0;
        if (!rule.requires.test(text)) continue;
      }
      hits.push({
        ruleId: rule.id,
        path: unit.path,
        line,
        excerpt: text.trim(),
        severity: rule.severity,
        title: rule.title[lang],
        body: rule.body[lang],
      });
    }
  }

  return hits;
}

/** Rule hits carry no model output, but excerpts still pass through the redactor. */
export function redactHits(hits: RuleHit[], redactor: Redactor): RuleHit[] {
  return hits.map((hit) => ({ ...hit, excerpt: redactor.redact(hit.excerpt) }));
}

export const RULE_IDS = [...RULES.map((rule) => rule.id), "secret-in-diff"];
