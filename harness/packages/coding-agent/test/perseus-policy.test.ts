import assert from "node:assert/strict";
import {
	type AssistantMessage,
	type AssistantMessageEvent,
	EventStream,
	type Model,
} from "@earendil-works/pi-ai";
import { createPerseusController } from "../src/core/perseus-controller.ts";

class MockAssistantStream extends EventStream<AssistantMessageEvent, AssistantMessage> {
	constructor(message: AssistantMessage) {
		super(
			(event) => event.type === "done" || event.type === "error",
			(event) => {
				if (event.type === "done") return event.message;
				if (event.type === "error") return event.error;
				throw new Error("unexpected event");
			},
		);
		this.push({ type: "done", reason: "stop", message });
	}
}

const model: Model<"openai-responses"> = {
	id: "mock",
	name: "mock",
	api: "openai-responses",
	provider: "mock",
	baseUrl: "https://example.invalid",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 8192,
	maxTokens: 2048,
};

const response: AssistantMessage = {
	role: "assistant",
	content: [{
		type: "text",
		text: JSON.stringify({
			candidates: [
				{ tool: "read", arguments: { path: "/high" }, confidence: 0.9 },
				{ tool: "read", arguments: { path: "/low" }, confidence: 0.2 },
			],
		}),
	}],
	api: "openai-responses",
	provider: "mock",
	model: "mock",
	usage: {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	},
	stopReason: "stop",
	timestamp: Date.now(),
};

let predictorCalls = 0;
let observedReasoning: unknown;
let observedMaxTokens: unknown;
const controller = createPerseusController({
	model,
	safeTools: ["read"],
	thinkingLevel: "low",
	minConfidence: 0.5,
	maxConsecutiveMissTurns: 2,
	cooldownTurns: 2,
});
const beginInput = {
	context: { systemPrompt: "", messages: [], tools: [] },
	actorModel: model,
	thinkingLevel: "high" as const,
	convertToLlm: () => [],
	streamFn: (_model: Model<any>, _context: unknown, options: { reasoning?: unknown; maxTokens?: unknown }) => {
		predictorCalls += 1;
		observedReasoning = options.reasoning;
		observedMaxTokens = options.maxTokens;
		return new MockAssistantStream(response);
	},
	requestIndex: 0,
};

const first = controller.beginTurn(beginInput);
assert.ok(first);
assert.deepEqual(await first.candidates, [
	{ toolName: "read", arguments: { path: "/high" }, confidence: 0.9, rationale: undefined },
]);
assert.equal(observedReasoning, "low", "Speculator thinking must be independent from Actor thinking");
assert.equal(observedMaxTokens, 256, "Speculator output must have a bounded default");

controller.record({ event: "turn_closed", requestIndex: 0, hits: 0, misses: 1 });
controller.record({ event: "turn_closed", requestIndex: 1, hits: 0, misses: 1 });
assert.equal(controller.beginTurn({ ...beginInput, requestIndex: 2 }), undefined);
assert.equal(controller.beginTurn({ ...beginInput, requestIndex: 3 }), undefined);
assert.equal(predictorCalls, 1, "cooldown turns must not issue prediction requests");

const resumed = controller.beginTurn({ ...beginInput, requestIndex: 4 });
assert.ok(resumed, "Speculation must resume after the bounded cooldown");
await resumed.candidates;
assert.equal(predictorCalls, 2);

console.log("PERSEUS confidence policy and miss circuit-breaker tests passed");
