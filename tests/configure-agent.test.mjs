import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const configure = path.join(root, "scripts", "configure-agent.mjs");
const state = mkdtempSync(path.join(tmpdir(), "perseus-config-test-"));

function generate(name, environment) {
	const output = path.join(state, name);
	const completed = spawnSync(process.execPath, [configure, output], {
		env: {
			...process.env,
			PERSEUS_ACTOR_MODEL: "model",
			PERSEUS_ACTOR_API_TYPE: "openai-completions",
			PERSEUS_ACTOR_API_KEY: "test-key",
			...environment,
		},
		encoding: "utf8",
	});
	assert.equal(completed.status, 0, completed.stderr);
	return JSON.parse(readFileSync(path.join(output, "models.json"), "utf8"));
}

try {
	const deepseek = generate("deepseek", {
		PERSEUS_ACTOR_PROVIDER: "deepseek",
		PERSEUS_ACTOR_BASE_URL: "https://api.deepseek.com",
		PERSEUS_ACTOR_THINKING: "high",
	});
	assert.equal(deepseek.providers.deepseek.compat.thinkingFormat, "deepseek");
	assert.equal(deepseek.providers.deepseek.models[0].reasoning, true);
	assert.equal(deepseek.providers.deepseek.models[0].compat.thinkingFormat, "deepseek");

	const detected = generate("detected", {
		PERSEUS_ACTOR_PROVIDER: "openai-compatible",
		PERSEUS_ACTOR_BASE_URL: "https://api.deepseek.com/v1",
		PERSEUS_ACTOR_THINKING: "off",
	});
	assert.equal(detected.providers["openai-compatible"].compat.thinkingFormat, "deepseek");
	assert.equal(detected.providers["openai-compatible"].models[0].reasoning, true);

	const generic = generate("generic", {
		PERSEUS_ACTOR_PROVIDER: "openai-compatible",
		PERSEUS_ACTOR_BASE_URL: "https://provider.example/v1",
		PERSEUS_ACTOR_THINKING: "off",
	});
	assert.equal(generic.providers["openai-compatible"].compat.thinkingFormat, undefined);
	assert.equal(generic.providers["openai-compatible"].models[0].reasoning, false);
	console.log("PERSEUS provider reasoning configuration tests passed");
} finally {
	rmSync(state, { recursive: true, force: true });
}
