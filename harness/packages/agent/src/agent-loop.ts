/**
 * Agent loop that works with AgentMessage throughout.
 * Transforms to Message[] only at the LLM call boundary.
 */

import {
	type AssistantMessage,
	type Context,
	EventStream,
	type Model,
	streamSimple,
	type ToolResultMessage,
	validateToolArguments,
} from "@earendil-works/pi-ai";
import type {
	AgentContext,
	AgentEvent,
	AgentLoopConfig,
	AgentMessage,
	AgentTool,
	AgentToolCall,
	AgentToolResult,
	SpeculativeActionCandidate,
	SpeculativeActionsPrediction,
	StreamFn,
} from "./types.ts";

export type AgentEventSink = (event: AgentEvent) => Promise<void> | void;

/**
 * Start an agent loop with a new prompt message.
 * The prompt is added to the context and events are emitted for it.
 */
export function agentLoop(
	prompts: AgentMessage[],
	context: AgentContext,
	config: AgentLoopConfig,
	signal?: AbortSignal,
	streamFn?: StreamFn,
): EventStream<AgentEvent, AgentMessage[]> {
	const stream = createAgentStream();

	void runAgentLoop(
		prompts,
		context,
		config,
		async (event) => {
			stream.push(event);
		},
		signal,
		streamFn,
	).then((messages) => {
		stream.end(messages);
	});

	return stream;
}

/**
 * Continue an agent loop from the current context without adding a new message.
 * Used for retries - context already has user message or tool results.
 *
 * **Important:** The last message in context must convert to a `user` or `toolResult` message
 * via `convertToLlm`. If it doesn't, the LLM provider will reject the request.
 * This cannot be validated here since `convertToLlm` is only called once per turn.
 */
export function agentLoopContinue(
	context: AgentContext,
	config: AgentLoopConfig,
	signal?: AbortSignal,
	streamFn?: StreamFn,
): EventStream<AgentEvent, AgentMessage[]> {
	if (context.messages.length === 0) {
		throw new Error("Cannot continue: no messages in context");
	}

	if (context.messages[context.messages.length - 1].role === "assistant") {
		throw new Error("Cannot continue from message role: assistant");
	}

	const stream = createAgentStream();

	void runAgentLoopContinue(
		context,
		config,
		async (event) => {
			stream.push(event);
		},
		signal,
		streamFn,
	).then((messages) => {
		stream.end(messages);
	});

	return stream;
}

export async function runAgentLoop(
	prompts: AgentMessage[],
	context: AgentContext,
	config: AgentLoopConfig,
	emit: AgentEventSink,
	signal?: AbortSignal,
	streamFn?: StreamFn,
): Promise<AgentMessage[]> {
	const newMessages: AgentMessage[] = [...prompts];
	const currentContext: AgentContext = {
		...context,
		messages: [...context.messages, ...prompts],
	};

	await emit({ type: "agent_start" });
	await emit({ type: "turn_start" });
	for (const prompt of prompts) {
		await emit({ type: "message_start", message: prompt });
		await emit({ type: "message_end", message: prompt });
	}

	await runLoop(currentContext, newMessages, config, signal, emit, streamFn);
	return newMessages;
}

export async function runAgentLoopContinue(
	context: AgentContext,
	config: AgentLoopConfig,
	emit: AgentEventSink,
	signal?: AbortSignal,
	streamFn?: StreamFn,
): Promise<AgentMessage[]> {
	if (context.messages.length === 0) {
		throw new Error("Cannot continue: no messages in context");
	}

	if (context.messages[context.messages.length - 1].role === "assistant") {
		throw new Error("Cannot continue from message role: assistant");
	}

	const newMessages: AgentMessage[] = [];
	const currentContext: AgentContext = { ...context };

	await emit({ type: "agent_start" });
	await emit({ type: "turn_start" });

	await runLoop(currentContext, newMessages, config, signal, emit, streamFn);
	return newMessages;
}

function createAgentStream(): EventStream<AgentEvent, AgentMessage[]> {
	return new EventStream<AgentEvent, AgentMessage[]>(
		(event: AgentEvent) => event.type === "agent_end",
		(event: AgentEvent) => (event.type === "agent_end" ? event.messages : []),
	);
}

/**
 * Main loop logic shared by agentLoop and agentLoopContinue.
 */
async function runLoop(
	initialContext: AgentContext,
	newMessages: AgentMessage[],
	initialConfig: AgentLoopConfig,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
	streamFn?: StreamFn,
): Promise<void> {
	let currentContext = initialContext;
	let config = initialConfig;
	let firstTurn = true;
	let requestIndex = 0;
	let prefetchedResponse: Promise<AssistantMessage | undefined> | undefined;
	// Check for steering messages at start (user may have typed while waiting)
	let pendingMessages: AgentMessage[] = (await config.getSteeringMessages?.()) || [];

	// Outer loop: continues when queued follow-up messages arrive after agent would stop
	while (true) {
		let hasMoreToolCalls = true;

		// Inner loop: process tool calls and steering messages
		while (hasMoreToolCalls || pendingMessages.length > 0) {
			if (!firstTurn) {
				await emit({ type: "turn_start" });
			} else {
				firstTurn = false;
			}

			// Process pending messages (inject before next assistant response)
			if (pendingMessages.length > 0) {
				for (const message of pendingMessages) {
					await emit({ type: "message_start", message });
					await emit({ type: "message_end", message });
					currentContext.messages.push(message);
					newMessages.push(message);
				}
				pendingMessages = [];
			}

			// Stream assistant response, or consume an already-running depth-two Actor call.
			let streamed: StreamedAssistantResponse;
			const prefetched = prefetchedResponse ? await prefetchedResponse : undefined;
			prefetchedResponse = undefined;
			if (prefetched) {
				requestIndex += 1;
				streamed = await emitPrefetchedAssistantResponse(currentContext, prefetched, emit);
			} else {
				streamed = await streamAssistantResponse(
					currentContext,
					config,
					signal,
					emit,
					streamFn,
					requestIndex++,
				);
			}
			const message = streamed.message;
			newMessages.push(message);

			if (message.stopReason === "error" || message.stopReason === "aborted") {
				streamed.speculativeTurn?.actorResolved(message);
				streamed.speculativeTurn?.close();
				await emit({ type: "turn_end", message, toolResults: [] });
				await emit({ type: "agent_end", messages: newMessages });
				return;
			}

			// Check for tool calls
			const toolCalls = message.content.filter((c) => c.type === "toolCall");
			streamed.speculativeTurn?.actorResolved(message);

			const toolResults: ToolResultMessage[] = [];
			hasMoreToolCalls = false;
			if (toolCalls.length > 0) {
				const executedToolBatch = await executeToolCalls(
					currentContext,
					message,
					config,
					signal,
					emit,
					streamed.speculativeTurn,
				);
				toolResults.push(...executedToolBatch.messages);
				hasMoreToolCalls = !executedToolBatch.terminate;

				for (const result of toolResults) {
					currentContext.messages.push(result);
					newMessages.push(result);
				}
			}
			await emit({ type: "turn_end", message, toolResults });

			const nextTurnContext = {
				message,
				toolResults,
				context: currentContext,
				newMessages,
			};
			const nextTurnSnapshot = await config.prepareNextTurn?.(nextTurnContext);
			if (nextTurnSnapshot) {
				currentContext = nextTurnSnapshot.context ?? currentContext;
				config = {
					...config,
					model: nextTurnSnapshot.model ?? config.model,
					reasoning:
						nextTurnSnapshot.thinkingLevel === undefined
							? config.reasoning
							: nextTurnSnapshot.thinkingLevel === "off"
								? undefined
								: nextTurnSnapshot.thinkingLevel,
				};
			}

			const shouldStop = await config.shouldStopAfterTurn?.({
					message,
					toolResults,
					context: currentContext,
					newMessages,
				});

			pendingMessages = (await config.getSteeringMessages?.()) || [];
			if (!shouldStop && hasMoreToolCalls && pendingMessages.length === 0) {
				const claimed = await streamed.speculativeTurn?.claimContinuation(currentContext, config);
				prefetchedResponse = claimed?.response;
			}
			streamed.speculativeTurn?.close();

			if (shouldStop) {
				await emit({ type: "agent_end", messages: newMessages });
				return;
			}
		}

		// Agent would stop here. Check for follow-up messages.
		const followUpMessages = (await config.getFollowUpMessages?.()) || [];
		if (followUpMessages.length > 0) {
			// Set as pending so inner loop processes them
			pendingMessages = followUpMessages;
			continue;
		}

		// No more messages, exit
		break;
	}

	await emit({ type: "agent_end", messages: newMessages });
}

/**
 * Stream an assistant response from the LLM.
 * This is where AgentMessage[] gets transformed to Message[] for the LLM.
 */
async function streamAssistantResponse(
	context: AgentContext,
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
	streamFn?: StreamFn,
	requestIndex = 0,
): Promise<StreamedAssistantResponse> {
	const preparedRequest = await prepareAssistantRequest(context, config, signal);
	const { messages, llmContext } = preparedRequest;

	const streamFunction = streamFn || streamSimple;
	const speculativeContext = messages === context.messages ? context : { ...context, messages };
	const speculativeTurn = startSpeculativeTurn(speculativeContext, config, streamFunction, signal, requestIndex);

	// Resolve API key (important for expiring tokens)
	const resolvedApiKey =
		(config.getApiKey ? await config.getApiKey(config.model.provider) : undefined) || config.apiKey;

	const response = await streamFunction(config.model, llmContext, {
		...config,
		apiKey: resolvedApiKey,
		signal,
	});

	let partialMessage: AssistantMessage | null = null;
	let addedPartial = false;

	for await (const event of response) {
		switch (event.type) {
			case "start":
				partialMessage = event.partial;
				context.messages.push(partialMessage);
				addedPartial = true;
				await emit({ type: "message_start", message: { ...partialMessage } });
				break;

			case "text_start":
			case "text_delta":
			case "text_end":
			case "thinking_start":
			case "thinking_delta":
			case "thinking_end":
			case "toolcall_start":
			case "toolcall_delta":
			case "toolcall_end":
				if (partialMessage) {
					partialMessage = event.partial;
					context.messages[context.messages.length - 1] = partialMessage;
					await emit({
						type: "message_update",
						assistantMessageEvent: event,
						message: { ...partialMessage },
					});
				}
				break;

			case "done":
			case "error": {
				const finalMessage = await response.result();
				if (addedPartial) {
					context.messages[context.messages.length - 1] = finalMessage;
				} else {
					context.messages.push(finalMessage);
				}
				if (!addedPartial) {
					await emit({ type: "message_start", message: { ...finalMessage } });
				}
				await emit({ type: "message_end", message: finalMessage });
				return { message: finalMessage, speculativeTurn };
			}
		}
	}

	const finalMessage = await response.result();
	if (addedPartial) {
		context.messages[context.messages.length - 1] = finalMessage;
	} else {
		context.messages.push(finalMessage);
		await emit({ type: "message_start", message: { ...finalMessage } });
	}
	await emit({ type: "message_end", message: finalMessage });
	return { message: finalMessage, speculativeTurn };
}

type PreparedAssistantRequest = {
	messages: AgentMessage[];
	llmContext: Context;
	contextKey: string;
};

async function prepareAssistantRequest(
	context: AgentContext,
	config: AgentLoopConfig,
	signal?: AbortSignal,
): Promise<PreparedAssistantRequest> {
	let messages = context.messages;
	if (config.transformContext) messages = await config.transformContext(messages, signal);
	if (config.canonicalToolState) messages = canonicalizeToolState(messages);
	const llmMessages = await config.convertToLlm(messages);
	const llmContext: Context = {
		systemPrompt: context.systemPrompt,
		messages: llmMessages,
		tools: context.tools,
	};
	return {
		messages,
		llmContext,
		contextKey: stableJson({
			model: `${config.model.provider}/${config.model.id}/${config.model.api}`,
			reasoning: config.reasoning ?? "off",
			systemPrompt: llmContext.systemPrompt ?? "",
			messages: llmContext.messages.map(providerMessageProjection),
			tools: (llmContext.tools ?? []).map((tool) => ({
				name: tool.name,
				description: tool.description,
				parameters: tool.parameters,
			})),
		}),
	};
}

function providerMessageProjection(message: Context["messages"][number]): unknown {
	if (message.role === "assistant") {
		return { role: message.role, content: message.content };
	}
	if (message.role === "toolResult") {
		return {
			role: message.role,
			toolCallId: message.toolCallId,
			toolName: message.toolName,
			content: message.content,
			isError: message.isError,
		};
	}
	return { role: message.role, content: message.content };
}

export function canonicalizeToolState(messages: AgentMessage[]): AgentMessage[] {
	let toolBatch = 0;
	const canonicalIds = new Map<string, string>();
	return messages.map((message) => {
		if (message.role === "assistant") {
			const toolCalls = message.content.filter((item) => item.type === "toolCall");
			if (toolCalls.length === 0) return message;
			const content = toolCalls.map((toolCall, index) => {
				const id = `perseus-tool-${toolBatch}-${index}`;
				canonicalIds.set(toolCall.id, id);
				return { ...toolCall, id };
			});
			toolBatch += 1;
			return { ...message, content };
		}
		if (message.role === "toolResult") {
			const toolCallId = canonicalIds.get(message.toolCallId);
			return toolCallId ? { ...message, toolCallId } : message;
		}
		return message;
	});
}

type StreamedAssistantResponse = {
	message: AssistantMessage;
	speculativeTurn?: ActiveSpeculativeTurn;
};

async function emitPrefetchedAssistantResponse(
	context: AgentContext,
	message: AssistantMessage,
	emit: AgentEventSink,
): Promise<StreamedAssistantResponse> {
	context.messages.push(message);
	await emit({ type: "message_start", message: { ...message } });
	await emit({ type: "message_end", message });
	return { message };
}

type SpeculativeFutureEntry = {
	candidate: SpeculativeActionCandidate;
	abortController: AbortController;
	promise: Promise<SpeculativeExecutedToolCall>;
	claimed: boolean;
};

type SpeculativeExecutedToolCall = {
	outcome: ExecutedToolCallOutcome;
	startedAtMs: number;
	completedAtMs: number;
};

type SpeculativeContinuationEntry = {
	contextKey: Promise<string>;
	response: Promise<AssistantMessage | undefined>;
	abortController: AbortController;
	startedAtMs: number;
	claimed: boolean;
};

type ClaimedSpeculativeContinuation = {
	response: Promise<AssistantMessage | undefined>;
};

function startSpeculativeTurn(
	context: AgentContext,
	config: AgentLoopConfig,
	streamFn: StreamFn,
	signal: AbortSignal | undefined,
	requestIndex: number,
): ActiveSpeculativeTurn | undefined {
	const controller = config.speculativeActions;
	if (!controller || signal?.aborted || !context.tools?.length) return undefined;
	try {
		const prediction = controller.beginTurn({
			context,
			actorModel: config.model,
			thinkingLevel: config.reasoning ?? "off",
			convertToLlm: config.convertToLlm,
			streamFn,
			signal,
			requestIndex,
		});
		return prediction
			? new ActiveSpeculativeTurn(context, config, streamFn, controller, prediction, signal, requestIndex)
			: undefined;
	} catch (error) {
		controller.record({
			event: "prediction_start_error",
			requestIndex,
			error: error instanceof Error ? error.message : String(error),
		});
		return undefined;
	}
}

class ActiveSpeculativeTurn {
	private readonly context: AgentContext;
	private readonly config: AgentLoopConfig;
	private readonly streamFn: StreamFn;
	private readonly controller: NonNullable<AgentLoopConfig["speculativeActions"]>;
	private readonly prediction: SpeculativeActionsPrediction;
	private readonly parentSignal: AbortSignal | undefined;
	private readonly requestIndex: number;
	private readonly entries = new Map<string, SpeculativeFutureEntry>();
	private readonly launched: Promise<void>;
	private actorDone = false;
	private closed = false;
	private hits = 0;
	private misses = 0;
	private continuation?: SpeculativeContinuationEntry;

	constructor(
		context: AgentContext,
		config: AgentLoopConfig,
		streamFn: StreamFn,
		controller: NonNullable<AgentLoopConfig["speculativeActions"]>,
		prediction: SpeculativeActionsPrediction,
		parentSignal: AbortSignal | undefined,
		requestIndex: number,
	) {
		this.context = {
			...context,
			messages: [...context.messages],
			tools: context.tools ? [...context.tools] : undefined,
		};
		this.config = config;
		this.streamFn = streamFn;
		this.controller = controller;
		this.prediction = prediction;
		this.parentSignal = parentSignal;
		this.requestIndex = requestIndex;
		this.controller.record({ event: "turn_started", requestIndex, turnId: prediction.id });
		this.launched = this.launchCandidates();
	}

	actorResolved(message?: AssistantMessage): void {
		if (this.actorDone) return;
		this.actorDone = true;
		this.prediction.cancel?.();
		this.controller.record({
			event: "actor_resolved",
			requestIndex: this.requestIndex,
			turnId: this.prediction.id,
			prelaunched: this.entries.size,
			stopReason: message?.stopReason,
			usage: message?.usage,
			actualToolCalls: message?.content
				.filter((item) => item.type === "toolCall")
				.map((item) => ({ toolName: item.name, arguments: item.arguments })),
		});
	}

	async claim(prepared: PreparedToolCall): Promise<ExecutedToolCallOutcome | undefined> {
		const key = exactToolCallKey(prepared.toolCall.name, prepared.args);
		const entry = this.entries.get(key);
		if (!entry) {
			this.misses += 1;
			this.controller.record({
				event: "cache_miss",
				requestIndex: this.requestIndex,
				turnId: this.prediction.id,
				toolName: prepared.toolCall.name,
				arguments: asRecord(prepared.args),
			});
			return undefined;
		}
		entry.claimed = true;
		this.hits += 1;
		this.controller.record({
			event: "cache_hit",
			requestIndex: this.requestIndex,
			turnId: this.prediction.id,
			toolName: prepared.toolCall.name,
			arguments: asRecord(prepared.args),
			confidence: entry.candidate.confidence,
		});
		const claimedAtMs = Date.now();
		const execution = await entry.promise;
		const toolLatencyMs = Math.max(0, execution.completedAtMs - execution.startedAtMs);
		const headStartMs = Math.max(0, claimedAtMs - execution.startedAtMs);
		const savedMs = Math.min(toolLatencyMs, headStartMs);
		this.controller.record({
			event: "speculation_saved",
			requestIndex: this.requestIndex,
			turnId: this.prediction.id,
			toolName: prepared.toolCall.name,
			arguments: asRecord(prepared.args),
			confidence: entry.candidate.confidence,
			savedMs,
			toolLatencyMs,
			headStartMs,
			waitedMs: Math.max(0, execution.completedAtMs - claimedAtMs),
		});
		return execution.outcome;
	}

	async claimContinuation(
		actualContext: AgentContext,
		actualConfig: AgentLoopConfig,
	): Promise<ClaimedSpeculativeContinuation | undefined> {
		const entry = this.continuation;
		if (!entry || entry.claimed) return undefined;
		const [predictedKey, actualRequest] = await Promise.all([
			entry.contextKey,
			prepareAssistantRequest(actualContext, actualConfig, this.parentSignal),
		]);
		if (!predictedKey || predictedKey !== actualRequest.contextKey) {
			entry.abortController.abort();
			this.controller.record({
				event: "continuation_miss",
				requestIndex: this.requestIndex,
				turnId: this.prediction.id,
				reason: "provider_context_mismatch",
			});
			return undefined;
		}
		entry.claimed = true;
		const claimedAtMs = Date.now();
		this.controller.record({
			event: "continuation_hit",
			requestIndex: this.requestIndex,
			turnId: this.prediction.id,
			headStartMs: Math.max(0, claimedAtMs - entry.startedAtMs),
		});
		return {
			response: entry.response.then((message) => {
				if (!message) return undefined;
				const completedAtMs = Date.now();
				const actorLatencyMs = Math.max(0, completedAtMs - entry.startedAtMs);
				const headStartMs = Math.max(0, claimedAtMs - entry.startedAtMs);
				this.controller.record({
					event: "continuation_saved",
					requestIndex: this.requestIndex,
					turnId: this.prediction.id,
					savedMs: Math.min(actorLatencyMs, headStartMs),
					actorLatencyMs,
					headStartMs,
					waitedMs: Math.max(0, completedAtMs - claimedAtMs),
				});
				return message;
			}),
		};
	}

	close(): void {
		if (this.closed) return;
		this.closed = true;
		this.prediction.cancel?.();
		let discarded = 0;
		for (const entry of this.entries.values()) {
			if (entry.claimed) continue;
			discarded += 1;
			entry.abortController.abort();
			this.controller.record({
				event: "candidate_discarded",
				requestIndex: this.requestIndex,
				turnId: this.prediction.id,
				toolName: entry.candidate.toolName,
				arguments: entry.candidate.arguments,
			});
		}
		if (this.continuation && !this.continuation.claimed) {
			this.continuation.abortController.abort();
			this.controller.record({
				event: "continuation_discarded",
				requestIndex: this.requestIndex,
				turnId: this.prediction.id,
			});
		}
		this.controller.record({
			event: "turn_closed",
			requestIndex: this.requestIndex,
			turnId: this.prediction.id,
			prelaunched: this.entries.size,
			hits: this.hits,
			misses: this.misses,
			discarded,
		});
		void this.launched.catch(() => undefined);
	}

	private async launchCandidates(): Promise<void> {
		let received = 0;
		let lateRecorded = false;
		try {
			for await (const candidate of asCandidateStream(this.prediction.candidates)) {
				received += 1;
				if (this.actorDone || this.closed || this.parentSignal?.aborted) {
					if (!lateRecorded) {
						lateRecorded = true;
						this.controller.record({
							event: "prediction_late",
							requestIndex: this.requestIndex,
							turnId: this.prediction.id,
							candidateCount: received,
						});
					}
					continue;
				}
				this.launchCandidate(candidate, received - 1);
			}
		} catch (error) {
			this.controller.record({
				event: "prediction_error",
				requestIndex: this.requestIndex,
				turnId: this.prediction.id,
				error: error instanceof Error ? error.message : String(error),
			});
			return;
		}
		if (received === 0 && !lateRecorded && (this.actorDone || this.closed || this.parentSignal?.aborted)) {
			this.controller.record({
				event: "prediction_late",
				requestIndex: this.requestIndex,
				turnId: this.prediction.id,
				candidateCount: 0,
			});
		}
	}

	private launchCandidate(candidate: SpeculativeActionCandidate, index: number): void {
		if (!this.controller.isSafeTool(candidate.toolName)) {
			this.controller.record({
				event: "candidate_unsafe",
				requestIndex: this.requestIndex,
				turnId: this.prediction.id,
				toolName: candidate.toolName,
				arguments: candidate.arguments,
			});
			return;
		}
		const prepared = prepareSpeculativeCandidate(this.context, candidate, this.prediction.id, index);
		if (!prepared) {
			this.controller.record({
				event: "candidate_invalid",
				requestIndex: this.requestIndex,
				turnId: this.prediction.id,
				toolName: candidate.toolName,
				arguments: candidate.arguments,
			});
			return;
		}
		const key = exactToolCallKey(prepared.toolCall.name, prepared.args);
		if (this.entries.has(key)) return;
		const abortController = new AbortController();
		const abort = () => abortController.abort();
		this.parentSignal?.addEventListener("abort", abort, { once: true });
		const startedAtMs = Date.now();
		const promise = executePreparedToolCall(prepared, abortController.signal, async () => undefined).then((result) => {
			const completedAtMs = Date.now();
			this.parentSignal?.removeEventListener("abort", abort);
			this.controller.record({
				event: "candidate_completed",
				requestIndex: this.requestIndex,
				turnId: this.prediction.id,
				toolName: candidate.toolName,
				arguments: asRecord(prepared.args),
				isError: result.isError,
				latencyMs: completedAtMs - startedAtMs,
			});
			const execution = { outcome: result, startedAtMs, completedAtMs };
			this.maybeStartContinuation(candidate, prepared, execution);
			return execution;
		});
		this.entries.set(key, { candidate, abortController, promise, claimed: false });
		this.controller.record({
			event: "candidate_prelaunched",
			requestIndex: this.requestIndex,
			turnId: this.prediction.id,
			toolName: candidate.toolName,
			arguments: asRecord(prepared.args),
			confidence: candidate.confidence,
		});
	}

	private maybeStartContinuation(
		candidate: SpeculativeActionCandidate,
		prepared: PreparedToolCall,
		execution: SpeculativeExecutedToolCall,
	): void {
		if (
			this.config.speculativeDepth !== 2 ||
			!this.config.canonicalToolState ||
			this.continuation ||
			(candidate.confidence ?? 0) < (this.config.speculativeDepthMinConfidence ?? 0.9) ||
			execution.outcome.isError
		) {
			return;
		}
		const predictedAssistant = syntheticToolAssistant(this.config.model, prepared.toolCall);
		const predictedResult = createToolResultMessage({
			toolCall: prepared.toolCall,
			result: execution.outcome.result,
			isError: execution.outcome.isError,
		});
		const predictedContext: AgentContext = {
			...this.context,
			messages: [...this.context.messages, predictedAssistant, predictedResult],
		};
		const abortController = new AbortController();
		const abortFromParent = () => abortController.abort();
		this.parentSignal?.addEventListener("abort", abortFromParent, { once: true });
		const startedAtMs = Date.now();
		const preparedRequest = prepareAssistantRequest(predictedContext, this.config, abortController.signal);
		const contextKey = preparedRequest.then((request) => request.contextKey, () => "");
		const response = preparedRequest
			.then(async ({ llmContext }) => {
				this.controller.record({
					event: "continuation_prelaunched",
					requestIndex: this.requestIndex,
					turnId: this.prediction.id,
					toolName: candidate.toolName,
					arguments: candidate.arguments,
					confidence: candidate.confidence,
				});
				const resolvedApiKey =
					(this.config.getApiKey
						? await this.config.getApiKey(this.config.model.provider)
						: undefined) || this.config.apiKey;
				const stream = await this.streamFn(this.config.model, llmContext, {
					...this.config,
					apiKey: resolvedApiKey,
					signal: abortController.signal,
				});
				for await (const _event of stream) {
					// Buffer the detached authoritative Actor response until the branch validates.
				}
				const message = await stream.result();
				this.controller.record({
					event: "continuation_completed",
					requestIndex: this.requestIndex,
					turnId: this.prediction.id,
					latencyMs: Date.now() - startedAtMs,
					stopReason: message.stopReason,
					usage: message.usage,
				});
				return message.stopReason === "error" || message.stopReason === "aborted" ? undefined : message;
			})
			.catch((error) => {
				this.controller.record({
					event: "continuation_failed",
					requestIndex: this.requestIndex,
					turnId: this.prediction.id,
					error: error instanceof Error ? error.message : String(error),
				});
				return undefined;
			})
			.finally(() => this.parentSignal?.removeEventListener("abort", abortFromParent));
		this.continuation = { contextKey, response, abortController, startedAtMs, claimed: false };
	}
}

async function* asCandidateStream(
	source: SpeculativeActionsPrediction["candidates"],
): AsyncGenerator<SpeculativeActionCandidate> {
	if (Symbol.asyncIterator in Object(source)) {
		for await (const candidate of source as AsyncIterable<SpeculativeActionCandidate>) yield candidate;
		return;
	}
	for (const candidate of await (source as Promise<SpeculativeActionCandidate[]>)) yield candidate;
}

function prepareSpeculativeCandidate(
	context: AgentContext,
	candidate: SpeculativeActionCandidate,
	turnId: string,
	index: number,
): PreparedToolCall | undefined {
	const tool = context.tools?.find((item) => item.name === candidate.toolName);
	if (!tool) return undefined;
	const toolCall = {
		type: "toolCall" as const,
		id: `spec-${turnId}-${index}`,
		name: candidate.toolName,
		arguments: candidate.arguments,
	};
	try {
		const preparedToolCall = prepareToolCallArguments(tool, toolCall);
		const args = validateToolArguments(tool, preparedToolCall);
		return { kind: "prepared", toolCall, tool, args };
	} catch {
		return undefined;
	}
}

function exactToolCallKey(toolName: string, args: unknown): string {
	return `${toolName}\n${stableJson(args)}`;
}

function stableJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(",")}]`;
	if (value && typeof value === "object") {
		const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) =>
			left.localeCompare(right),
		);
		return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;
	}
	return JSON.stringify(value) ?? "null";
}

function asRecord(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}

/**
 * Execute tool calls from an assistant message.
 */
async function executeToolCalls(
	currentContext: AgentContext,
	assistantMessage: AssistantMessage,
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
	speculativeTurn?: ActiveSpeculativeTurn,
): Promise<ExecutedToolCallBatch> {
	const toolCalls = assistantMessage.content.filter((c) => c.type === "toolCall");
	const hasSequentialToolCall = toolCalls.some(
		(tc) => currentContext.tools?.find((t) => t.name === tc.name)?.executionMode === "sequential",
	);
	if (config.toolExecution === "sequential" || hasSequentialToolCall) {
		return executeToolCallsSequential(currentContext, assistantMessage, toolCalls, config, signal, emit, speculativeTurn);
	}
	return executeToolCallsParallel(currentContext, assistantMessage, toolCalls, config, signal, emit, speculativeTurn);
}

type ExecutedToolCallBatch = {
	messages: ToolResultMessage[];
	terminate: boolean;
};

async function executeToolCallsSequential(
	currentContext: AgentContext,
	assistantMessage: AssistantMessage,
	toolCalls: AgentToolCall[],
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
	speculativeTurn?: ActiveSpeculativeTurn,
): Promise<ExecutedToolCallBatch> {
	const finalizedCalls: FinalizedToolCallOutcome[] = [];
	const messages: ToolResultMessage[] = [];

	for (const toolCall of toolCalls) {
		await emit({
			type: "tool_execution_start",
			toolCallId: toolCall.id,
			toolName: toolCall.name,
			args: toolCall.arguments,
		});

		const preparation = await prepareToolCall(currentContext, assistantMessage, toolCall, config, signal);
		let finalized: FinalizedToolCallOutcome;
		if (preparation.kind === "immediate") {
			finalized = {
				toolCall,
				result: preparation.result,
				isError: preparation.isError,
			};
		} else {
			const executed =
				(await speculativeTurn?.claim(preparation)) ??
				(await executePreparedToolCall(preparation, signal, emit));
			finalized = await finalizeExecutedToolCall(
				currentContext,
				assistantMessage,
				preparation,
				executed,
				config,
				signal,
			);
		}

		await emitToolExecutionEnd(finalized, emit);
		const toolResultMessage = createToolResultMessage(finalized);
		await emitToolResultMessage(toolResultMessage, emit);
		finalizedCalls.push(finalized);
		messages.push(toolResultMessage);

		if (signal?.aborted) {
			break;
		}
	}

	return {
		messages,
		terminate: shouldTerminateToolBatch(finalizedCalls),
	};
}

async function executeToolCallsParallel(
	currentContext: AgentContext,
	assistantMessage: AssistantMessage,
	toolCalls: AgentToolCall[],
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
	speculativeTurn?: ActiveSpeculativeTurn,
): Promise<ExecutedToolCallBatch> {
	const finalizedCalls: FinalizedToolCallEntry[] = [];

	for (const toolCall of toolCalls) {
		await emit({
			type: "tool_execution_start",
			toolCallId: toolCall.id,
			toolName: toolCall.name,
			args: toolCall.arguments,
		});

		const preparation = await prepareToolCall(currentContext, assistantMessage, toolCall, config, signal);
		if (preparation.kind === "immediate") {
			const finalized = {
				toolCall,
				result: preparation.result,
				isError: preparation.isError,
			} satisfies FinalizedToolCallOutcome;
			await emitToolExecutionEnd(finalized, emit);
			finalizedCalls.push(finalized);
			if (signal?.aborted) {
				break;
			}
			continue;
		}

		finalizedCalls.push(async () => {
			const executed =
				(await speculativeTurn?.claim(preparation)) ??
				(await executePreparedToolCall(preparation, signal, emit));
			const finalized = await finalizeExecutedToolCall(
				currentContext,
				assistantMessage,
				preparation,
				executed,
				config,
				signal,
			);
			await emitToolExecutionEnd(finalized, emit);
			return finalized;
		});
		if (signal?.aborted) {
			break;
		}
	}

	const orderedFinalizedCalls = await Promise.all(
		finalizedCalls.map((entry) => (typeof entry === "function" ? entry() : Promise.resolve(entry))),
	);
	const messages: ToolResultMessage[] = [];
	for (const finalized of orderedFinalizedCalls) {
		const toolResultMessage = createToolResultMessage(finalized);
		await emitToolResultMessage(toolResultMessage, emit);
		messages.push(toolResultMessage);
	}

	return {
		messages,
		terminate: shouldTerminateToolBatch(orderedFinalizedCalls),
	};
}

type PreparedToolCall = {
	kind: "prepared";
	toolCall: AgentToolCall;
	tool: AgentTool<any>;
	args: unknown;
};

type ImmediateToolCallOutcome = {
	kind: "immediate";
	result: AgentToolResult<any>;
	isError: boolean;
};

type ExecutedToolCallOutcome = {
	result: AgentToolResult<any>;
	isError: boolean;
};

type FinalizedToolCallOutcome = {
	toolCall: AgentToolCall;
	result: AgentToolResult<any>;
	isError: boolean;
};

type FinalizedToolCallEntry = FinalizedToolCallOutcome | (() => Promise<FinalizedToolCallOutcome>);

function shouldTerminateToolBatch(finalizedCalls: FinalizedToolCallOutcome[]): boolean {
	return finalizedCalls.length > 0 && finalizedCalls.every((finalized) => finalized.result.terminate === true);
}

function prepareToolCallArguments(tool: AgentTool<any>, toolCall: AgentToolCall): AgentToolCall {
	if (!tool.prepareArguments) {
		return toolCall;
	}
	const preparedArguments = tool.prepareArguments(toolCall.arguments);
	if (preparedArguments === toolCall.arguments) {
		return toolCall;
	}
	return {
		...toolCall,
		arguments: preparedArguments as Record<string, any>,
	};
}

async function prepareToolCall(
	currentContext: AgentContext,
	assistantMessage: AssistantMessage,
	toolCall: AgentToolCall,
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
): Promise<PreparedToolCall | ImmediateToolCallOutcome> {
	const tool = currentContext.tools?.find((t) => t.name === toolCall.name);
	if (!tool) {
		return {
			kind: "immediate",
			result: createErrorToolResult(`Tool ${toolCall.name} not found`),
			isError: true,
		};
	}

	try {
		const preparedToolCall = prepareToolCallArguments(tool, toolCall);
		const validatedArgs = validateToolArguments(tool, preparedToolCall);
		if (config.beforeToolCall) {
			const beforeResult = await config.beforeToolCall(
				{
					assistantMessage,
					toolCall,
					args: validatedArgs,
					context: currentContext,
				},
				signal,
			);
			if (signal?.aborted) {
				return {
					kind: "immediate",
					result: createErrorToolResult("Operation aborted"),
					isError: true,
				};
			}
			if (beforeResult?.block) {
				return {
					kind: "immediate",
					result: createErrorToolResult(beforeResult.reason || "Tool execution was blocked"),
					isError: true,
				};
			}
		}
		if (signal?.aborted) {
			return {
				kind: "immediate",
				result: createErrorToolResult("Operation aborted"),
				isError: true,
			};
		}
		return {
			kind: "prepared",
			toolCall,
			tool,
			args: validatedArgs,
		};
	} catch (error) {
		return {
			kind: "immediate",
			result: createErrorToolResult(error instanceof Error ? error.message : String(error)),
			isError: true,
		};
	}
}

async function executePreparedToolCall(
	prepared: PreparedToolCall,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
): Promise<ExecutedToolCallOutcome> {
	const updateEvents: Promise<void>[] = [];

	try {
		const result = await prepared.tool.execute(
			prepared.toolCall.id,
			prepared.args as never,
			signal,
			(partialResult) => {
				updateEvents.push(
					Promise.resolve(
						emit({
							type: "tool_execution_update",
							toolCallId: prepared.toolCall.id,
							toolName: prepared.toolCall.name,
							args: prepared.toolCall.arguments,
							partialResult,
						}),
					),
				);
			},
		);
		await Promise.all(updateEvents);
		return { result, isError: false };
	} catch (error) {
		await Promise.all(updateEvents);
		return {
			result: createErrorToolResult(error instanceof Error ? error.message : String(error)),
			isError: true,
		};
	}
}

async function finalizeExecutedToolCall(
	currentContext: AgentContext,
	assistantMessage: AssistantMessage,
	prepared: PreparedToolCall,
	executed: ExecutedToolCallOutcome,
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
): Promise<FinalizedToolCallOutcome> {
	let result = executed.result;
	let isError = executed.isError;

	if (config.afterToolCall) {
		try {
			const afterResult = await config.afterToolCall(
				{
					assistantMessage,
					toolCall: prepared.toolCall,
					args: prepared.args,
					result,
					isError,
					context: currentContext,
				},
				signal,
			);
			if (afterResult) {
				result = {
					content: afterResult.content ?? result.content,
					details: afterResult.details ?? result.details,
					terminate: afterResult.terminate ?? result.terminate,
				};
				isError = afterResult.isError ?? isError;
			}
		} catch (error) {
			result = createErrorToolResult(error instanceof Error ? error.message : String(error));
			isError = true;
		}
	}

	return {
		toolCall: prepared.toolCall,
		result,
		isError,
	};
}

function createErrorToolResult(message: string): AgentToolResult<any> {
	return {
		content: [{ type: "text", text: message }],
		details: {},
	};
}

async function emitToolExecutionEnd(finalized: FinalizedToolCallOutcome, emit: AgentEventSink): Promise<void> {
	await emit({
		type: "tool_execution_end",
		toolCallId: finalized.toolCall.id,
		toolName: finalized.toolCall.name,
		result: finalized.result,
		isError: finalized.isError,
	});
}

function createToolResultMessage(finalized: FinalizedToolCallOutcome): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: finalized.toolCall.id,
		toolName: finalized.toolCall.name,
		content: finalized.result.content,
		details: finalized.result.details,
		isError: finalized.isError,
		timestamp: Date.now(),
	};
}

function syntheticToolAssistant(model: Model<any>, toolCall: AgentToolCall): AssistantMessage {
	return {
		role: "assistant",
		content: [toolCall],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "toolUse",
		timestamp: Date.now(),
	};
}

async function emitToolResultMessage(toolResultMessage: ToolResultMessage, emit: AgentEventSink): Promise<void> {
	await emit({ type: "message_start", message: toolResultMessage });
	await emit({ type: "message_end", message: toolResultMessage });
}
