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
	AgentLoopConfig,
	AgentMessage,
	AgentTool,
	SpeculativeActionTraceEvent,
	SpeculativeActionsController,
} from "../src/types.ts";

class MockAssistantStream extends EventStream<AssistantMessageEvent, AssistantMessage> {
	constructor() {
		super(
			(event) => event.type === "done" || event.type === "error",
			(event) => {
				if (event.type === "done") return event.message;
				if (event.type === "error") return event.error;
				throw new Error("unexpected event");
			},
		);
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

function assistant(content: AssistantMessage["content"]): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "openai-responses",
		provider: "mock",
		model: "mock",
		usage: usage(),
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function controller(
	args: Record<string, unknown>,
	safe: boolean,
	events: SpeculativeActionTraceEvent[],
): SpeculativeActionsController {
	return {
		beginTurn(input) {
			return {
				id: `turn-${input.requestIndex}`,
				candidates: input.requestIndex === 0
					? new Promise((resolve) => setTimeout(() => resolve([
						{ toolName: "lookup", arguments: args, confidence: 0.9 },
					]), 5))
					: Promise.resolve([]),
			};
		},
		isSafeTool: () => safe,
		record: (event) => events.push(event),
	};
}

async function runScenario(
	predictedArgs: Record<string, unknown>,
	safe: boolean,
	rejectSpeculation = false,
) {
	const events: SpeculativeActionTraceEvent[] = [];
	const starts: number[] = [];
	let actorResolvedAt = 0;
	let executions = 0;
	const toolSchema = Type.Object({ a: Type.Number(), b: Type.Number() });
	const tool: AgentTool<typeof toolSchema, { a: number; b: number }> = {
		name: "lookup",
		label: "lookup",
		description: "Read-only lookup",
		parameters: toolSchema,
		async execute(id, params, signal) {
			executions += 1;
			starts.push(Date.now());
			await new Promise<void>((resolve, reject) => {
				const timer = setTimeout(resolve, 90);
				signal?.addEventListener("abort", () => {
					clearTimeout(timer);
					reject(new Error("aborted"));
				}, { once: true });
			});
			return {
				content: [{ type: "text", text: JSON.stringify(params) }],
				details: rejectSpeculation && id.startsWith("spec-")
					? { perseusSpeculationRejected: true }
					: {},
			};
		},
	};
	const context: AgentContext = { systemPrompt: "test", messages: [], tools: [tool] };
	const config: AgentLoopConfig = {
		model,
		convertToLlm: (messages) => messages as Message[],
		speculativeActions: controller(predictedArgs, safe, events),
	};
	let actorCall = 0;
	const streamFn = () => {
		const stream = new MockAssistantStream();
		const call = actorCall++;
		setTimeout(() => {
			if (call === 0) actorResolvedAt = Date.now();
			const message = call === 0
				? assistant([{ type: "toolCall", id: "actual-1", name: "lookup", arguments: { b: 2, a: 1 } }])
				: assistant([{ type: "text", text: "done" }]);
			stream.push({ type: "done", reason: "stop", message });
		}, call === 0 ? 60 : 0);
		return stream;
	};
	const prompt: AgentMessage = { role: "user", content: "go", timestamp: Date.now() };
	const stream = agentLoop([prompt], context, config, undefined, streamFn);
	for await (const _event of stream) {
		// Drain the complete end-to-end loop.
	}
	await stream.result();
	return { events, starts, actorResolvedAt, executions };
}

const hit = await runScenario({ a: 1, b: 2 }, true);
assert.equal(hit.executions, 1, "an exact hit must execute the tool only once");
assert.ok(hit.starts[0] < hit.actorResolvedAt, "safe tool must start before the Actor resolves");
assert.equal(hit.events.filter((event) => event.event === "cache_hit").length, 1);
const saved = hit.events.find((event) => event.event === "speculation_saved");
assert.ok(saved, "an exact hit must report its measured critical-path saving");
assert.ok(Number(saved.savedMs) > 0);
assert.ok(Number(saved.savedMs) <= Number(saved.toolLatencyMs));
assert.ok(Number(saved.waitedMs) >= 0);

const miss = await runScenario({ a: 9, b: 2 }, true);
assert.equal(miss.executions, 2, "a strict argument miss must preserve the Actor execution");
assert.equal(miss.events.filter((event) => event.event === "cache_miss").length, 1);

const unsafe = await runScenario({ a: 1, b: 2 }, false);
assert.equal(unsafe.executions, 1, "unsafe speculation must never pre-execute");
assert.ok(unsafe.starts[0] >= unsafe.actorResolvedAt);
assert.equal(unsafe.events.filter((event) => event.event === "candidate_unsafe").length, 1);

const rejected = await runScenario({ a: 1, b: 2 }, true, true);
assert.equal(rejected.executions, 2, "a rejected snapshot must execute the Actor call normally");
assert.equal(rejected.events.filter((event) => event.event === "candidate_rejected").length, 1);
assert.equal(rejected.events.filter((event) => event.event === "cache_hit").length, 0);

console.log("PERSEUS speculative swarm protocol tests passed");
