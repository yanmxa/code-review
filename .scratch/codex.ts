import { createModels } from "@earendil-works/pi-ai";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
const models = createModels();
const p = openaiCodexProvider();
models.setProvider(p);
console.log("provider id:", p.id, "| api:", p.api ?? "(n/a)");
for (const m of models.getModels("openai-codex")) console.log(`  ${m.id.padEnd(26)} ctx=${m.contextWindow} in=$${m.cost.input} out=$${m.cost.output}`);
const auth = await models.checkAuth("openai-codex").catch((e) => ({ error: String(e).slice(0,120) }));
console.log("auth check:", JSON.stringify(auth));
