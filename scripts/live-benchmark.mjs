import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

const models = ["deepseek-v4-flash", "deepseek-v4-pro"];
const prices = {
  "deepseek-v4-flash": { input: 0.14, output: 0.28 },
  "deepseek-v4-pro": { input: 1.74, output: 3.48 },
};
const maxTokens = 32;
const prefix = "DeepPi direct-cache verification prefix. ".repeat(256);

if (process.env.DEEPPI_LIVE !== "1") throw new Error("Set DEEPPI_LIVE=1 to enable paid API calls.");
const apiKey = process.env.DEEPSEEK_API_KEY;
if (!apiKey) throw new Error("DEEPSEEK_API_KEY is required.");

const estimatedInputTokens = Math.ceil(prefix.length / 3);
const maximumSpend = models.reduce((sum, model) =>
  sum + (2 * estimatedInputTokens * prices[model].input + 2 * maxTokens * prices[model].output) / 1_000_000,
0);
console.log(`Models: ${models.join(", ")}`);
console.log("Requests: 4");
console.log(`Output ceiling: ${maxTokens} tokens/request`);
console.log(`Estimated maximum spend at current documented prices: $${maximumSpend.toFixed(4)}`);

if (process.env.DEEPPI_LIVE_CONFIRM !== "I_ACCEPT_COST") {
  const terminal = createInterface({ input, output });
  const answer = await terminal.question("Type YES to send paid requests: ");
  terminal.close();
  if (answer !== "YES") throw new Error("Cancelled before sending requests.");
}

async function complete(model, messages) {
  const response = await fetch("https://api.deepseek.com/chat/completions", {
    method: "POST",
    headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({ model, messages, max_tokens: maxTokens, thinking: { type: "disabled" } }),
  });
  const body = await response.json();
  if (!response.ok) throw new Error(`${model} returned ${response.status}: ${JSON.stringify(body)}`);
  return body;
}

let failed = false;
for (const model of models) {
  const messages = [
    { role: "system", content: prefix },
    { role: "user", content: "Reply with exactly OK." },
  ];
  const first = await complete(model, messages);
  const second = await complete(model, [
    ...messages,
    first.choices[0].message,
    { role: "user", content: "Reply with exactly OK again." },
  ]);
  const hit = second.usage?.prompt_cache_hit_tokens ?? 0;
  const miss = second.usage?.prompt_cache_miss_tokens ?? 0;
  console.log(`${model}: hit=${hit} miss=${miss}`);
  if (hit === 0) failed = true;
}
if (failed) throw new Error("At least one model reported zero cache-hit tokens on its repeated-prefix request.");
