import { Type } from "typebox";
import ts from "typescript";
import { defineReviewTool, reviewTool } from "./spec.js";

/**
 * Typecheck a changed TypeScript/JavaScript file.
 *
 * It exists as much to demonstrate the extension point as to catch bugs: adding
 * it required no change to the pipeline, prompt assembly, or grading — only
 * this file and one line in `tools/index.ts`.
 *
 * Safety: the file is fetched over HTTPS into memory and handed to the
 * TypeScript compiler through a virtual `CompilerHost`. `noResolve` keeps the
 * compiler from reaching for imports, `noEmit` keeps it from writing anything,
 * and the compiler only ever parses the text as data. No repository code runs.
 *
 * Honest scope: without the project's `node_modules` and tsconfig, imported
 * types are unknown. Diagnostics about missing modules and unresolved imports
 * are therefore filtered out, leaving syntax errors and self-contained semantic
 * errors. Those are reproducible without an LLM, which is why this tool carries
 * `evidenceKind: "static"` and can promote a finding to adoptable.
 */
export const tsSyntaxCheckTool = defineReviewTool({
  meta: {
    id: "ts_syntax_check",
    evidenceKind: "static",
    enabledByDefault: true,
    costHint: "free",
    promptSnippet:
      "ts_syntax_check — run the TypeScript compiler over a changed .ts/.tsx/.js file for syntax and " +
      "self-contained type errors. Its output is verifiable evidence; cite it when it supports a finding.",
  },
  build(context) {
    return reviewTool({
      name: "ts_syntax_check",
      label: "Typecheck",
      description:
        "Run the TypeScript compiler on a single changed TypeScript or JavaScript file at the PR head " +
        "commit and return its diagnostics. Cross-module type errors are not reported (imports are not " +
        "resolved), but syntax errors and errors within the file are. Use it to confirm a suspected " +
        "type or syntax problem before reporting it — a confirmed diagnostic makes the finding " +
        "directly adoptable.",
      parameters: Type.Object({
        path: Type.String({ description: "Repository-relative path to a .ts/.tsx/.mts/.js/.jsx file." }),
      }),
      async execute(_toolCallId, params): Promise<{ content: { type: "text"; text: string }[]; details: TsCheckDetails }> {
        const path = params.path.replace(/^\.?\//, "");
        context.report?.(path);

        if (!/\.(m|c)?(ts|tsx|js|jsx)$/.test(path)) {
          return {
            content: [
              { type: "text" as const, text: `Not a TypeScript/JavaScript file, skipping: ${path}` },
            ],
            details: { path, checked: false, diagnostics: [] },
          };
        }

        const source = await context.adapter.fetchFile(
          context.snapshot.target,
          path,
          context.snapshot.meta.headSha,
        );
        if (source === null) {
          return {
            content: [{ type: "text" as const, text: `File not found at head commit: ${path}` }],
            details: { path, checked: false, diagnostics: [] },
          };
        }

        const diagnostics = typecheckInMemory(path, source);

        const text =
          diagnostics.length === 0
            ? `ts_syntax_check: no diagnostics for ${path}.`
            : `ts_syntax_check found ${diagnostics.length} diagnostic(s) in ${path}:\n\n` +
              diagnostics.map((d) => `  ${path}:${d.line}:${d.column}  TS${d.code}: ${d.message}`).join("\n");

        return {
          content: [{ type: "text" as const, text }],
          details: { path, checked: true, diagnostics },
        };
      },
    });
  },
});

export interface TsCheckDetails {
  path: string;
  checked: boolean;
  diagnostics: TsDiagnostic[];
}

export interface TsDiagnostic {
  line: number;
  column: number;
  code: number;
  message: string;
  category: "error" | "warning";
}

/**
 * Diagnostics that only mean "we did not give the compiler the whole project".
 * Reporting them would be noise indistinguishable from a real finding.
 */
const UNRESOLVABLE_WITHOUT_PROJECT = new Set([
  2307, // Cannot find module
  2304, // Cannot find name
  2318, // Cannot find global type
  2503, // Cannot find namespace
  2688, // Cannot find type definition file
  2792, // Cannot find module; did you mean to set moduleResolution
  7016, // Could not find a declaration file for module
  6053, // File not found
  2686, // refers to a UMD global
]);

/** Run the compiler over one file with a virtual host. Exported for tests. */
export function typecheckInMemory(path: string, source: string): TsDiagnostic[] {
  const options: ts.CompilerOptions = {
    noEmit: true,
    noResolve: true,
    allowJs: true,
    checkJs: false,
    skipLibCheck: true,
    skipDefaultLibCheck: true,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    jsx: ts.JsxEmit.Preserve,
    allowImportingTsExtensions: true,
    isolatedModules: true,
  };

  const sourceFile = ts.createSourceFile(path, source, options.target!, true, scriptKindFor(path));

  const host: ts.CompilerHost = {
    getSourceFile: (fileName) => (fileName === path ? sourceFile : undefined),
    // No lib.d.ts is loaded: pulling it in would need a real filesystem, and the
    // diagnostics it enables are exactly the cross-project ones we filter anyway.
    getDefaultLibFileName: () => "lib.d.ts",
    writeFile: () => undefined,
    getCurrentDirectory: () => "/",
    getDirectories: () => [],
    fileExists: (fileName) => fileName === path,
    readFile: (fileName) => (fileName === path ? source : undefined),
    getCanonicalFileName: (fileName) => fileName,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => "\n",
  };

  const program = ts.createProgram([path], options, host);
  const raw = [
    ...program.getSyntacticDiagnostics(sourceFile),
    ...program.getSemanticDiagnostics(sourceFile),
  ];

  const out: TsDiagnostic[] = [];
  for (const diagnostic of raw) {
    if (UNRESOLVABLE_WITHOUT_PROJECT.has(diagnostic.code)) continue;
    if (diagnostic.file === undefined || diagnostic.start === undefined) continue;
    const { line, character } = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start);
    out.push({
      line: line + 1,
      column: character + 1,
      code: diagnostic.code,
      message: ts.flattenDiagnosticMessageText(diagnostic.messageText, " "),
      category: diagnostic.category === ts.DiagnosticCategory.Error ? "error" : "warning",
    });
  }
  return out;
}

function scriptKindFor(path: string): ts.ScriptKind {
  if (path.endsWith(".tsx")) return ts.ScriptKind.TSX;
  if (path.endsWith(".jsx")) return ts.ScriptKind.JSX;
  if (/\.(m|c)?js$/.test(path)) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}
