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

function assistant(content: AssistantMessage["content"], stopReason: AssistantMessage["stopReason"]): AssistantMessage {
	return {
		role: "assistant",
		content,
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
		stopReason,
		timestamp: Date.now(),
	};
}

const schema = Type.Object({ value: Type.String() });
const tool: AgentTool<typeof schema, { value: string }> = {
	name: "workspace",
	label: "workspace",
	description: "Write or verify an artifact",
	parameters: schema,
	async execute(_id, params) {
		return { content: [{ type: "text", text: params.value }], details: {} };
	},
};

const trace: SpeculativeActionTraceEvent[] = [];
const controller: SpeculativeActionsController = {
	beginTurn(input) {
		return { id: `turn-${input.requestIndex}`, candidates: Promise.resolve([]) };
	},
	isSafeTool: () => false,
	record: (event) => trace.push(event),
};

const responses = [
	assistant([{ type: "toolCall", id: "write", name: "workspace", arguments: { value: "written" } }], "toolUse"),
	assistant([{ type: "text", text: "premature final" }], "stop"),
	assistant([{ type: "toolCall", id: "verify", name: "workspace", arguments: { value: "verified" } }], "toolUse"),
	assistant([{ type: "text", text: "corrected final" }], "stop"),
];
const contexts: Message[][] = [];
let call = 0;
const context: AgentContext = { systemPrompt: "test", messages: [], tools: [tool] };
const prompt: AgentMessage = { role: "user", content: "build it", timestamp: Date.now() };
const stream = agentLoop([prompt], context, {
	model,
	convertToLlm: (messages) => messages as Message[],
	speculativeActions: controller,
	verificationCritic: {
		maxPasses: 1,
		prompt: "Verification gate: use tools and fix failures.",
	},
}, undefined, (_model, llmContext) => {
	contexts.push(llmContext.messages);
	return new MockAssistantStream(responses[call++]);
});
for await (const _event of stream) {
	// Drain the complete loop.
}
const messages = await stream.result();
assert.equal(call, 4);
assert.equal((messages.at(-1) as AssistantMessage).content[0].type, "text");
assert.equal(
	(messages.at(-1) as AssistantMessage).content[0].type === "text"
		? (messages.at(-1) as AssistantMessage).content[0].text
		: "",
	"corrected final",
);
assert.ok(contexts[2].some((message) =>
	message.role === "user" &&
	typeof message.content === "string" &&
	message.content.startsWith("Verification gate:"),
));
assert.equal(trace.filter((event) => event.event === "critic_requested").length, 1);
assert.equal(trace.filter((event) => event.event === "critic_completed").length, 1);

console.log("PERSEUS verification critic tests passed");
