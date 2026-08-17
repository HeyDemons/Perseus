import assert from "node:assert/strict";
import type { AssistantMessage } from "../src/types.ts";
import { isContextOverflow } from "../src/utils/overflow.ts";

function message(overrides: Partial<AssistantMessage>): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "completed" }],
		api: "openai-completions",
		provider: "deepseek",
		model: "deepseek-v4-flash",
		usage: {
			input: 65,
			output: 786,
			cacheRead: 174_464,
			cacheWrite: 0,
			totalTokens: 175_315,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
		...overrides,
	};
}

assert.equal(
	isContextOverflow(message({}), 131_072),
	false,
	"A valid DeepSeek completion must not be retried because cache accounting exceeds the configured window",
);

assert.equal(
	isContextOverflow(message({ provider: "zai", model: "glm-5" }), 131_072),
	true,
	"z.ai silent overflow detection must remain active",
);

assert.equal(
	isContextOverflow(
		message({
			stopReason: "error",
			errorMessage: "maximum context length is 131072 tokens",
		}),
		131_072,
	),
	true,
	"Explicit overflow errors must remain provider-independent",
);

console.log("Context overflow provider tests passed");
