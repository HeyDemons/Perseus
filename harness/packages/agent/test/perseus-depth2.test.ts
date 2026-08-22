import assert from "node:assert/strict";
import {
	type AssistantMessage,
	type AssistantMessageEvent,
	EventStream,
	type Message,
	type Model,
} from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { agentLoop } from "../src/agent-loop.ts";
import type {
	AgentContext,
	AgentMessage,
	AgentTool,
	SpeculativeActionTraceEvent,
	SpeculativeActionsController,
} from "../src/types.ts";

class MockAssistantStream extends EventStream<AssistantMessageEvent, AssistantMessage> {
	constructor(message: AssistantMessage, delayMs: number, signal?: AbortSignal) {
		super(
			(event) => event.type === "done" || event.type === "error",
			(event) => {
				if (event.type === "done") return event.message;
				if (event.type === "error") return event.error;
				throw new Error("unexpected event");
			},
		);
		const timer = setTimeout(() => this.push({ type: "done", reason: "stop", message }), delayMs);
		signal?.addEventListener("abort", () => {
			clearTimeout(timer);
			this.push({ type: "error", reason: "aborted", error: assistant([], "aborted") });
		}, { once: true });
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

function usage() {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function assistant(content: AssistantMessage["content"], stopReason: AssistantMessage["stopReason"]): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "openai-responses",
		provider: "mock",
		model: "mock",
		usage: usage(),
		stopReason,
		timestamp: Date.now(),
	};
}

function controller(events: SpeculativeActionTraceEvent[]): SpeculativeActionsController {
	return {
		beginTurn(input) {
			return {
				id: `turn-${input.requestIndex}`,
				candidates: input.requestIndex === 0
					? new Promise((resolve) => setTimeout(() => resolve([
						{ toolName: "lookup", arguments: { value: 1 }, confidence: 0.99 },
					]), 5))
					: Promise.resolve([]),
			};
		},
		isSafeTool: () => true,
		record: (event) => events.push(event),
	};
}

async function run(actualValue: number) {
	const events: SpeculativeActionTraceEvent[] = [];
	let actorResolvedAt = 0;
	let continuationStartedAt = 0;
	let normalContinuationStartedAt = 0;
	let calls = 0;
	const schema = Type.Object({ value: Type.Number() });
	const tool: AgentTool<typeof schema, { value: number }> = {
		name: "lookup",
		label: "lookup",
		description: "Read-only lookup",
		parameters: schema,
		async execute(_id, params) {
			await new Promise((resolve) => setTimeout(resolve, 20));
			return { content: [{ type: "text", text: `value=${params.value}` }], details: {} };
		},
	};
	const context: AgentContext = { systemPrompt: "test", messages: [], tools: [tool] };
	const streamFn = (_model: Model<any>, llmContext: { messages: Message[] }, options?: { signal?: AbortSignal }) => {
		calls += 1;
		const last = llmContext.messages.at(-1);
		if (last?.role !== "toolResult") {
			return new MockAssistantStream(assistant([
				{ type: "text", text: "<think>authoritative reasoning</think>" },
				{ type: "toolCall", id: "actual-call", name: "lookup", arguments: { value: actualValue } },
			], "toolUse"), 60, options?.signal);
		}
		const text = last.content.find((item) => item.type === "text")?.text ?? "";
		if (text === "value=1") continuationStartedAt ||= Date.now();
		else normalContinuationStartedAt ||= Date.now();
		return new MockAssistantStream(assistant([{ type: "text", text: `done:${text}` }], "stop"), 100, options?.signal);
	};
	const prompt: AgentMessage = { role: "user", content: "go", timestamp: Date.now() };
	const stream = agentLoop([prompt], context, {
		model,
		convertToLlm: (messages) => messages as Message[],
		speculativeActions: controller(events),
		canonicalToolState: true,
		speculativeDepth: 2,
		speculativeDepthMinConfidence: 0.9,
	}, undefined, (...args) => {
		const result = streamFn(...args);
		if (calls === 1) {
			setTimeout(() => {
				actorResolvedAt = Date.now();
			}, 60);
		}
		return result;
	});
	for await (const _event of stream) {
		// Drain the complete loop.
	}
	const messages = await stream.result();
	return { events, messages, calls, actorResolvedAt, continuationStartedAt, normalContinuationStartedAt };
}

const hit = await run(1);
assert.ok(hit.continuationStartedAt > 0 && hit.continuationStartedAt < hit.actorResolvedAt);
assert.equal(hit.calls, 2, "a depth-two hit must reuse the already-running Actor call");
assert.equal(hit.events.filter((event) => event.event === "continuation_hit").length, 1);
assert.equal(hit.events.filter((event) => event.event === "continuation_saved").length, 1);
assert.equal((hit.messages.at(-1) as AssistantMessage).content[0].type, "text");

const miss = await run(2);
assert.equal(miss.calls, 3, "a projected-context miss must fall back to a normal next Actor call");
assert.equal(miss.events.filter((event) => event.event === "continuation_miss").length, 1);
assert.ok(miss.normalContinuationStartedAt > miss.actorResolvedAt);
const final = miss.messages.at(-1) as AssistantMessage;
assert.equal(final.content[0].type === "text" ? final.content[0].text : "", "done:value=2");

console.log("PERSEUS depth-two continuation tests passed");
