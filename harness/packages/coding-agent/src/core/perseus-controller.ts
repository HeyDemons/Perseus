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
				: 256;
		this.timeoutMs =
			typeof options.timeoutMs === "number" && Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
				? options.timeoutMs
				: 5000;
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
		const candidates = finalizeCandidateStream(this.predict(input, id, abortController.signal), () => {
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

	private async *predict(
		input: SpeculativeActionsBeginContext,
		turnId: string,
		signal: AbortSignal,
	): AsyncGenerator<SpeculativeActionCandidate> {
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
				"Predict the exact tool calls that the authoritative Actor is most likely to emit in its next batch.",
				`Return up to ${this.topK} likely batch members, ordered by confidence. Calls may co-occur; they are not mutually exclusive alternatives.`,
				"Emit one strict JSON object per line and no prose:",
				'{"tool":"exact_name","arguments":{},"confidence":0.0}',
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
			let raw = "";
			let pendingLine = "";
			const candidates: SpeculativeActionCandidate[] = [];
			const admittedCandidates: SpeculativeActionCandidate[] = [];
			const seen = new Set<string>();
			for await (const event of stream) {
				if (event.type !== "text_delta") continue;
				raw += event.delta;
				pendingLine += event.delta;
				const lines = pendingLine.split(/\r?\n/);
				pendingLine = lines.pop() ?? "";
				for (const line of lines) {
					for (const candidate of uniqueCandidates(line, this.topK - candidates.length, seen)) {
						candidates.push(candidate);
						if (!this.admitCandidate(candidate, input.requestIndex, turnId)) continue;
						admittedCandidates.push(candidate);
						this.record({
							event: "candidate_streamed",
							requestIndex: input.requestIndex,
							turnId,
							toolName: candidate.toolName,
							arguments: candidate.arguments,
							confidence: candidate.confidence,
							rank: candidates.length,
							emittedAfterMs: Date.now() - started,
						});
						yield candidate;
					}
				}
			}
			const response = await stream.result();
			const finalRaw = assistantText(response) || raw;
			for (const candidate of uniqueCandidates(finalRaw, this.topK - candidates.length, seen)) {
				candidates.push(candidate);
				if (!this.admitCandidate(candidate, input.requestIndex, turnId)) continue;
				admittedCandidates.push(candidate);
				this.record({
					event: "candidate_streamed",
					requestIndex: input.requestIndex,
					turnId,
					toolName: candidate.toolName,
					arguments: candidate.arguments,
					confidence: candidate.confidence,
					rank: candidates.length,
					emittedAfterMs: Date.now() - started,
				});
				yield candidate;
			}
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
				raw: finalRaw,
			});
		} catch (error) {
			this.record({
				event: signal.aborted ? "prediction_aborted" : "prediction_failed",
				requestIndex: input.requestIndex,
				turnId,
				latencyMs: Date.now() - started,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	private admitCandidate(candidate: SpeculativeActionCandidate, requestIndex: number, turnId: string): boolean {
		const confidence = candidate.confidence ?? 0;
		if (confidence >= this.minConfidence) return true;
		this.record({
			event: "candidate_below_confidence",
			requestIndex,
			turnId,
			toolName: candidate.toolName,
			arguments: candidate.arguments,
			confidence,
			threshold: this.minConfidence,
		});
		return false;
	}
}

async function* finalizeCandidateStream(
	source: AsyncIterable<SpeculativeActionCandidate>,
	cleanup: () => void,
): AsyncGenerator<SpeculativeActionCandidate> {
	try {
		for await (const candidate of source) yield candidate;
	} finally {
		cleanup();
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
	const candidates: SpeculativeActionCandidate[] = [];
	const seen = new Set<string>();
	for (const value of parseJsonValues(raw)) {
		const rows = Array.isArray(value)
			? value
			: speculativeRows(value);
		if (rows.length === 0) continue;
		for (const row of rows) {
			if (!row || typeof row !== "object" || Array.isArray(row)) continue;
			const item = row as Record<string, unknown>;
			const toolName = firstString(item.tool, item.toolName, item.tool_name, item.name);
			const args = item.arguments ?? item.args ?? item.parameters;
			if (!toolName || !args || typeof args !== "object" || Array.isArray(args)) continue;
			const confidence = typeof item.confidence === "number" && Number.isFinite(item.confidence)
				? Math.max(0, Math.min(1, item.confidence))
				: undefined;
			const key = `${toolName}\n${stableJson(args)}`;
			if (seen.has(key)) continue;
			seen.add(key);
			candidates.push({
				toolName,
				arguments: args as Record<string, unknown>,
				confidence,
				rationale: typeof item.rationale === "string" ? item.rationale : undefined,
			});
			if (candidates.length >= Math.max(1, topK)) return candidates;
		}
	}
	return candidates;
}

function speculativeRows(value: unknown): unknown[] {
	if (!value || typeof value !== "object" || Array.isArray(value)) return [];
	const record = value as Record<string, unknown>;
	if (Array.isArray(record.candidates)) return record.candidates;
	if (Array.isArray(record.batch)) return record.batch;
	return [record];
}

function uniqueCandidates(raw: string, limit: number, seen: Set<string>): SpeculativeActionCandidate[] {
	if (limit <= 0) return [];
	const output: SpeculativeActionCandidate[] = [];
	for (const candidate of parseSpeculativeCandidates(raw, limit)) {
		const key = `${candidate.toolName}\n${stableJson(candidate.arguments)}`;
		if (seen.has(key)) continue;
		seen.add(key);
		output.push(candidate);
		if (output.length >= limit) break;
	}
	return output;
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
