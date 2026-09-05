import assert from "node:assert/strict";
import { buildParams } from "../src/providers/openai-completions.ts";
import type { Context, Model, ModelThinkingLevel, ThinkingLevelMap } from "../src/types.ts";

// Omitting reasoning_effort leaves an OpenAI-compatible endpoint on its own default, which is
// commonly thinking-on. These assertions pin the difference between "unset" and an explicit
// "off", because a caller that asks for thinking off and silently gets thinking on wastes its
// whole latency budget on reasoning tokens it never wanted.

function model(overrides: Partial<Model<"openai-completions">> = {}): Model<"openai-completions"> {
	return {
		id: "gpt-5.6-terra",
		name: "Terra",
		api: "openai-completions",
		provider: "openai-compatible",
		baseUrl: "https://example.invalid/v1",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 4096,
		...overrides,
	} as Model<"openai-completions">;
}

const context: Context = {
	systemPrompt: "predict the next tool call",
	messages: [{ role: "user", content: [{ type: "text", text: "hello" }], timestamp: 0 }],
	tools: [],
};

function effortOf(
	options: { reasoningEffort?: ModelThinkingLevel; reasoningDisabled?: boolean },
	thinkingLevelMap?: ThinkingLevelMap,
): unknown {
	const params = buildParams(model(thinkingLevelMap ? { thinkingLevelMap } : {}), context, options as never);
	return (params as Record<string, unknown>).reasoning_effort;
}

assert.equal(
	effortOf({}),
	undefined,
	"An unset thinking level must omit reasoning_effort and keep the provider default",
);

assert.equal(
	effortOf({ reasoningDisabled: true }),
	"none",
	"An explicit thinking-off must send a real off value, not omit the parameter",
);

assert.equal(
	effortOf({ reasoningEffort: "high" }),
	"high",
	"A requested effort level must still be sent unchanged",
);

assert.equal(
	effortOf({ reasoningDisabled: true }, { off: null }),
	undefined,
	"A model that maps off to null opts out of sending any off value",
);

assert.equal(
	effortOf({ reasoningDisabled: true }, { off: "minimal" }),
	"minimal",
	"A model's own off value wins over the none default",
);

assert.equal(
	(buildParams(model({ reasoning: false }), context, { reasoningDisabled: true } as never) as Record<string, unknown>)
		.reasoning_effort,
	undefined,
	"A model without reasoning must never receive reasoning_effort",
);

console.log("Reasoning off/unset provider tests passed");
