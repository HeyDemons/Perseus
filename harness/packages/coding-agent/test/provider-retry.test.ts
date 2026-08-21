import assert from "node:assert/strict";
import {
	isNonRetryableProviderLimitError,
	isRetryableProviderErrorMessage,
} from "../src/core/agent-session.ts";

// The relay in front of this experiment's model returns "Upstream service temporarily
// unavailable". Classifying it as terminal gave PERSEUS zero retries where a matched
// control retried the same upstream failure, which shows up as extra PERSEUS failures
// rather than as a provider problem.
for (const message of [
	"Upstream service temporarily unavailable",
	"Service Unavailable",
	"service is currently unavailable",
	"503 Service Unavailable",
	"429 Current group upstream load is saturated",
	"overloaded_error",
	"rate limit exceeded",
	"fetch failed",
	"socket hang up",
]) {
	assert.equal(isRetryableProviderErrorMessage(message), true, `expected retryable: ${message}`);
}

// A spend or quota wall must stay terminal; retrying only burns the remaining budget.
for (const message of [
	"Monthly usage limit reached",
	"insufficient_quota",
	"quota exceeded",
	"available balance is too low",
]) {
	assert.equal(isNonRetryableProviderLimitError(message), true, `expected limit error: ${message}`);
	assert.equal(isRetryableProviderErrorMessage(message), false, `expected terminal: ${message}`);
}

// Ordinary task-level failures must not be mistaken for transport faults.
for (const message of ["tool not found", "invalid argument", ""]) {
	assert.equal(isRetryableProviderErrorMessage(message), false, `expected terminal: ${message}`);
}

console.log("provider-retry: OK");
