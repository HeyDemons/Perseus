import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import harnessevalToolBridge, { postJsonDirect, toolResultContent } from "./tool_bridge_extension.ts";

const content = toolResultContent({
	ok: true,
	result: {
		path: "figure.png",
		image: {
			type: "image",
			mime_type: "image/png",
			bytes: 6,
			_harnesseval_image: { data: "iVBORw0K", mime_type: "image/png", detail: "auto" },
		},
	},
});

assert.deepEqual(content[1], { type: "image", data: "iVBORw0K", mimeType: "image/png" });
assert.equal(content[0]?.type, "text");
if (content[0]?.type !== "text") throw new Error("missing metadata text block");
assert.deepEqual(JSON.parse(content[0].text), {
	ok: true,
	result: {
		path: "figure.png",
		image: { type: "image", mime_type: "image/png", bytes: 6 },
	},
});
assert.equal(content[0].text.includes("iVBORw0K"), false);
assert.equal(content[0].text.includes("_harnesseval_image"), false);

async function testDirectPostBypassesProxyEnvironment() {
	const server = createServer((request, response) => {
		const chunks: Buffer[] = [];
		request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
		request.on("end", () => {
			assert.equal(request.method, "POST");
			assert.deepEqual(JSON.parse(Buffer.concat(chunks).toString("utf8")), { value: 7 });
			response.writeHead(200, { "content-type": "application/json" });
			response.end(JSON.stringify({ ok: true, result: "direct" }));
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (address === null || typeof address === "string") throw new Error("missing test server port");
	const previousProxy = process.env.HTTP_PROXY;
	try {
		process.env.HTTP_PROXY = "http://127.0.0.1:1";
		const result = await postJsonDirect(`http://127.0.0.1:${address.port}/execute`, { value: 7 });
		assert.equal(result.ok, true);
		assert.deepEqual(result.payload, { ok: true, result: "direct" });
	} finally {
		if (previousProxy === undefined) delete process.env.HTTP_PROXY;
		else process.env.HTTP_PROXY = previousProxy;
		await new Promise<void>((resolve, reject) =>
			server.close((error) => (error ? reject(error) : resolve())),
		);
	}
}

async function testDeclarationOnlyLifecycle() {
	const directory = mkdtempSync(join(tmpdir(), "harnesseval-declaration-only-"));
	const manifestPath = join(directory, "manifest.json");
	writeFileSync(
		manifestPath,
		JSON.stringify({
			tools: [{ name: "lookup", parameters: { type: "object", properties: {} } }],
			metadata: { lifecycle: "single_turn_declaration_only" },
		}),
	);
	const previousManifest = process.env.HARNESSEVAL_TOOL_MANIFEST;
	const previousEndpoint = process.env.HARNESSEVAL_TOOL_ENDPOINT;
	const previousFetch = globalThis.fetch;
	try {
		process.env.HARNESSEVAL_TOOL_MANIFEST = manifestPath;
		process.env.HARNESSEVAL_TOOL_ENDPOINT = "http://must-not-be-called.invalid";
		let fetchCalls = 0;
		globalThis.fetch = (async () => {
			fetchCalls++;
			throw new Error("declaration-only tools must not use fetch");
		}) as typeof fetch;
		const tools: any[] = [];
		harnessevalToolBridge({
			on() {},
			registerTool(tool: any) {
				tools.push(tool);
			},
		});
		const result = await tools[0].execute("call-1", { id: 7 });
		assert.equal(fetchCalls, 0);
		assert.equal(result.terminate, true);
		assert.equal(result.isError, false);
		assert.deepEqual(result.details, { harnessevalDeclarationOnly: true });
		assert.equal(result.content[0]?.type, "text");
		if (result.content[0]?.type !== "text") throw new Error("missing declaration result");
		assert.deepEqual(JSON.parse(result.content[0].text), {
			ok: true,
			result: {
				recorded_function_call: "lookup",
				arguments: { id: 7 },
				declaration_only: true,
				execution: "not_run",
			},
		});
	} finally {
		globalThis.fetch = previousFetch;
		if (previousManifest === undefined) delete process.env.HARNESSEVAL_TOOL_MANIFEST;
		else process.env.HARNESSEVAL_TOOL_MANIFEST = previousManifest;
		if (previousEndpoint === undefined) delete process.env.HARNESSEVAL_TOOL_ENDPOINT;
		else process.env.HARNESSEVAL_TOOL_ENDPOINT = previousEndpoint;
		rmSync(directory, { recursive: true, force: true });
	}
}

Promise.all([testDirectPostBypassesProxyEnvironment(), testDeclarationOnlyLifecycle()])
	.then(() => console.log("HarnessEval tool bridge: OK"))
	.catch((error) => {
		console.error(error);
		process.exitCode = 1;
	});
