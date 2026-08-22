import { readFileSync } from "node:fs";
import { request as httpRequest } from "node:http";

type ToolEntry = {
	name: string;
	description?: string;
	parameters?: Record<string, unknown>;
};

type ToolManifest = {
	tools: ToolEntry[];
	metadata?: { lifecycle?: string };
};

type SpeculativeDetails = {
	harnessevalSpeculation?: {
		id: string;
		tool: string;
		arguments: Record<string, unknown>;
	};
};

type ToolContent =
	| { type: "text"; text: string }
	| { type: "image"; data: string; mimeType: string };

const WIRE_IMAGE_MARKER = "_harnesseval_image";
const DECLARATION_ONLY_LIFECYCLE = "single_turn_declaration_only";

export function postJsonDirect(url: string, payload: Record<string, unknown>): Promise<{ ok: boolean; payload: any }> {
	const body = JSON.stringify(payload);
	return new Promise((resolve, reject) => {
		const request = httpRequest(
			url,
			{
				method: "POST",
				agent: false,
				headers: {
					"content-type": "application/json",
					"content-length": Buffer.byteLength(body).toString(),
				},
			},
			(response) => {
				const chunks: Buffer[] = [];
				response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
				response.on("error", reject);
				response.on("end", () => {
					try {
						const decoded = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
						const status = response.statusCode ?? 500;
						resolve({ ok: status >= 200 && status < 300, payload: decoded });
					} catch (error) {
						reject(error);
					}
				});
			},
		);
		request.on("error", reject);
		request.end(body);
	});
}

function stripWireImages(value: unknown, images: ToolContent[]): unknown {
	if (Array.isArray(value)) return value.map((item) => stripWireImages(item, images));
	if (value === null || typeof value !== "object") return value;

	const source = value as Record<string, unknown>;
	const marker = source[WIRE_IMAGE_MARKER];
	if (marker !== null && typeof marker === "object") {
		const encoded = marker as Record<string, unknown>;
		if (typeof encoded.data === "string" && typeof encoded.mime_type === "string") {
			images.push({ type: "image", data: encoded.data, mimeType: encoded.mime_type });
		}
	}
	const visible: Record<string, unknown> = {};
	for (const [key, item] of Object.entries(source)) {
		if (key !== WIRE_IMAGE_MARKER) visible[key] = stripWireImages(item, images);
	}
	return visible;
}

export function toolResultContent(payload: unknown): ToolContent[] {
	const images: ToolContent[] = [];
	const visible = stripWireImages(payload, images);
	return [{ type: "text", text: JSON.stringify(visible) ?? "null" }, ...images];
}

export function declarationOnlyToolResult(tool: string, arguments_: Record<string, unknown>) {
	return {
		content: toolResultContent({
			ok: true,
			result: {
				recorded_function_call: tool,
				arguments: arguments_,
				declaration_only: true,
				execution: "not_run",
			},
		}),
		details: { harnessevalDeclarationOnly: true },
		isError: false,
		// BFCL evaluates the first assistant tool-call batch itself. This hint makes the
		// agent end immediately after that batch instead of asking the actor for another
		// turn with synthetic tool observations.
		terminate: true,
	};
}

function required(name: string): string {
	const value = process.env[name]?.trim();
	if (!value) throw new Error(`${name} is required`);
	return value;
}

export default function harnessevalToolBridge(api: any) {
	const manifest = JSON.parse(
		readFileSync(required("HARNESSEVAL_TOOL_MANIFEST"), "utf8"),
	) as ToolManifest;
	if (!Array.isArray(manifest.tools)) throw new Error("HarnessEval manifest tools must be an array");
	const endpoint = required("HARNESSEVAL_TOOL_ENDPOINT").replace(/\/+$/, "");
	const declarationOnly = manifest.metadata?.lifecycle === DECLARATION_ONLY_LIFECYCLE;
	api.on("tool_result", async (event: any) => {
		const speculation = (event.details as SpeculativeDetails | undefined)?.harnessevalSpeculation;
		if (!speculation) return undefined;
		const response = await postJsonDirect(`${endpoint}/commit`, {
				speculation_id: speculation.id,
				tool: speculation.tool,
				arguments: speculation.arguments,
		});
		const payload = response.payload;
		return {
			content: toolResultContent(payload),
			details: { harnessevalSpeculationCommitted: speculation.id },
			isError: !response.ok || payload?.ok === false,
		};
	});
	for (const entry of manifest.tools as ToolEntry[]) {
		api.registerTool({
			name: entry.name,
			label: entry.name,
			description: entry.description || `HarnessEval tool ${entry.name}`,
			parameters: entry.parameters || { type: "object", properties: {} },
			async execute(toolCallId: string, params: Record<string, unknown>) {
				if (declarationOnly) return declarationOnlyToolResult(entry.name, params ?? {});
				try {
					const response = await postJsonDirect(`${endpoint}/execute`, {
							tool: entry.name,
							arguments: params ?? {},
							speculative: toolCallId.startsWith("spec-"),
					});
					const payload = response.payload;
					const speculationId = payload?._harnesseval_speculation_id;
					const speculationRejected = payload?._harnesseval_speculation_rejected === true;
					const visiblePayload = { ...payload };
					delete visiblePayload._harnesseval_speculation_id;
					delete visiblePayload._harnesseval_speculation_rejected;
					return {
						content: toolResultContent(visiblePayload),
						details:
							speculationRejected
								? {
									perseusSpeculationRejected: true,
									reason: typeof payload?.error === "string" ? payload.error : "snapshot_rejected",
								}
								: typeof speculationId === "string"
								? {
									harnessevalSpeculation: {
										id: speculationId,
										tool: entry.name,
										arguments: params ?? {},
									},
								}
								: {},
						isError: speculationRejected || !response.ok || payload?.ok === false,
					};
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					return { content: [{ type: "text", text: message }], isError: true };
				}
			},
		});
	}
}
