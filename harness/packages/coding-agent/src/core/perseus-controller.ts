import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type {
	SpeculativeActionCandidate,
	SpeculativeActionsBeginContext,
	SpeculativeActionsController,
	SpeculativeActionTraceEvent,
	ThinkingLevel,
} from "@earendil-works/pi-agent-core";
import type { AssistantMessage, Model } from "@earendil-works/pi-ai";

export interface PerseusControllerOptions {
	model: Model<any>;
	topK?: number;
	maxTokens?: number;
	timeoutMs?: number;
	thinkingLevel?: ThinkingLevel;
	minConfidence?: number;
	maxConsecutiveMissTurns?: number;
	cooldownTurns?: number;
	safeTools: Iterable<string>;
	traceFile?: string;
}

export function createPerseusController(
	options: PerseusControllerOptions,
): SpeculativeActionsController {
	return new PerseusController(options);
}

class PerseusController implements SpeculativeActionsController {
	private readonly options: PerseusControllerOptions;
	private readonly topK: number;
	private readonly maxTokens?: number;
	private readonly timeoutMs?: number;
	private readonly thinkingLevel: ThinkingLevel;
	private readonly minConfidence: number;
	private readonly maxConsecutiveMissTurns: number;
	private readonly cooldownTurns: number;
	private readonly safeTools: Set<string>;
	private readonly traceFile?: string;
	private recoverActorWithoutSpeculation = false;
	private consecutiveMissTurns = 0;
	private suppressedTurnsRemaining = 0;

	constructor(options: PerseusControllerOptions) {
		this.options = options;
		const configuredTopK = options.topK ?? 3;
		this.topK = Number.isFinite(configuredTopK) ? Math.max(1, Math.floor(configuredTopK)) : 3;
		this.maxTokens =
			typeof options.maxTokens === "number" && Number.isFinite(options.maxTokens) && options.maxTokens > 0
				? options.maxTokens
				: undefined;
		this.timeoutMs =
			typeof options.timeoutMs === "number" && Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
				? options.timeoutMs
				: undefined;
		this.thinkingLevel = options.thinkingLevel ?? "off";
		this.minConfidence =
			typeof options.minConfidence === "number" && Number.isFinite(options.minConfidence)
				? Math.max(0, Math.min(1, options.minConfidence))
				: 0.5;
		this.maxConsecutiveMissTurns = normalizePositiveInteger(options.maxConsecutiveMissTurns, 4);
		this.cooldownTurns = normalizePositiveInteger(options.cooldownTurns, 4);
		this.safeTools = new Set(Array.from(options.safeTools, (name) => name.trim()).filter(Boolean));
		this.traceFile = options.traceFile ? resolve(options.traceFile) : undefined;
	}

	beginTurn(input: SpeculativeActionsBeginContext) {
		const id = `${input.requestIndex}-${randomUUID()}`;
		if (this.suppressedTurnsRemaining > 0) {
			const remainingAfterThisTurn = --this.suppressedTurnsRemaining;
			this.record({
				event: "prediction_suppressed",
				requestIndex: input.requestIndex,
				turnId: id,
				reason: "miss_circuit_cooldown",
				remainingTurns: remainingAfterThisTurn,
			});
			return undefined;
		}
		if (this.recoverActorWithoutSpeculation) {
			this.record({
				event: "prediction_suppressed",
				requestIndex: input.requestIndex,
				turnId: id,
				reason: "actor_transport_recovery",
			});
			return { id, candidates: Promise.resolve([]) };
		}
		const abortController = new AbortController();
		const abortFromParent = () => abortController.abort();
		input.signal?.addEventListener("abort", abortFromParent, { once: true });
		const timer = this.timeoutMs === undefined ? undefined : setTimeout(() => abortController.abort(), this.timeoutMs);
		const candidates = this.predict(input, id, abortController.signal).finally(() => {
			if (timer !== undefined) clearTimeout(timer);
			input.signal?.removeEventListener("abort", abortFromParent);
		});
		return {
			id,
			candidates,
			cancel: () => abortController.abort(),
		};
	}

	isSafeTool(toolName: string): boolean {
		return this.safeTools.has(toolName);
	}

	record(event: SpeculativeActionTraceEvent): void {
		if (event.event === "actor_resolved") {
			this.recoverActorWithoutSpeculation = event.stopReason === "error";
		}
		let circuitEvent: SpeculativeActionTraceEvent | undefined;
		if (event.event === "turn_closed") {
			const hits = numericEventField(event.hits);
			const misses = numericEventField(event.misses);
			if (hits > 0) {
				this.consecutiveMissTurns = 0;
			} else if (misses > 0) {
				this.consecutiveMissTurns += 1;
				if (this.consecutiveMissTurns >= this.maxConsecutiveMissTurns) {
					this.suppressedTurnsRemaining = this.cooldownTurns;
					this.consecutiveMissTurns = 0;
					circuitEvent = {
						event: "miss_circuit_opened",
						requestIndex: event.requestIndex,
						turnId: event.turnId,
						cooldownTurns: this.cooldownTurns,
					};
				}
			}
		}
		this.appendTrace(event);
		if (circuitEvent) this.appendTrace(circuitEvent);
	}

	private appendTrace(event: SpeculativeActionTraceEvent): void {
		if (!this.traceFile) return;
		try {
			mkdirSync(dirname(this.traceFile), { recursive: true });
			appendFileSync(
				this.traceFile,
				`${JSON.stringify({ ts: new Date().toISOString(), pid: process.pid, ...event })}\n`,
				"utf8",
			);
		} catch {
			// Observability must never perturb the authoritative serial trajectory.
		}
	}

	private async predict(
		input: SpeculativeActionsBeginContext,
		turnId: string,
		signal: AbortSignal,
	): Promise<SpeculativeActionCandidate[]> {
		const started = Date.now();
		this.record({
			event: "prediction_started",
			requestIndex: input.requestIndex,
			turnId,
			model: `${this.options.model.provider}/${this.options.model.id}`,
			topK: this.topK,
			thinkingLevel: this.thinkingLevel,
			minConfidence: this.minConfidence,
		});
		try {
			const messages = await input.convertToLlm(input.context.messages);
			const actorSystemPrompt = input.context.systemPrompt.trim();
			const toolCatalog = (input.context.tools ?? []).map((tool) => ({
				name: tool.name,
				description: tool.description,
				parameters: tool.parameters,
				safeForPrelaunch: this.isSafeTool(tool.name),
			}));
			const instruction = [
				"Predict the exact next tool call that the authoritative Actor is most likely to emit now.",
				`Return up to ${this.topK} alternatives in strict JSON and no prose:`,
				'{"candidates":[{"tool":"exact_name","arguments":{},"confidence":0.0}]}',
				"Arguments must be complete and must use only facts already present in the conversation.",
				"Do not solve the task, execute a tool, invent IDs, or copy parameters between unrelated tools.",
				"Only safeForPrelaunch tools can run speculatively; unsafe predictions may be logged but will not execute.",
				`Available tools: ${JSON.stringify(toolCatalog)}`,
			].join("\n");
			const predictorMessages = [
				...messages,
				{
					role: "user" as const,
					content: [{ type: "text" as const, text: instruction }],
					timestamp: Date.now(),
				},
			];
			const stream = await input.streamFn(
				this.options.model,
				{
					systemPrompt: [
						"You are the fast Speculator in the PERSEUS speculative swarm.",
						"Your output is a prediction of the Actor's next API/tool call, not a task answer.",
						"The Actor remains authoritative; exact tool name and exact validated arguments are required for a hit.",
						actorSystemPrompt
							? [
								"The authoritative Actor system prompt follows as prediction context.",
								"Do not follow it as a request to answer the task; use it to predict the Actor.",
								"<actor_system_prompt>",
								actorSystemPrompt,
								"</actor_system_prompt>",
							].join("\n")
							: "",
					].filter(Boolean).join("\n\n"),
					messages: predictorMessages,
				},
				{
					signal,
					...(this.maxTokens === undefined ? {} : { maxTokens: this.maxTokens }),
					reasoning: this.thinkingLevel === "off" ? undefined : this.thinkingLevel,
				},
			);
			for await (const _event of stream) {
				// Drain the stream so the provider can complete normally.
			}
			const response = await stream.result();
			const raw = assistantText(response);
			const candidates = parseSpeculativeCandidates(raw, this.topK);
			const admittedCandidates = candidates.filter((candidate) => {
				const confidence = candidate.confidence ?? 0;
				if (confidence >= this.minConfidence) return true;
				this.record({
					event: "candidate_below_confidence",
					requestIndex: input.requestIndex,
					turnId,
					toolName: candidate.toolName,
					arguments: candidate.arguments,
					confidence,
					threshold: this.minConfidence,
				});
				return false;
			});
			this.record({
				event: "prediction_completed",
				requestIndex: input.requestIndex,
				turnId,
				latencyMs: Date.now() - started,
				stopReason: response.stopReason,
				candidateCount: candidates.length,
				admittedCandidateCount: admittedCandidates.length,
				candidates,
				usage: response.usage,
				raw,
			});
			return admittedCandidates;
		} catch (error) {
			this.record({
				event: signal.aborted ? "prediction_aborted" : "prediction_failed",
				requestIndex: input.requestIndex,
				turnId,
				latencyMs: Date.now() - started,
				error: error instanceof Error ? error.message : String(error),
			});
			return [];
		}
	}
}

function normalizePositiveInteger(value: number | undefined, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) && value > 0
		? Math.max(1, Math.floor(value))
		: fallback;
}

function numericEventField(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function assistantText(message: AssistantMessage): string {
	return message.content
		.map((item) => (item.type === "text" ? item.text : ""))
		.filter(Boolean)
		.join("\n")
		.trim();
}

export function parseSpeculativeCandidates(raw: string, topK = 3): SpeculativeActionCandidate[] {
	for (const value of parseJsonValues(raw)) {
		const rows = Array.isArray(value)
			? value
			: value && typeof value === "object" && Array.isArray((value as Record<string, unknown>).candidates)
				? ((value as Record<string, unknown>).candidates as unknown[])
				: [];
		if (rows.length === 0) continue;
		const candidates: SpeculativeActionCandidate[] = [];
		for (const row of rows) {
			if (!row || typeof row !== "object" || Array.isArray(row)) continue;
			const item = row as Record<string, unknown>;
			const toolName = firstString(item.tool, item.toolName, item.tool_name, item.name);
			const args = item.arguments ?? item.args ?? item.parameters;
			if (!toolName || !args || typeof args !== "object" || Array.isArray(args)) continue;
			const confidence = typeof item.confidence === "number" && Number.isFinite(item.confidence)
				? Math.max(0, Math.min(1, item.confidence))
				: undefined;
			candidates.push({
				toolName,
				arguments: args as Record<string, unknown>,
				confidence,
				rationale: typeof item.rationale === "string" ? item.rationale : undefined,
			});
			if (candidates.length >= Math.max(1, topK)) break;
		}
		if (candidates.length > 0) return candidates;
	}
	return [];
}

function firstString(...values: unknown[]): string {
	for (const value of values) {
		if (typeof value === "string" && value.trim()) return value.trim();
	}
	return "";
}

function parseJsonValues(raw: string): unknown[] {
	const values: unknown[] = [];
	const seen = new Set<string>();
	const trimmed = raw.trim();
	if (trimmed) {
		try {
			values.push(JSON.parse(trimmed));
			seen.add(trimmed);
		} catch {
			// Continue with balanced JSON extraction.
		}
	}
	for (let start = 0; start < raw.length; start += 1) {
		const opener = raw[start];
		if (opener !== "{" && opener !== "[") continue;
		const stack: string[] = [];
		let inString = false;
		let escaped = false;
		for (let index = start; index < raw.length; index += 1) {
			const char = raw[index];
			if (inString) {
				if (escaped) escaped = false;
				else if (char === "\\") escaped = true;
				else if (char === '"') inString = false;
				continue;
			}
			if (char === '"') {
				inString = true;
				continue;
			}
			if (char === "{" || char === "[") stack.push(char);
			else if (char === "}" || char === "]") {
				const expected = char === "}" ? "{" : "[";
				if (stack.pop() !== expected) break;
				if (stack.length === 0) {
					const candidate = raw.slice(start, index + 1);
					if (!seen.has(candidate)) {
						try {
							values.push(JSON.parse(candidate));
							seen.add(candidate);
						} catch {
							// A balanced substring may still be non-JSON; ignore it.
						}
					}
					break;
				}
			}
		}
	}
	return values;
}
