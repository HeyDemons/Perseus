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
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 8192,
	maxTokens: 2048,
};

const response: AssistantMessage = {
	role: "assistant",
	content: [{ type: "text", text: '{"candidates":[]}' }],
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
const controller = createPerseusController({ model, safeTools: ["read"] });
const beginInput = {
	context: { systemPrompt: "", messages: [], tools: [] },
	actorModel: model,
	thinkingLevel: "off" as const,
	convertToLlm: () => [],
	streamFn: () => {
		predictorCalls += 1;
		return new MockAssistantStream(response);
	},
	requestIndex: 1,
};

controller.record({ event: "actor_resolved", requestIndex: 0, stopReason: "error" });
await controller.beginTurn(beginInput)?.candidates;
assert.equal(predictorCalls, 0, "Actor transport recovery must not compete with another prediction request");

controller.record({ event: "actor_resolved", requestIndex: 1, stopReason: "stop" });
await controller.beginTurn({ ...beginInput, requestIndex: 2 })?.candidates;
assert.equal(predictorCalls, 1, "Speculation should resume after the authoritative Actor recovers");

console.log("PERSEUS Actor recovery circuit-breaker tests passed");
