import { createModels } from "@earendil-works/pi-ai";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";

const models = createModels();
models.setProvider(openaiProvider());
const model = models.getModel("openai", "gpt-5.4")!;
console.log("model:", model.id, model.api, model.baseUrl);

const stream = models.streamSimple(model, {
  systemPrompt: "You are terse.",
  messages: [{ role: "user", content: "Say hi in three words.", timestamp: Date.now() }],
});
for await (const e of stream) {
  if (e.type === "error") { console.log("ERROR EVENT:", JSON.stringify(e.error.errorMessage), e.error.stopReason); }
  if (e.type === "done") { console.log("OK:", JSON.stringify(e.message.content), "usage:", e.message.usage.input, e.message.usage.output, "cost:", e.message.usage.cost.total); }
}
