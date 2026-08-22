import assert from "node:assert/strict";
import {
	type AssistantMessage,
	type AssistantMessageEvent,
	EventStream,
	type Message,
	type Model,
} from "@earendil-works/pi-ai";
import {
	createPerseusController,
	parseSpeculativeCandidates,
} from "../src/core/perseus-controller.ts";

class TimedAssistantStream extends EventStream<AssistantMessageEvent, AssistantMessage> {
	public finished = false;

	constructor(firstLine: string, secondLine: string) {
		super(
			(event) => event.type === "done" || event.type === "error",
			(event) => {
				if (event.type === "done") return event.message;
				if (event.type === "error") return event.error;
				throw new Error("unexpected event");
			},
		);
		const partial = message("");
		setTimeout(() => {
			this.push({ type: "start", partial });
			this.push({ type: "text_start", contentIndex: 0, partial });
			this.push({ type: "text_delta", contentIndex: 0, delta: `${firstLine}\n`, partial: message(firstLine) });
		}, 5);
		setTimeout(() => {
			const text = `${firstLine}\n${secondLine}`;
			this.push({ type: "text_delta", contentIndex: 0, delta: secondLine, partial: message(text) });
			this.push({ type: "text_end", contentIndex: 0, content: text, partial: message(text) });
			this.finished = true;
			this.push({ type: "done", reason: "stop", message: message(text) });
		}, 80);
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

function message(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
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
}

const firstLine = JSON.stringify({ tool: "read", arguments: { path: "/a" }, confidence: 0.9 });
const secondLine = JSON.stringify({ tool: "read", arguments: { path: "/b" }, confidence: 0.8 });
let timedStream: TimedAssistantStream | undefined;
let observedContext: { systemPrompt?: string; messages: Message[] } | undefined;
const convertedMessages = Array.from({ length: 8 }, (_, index) => ({
	role: "user" as const,
	content: `message-${index}`,
	timestamp: index,
}));
const controller = createPerseusController({ model, safeTools: ["read"], minConfidence: 0.5 });
const prediction = controller.beginTurn({
	context: { systemPrompt: "actor-system-secret", messages: [], tools: [] },
	actorModel: model,
	thinkingLevel: "high",
	convertToLlm: () => convertedMessages,
	streamFn: (_model, context) => {
		observedContext = context;
		timedStream = new TimedAssistantStream(firstLine, secondLine);
		return timedStream;
	},
	requestIndex: 0,
});
assert.ok(prediction);

const candidates = [];
for await (const candidate of prediction.candidates as AsyncIterable<unknown>) {
	candidates.push(candidate);
	if (candidates.length === 1) {
		assert.equal(timedStream?.finished, false, "first NDJSON candidate must arrive before the full response");
	}
}
assert.deepEqual(candidates, [
	{ toolName: "read", arguments: { path: "/a" }, confidence: 0.9, rationale: undefined },
	{ toolName: "read", arguments: { path: "/b" }, confidence: 0.8, rationale: undefined },
]);
assert.equal(observedContext?.messages.length, 7, "six recent messages plus one prediction instruction are sent");
assert.equal(observedContext?.messages[0]?.content, "message-2");
assert.ok(!observedContext?.systemPrompt?.includes("actor-system-secret"));

assert.deepEqual(
	parseSpeculativeCandidates(JSON.stringify({
		batch: [
			{ tool: "read", arguments: { path: "/a" }, confidence: 0.9 },
			{ tool: "read", arguments: { path: "/b" }, confidence: 0.8 },
		],
	})),
	candidates,
);

console.log("PERSEUS streaming and batch candidate tests passed");
