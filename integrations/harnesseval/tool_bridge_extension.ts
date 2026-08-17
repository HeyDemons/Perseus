import { readFileSync } from "node:fs";

type ToolEntry = {
	name: string;
	description?: string;
	parameters?: Record<string, unknown>;
};

type SpeculativeDetails = {
	harnessevalSpeculation?: {
		id: string;
		tool: string;
		arguments: Record<string, unknown>;
	};
};

function required(name: string): string {
	const value = process.env[name]?.trim();
	if (!value) throw new Error(`${name} is required`);
	return value;
}

export default function harnessevalToolBridge(api: any) {
	const manifest = JSON.parse(readFileSync(required("HARNESSEVAL_TOOL_MANIFEST"), "utf8"));
	if (!Array.isArray(manifest.tools)) throw new Error("HarnessEval manifest tools must be an array");
	const endpoint = required("HARNESSEVAL_TOOL_ENDPOINT").replace(/\/+$/, "");
	api.on("tool_result", async (event: any) => {
		const speculation = (event.details as SpeculativeDetails | undefined)?.harnessevalSpeculation;
		if (!speculation) return undefined;
		const response = await fetch(`${endpoint}/commit`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				speculation_id: speculation.id,
				tool: speculation.tool,
				arguments: speculation.arguments,
			}),
		});
		const payload = await response.json();
		return {
			content: [{ type: "text", text: JSON.stringify(payload) }],
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
				try {
					const response = await fetch(`${endpoint}/execute`, {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({
							tool: entry.name,
							arguments: params ?? {},
							speculative: toolCallId.startsWith("spec-"),
						}),
					});
					const payload = await response.json();
					const speculationId = payload?._harnesseval_speculation_id;
					const visiblePayload = { ...payload };
					delete visiblePayload._harnesseval_speculation_id;
					return {
						content: [{ type: "text", text: JSON.stringify(visiblePayload) }],
						details:
							typeof speculationId === "string"
								? {
									harnessevalSpeculation: {
										id: speculationId,
										tool: entry.name,
										arguments: params ?? {},
									},
								}
								: {},
						isError: !response.ok || payload?.ok === false,
					};
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					return { content: [{ type: "text", text: message }], isError: true };
				}
			},
		});
	}
}
