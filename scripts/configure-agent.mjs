#!/usr/bin/env node
import { chmod, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const agentDir = path.resolve(process.argv[2] || "");
if (!process.argv[2]) throw new Error("usage: configure-agent.mjs <agent-dir>");

const actor = {
	provider: (process.env.PERSEUS_ACTOR_PROVIDER || "openai-compatible").trim().toLowerCase(),
	model: (process.env.PERSEUS_ACTOR_MODEL || "").trim(),
	baseUrl: (process.env.PERSEUS_ACTOR_BASE_URL || "").trim().replace(/\/$/, ""),
	api: (process.env.PERSEUS_ACTOR_API_TYPE || "openai-completions").trim(),
	keyEnv: "PERSEUS_ACTOR_API_KEY",
};
const speculator = {
	provider: (process.env.PERSEUS_SPECULATOR_PROVIDER || actor.provider).trim().toLowerCase(),
	model: (process.env.PERSEUS_SPECULATOR_MODEL || actor.model).trim(),
	baseUrl: (process.env.PERSEUS_SPECULATOR_BASE_URL || actor.baseUrl).trim().replace(/\/$/, ""),
	api: (process.env.PERSEUS_SPECULATOR_API_TYPE || actor.api).trim(),
	keyEnv: actor.provider === (process.env.PERSEUS_SPECULATOR_PROVIDER || actor.provider).trim().toLowerCase()
		? "PERSEUS_ACTOR_API_KEY"
		: "PERSEUS_SPECULATOR_API_KEY",
};

for (const [role, config] of [["actor", actor], ["speculator", speculator]]) {
	if (!config.model) throw new Error(`PERSEUS_${role.toUpperCase()}_MODEL is required`);
	if (!config.baseUrl) throw new Error(`PERSEUS_${role.toUpperCase()}_BASE_URL is required`);
}
if (!process.env.PERSEUS_ACTOR_API_KEY?.trim()) throw new Error("PERSEUS_ACTOR_API_KEY is required");
if (speculator.provider !== actor.provider && !process.env.PERSEUS_SPECULATOR_API_KEY?.trim()) {
	throw new Error("PERSEUS_SPECULATOR_API_KEY is required for a separate speculator provider");
}

function compat(reasoning) {
	return {
		supportsStore: false,
		supportsDeveloperRole: false,
		supportsReasoningEffort: reasoning,
		maxTokensField: "max_tokens",
		supportsStrictMode: false,
	};
}

function modelEntry(config, reasoning) {
	const configuredMaxTokens = Number.parseInt(process.env.PERSEUS_MAX_TOKENS || "", 10);
	return {
		id: config.model,
		name: config.model,
		api: config.api,
		baseUrl: config.baseUrl,
		reasoning,
		...(Number.isFinite(configuredMaxTokens) && configuredMaxTokens > 0
			? { maxTokens: configuredMaxTokens }
			: {}),
		contextWindow: Number.parseInt(process.env.PERSEUS_CONTEXT_WINDOW || "128000", 10),
		compat: compat(reasoning),
	};
}

const actorReasoning = (process.env.PERSEUS_ACTOR_THINKING || "off").trim().toLowerCase() !== "off";
const providers = {};
providers[actor.provider] = {
	baseUrl: actor.baseUrl,
	apiKey: `$${actor.keyEnv}`,
	api: actor.api,
	compat: compat(actorReasoning),
	models: [modelEntry(actor, actorReasoning)],
};
if (speculator.provider === actor.provider) {
	if (!providers[actor.provider].models.some((item) => item.id === speculator.model)) {
		providers[actor.provider].models.push(modelEntry(speculator, false));
	}
} else {
	providers[speculator.provider] = {
		baseUrl: speculator.baseUrl,
		apiKey: `$${speculator.keyEnv}`,
		api: speculator.api,
		compat: compat(false),
		models: [modelEntry(speculator, false)],
	};
}

const timeoutMs = Number.parseInt(process.env.PERSEUS_API_TIMEOUT_MS || "180000", 10);
const settings = {
	retry: {
		provider: {
			timeoutMs,
			maxRetries: Number.parseInt(process.env.PERSEUS_API_MAX_RETRIES || "1", 10),
			maxRetryDelayMs: Number.parseInt(process.env.PERSEUS_API_MAX_RETRY_DELAY_MS || "30000", 10),
		},
	},
	httpIdleTimeoutMs: timeoutMs,
	websocketConnectTimeoutMs: Number.parseInt(process.env.PERSEUS_WEBSOCKET_CONNECT_TIMEOUT_MS || "30000", 10),
};

await mkdir(agentDir, { recursive: true });
const modelsPath = path.join(agentDir, "models.json");
const settingsPath = path.join(agentDir, "settings.json");
await writeFile(modelsPath, `${JSON.stringify({ providers }, null, 2)}\n`, { mode: 0o600 });
await writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
await chmod(modelsPath, 0o600);
await chmod(settingsPath, 0o600);
await chmod(agentDir, 0o700);
