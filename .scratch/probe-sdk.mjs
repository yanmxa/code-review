import OpenAI from "openai";
const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
try {
  const r = await client.responses.create({ model: "gpt-5.4", input: "Say hi in three words.", max_output_tokens: 20 });
  console.log("SDK OK:", r.status);
} catch (e) {
  console.log("SDK ERROR:", e.constructor.name, e.message);
  console.log("cause:", e.cause?.message ?? e.cause);
}
