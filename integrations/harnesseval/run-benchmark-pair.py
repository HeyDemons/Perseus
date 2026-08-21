#!/usr/bin/env python3
from __future__ import annotations

import argparse
import hashlib
import json
import os
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit, urlunsplit


STATIC_BENCHMARKS = {"gaia", "gdpval", "trajectory-bench", "bfcl"}
NATIVE_EPISODE_BENCHMARKS = {"vitabench", "tau2"}
TASK_BENCHMARKS = {"terminal-bench-2", "swe-bench-verified"}
PRODUCT_BENCHMARKS = STATIC_BENCHMARKS | NATIVE_EPISODE_BENCHMARKS | TASK_BENCHMARKS
API_ENV = (
    "PERSEUS_ACTOR_PROVIDER",
    "PERSEUS_ACTOR_MODEL",
    "PERSEUS_ACTOR_BASE_URL",
    "PERSEUS_ACTOR_API_TYPE",
    "PERSEUS_ACTOR_API_KEY",
    "PERSEUS_ACTOR_USER_AGENT",
    "PERSEUS_ACTOR_THINKING",
    "PERSEUS_SPECULATOR_PROVIDER",
    "PERSEUS_SPECULATOR_MODEL",
    "PERSEUS_SPECULATOR_BASE_URL",
    "PERSEUS_SPECULATOR_API_TYPE",
    "PERSEUS_SPECULATOR_API_KEY",
    "PERSEUS_SPECULATOR_USER_AGENT",
    "PERSEUS_TOP_K",
    "PERSEUS_SPECULATOR_MAX_TOKENS",
    "PERSEUS_SPECULATOR_TIMEOUT_MS",
    "PERSEUS_API_TIMEOUT_MS",
    "PERSEUS_API_MAX_RETRIES",
    "PERSEUS_API_MAX_RETRY_DELAY_MS",
    "PERSEUS_CONTEXT_WINDOW",
)
ROOTLESS_HOST_GATEWAY = "10.0.2.2"
HOST_GATEWAY_OVERRIDE_ENV = "HARNESSEVAL_DOCKER_HOST_GATEWAY"
DECLARATION_ONLY_LIFECYCLE = "single_turn_declaration_only"


def arm_timeout_sec() -> float | None:
    raw = os.environ.get("HARNESS_ARM_TIMEOUT_S", "").strip()
    if not raw:
        return None
    value = float(raw)
    if value <= 0:
        raise ValueError("HARNESS_ARM_TIMEOUT_S must be positive")
    return value


def bounded_phase_timeout(
    requested: float,
    deadline: float | None,
    *,
    reserve_sec: float = 0.0,
) -> float:
    if deadline is None:
        return requested
    return max(0.001, min(requested, deadline - time.monotonic() - reserve_sec))


def terminal_verifier_reserve_sec(total_timeout_sec: float | None) -> float:
    if total_timeout_sec is None:
        return 0.0
    configured = float(os.environ.get("TERMINAL_BENCH_VERIFIER_RESERVE_S", "120"))
    if configured < 0:
        raise ValueError("TERMINAL_BENCH_VERIFIER_RESERVE_S must be non-negative")
    return min(configured, total_timeout_sec / 2)


def product_working_directory(benchmark_id: str) -> str:
    if benchmark_id in STATIC_BENCHMARKS:
        # The product container mounts mode_dir at /job; the static bridge copied the
        # prepared case into this shared subtree. Starting here keeps relative paths inside
        # the case instead of teaching the model that its workspace is the unrelated /tmp.
        return "/job/benchmark_server/case_workspace/workspace"
    return "/tmp"


@dataclass
class ToolServerHandle:
    process: subprocess.Popen[str]
    log: Any
    url: str
    task_container: str | None = None
    context: dict[str, Any] | None = None
    container_ip: str | None = None


# The benchmark tool server is always reached over loopback. An operator shell that
# exports http_proxy for image builds must not have that proxy swallow this control
# channel, so these requests are issued with proxy handling explicitly disabled.
_DIRECT_OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def container_reachable_url(url: str) -> str:
    parsed = urlsplit(url)
    if parsed.hostname not in {"localhost", "127.0.0.1", "::1"}:
        return url
    port = f":{parsed.port}" if parsed.port is not None else ""
    return urlunsplit((parsed.scheme, f"host.docker.internal{port}", parsed.path, parsed.query, parsed.fragment))


def docker_host_alias(platform: Any) -> str:
    """Return a host alias that works for both rootful and rootless Docker.

    Docker's ``host-gateway`` special value resolves to the bridge gateway. That is the
    host under rootful Docker, but under RootlessKit it resolves to the rootless daemon's
    inner bridge (172.17.0.1 on the experiment server), where no host process is listening.
    RootlessKit exposes the real host loopback through 10.0.2.2 when host-loopback access is
    enabled. A preflight below verifies that the daemon actually permits this before any
    model request is made.
    """
    override = os.environ.get(HOST_GATEWAY_OVERRIDE_ENV, "").strip()
    if override:
        if any(character.isspace() for character in override):
            raise RuntimeError(
                f"{HOST_GATEWAY_OVERRIDE_ENV} must be one Docker --add-host address"
            )
        return f"host.docker.internal:{override}"

    completed = subprocess.run(
        platform._docker("info", "--format", "{{json .SecurityOptions}}"),
        text=True,
        capture_output=True,
        check=False,
        timeout=15,
    )
    if completed.returncode != 0:
        detail = (completed.stderr or completed.stdout).strip()
        raise RuntimeError(f"Unable to inspect Docker security options: {detail}")
    try:
        security_options = json.loads(completed.stdout)
    except json.JSONDecodeError as exc:
        raise RuntimeError(
            f"Docker returned invalid security options: {completed.stdout.strip()}"
        ) from exc
    if not isinstance(security_options, list):
        raise RuntimeError("Docker security options were not a JSON list")
    rootless = any("rootless" in str(option).lower() for option in security_options)
    gateway = ROOTLESS_HOST_GATEWAY if rootless else "host-gateway"
    return f"host.docker.internal:{gateway}"


class ToolBridgeInfrastructureError(RuntimeError):
    pass


_TOOL_ENDPOINT_PROBE = r"""
const endpoint = process.argv[1].replace(/\/$/, "") + "/manifest";
const controller = new AbortController();
const timer = setTimeout(() => controller.abort(), 10000);
fetch(endpoint, {signal: controller.signal})
  .then(async response => {
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body = await response.json();
    if (!Array.isArray(body.tools)) throw new Error("manifest has no tools array");
    console.log(`ok tools=${body.tools.length}`);
  })
  .catch(error => {
    console.error(error.cause?.code || error.name || error.message);
    process.exitCode = 1;
  })
  .finally(() => clearTimeout(timer));
"""


def preflight_tool_endpoint(
    *,
    platform: Any,
    image: str,
    endpoint: str,
    host_alias: str,
    direct_hosts: tuple[str, ...],
    log_path: Path,
) -> None:
    """Prove that the exact agent image can reach the tool bridge before spending tokens."""
    container = f"harnesseval-preflight-{os.getpid()}-{uuid.uuid4().hex[:8]}"
    command = platform._docker(
        "run",
        "--rm",
        "--init",
        "--name",
        container,
        "--network",
        "bridge",
        "--add-host",
        host_alias,
        "--read-only",
        "--tmpfs",
        "/tmp:rw,exec,nosuid,size=64m",
    )
    command.extend(egress_flags(platform, "bridge", direct_hosts))
    command.extend(
        ["--entrypoint", "node", image, "-e", _TOOL_ENDPOINT_PROBE, endpoint]
    )
    try:
        completed = subprocess.run(
            command,
            text=True,
            capture_output=True,
            check=False,
            timeout=30,
        )
    except subprocess.TimeoutExpired as exc:
        subprocess.run(
            platform._docker("rm", "-f", container),
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            check=False,
        )
        log_path.write_text(
            f"timeout after 30s\nstdout:\n{exc.stdout or ''}\nstderr:\n{exc.stderr or ''}\n",
            encoding="utf-8",
        )
        raise ToolBridgeInfrastructureError(
            f"Agent-container tool endpoint preflight timed out: {endpoint}"
        ) from exc

    log_path.write_text(
        f"returncode={completed.returncode}\nstdout:\n{completed.stdout}"
        f"\nstderr:\n{completed.stderr}\n",
        encoding="utf-8",
    )
    if completed.returncode != 0:
        detail = (completed.stderr or completed.stdout).strip()
        raise ToolBridgeInfrastructureError(
            "Agent container cannot reach the benchmark tool endpoint "
            f"{endpoint} via {host_alias}: {detail or 'probe failed'}"
        )


def tool_bridge_failure(benchmark_id: str, bridge_result: dict[str, Any]) -> str | None:
    """Identify the silent bridge failure that previously became a normal zero score."""
    if benchmark_id not in TASK_BENCHMARKS:
        return None
    tool_calls = bridge_result.get("tool_calls")
    environment_calls = bridge_result.get("environment_tool_calls")
    if isinstance(tool_calls, int) and tool_calls > 0 and environment_calls == 0:
        return (
            f"Agent emitted {tool_calls} committed tool call(s), but the task environment "
            "executed none"
        )
    return None


def atomic_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    os.replace(temporary, path)


def next_attempt_dir(root: Path) -> Path:
    """Allocate an immutable numbered attempt directory without deleting prior evidence."""

    attempts = root / "attempts"
    attempts.mkdir(parents=True, exist_ok=True)
    numbers = [
        int(path.name)
        for path in attempts.iterdir()
        if path.is_dir() and path.name.isdigit()
    ]
    attempt = attempts / f"{(max(numbers, default=0) + 1):04d}"
    attempt.mkdir()
    return attempt


def git_worktree_identity(root: Path, prefix: str) -> dict[str, Any]:
    revision = subprocess.run(
        ["git", "-C", str(root), "rev-parse", "HEAD"],
        text=True,
        capture_output=True,
        check=False,
    )
    status = subprocess.run(
        ["git", "-C", str(root), "status", "--porcelain", "--untracked-files=all"],
        text=True,
        capture_output=True,
        check=False,
    )
    listed = subprocess.run(
        ["git", "-C", str(root), "ls-files", "-co", "--exclude-standard", "-z"],
        capture_output=True,
        check=False,
    )
    digest = hashlib.sha256()
    if listed.returncode == 0:
        for raw_relative in sorted(item for item in listed.stdout.split(b"\0") if item):
            path = root / raw_relative.decode("utf-8", errors="surrogateescape")
            if path.is_file():
                digest.update(raw_relative)
                digest.update(b"\0")
                digest.update(path.read_bytes())
                digest.update(b"\0")
    return {
        f"{prefix}_git_sha": revision.stdout.strip() if revision.returncode == 0 else None,
        f"{prefix}_git_dirty": bool(status.stdout.strip()) if status.returncode == 0 else None,
        f"{prefix}_worktree_sha256": digest.hexdigest() if listed.returncode == 0 else None,
    }


def product_implementation_identity(platform: Any, image: str) -> dict[str, Any]:
    perseus_root = Path(__file__).resolve().parents[2]
    try:
        inspected = subprocess.run(
            ["docker", "image", "inspect", image],
            text=True,
            capture_output=True,
            check=False,
        )
    except OSError:
        inspected = subprocess.CompletedProcess([], 1, "", "docker unavailable")
    image_identity = None
    if inspected.returncode == 0:
        value = json.loads(inspected.stdout)[0]
        image_identity = {
            "name": image,
            "id": value.get("Id"),
            "repo_digests": sorted(value.get("RepoDigests") or []),
        }
    return {
        **platform.implementation_identity(),
        **git_worktree_identity(perseus_root, "perseus"),
        "product_image": image_identity,
    }


def request_json(
    url: str,
    payload: dict[str, Any] | None = None,
    *,
    timeout: float | None = 10,
) -> dict[str, Any]:
    data = None if payload is None else json.dumps(payload, ensure_ascii=False).encode("utf-8")
    request = urllib.request.Request(
        url,
        data=data,
        headers={"Content-Type": "application/json"},
        method="GET" if payload is None else "POST",
    )
    try:
        with _DIRECT_OPENER.open(request, timeout=timeout) as response:
            value = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"HTTP {exc.code} from {url}: {body}") from exc
    if not isinstance(value, dict):
        raise TypeError(f"Expected JSON object from {url}")
    return value


def wait_manifest(url: str, process: subprocess.Popen[str], log_path: Path) -> dict[str, Any]:
    while process.poll() is None:
        try:
            return request_json(f"{url}/manifest")
        except (OSError, urllib.error.URLError, json.JSONDecodeError, RuntimeError):
            try:
                status = request_json(f"{url}/status")
            except (OSError, urllib.error.URLError, json.JSONDecodeError, RuntimeError):
                time.sleep(0.1)
                continue
            if status.get("state") == "failed":
                raise RuntimeError(f"Benchmark native episode failed before manifest: {status.get('error')}")
            time.sleep(0.1)
    details = log_path.read_text(encoding="utf-8", errors="replace") if log_path.is_file() else ""
    raise RuntimeError(f"Benchmark tool server exited before becoming ready: {details}")


def jsonl(path: Path) -> tuple[list[dict[str, Any]], int]:
    rows: list[dict[str, Any]] = []
    malformed = 0
    if not path.is_file():
        return rows, malformed
    with path.open(encoding="utf-8", errors="replace") as source:
        for line in source:
            if not line.strip():
                continue
            try:
                value = json.loads(line)
            except json.JSONDecodeError:
                malformed += 1
                continue
            if isinstance(value, dict):
                rows.append(value)
            else:
                malformed += 1
    return rows, malformed


def record_json_stream(
    command: list[str],
    events_path: Path,
    stderr_path: Path,
    *,
    timeout_sec: float | None = None,
    container_name: str | None = None,
) -> int:
    """Record Pi events without duplicating every accumulated stream prefix."""
    with (
        events_path.open("w", encoding="utf-8") as events,
        stderr_path.open("w", encoding="utf-8") as stderr,
    ):
        process = subprocess.Popen(
            command,
            stdout=subprocess.PIPE,
            stderr=stderr,
            text=True,
            bufsize=1,
        )
        assert process.stdout is not None

        def consume_line(line: str) -> None:
            try:
                event = json.loads(line)
            except json.JSONDecodeError:
                events.write(line)
                events.flush()
                return
            if isinstance(event, dict) and event.get("type") == "message_update":
                update = event.get("assistantMessageEvent")
                if isinstance(update, dict):
                    event = {
                        "type": "message_update",
                        "assistantMessageEvent": {
                            key: value
                            for key, value in update.items()
                            if key != "partial"
                        },
                    }
            events.write(
                json.dumps(event, ensure_ascii=False, separators=(",", ":")) + "\n"
            )
            events.flush()

        if timeout_sec is None:
            # Preserve the established streaming path for non-Terminal benchmarks. Only a
            # task with an official phase deadline needs the waiter thread below.
            for line in process.stdout:
                consume_line(line)
            return process.wait()

        def consume() -> None:
            assert process.stdout is not None
            for line in process.stdout:
                consume_line(line)

        reader = threading.Thread(
            target=consume, name="perseus-json-reader", daemon=True
        )
        reader.start()
        try:
            returncode = process.wait(timeout=timeout_sec)
        except subprocess.TimeoutExpired:
            if container_name:
                try:
                    subprocess.run(
                        ["docker", "kill", container_name],
                        text=True,
                        capture_output=True,
                        check=False,
                        timeout=15,
                    )
                except subprocess.TimeoutExpired:
                    pass
            if process.poll() is None:
                process.terminate()
                try:
                    process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait()
            stderr.write(f"\nAgent phase timed out after {timeout_sec:.1f}s\n")
            stderr.flush()
            returncode = 124
        finally:
            reader.join(timeout=10)
        return returncode


def assistant_text(events: list[dict[str, Any]]) -> str:
    answers: list[str] = []
    for event in events:
        if event.get("type") != "message_end":
            continue
        message = event.get("message")
        if not isinstance(message, dict) or message.get("role") != "assistant":
            continue
        content = message.get("content")
        if not isinstance(content, list):
            continue
        parts = [
            item["text"]
            for item in content
            if isinstance(item, dict) and item.get("type") == "text" and isinstance(item.get("text"), str)
        ]
        if parts:
            answers.append("\n".join(parts))
    return answers[-1] if answers else ""


def scorer_answer(benchmark_id: str, answer: str) -> str:
    if benchmark_id != "gaia":
        return answer
    lines = [line.strip() for line in answer.splitlines() if line.strip()]
    if not lines:
        return ""
    candidate = lines[-1]
    for prefix in ("Final answer:", "Final Answer:", "Answer:"):
        if candidate.startswith(prefix):
            candidate = candidate[len(prefix):].strip()
            break
    return candidate.strip("`* ")


def actor_metrics(events: list[dict[str, Any]]) -> dict[str, Any]:
    calls: list[dict[str, Any]] = []
    rounds = 0
    usage = {"input": 0, "output": 0, "cache_read": 0, "cache_write": 0, "total": 0}
    last_stop_reason = None
    last_error = None
    for event in events:
        if event.get("type") != "message_end":
            continue
        message = event.get("message")
        if not isinstance(message, dict) or message.get("role") != "assistant":
            continue
        rounds += 1
        last_stop_reason = message.get("stopReason")
        last_error = message.get("errorMessage")
        for item in message.get("content") or []:
            if isinstance(item, dict) and item.get("type") == "toolCall":
                calls.append(
                    {
                        "id": str(item.get("id") or ""),
                        "name": str(item.get("name") or ""),
                        "arguments": item.get("arguments") if isinstance(item.get("arguments"), dict) else {},
                    }
                )
        raw_usage = message.get("usage") or {}
        for source, target in (
            ("input", "input"),
            ("output", "output"),
            ("cacheRead", "cache_read"),
            ("cacheWrite", "cache_write"),
            ("totalTokens", "total"),
        ):
            value = raw_usage.get(source)
            if isinstance(value, (int, float)):
                usage[target] += value
    return {
        "rounds": rounds,
        "committed_calls": calls,
        "usage": usage,
        "last_stop_reason": last_stop_reason,
        "last_error": last_error,
    }


def first_assistant_tool_calls(events: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Return exactly the native tool-call batch BFCL evaluates.

    Official single-turn BFCL performs one provider request and scores that assistant
    response directly. Keep this extraction independent of the extension's termination
    hint so a future agent-loop regression cannot silently accumulate retry calls again.
    """
    for event in events:
        if event.get("type") != "message_end":
            continue
        message = event.get("message")
        if not isinstance(message, dict) or message.get("role") != "assistant":
            continue
        return [
            {
                "id": str(item.get("id") or ""),
                "name": str(item.get("name") or ""),
                "arguments": (
                    item.get("arguments")
                    if isinstance(item.get("arguments"), dict)
                    else {}
                ),
            }
            for item in message.get("content") or []
            if isinstance(item, dict) and item.get("type") == "toolCall"
        ]
    return []


def mechanism_counts(trace: list[dict[str, Any]]) -> dict[str, int]:
    counts: dict[str, int] = {}
    for row in trace:
        name = str(row.get("event") or "unknown")
        counts[name] = counts.get(name, 0) + 1
    return counts


def score_result(benchmark_id: str, prepared: Path | None, result: dict[str, Any]) -> dict[str, Any]:
    if benchmark_id in NATIVE_EPISODE_BENCHMARKS | TASK_BENCHMARKS:
        if result.get("failure_kind") == "tool_bridge_infrastructure":
            return {
                "authority": f"{benchmark_id}_native_evaluator",
                "status": "infra_failed",
                "score": None,
                "reward": None,
                "termination_reason": "tool_bridge_infrastructure",
            }
        bridge = result.get("native") or {}
        return {
            "authority": f"{benchmark_id}_native_evaluator",
            "status": bridge.get("native_score_status", "not_requested"),
            "score": bridge.get("native_score"),
            "reward": bridge.get("native_reward"),
            "termination_reason": bridge.get("termination_reason"),
        }
    if prepared is None:
        raise ValueError(f"Prepared authority is required for {benchmark_id}")
    gold_path = prepared / "authority" / "gold.json"
    gold = json.loads(gold_path.read_text(encoding="utf-8"))
    if benchmark_id == "gaia":
        from benchmark_platform.scorers.gaia import question_score

        target = str(gold.get("answer") or "")
        prediction = str(result.get("scorer_answer") or result.get("answer") or "")
        return {
            "authority": "gaia_public_answer_scorer",
            "status": "completed",
            "score": 1.0 if question_score(prediction, target) else 0.0,
            "scorer_input": prediction,
        }
    if benchmark_id == "bfcl" and str(gold.get("id") or "").startswith("irrelevance_"):
        return {
            "authority": "bfcl_irrelevance_no_function_call",
            "status": "completed",
            "score": 1.0 if not result["actor"]["committed_calls"] else 0.0,
        }
    if benchmark_id == "trajectory-bench":
        from benchmark_platform.bridges.adapters import _tool_name

        target = str(gold.get("final_answer") or "").strip()
        public_case = json.loads((prepared / "input" / "case.json").read_text(encoding="utf-8"))
        normalized_to_public = {
            _tool_name(str(item.get("tool name") or "")): str(item.get("tool name") or "")
            for item in public_case.get("tools") or []
        }
        expected_tools = {
            str(item.get("tool name") or "")
            for item in gold.get("tool_list") or []
        }
        observed_tools = {
            normalized_to_public.get(item["name"], item["name"])
            for item in result["actor"]["committed_calls"]
        }
        return {
            "authority": "traject_official_tool_name_metrics_and_answer_diagnostic",
            "status": "completed",
            "answer_exact": bool(target) and result.get("answer", "").strip() == target,
            "trajectory_exact": expected_tools == observed_tools,
            "tool_inclusion": len(expected_tools & observed_tools) / len(expected_tools) if expected_tools else None,
        }
    return {
        "authority": "gdpval_external_rubric" if benchmark_id == "gdpval" else "benchmark_native_scorer",
        "status": "not_run",
    }


def docker_host_port(container_name: str, port: int, process: subprocess.Popen[str]) -> int:
    while process.poll() is None:
        completed = subprocess.run(
            ["docker", "port", container_name, f"{port}/tcp"],
            text=True,
            capture_output=True,
            check=False,
        )
        if completed.returncode == 0 and completed.stdout.strip():
            return int(completed.stdout.strip().rsplit(":", 1)[1])
        time.sleep(0.1)
    raise RuntimeError("Benchmark tool server exited before Docker published its port")


def egress_flags(platform: Any, network: str, direct_hosts: tuple[str, ...] = ()) -> list[str]:
    """Docker may inject a client-wide proxy into every container. Any host the product
    must reach directly has to be named in NO_PROXY, and proxy bypass lists match host
    names, not CIDR ranges, so the concrete address is appended rather than a subnet."""
    flags = list(platform._egress_env(network))
    if not direct_hosts:
        return flags
    extra = ",".join(direct_hosts)
    return [
        f"{item},{extra}" if item.startswith(("NO_PROXY=", "no_proxy=")) else item
        for item in flags
    ]


def container_address(platform: Any, container_name: str) -> str | None:
    completed = subprocess.run(
        platform._docker(
            "inspect", "-f",
            "{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}",
            container_name,
        ),
        text=True, capture_output=True, check=False,
    )
    return completed.stdout.strip() or None


# Rootless Docker picks the published host port and RootlessKit binds it a moment later, so
# two concurrent launches can be handed the same one: "RootlessKit PortManager.AddPort():
# listen tcp4 127.0.0.1:32936: bind: address already in use", which killed 2 of 30 tau2 cases
# before the model ran at all. The race cannot be designed away from here -- picking the port
# ourselves loses the same way -- so relaunch on that exact signature with a fresh name.
PORT_BIND_RACE = "bind: address already in use"
PORT_BIND_ATTEMPTS = 3


def start_tool_server(
    *, platform: Any, benchmark: Any, prepared: Path | None, mode_dir: Path, case_id: str
) -> ToolServerHandle:
    for attempt in range(PORT_BIND_ATTEMPTS):
        try:
            return _start_tool_server(
                platform=platform,
                benchmark=benchmark,
                prepared=prepared,
                mode_dir=mode_dir,
                case_id=case_id,
            )
        except RuntimeError:
            # Each attempt truncates the log, so this reads the attempt that just failed. Any
            # other RuntimeError -- a server that came up but never published its manifest --
            # is not a race and must surface unchanged.
            log_path = mode_dir / "benchmark_server" / "server.log"
            raced = log_path.exists() and PORT_BIND_RACE in log_path.read_text(
                encoding="utf-8", errors="replace"
            )
            if attempt + 1 >= PORT_BIND_ATTEMPTS or not raced:
                raise
    raise AssertionError("unreachable")


def _start_tool_server(
    *, platform: Any, benchmark: Any, prepared: Path | None, mode_dir: Path, case_id: str
) -> ToolServerHandle:
    server_dir = mode_dir / "benchmark_server"
    server_dir.mkdir(parents=True, exist_ok=True)
    log_path = server_dir / "server.log"
    container_name = f"harnesseval-product-{os.getpid()}-{uuid.uuid4().hex[:8]}"
    command = [
        "docker", "run", "--rm", "--init", "--name", container_name,
        "--network", "bridge", "-p", "127.0.0.1::8765",
        "--read-only", "--tmpfs", "/tmp:rw,exec,nosuid,size=1g",
        "-e", "HOME=/tmp", "-e", "PYTHONUNBUFFERED=1",
        *egress_flags(platform, "bridge"),
        "-v", f"{platform.root}:/opt/harnesseval:ro",
        "-v", f"{server_dir}:/job:rw",
        "-w", "/opt/harnesseval",
    ]
    container_api_url = container_reachable_url(os.environ.get("API_URL", ""))
    if container_api_url.startswith(("http://host.docker.internal", "https://host.docker.internal")):
        command.extend(["--add-host", docker_host_alias(platform)])
    if prepared is not None:
        command.extend(["-v", f"{prepared / 'input'}:/bridge:ro"])
    for name in ("API_URL", "TOOLBENCH_KEY", "TRAJECT_TOOL_MODE"):
        if name in os.environ:
            command.extend(["-e", f"API_URL={container_api_url}" if name == "API_URL" else name])
    if benchmark.id in NATIVE_EPISODE_BENCHMARKS:
        module = (
            "benchmark_platform.bridges.vita_product_server"
            if benchmark.id == "vitabench"
            else "benchmark_platform.bridges.tau_product_server"
        )
        policy = {"native_evaluate": True}
        command.extend(
            [
                "-e", "HARNESS_API_BASE", "-e", "HARNESS_API_TYPE",
                "-e", "HARNESS_API_KEY", "-e", "HARNESS_MODEL",
                "-e", "HARNESS_MAX_OUTPUT_TOKENS",
                benchmark.adapter["image"],
                "python", "-m", module,
                "--case", case_id,
                "--policy", json.dumps(policy, sort_keys=True),
            ]
        )
    else:
        command.extend(
            [
                benchmark.adapter["image"],
                "python", "-m", "benchmark_platform.bridges.product_server",
                "--benchmark", benchmark.id, "--case", case_id,
            ]
        )
    log = log_path.open("w", encoding="utf-8")
    server_env = dict(os.environ)
    server_env.setdefault("HARNESS_API_BASE", os.environ.get("PERSEUS_ACTOR_BASE_URL", ""))
    server_env.setdefault("HARNESS_API_KEY", os.environ.get("PERSEUS_ACTOR_API_KEY", ""))
    server_env.setdefault("HARNESS_MODEL", os.environ.get("PERSEUS_ACTOR_MODEL", ""))
    process = subprocess.Popen(command, stdout=log, stderr=subprocess.STDOUT, text=True, env=server_env)
    try:
        port = docker_host_port(container_name, 8765, process)
    except Exception:
        process.terminate()
        process.wait()
        log.close()
        raise
    url = f"http://127.0.0.1:{port}"
    wait_manifest(url, process, log_path)
    return ToolServerHandle(
        process, log, url, container_ip=container_address(platform, container_name)
    )


def swe_controller_command(
    platform: Any, benchmark: Any, job: Path, action: str, case_id: str
) -> list[str]:
    command = platform._docker("run", "--rm", "--init", "--network", "bridge")
    command.extend(egress_flags(platform, "bridge"))
    command.extend(["-v", f"{platform._docker_socket()}:/var/run/docker.sock:rw"])
    command.extend(["-e", "DOCKER_HOST=unix:///var/run/docker.sock"])
    if os.environ.get("HF_TOKEN"):
        command.extend(["-e", "HF_TOKEN"])
    command.extend(
        [
            "-v",
            f"{job.resolve()}:/job:rw",
            benchmark.adapter["image"],
            "python",
            "/opt/platform/swebench_bridge.py",
            action,
            "--case",
            case_id,
        ]
    )
    return command


def _record_command(
    command: list[str], log_path: Path
) -> subprocess.CompletedProcess[str]:
    completed = subprocess.run(command, text=True, capture_output=True, check=False)
    with log_path.open("a", encoding="utf-8") as log:
        log.write(completed.stdout)
        log.write(completed.stderr)
    return completed


def start_task_tool_server(
    *, platform: Any, benchmark: Any, mode_dir: Path, case_id: str
) -> ToolServerHandle:
    server_dir = mode_dir / "benchmark_server"
    server_dir.mkdir(parents=True, exist_ok=True)
    setup_log = server_dir / "setup.log"
    container = f"harnesseval-task-{os.getpid()}-{uuid.uuid4().hex[:8]}"
    context: dict[str, Any] = {"server_dir": server_dir}
    if benchmark.id == "terminal-bench-2":
        task_dir, task_metadata = platform._terminal_metadata(benchmark, case_id)
        settings = platform._terminal_task_settings(task_metadata)
        if settings.verifier_mode != "shared":
            raise RuntimeError(
                "Terminal-Bench product runner supports Harbor shared verifiers only"
            )
        prompt = platform._terminal_agent_prompt(
            (task_dir / "instruction.md").read_text(encoding="utf-8")
        )
        # Terminal-Bench tasks are machine-state tasks, not /app-only file tasks. Nginx,
        # apt/R installs and service configuration all live elsewhere in the same container.
        workspace_root = "/"
        task_image = (
            task_metadata.get("environment", {}).get("docker_image")
            or benchmark.adapter["image"]
        )
        create = platform._terminal_create_command(
            benchmark=benchmark,
            metadata=task_metadata,
            image=task_image,
            container=container,
            labels=["orch.benchmark-platform=1", "orch.product-bridge=1"],
        )
        context.update(
            {
                "task_dir": task_dir,
                "task_metadata": task_metadata,
                "settings": settings,
                "workspace_root": workspace_root,
                "task_image": task_image,
            }
        )
    else:
        prepare = swe_controller_command(
            platform, benchmark, server_dir, "prepare", case_id
        )
        completed = _record_command(prepare, setup_log)
        public_path = server_dir / "public_case.json"
        if completed.returncode != 0 or not public_path.is_file():
            raise RuntimeError(
                "SWE-bench public case preparation failed; see setup.log"
            )
        public_case = json.loads(public_path.read_text(encoding="utf-8"))
        if public_case.get("hidden_fields_exposed_to_agent") != []:
            raise RuntimeError("SWE-bench preparation exposed hidden authority fields")
        prompt = str(public_case["prompt"])
        workspace_root = str(public_case["workspace_root"])
        create = platform._docker("create", "--init", "--name", container)
        create.extend(
            ["--label", "orch.benchmark-platform=1", "--label", "orch.product-bridge=1"]
        )
        create.extend(["--platform", public_case["task_image"]["platform"]])
        create.extend(["--network", "bridge", *egress_flags(platform, "bridge")])
        create.extend(
            [
                "-w",
                workspace_root,
                public_case["task_image"]["name"],
                "sh",
                "-lc",
                "while :; do sleep 3600; done",
            ]
        )
        context.update({"public_case": public_case, "workspace_root": workspace_root})
    created = _record_command(create, setup_log)
    if created.returncode != 0:
        raise RuntimeError("Task container creation failed; see setup.log")
    started = _record_command(platform._docker("start", container), setup_log)
    if started.returncode != 0:
        subprocess.run(
            platform._docker("rm", "-f", container), capture_output=True, check=False
        )
        raise RuntimeError("Task container start failed; see setup.log")
    if benchmark.id == "terminal-bench-2":
        default_workdir = platform._terminal_container_workdir(container)
        context["default_workdir"] = default_workdir
        agent_timeout_sec = float(context["settings"].agent_timeout_sec)
    else:
        default_workdir = workspace_root
        agent_timeout_sec = 3600.0
    prompt_path = server_dir / "prompt.txt"
    prompt_path.write_text(prompt, encoding="utf-8")
    endpoint_path = server_dir / "task_product_server.json"
    log_path = server_dir / "server.log"
    log = log_path.open("w", encoding="utf-8")
    environment = dict(os.environ)
    python_path = environment.get("PYTHONPATH")
    environment["PYTHONPATH"] = str(platform.root) + (
        os.pathsep + python_path if python_path else ""
    )
    command = [
        sys.executable,
        "-m",
        "benchmark_platform.bridges.task_product_server",
        "--benchmark",
        benchmark.id,
        "--case",
        case_id,
        "--prompt-file",
        str(prompt_path),
        "--container",
        container,
        "--workspace-root",
        workspace_root,
        "--default-workdir",
        default_workdir,
        "--agent-timeout-sec",
        str(agent_timeout_sec),
        "--job",
        str(server_dir),
    ]
    process = subprocess.Popen(
        command,
        cwd=platform.root,
        env=environment,
        stdout=log,
        stderr=subprocess.STDOUT,
        text=True,
    )
    try:
        while process.poll() is None and not endpoint_path.is_file():
            time.sleep(0.1)
        if not endpoint_path.is_file():
            raise RuntimeError(
                "Task product server exited before publishing its endpoint"
            )
        endpoint = json.loads(endpoint_path.read_text(encoding="utf-8"))
        url = f"http://{endpoint['host']}:{endpoint['port']}"
        wait_manifest(url, process, log_path)
        return ToolServerHandle(process, log, url, container, context)
    except Exception:
        if process.poll() is None:
            process.terminate()
            process.wait()
        log.close()
        subprocess.run(
            platform._docker("rm", "-f", container), capture_output=True, check=False
        )
        raise


def finalize_task(
    *,
    platform: Any,
    benchmark: Any,
    case_id: str,
    mode_dir: Path,
    handle: ToolServerHandle,
    arm_deadline: float | None = None,
) -> dict[str, Any]:
    assert handle.task_container is not None
    context = handle.context or {}
    server_dir = Path(context["server_dir"])
    evaluator_log = server_dir / "evaluator.log"
    if benchmark.id == "terminal-bench-2":
        logs = mode_dir / "verifier"
        logs.mkdir()
        task_dir = Path(context["task_dir"])
        task_metadata = dict(context["task_metadata"])
        settings = context["settings"]
        with evaluator_log.open("a", encoding="utf-8") as log:
            verifier_result = platform._terminal_run_shared_verifier(
                container=handle.task_container,
                task_dir=task_dir,
                logs_dir=logs,
                timeout_sec=bounded_phase_timeout(
                    float(settings.verifier_timeout_sec), arm_deadline
                ),
                log=log,
                prefix="[terminal-bench-2:verifier] ",
                verifier_env={
                    str(name): str(value)
                    for name, value in (
                        task_metadata.get("verifier", {}).get("env") or {}
                    ).items()
                },
                verifier_user=task_metadata.get("verifier", {}).get("user"),
            )
        workspace = mode_dir / "workspace"
        copied = platform._terminal_copy_workdir(
            container=handle.task_container,
            workdir=str(context["default_workdir"]),
            destination=workspace,
        )
        if copied.returncode != 0:
            with evaluator_log.open("a", encoding="utf-8") as log:
                log.write(
                    f"Unable to copy Terminal-Bench workdir artifact: "
                    f"{copied.stderr or copied.stdout}\n"
                )
        scores = verifier_result.get("scores") or {}
        reward = scores.get("reward")
        return {
            "native_score_status": verifier_result["status"],
            "native_score": float(reward) if isinstance(reward, (int, float)) else None,
            "native_reward": float(reward)
            if isinstance(reward, (int, float))
            else None,
            "native_scores": scores,
            "evaluator_returncode": verifier_result["returncode"],
            "verifier_attempts": verifier_result["attempts"],
            "verifier_error": verifier_result.get("error"),
            "termination_reason": verifier_result["termination_reason"],
        }
    workspace_root = str(context["workspace_root"])
    staged = _record_command(
        platform._docker(
            "exec", "-w", workspace_root, handle.task_container, "git", "add", "-A"
        ),
        evaluator_log,
    )
    if staged.returncode != 0:
        raise RuntimeError("Unable to stage SWE-bench workspace changes")
    patch_result = _record_command(
        platform._docker(
            "exec",
            "-w",
            workspace_root,
            handle.task_container,
            "git",
            "-c",
            "core.fileMode=false",
            "diff",
            "--cached",
            "--binary",
        ),
        evaluator_log,
    )
    if patch_result.returncode != 0:
        raise RuntimeError("Unable to extract SWE-bench model patch")
    (server_dir / "model.patch").write_text(patch_result.stdout, encoding="utf-8")
    evaluate = swe_controller_command(
        platform, benchmark, server_dir, "evaluate", case_id
    )
    checked = _record_command(evaluate, evaluator_log)
    payload_path = server_dir / "payload.json"
    payload = (
        json.loads(payload_path.read_text(encoding="utf-8"))
        if payload_path.is_file()
        else {}
    )
    resolved = payload.get("scores", {}).get("resolved")
    return {
        "native_score_status": payload.get("native_score_status", "failed"),
        "native_score": resolved,
        "native_reward": resolved,
        "evaluator_returncode": checked.returncode,
        "termination_reason": "official_swebench_evaluator",
        "official_evaluation": payload,
    }


def run_mode(
    *,
    platform: Any,
    benchmark: Any,
    prepared: Path | None,
    run_dir: Path,
    case_id: str,
    image: str,
    extension: Path,
    enabled: bool,
) -> dict[str, Any]:
    total_arm_timeout_sec = arm_timeout_sec()
    arm_deadline = (
        time.monotonic() + total_arm_timeout_sec
        if total_arm_timeout_sec is not None
        else None
    )
    verifier_reserve_sec = terminal_verifier_reserve_sec(total_arm_timeout_sec)
    mode = "perseus" if enabled else "actor-only"
    mode_root = (
        run_dir / benchmark.id / case_id.replace("/", "_").replace(":", "_") / mode
    )
    mode_root.mkdir(parents=True, exist_ok=True)
    mode_dir = next_attempt_dir(mode_root)
    handle: ToolServerHandle | None = None
    system_prompt_source = (
        Path(__file__).resolve().parents[2]
        / "harness/packages/coding-agent/src/core/system-prompt.ts"
    )
    if not system_prompt_source.is_file():
        raise FileNotFoundError(
            f"PERSEUS system prompt source not found: {system_prompt_source}"
        )
    try:
        host_alias = docker_host_alias(platform)
        handle = (
            start_task_tool_server(
                platform=platform,
                benchmark=benchmark,
                mode_dir=mode_dir,
                case_id=case_id,
            )
            if benchmark.id in TASK_BENCHMARKS
            else start_tool_server(
                platform=platform,
                benchmark=benchmark,
                prepared=prepared,
                mode_dir=mode_dir,
                case_id=case_id,
            )
        )
        server_url = handle.url
        # Product-server containers are reached directly on the bridge. Task-product
        # servers are host processes and are reached through the rootful/rootless-aware
        # alias above while remaining bound to host loopback.
        direct_hosts = (
            (handle.container_ip,) if handle.container_ip else ("host.docker.internal",)
        )
        product_endpoint = (
            f"http://{handle.container_ip}:8765"
            if handle.container_ip
            else server_url.replace("127.0.0.1", "host.docker.internal")
        )
        events_path = mode_dir / "perseus-events.jsonl"
        stderr_path = mode_dir / "perseus-stderr.log"
        trace_path = mode_dir / "perseus-trace.jsonl"
        turn_event_paths: list[Path] = []
        turn_stderr_paths: list[Path] = []
        turn_trace_paths: list[Path] = []
        returncodes: list[int] = []
        agent_seconds = 0.0
        bridge_result: dict[str, Any] | None = None
        lifecycle = ""
        tools: list[str] = []
        safe_tools: list[str] = []
        turn = 0
        agent_timeout_sec = (
            bounded_phase_timeout(
                float((handle.context or {})["settings"].agent_timeout_sec),
                arm_deadline,
                reserve_sec=verifier_reserve_sec,
            )
            if benchmark.id == "terminal-bench-2"
            else None
        )
        agent_deadline = (
            time.monotonic() + agent_timeout_sec
            if agent_timeout_sec is not None
            else None
        )
        agent_timed_out = False

        if handle.container_ip is None:
            manifest = request_json(f"{server_url}/manifest")
            tools = [str(item["name"]) for item in manifest["tools"]]
            safe_tools = [str(item) for item in manifest.get("safe_tools", [])]
            lifecycle = str((manifest.get("metadata") or {}).get("lifecycle") or "")
            preflight_log = mode_dir / "benchmark_server" / "connectivity_preflight.log"
            try:
                preflight_tool_endpoint(
                    platform=platform,
                    image=image,
                    endpoint=product_endpoint,
                    host_alias=host_alias,
                    direct_hosts=direct_hosts,
                    log_path=preflight_log,
                )
            except ToolBridgeInfrastructureError as exc:
                events_path.write_text("", encoding="utf-8")
                stderr_path.write_text(str(exc) + "\n", encoding="utf-8")
                trace_path.write_text("", encoding="utf-8")
                result = {
                    "schema_version": 1,
                    "status": "failed",
                    "failure_kind": "tool_bridge_infrastructure",
                    "error": str(exc),
                    "benchmark": benchmark.id,
                    "case_id": case_id,
                    "profile": mode,
                    "perseus_enabled": enabled,
                    "agent_execution_seconds": 0.0,
                    "returncode": 1,
                    "answer": "",
                    "scorer_answer": "",
                    "answer_produced": False,
                    "runtime_warning": None,
                    "actor": {
                        "rounds": 0,
                        "committed_calls": [],
                        "usage": {
                            "input": 0,
                            "output": 0,
                            "cache_read": 0,
                            "cache_write": 0,
                            "total": 0,
                        },
                        "last_stop_reason": None,
                        "last_error": str(exc),
                    },
                    "tools": {
                        "available": tools,
                        "safe_for_prelaunch": safe_tools,
                        "calls": 0,
                        "trajectory": [],
                        "environment_calls": 0,
                        "environment_trajectory": [],
                    },
                    "native": None,
                    "speculation": {},
                    "parse_health": {
                        "event_rows": 0,
                        "malformed_event_rows": 0,
                        "trace_rows": 0,
                        "malformed_trace_rows": 0,
                    },
                    "environment_names": sorted(
                        name for name in API_ENV if name in os.environ
                    ),
                    "artifacts": {
                        "events": str(events_path),
                        "stderr": str(stderr_path),
                        "trace": str(trace_path),
                        "tool_trace": str(
                            mode_dir / "benchmark_server" / "tool_trace.jsonl"
                        ),
                        "connectivity_preflight": str(preflight_log),
                    },
                }
                atomic_json(mode_dir / "result.json", result)
                return result

        while bridge_result is None:
            turn += 1
            manifest = request_json(f"{server_url}/manifest")
            manifest_path = mode_dir / "tool_manifest.json"
            atomic_json(manifest_path, manifest)
            atomic_json(mode_dir / f"tool_manifest-turn-{turn:03d}.json", manifest)
            tools = [str(item["name"]) for item in manifest["tools"]]
            safe_tools = [str(item) for item in manifest.get("safe_tools", [])]
            lifecycle = str((manifest.get("metadata") or {}).get("lifecycle") or "")
            task_system_time = str(
                (manifest.get("metadata") or {}).get("system_time") or ""
            ).strip()
            turn_events = mode_dir / f"perseus-events-turn-{turn:03d}.jsonl"
            turn_stderr = mode_dir / f"perseus-stderr-turn-{turn:03d}.log"
            turn_trace = mode_dir / f"perseus-trace-turn-{turn:03d}.jsonl"
            turn_event_paths.append(turn_events)
            turn_stderr_paths.append(turn_stderr)
            turn_trace_paths.append(turn_trace)
            turn_container = (
                f"harnesseval-agent-{os.getpid()}-{uuid.uuid4().hex[:8]}"
                if agent_deadline is not None
                else None
            )
            command = [
                "docker",
                "run",
                "--rm",
                "--init",
            ]
            if turn_container is not None:
                command.extend(["--name", turn_container])
            command.extend([
                "--network",
                "bridge",
                "--add-host",
                host_alias,
                "--read-only",
                "--tmpfs",
                "/tmp:rw,exec,nosuid,size=1g",
                "-e",
                "HOME=/tmp",
                "-e",
                f"PERSEUS_ENABLED={1 if enabled else 0}",
                "-e",
                f"PERSEUS_SAFE_TOOLS={','.join(safe_tools)}",
                "-e",
                "PERSEUS_STATE_DIR=/tmp/perseus-state",
                "-e",
                f"PERSEUS_TRACE_FILE=/job/{turn_trace.name}",
                "-e",
                "HARNESSEVAL_TOOL_MANIFEST=/job/tool_manifest.json",
                "-e",
                f"HARNESSEVAL_TOOL_ENDPOINT={product_endpoint}",
                *egress_flags(platform, "bridge", direct_hosts),
            ])
            if task_system_time:
                command.extend(["-e", f"PI_SYSTEM_DATE={task_system_time.split()[0]}"])
            for name in API_ENV:
                if name in os.environ:
                    command.extend(["-e", name])
            command.extend(
                [
                    "-v",
                    f"{mode_dir}:/job:rw",
                    "-v",
                    f"{extension}:/opt/perseus/integrations/harnesseval/tool_bridge_extension.ts:ro",
                    "-v",
                    f"{system_prompt_source}:/opt/perseus/harness/packages/coding-agent/src/core/system-prompt.ts:ro",
                    "-w",
                    product_working_directory(benchmark.id),
                    image,
                    "/opt/perseus/perseus",
                    "--mode",
                    "json",
                    "--no-session",
                    "--print",
                    "--no-context-files",
                    "--no-skills",
                    "--no-prompt-templates",
                    "--no-builtin-tools",
                    "--extension",
                    "/opt/perseus/integrations/harnesseval/tool_bridge_extension.ts",
                    "--tools",
                    ",".join(tools),
                    "-p",
                    str(manifest["prompt"]),
                ]
            )
            started = time.perf_counter()
            remaining = (
                max(0.001, agent_deadline - time.monotonic())
                if agent_deadline is not None
                else None
            )
            turn_returncode = record_json_stream(
                command,
                turn_events,
                turn_stderr,
                timeout_sec=remaining,
                container_name=turn_container,
            )
            agent_seconds += time.perf_counter() - started
            returncodes.append(turn_returncode)
            agent_timed_out = turn_returncode == 124 and agent_deadline is not None
            if agent_timed_out and benchmark.id in TASK_BENCHMARKS:
                # Cancelling the product container disconnects an in-flight tool HTTP call;
                # explicitly cancel it in the bridge as well so its docker exec process is
                # gone before the same task container enters shared verification.
                try:
                    request_json(f"{server_url}/cancel", {}, timeout=45)
                except Exception as exc:
                    with turn_stderr.open("a", encoding="utf-8") as stderr:
                        stderr.write(
                            f"Unable to cancel in-flight task command: {exc}\n"
                        )
            turn_rows, _ = jsonl(turn_events)
            turn_answer = assistant_text(turn_rows)
            turn_actor = actor_metrics(turn_rows)

            should_continue_native = (
                benchmark.id in NATIVE_EPISODE_BENCHMARKS
                and turn_returncode == 0
                and turn_actor["last_stop_reason"] != "error"
                and bool(turn_answer.strip())
                and "###STOP###" not in turn_answer
            )
            if should_continue_native:
                continuation = request_json(
                    f"{server_url}/turn",
                    {"content": turn_answer},
                    timeout=None,
                )
                if continuation.get("episode_complete") is not True:
                    continue

            accumulated_events: list[dict[str, Any]] = []
            for path in turn_event_paths:
                rows, _ = jsonl(path)
                accumulated_events.extend(rows)
            accumulated_actor = actor_metrics(accumulated_events)
            committed_calls = (
                first_assistant_tool_calls(accumulated_events)
                if lifecycle == DECLARATION_ONLY_LIFECYCLE
                else accumulated_actor["committed_calls"]
            )
            bridge_result = request_json(
                f"{server_url}/final",
                {
                    "profile": mode,
                    "answer": turn_answer,
                    "committed_calls": committed_calls,
                },
                timeout=None,
            )

        events_path.write_text(
            "".join(path.read_text(encoding="utf-8", errors="replace") for path in turn_event_paths),
            encoding="utf-8",
        )
        stderr_path.write_text(
            "".join(path.read_text(encoding="utf-8", errors="replace") for path in turn_stderr_paths),
            encoding="utf-8",
        )
        trace_path.write_text(
            "".join(
                path.read_text(encoding="utf-8", errors="replace")
                for path in turn_trace_paths
                if path.is_file()
            ),
            encoding="utf-8",
        )
        returncode = next((code for code in returncodes if code != 0), returncodes[-1])
        events, malformed_events = jsonl(events_path)
        trace, malformed_trace = jsonl(trace_path)
        answer = assistant_text(events)
        score_answer = scorer_answer(benchmark.id, answer)
        actor = actor_metrics(events)
        if lifecycle == DECLARATION_ONLY_LIFECYCLE:
            actor["committed_calls"] = first_assistant_tool_calls(events)
        bridge_error = tool_bridge_failure(benchmark.id, bridge_result)
        if benchmark.id in TASK_BENCHMARKS and not bridge_error:
            bridge_result.update(
                finalize_task(
                    platform=platform,
                    benchmark=benchmark,
                    case_id=case_id,
                    mode_dir=mode_dir,
                    handle=handle,
                    arm_deadline=arm_deadline,
                )
            )
        elif bridge_error:
            bridge_result.update(
                {
                    "native_score_status": "infra_failed",
                    "native_score": None,
                    "native_reward": None,
                    "termination_reason": "tool_bridge_infrastructure",
                }
            )
        provider_failed = actor["last_stop_reason"] == "error"
        declaration_answer = (
            lifecycle == DECLARATION_ONLY_LIFECYCLE
            and bool(actor["committed_calls"])
            and actor["last_stop_reason"] == "toolUse"
        )
        answer_produced = not provider_failed and (bool(answer.strip()) or declaration_answer)
        runtime_completed = answer_produced and (
            actor["last_stop_reason"] == "stop" or declaration_answer
        )
        native_infra_failed = (
            benchmark.id == "terminal-bench-2"
            and bridge_result.get("native_score_status") != "completed"
        )
        failure_kind = None
        runtime_warning = None
        error = None
        if bridge_error:
            failure_kind = "tool_bridge_infrastructure"
            error = bridge_error
        elif native_infra_failed:
            failure_kind = "verifier_infrastructure"
            error = bridge_result.get("verifier_error") or "Native verifier failed"
        elif agent_timed_out:
            failure_kind = "agent_timeout"
            error = f"Agent exceeded its {agent_timeout_sec:.1f}s wall-clock timeout"
        elif provider_failed:
            failure_kind = "provider_error"
            error = actor.get("last_error")
        elif not answer_produced:
            failure_kind = "no_final_answer"
        elif returncode != 0:
            runtime_warning = "post_answer_runtime_error"
        result = {
            "schema_version": 1,
            "status": (
                "completed"
                if runtime_completed
                and not agent_timed_out
                and not bridge_error
                and not native_infra_failed
                else "failed"
            ),
            "failure_kind": failure_kind,
            "error": error,
            "benchmark": benchmark.id,
            "case_id": case_id,
            "profile": mode,
            "perseus_enabled": enabled,
            "agent_execution_seconds": agent_seconds,
            "returncode": returncode,
            "answer": answer,
            "scorer_answer": score_answer,
            "answer_produced": answer_produced,
            "agent_timed_out": agent_timed_out,
            "runtime_warning": runtime_warning,
            "actor": actor,
            "tools": {
                "available": tools,
                "safe_for_prelaunch": safe_tools,
                "calls": bridge_result.get("tool_calls", 0),
                "trajectory": bridge_result.get("calls", []),
                "environment_calls": bridge_result.get("environment_tool_calls", 0),
                "environment_trajectory": bridge_result.get("environment_calls", []),
            },
            "native": bridge_result if benchmark.id in NATIVE_EPISODE_BENCHMARKS | TASK_BENCHMARKS else None,
            "speculation": mechanism_counts(trace),
            "parse_health": {
                "event_rows": len(events),
                "malformed_event_rows": malformed_events,
                "trace_rows": len(trace),
                "malformed_trace_rows": malformed_trace,
            },
            "environment_names": sorted(name for name in API_ENV if name in os.environ),
            "artifacts": {
                "attempt": str(mode_dir),
                "mode_root": str(mode_root),
                "events": str(events_path),
                "stderr": str(stderr_path),
                "trace": str(mode_dir / "perseus-trace.jsonl"),
                "tool_trace": str(mode_dir / "benchmark_server" / "tool_trace.jsonl"),
            },
        }
        atomic_json(mode_dir / "result.json", result)
        return result
    finally:
        if handle is not None and handle.process.poll() is None:
            handle.process.terminate()
            try:
                handle.process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                handle.process.kill()
                handle.process.wait()
        if handle is not None:
            handle.log.close()
            if handle.task_container:
                if benchmark.id == "terminal-bench-2":
                    platform._terminal_remove_container(handle.task_container)
                else:
                    subprocess.run(
                        platform._docker("rm", "-f", handle.task_container),
                        stdout=subprocess.DEVNULL,
                        stderr=subprocess.DEVNULL,
                        check=False,
                    )


def main() -> None:
    parser = argparse.ArgumentParser(description="Run a benchmark-faithful PERSEUS/Actor-only matched pair")
    parser.add_argument("benchmark", choices=sorted(PRODUCT_BENCHMARKS))
    parser.add_argument("--case", required=True)
    parser.add_argument("--run-dir", type=Path, required=True)
    parser.add_argument("--harnesseval-root", type=Path, required=True)
    parser.add_argument("--orch-root", type=Path)
    parser.add_argument("--image", default="perseus:harnesseval-smoke")
    parser.add_argument("--mode", choices=("both", "perseus", "actor-only"), default="both")
    args = parser.parse_args()

    required = ("PERSEUS_ACTOR_MODEL", "PERSEUS_ACTOR_BASE_URL", "PERSEUS_ACTOR_API_KEY")
    missing = [name for name in required if not os.environ.get(name)]
    if missing:
        raise SystemExit(f"Missing required environment variable(s): {', '.join(missing)}")
    root = args.harnesseval_root.resolve()
    sys.path.insert(0, str(root))
    from benchmark_platform.engine import Platform

    platform = Platform(root, (args.orch_root or root.parent).resolve(), root / "catalog" / "benchmarks.json")
    benchmark = platform.catalog.get(args.benchmark)
    if benchmark.id == "terminal-bench-2":
        task_dir, task_metadata = platform._terminal_metadata(benchmark, args.case)
        task_image = task_metadata.get("environment", {}).get("docker_image") or benchmark.adapter["image"]
        if not platform.image_exists(task_image):
            pulled = subprocess.run(platform._docker("pull", task_image), check=False)
            if pulled.returncode != 0 or not platform.image_exists(task_image):
                raise SystemExit(f"Unable to pull benchmark task image for {args.case}: {task_image}")
    elif not platform.image_is_current(benchmark.adapter):
        built = platform.build(benchmark)
        if built.get("status") != "completed" or not platform.image_is_current(benchmark.adapter):
            raise SystemExit(f"Unable to build current benchmark image: {benchmark.adapter['image']}: {built}")
    prepared = (
        None
        if benchmark.id in NATIVE_EPISODE_BENCHMARKS | TASK_BENCHMARKS
        else platform._prepare_bridge_case(benchmark, args.case, args.run_dir)
    )
    extension = Path(__file__).resolve().with_name("tool_bridge_extension.ts")
    modes = [True, False] if args.mode == "both" else [args.mode == "perseus"]
    implementation = product_implementation_identity(platform, args.image)
    results = [
        run_mode(
            platform=platform,
            benchmark=benchmark,
            prepared=prepared,
            run_dir=args.run_dir.resolve(),
            case_id=args.case,
            image=args.image,
            extension=extension,
            enabled=enabled,
        )
        for enabled in modes
    ]
    for result in results:
        result["implementation"] = implementation
        result["score"] = score_result(benchmark.id, prepared, result)
        mode_dir = Path(result["artifacts"]["events"]).parent
        atomic_json(mode_dir / "result.json", result)
        mode_root = Path(result["artifacts"]["mode_root"])
        atomic_json(mode_root / "result.json", result)
        atomic_json(
            mode_root / "latest.json",
            {
                "schema_version": 1,
                "attempt": result["artifacts"]["attempt"],
                "result": str(mode_dir / "result.json"),
            },
        )
    pair_results = list(results)
    counterpart_note = None
    if args.mode != "both":
        case_slug = args.case.replace("/", "_").replace(":", "_")
        counterpart = "actor-only" if args.mode == "perseus" else "perseus"
        counterpart_path = args.run_dir.resolve() / benchmark.id / case_slug / counterpart / "result.json"
        if counterpart_path.is_file():
            stored = json.loads(counterpart_path.read_text(encoding="utf-8"))
            if isinstance(stored, dict) and stored.get("implementation") == implementation:
                pair_results.append(stored)
            elif isinstance(stored, dict):
                counterpart_note = (
                    f"Ignored {counterpart_path}: implementation identity differs; "
                    "run both modes under one pinned implementation to form a matched pair"
                )
    pair_results.sort(key=lambda item: 0 if item.get("profile") == "perseus" else 1)
    pair = {
        "schema_version": 1,
        "created_at": datetime.now(timezone.utc).isoformat(),
        "benchmark": benchmark.id,
        "case_id": args.case,
        "matched_variables": ["case", "prompt", "tools", "actor model", "thinking", "network"],
        "independent_variable": "PERSEUS_ENABLED",
        "implementation": implementation,
        "counterpart_note": counterpart_note,
        "results": pair_results,
    }
    case_slug = args.case.replace("/", "_").replace(":", "_")
    case_root = args.run_dir.resolve() / benchmark.id / case_slug
    pair_attempt = next_attempt_dir(case_root / "pair-history")
    pair["artifact"] = str(pair_attempt / "pair.json")
    atomic_json(pair_attempt / "pair.json", pair)
    atomic_json(case_root / "pair.json", pair)
    print(
        json.dumps(
            {
                "benchmark": benchmark.id,
                "case_id": args.case,
                "results": [
                    {
                        "profile": item["profile"],
                        "status": item["status"],
                        "failure_kind": item["failure_kind"],
                        "agent_execution_seconds": item["agent_execution_seconds"],
                        "rounds": item["actor"]["rounds"],
                        "tokens": item["actor"]["usage"]["total"],
                        "committed_tool_calls": item["tools"]["calls"],
                        "environment_tool_calls": item["tools"]["environment_calls"],
                        "score": item["score"],
                    }
                    for item in results
                ],
                "pair_artifact": str(args.run_dir.resolve() / benchmark.id / case_slug / "pair.json"),
            },
            ensure_ascii=False,
            indent=2,
        )
    )
    raise SystemExit(0 if all(item["status"] == "completed" for item in results) else 1)


if __name__ == "__main__":
    main()
