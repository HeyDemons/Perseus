#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.request
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


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
    "PERSEUS_ACTOR_THINKING",
    "PERSEUS_SPECULATOR_PROVIDER",
    "PERSEUS_SPECULATOR_MODEL",
    "PERSEUS_SPECULATOR_BASE_URL",
    "PERSEUS_SPECULATOR_API_TYPE",
    "PERSEUS_SPECULATOR_API_KEY",
    "PERSEUS_TOP_K",
    "PERSEUS_SPECULATOR_MAX_TOKENS",
    "PERSEUS_SPECULATOR_TIMEOUT_MS",
    "PERSEUS_API_TIMEOUT_MS",
    "PERSEUS_API_MAX_RETRIES",
    "PERSEUS_API_MAX_RETRY_DELAY_MS",
    "PERSEUS_CONTEXT_WINDOW",
)


@dataclass
class ToolServerHandle:
    process: subprocess.Popen[str]
    log: Any
    url: str
    task_container: str | None = None
    context: dict[str, Any] | None = None


def atomic_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    os.replace(temporary, path)


def request_json(url: str, payload: dict[str, Any] | None = None) -> dict[str, Any]:
    data = None if payload is None else json.dumps(payload, ensure_ascii=False).encode("utf-8")
    request = urllib.request.Request(
        url,
        data=data,
        headers={"Content-Type": "application/json"},
        method="GET" if payload is None else "POST",
    )
    with urllib.request.urlopen(request, timeout=10) as response:
        value = json.loads(response.read().decode("utf-8"))
    if not isinstance(value, dict):
        raise TypeError(f"Expected JSON object from {url}")
    return value


def wait_manifest(url: str, process: subprocess.Popen[str], log_path: Path) -> dict[str, Any]:
    while process.poll() is None:
        try:
            return request_json(f"{url}/manifest")
        except (OSError, urllib.error.URLError, json.JSONDecodeError):
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


def record_json_stream(command: list[str], events_path: Path, stderr_path: Path) -> int:
    """Record Pi events without duplicating every accumulated stream prefix."""
    with events_path.open("w", encoding="utf-8") as events, stderr_path.open("w", encoding="utf-8") as stderr:
        process = subprocess.Popen(
            command,
            stdout=subprocess.PIPE,
            stderr=stderr,
            text=True,
            bufsize=1,
        )
        assert process.stdout is not None
        for line in process.stdout:
            try:
                event = json.loads(line)
            except json.JSONDecodeError:
                events.write(line)
                continue
            if isinstance(event, dict) and event.get("type") == "message_update":
                update = event.get("assistantMessageEvent")
                if isinstance(update, dict):
                    event = {
                        "type": "message_update",
                        "assistantMessageEvent": {
                            key: value for key, value in update.items() if key != "partial"
                        },
                    }
            events.write(json.dumps(event, ensure_ascii=False, separators=(",", ":")) + "\n")
        return process.wait()


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


def mechanism_counts(trace: list[dict[str, Any]]) -> dict[str, int]:
    counts: dict[str, int] = {}
    for row in trace:
        name = str(row.get("event") or "unknown")
        counts[name] = counts.get(name, 0) + 1
    return counts


def score_result(benchmark_id: str, prepared: Path | None, result: dict[str, Any]) -> dict[str, Any]:
    if benchmark_id in NATIVE_EPISODE_BENCHMARKS | TASK_BENCHMARKS:
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


def egress_flags(platform: Any, network: str) -> list[str]:
    return list(platform._egress_env(network))


def start_tool_server(
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
    if prepared is not None:
        command.extend(["-v", f"{prepared / 'input'}:/bridge:ro"])
    for name in ("API_URL", "TOOLBENCH_KEY"):
        if name in os.environ:
            command.extend(["-e", name])
    if benchmark.id in NATIVE_EPISODE_BENCHMARKS:
        module = (
            "benchmark_platform.bridges.vita_product_server"
            if benchmark.id == "vitabench"
            else "benchmark_platform.bridges.tau_product_server"
        )
        policy = {"native_evaluate": benchmark.id == "tau2"}
        command.extend(
            [
                "-e", "HARNESS_API_BASE", "-e", "HARNESS_API_KEY", "-e", "HARNESS_MODEL",
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
    return ToolServerHandle(process, log, url)


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
            "-v", f"{job.resolve()}:/job:rw",
            benchmark.adapter["image"],
            "python", "/opt/platform/swebench_bridge.py", action,
            "--case", case_id,
        ]
    )
    return command


def _record_command(command: list[str], log_path: Path) -> subprocess.CompletedProcess[str]:
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
        task_dir = Path(benchmark.adapter["task_dir"])
        prompt = (task_dir / "instruction.md").read_text(encoding="utf-8")
        workspace_root = "/app"
        create = platform._docker("create", "--init", "--name", container)
        create.extend(["--label", "orch.benchmark-platform=1", "--label", "orch.product-bridge=1"])
        if docker_platform := benchmark.adapter.get("platform"):
            create.extend(["--platform", docker_platform])
        network = "bridge" if benchmark.adapter.get("allow_internet") else "none"
        create.extend(["--network", network, *egress_flags(platform, network)])
        create.extend(
            [
                "-w", workspace_root,
                benchmark.adapter["image"],
                "sh", "-lc", "while :; do sleep 3600; done",
            ]
        )
        context.update({"task_dir": task_dir, "workspace_root": workspace_root})
    else:
        prepare = swe_controller_command(platform, benchmark, server_dir, "prepare", case_id)
        completed = _record_command(prepare, setup_log)
        public_path = server_dir / "public_case.json"
        if completed.returncode != 0 or not public_path.is_file():
            raise RuntimeError("SWE-bench public case preparation failed; see setup.log")
        public_case = json.loads(public_path.read_text(encoding="utf-8"))
        if public_case.get("hidden_fields_exposed_to_agent") != []:
            raise RuntimeError("SWE-bench preparation exposed hidden authority fields")
        prompt = str(public_case["prompt"])
        workspace_root = str(public_case["workspace_root"])
        create = platform._docker("create", "--init", "--name", container)
        create.extend(["--label", "orch.benchmark-platform=1", "--label", "orch.product-bridge=1"])
        create.extend(["--platform", public_case["task_image"]["platform"]])
        create.extend(["--network", "bridge", *egress_flags(platform, "bridge")])
        create.extend(
            [
                "-w", workspace_root,
                public_case["task_image"]["name"],
                "sh", "-lc", "while :; do sleep 3600; done",
            ]
        )
        context.update({"public_case": public_case, "workspace_root": workspace_root})
    created = _record_command(create, setup_log)
    if created.returncode != 0:
        raise RuntimeError("Task container creation failed; see setup.log")
    started = _record_command(platform._docker("start", container), setup_log)
    if started.returncode != 0:
        subprocess.run(platform._docker("rm", "-f", container), capture_output=True, check=False)
        raise RuntimeError("Task container start failed; see setup.log")
    prompt_path = server_dir / "prompt.txt"
    prompt_path.write_text(prompt, encoding="utf-8")
    endpoint_path = server_dir / "task_product_server.json"
    log_path = server_dir / "server.log"
    log = log_path.open("w", encoding="utf-8")
    environment = dict(os.environ)
    python_path = environment.get("PYTHONPATH")
    environment["PYTHONPATH"] = str(platform.root) + (os.pathsep + python_path if python_path else "")
    command = [
        sys.executable,
        "-m", "benchmark_platform.bridges.task_product_server",
        "--benchmark", benchmark.id,
        "--case", case_id,
        "--prompt-file", str(prompt_path),
        "--container", container,
        "--workspace-root", workspace_root,
        "--job", str(server_dir),
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
            raise RuntimeError("Task product server exited before publishing its endpoint")
        endpoint = json.loads(endpoint_path.read_text(encoding="utf-8"))
        url = f"http://{endpoint['host']}:{endpoint['port']}"
        wait_manifest(url, process, log_path)
        return ToolServerHandle(process, log, url, container, context)
    except Exception:
        if process.poll() is None:
            process.terminate()
            process.wait()
        log.close()
        subprocess.run(platform._docker("rm", "-f", container), capture_output=True, check=False)
        raise


def finalize_task(
    *, platform: Any, benchmark: Any, case_id: str, mode_dir: Path, handle: ToolServerHandle
) -> dict[str, Any]:
    assert handle.task_container is not None
    context = handle.context or {}
    server_dir = Path(context["server_dir"])
    evaluator_log = server_dir / "evaluator.log"
    if benchmark.id == "terminal-bench-2":
        workspace = mode_dir / "workspace"
        workspace.mkdir()
        copied = _record_command(
            platform._docker("cp", f"{handle.task_container}:/app/.", str(workspace)),
            evaluator_log,
        )
        if copied.returncode != 0:
            raise RuntimeError("Unable to copy Terminal-Bench workspace")
        logs = mode_dir / "verifier"
        logs.mkdir()
        task_dir = Path(context["task_dir"])
        verifier = f"{handle.task_container}-verifier"
        verify = platform._docker("run", "--rm", "--init", "--name", verifier)
        if docker_platform := benchmark.adapter.get("platform"):
            verify.extend(["--platform", docker_platform])
        verify.extend(egress_flags(platform, "bridge"))
        verify.extend(
            [
                "--network", "bridge",
                "-v", f"{workspace.resolve()}:/app:rw",
                "-v", f"{task_dir / 'tests'}:/tests:ro",
                "-v", f"{logs.resolve()}:/logs/verifier:rw",
                "-w", "/app",
                benchmark.adapter["image"],
                "bash", "/tests/test.sh",
            ]
        )
        checked = _record_command(verify, evaluator_log)
        reward_path = logs / "reward.txt"
        reward = reward_path.read_text(encoding="utf-8").strip() if reward_path.is_file() else None
        return {
            "native_score_status": "completed" if reward is not None else "failed",
            "native_score": float(reward) if reward is not None else None,
            "native_reward": float(reward) if reward is not None else None,
            "evaluator_returncode": checked.returncode,
            "termination_reason": "official_verifier",
        }
    workspace_root = str(context["workspace_root"])
    staged = _record_command(
        platform._docker("exec", "-w", workspace_root, handle.task_container, "git", "add", "-A"),
        evaluator_log,
    )
    if staged.returncode != 0:
        raise RuntimeError("Unable to stage SWE-bench workspace changes")
    patch_result = _record_command(
        platform._docker(
            "exec", "-w", workspace_root, handle.task_container,
            "git", "-c", "core.fileMode=false", "diff", "--cached", "--binary",
        ),
        evaluator_log,
    )
    if patch_result.returncode != 0:
        raise RuntimeError("Unable to extract SWE-bench model patch")
    (server_dir / "model.patch").write_text(patch_result.stdout, encoding="utf-8")
    evaluate = swe_controller_command(platform, benchmark, server_dir, "evaluate", case_id)
    checked = _record_command(evaluate, evaluator_log)
    payload_path = server_dir / "payload.json"
    payload = json.loads(payload_path.read_text(encoding="utf-8")) if payload_path.is_file() else {}
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
    mode = "perseus" if enabled else "actor-only"
    mode_dir = run_dir / benchmark.id / case_id.replace("/", "_").replace(":", "_") / mode
    if mode_dir.exists():
        shutil.rmtree(mode_dir)
    mode_dir.mkdir(parents=True)
    handle: ToolServerHandle | None = None
    try:
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
        manifest = request_json(f"{server_url}/manifest")
        manifest_path = mode_dir / "tool_manifest.json"
        atomic_json(manifest_path, manifest)
        tools = [str(item["name"]) for item in manifest["tools"]]
        safe_tools = [str(item) for item in manifest.get("safe_tools", [])]
        product_endpoint = server_url.replace("127.0.0.1", "host.docker.internal")
        events_path = mode_dir / "perseus-events.jsonl"
        stderr_path = mode_dir / "perseus-stderr.log"
        command = [
            "docker", "run", "--rm", "--init", "--network", "bridge",
            "--add-host", "host.docker.internal:host-gateway",
            "--read-only", "--tmpfs", "/tmp:rw,exec,nosuid,size=1g",
            "-e", "HOME=/tmp", "-e", f"PERSEUS_ENABLED={1 if enabled else 0}",
            "-e", f"PERSEUS_SAFE_TOOLS={','.join(safe_tools)}",
            "-e", "PERSEUS_STATE_DIR=/tmp/perseus-state",
            "-e", "PERSEUS_TRACE_FILE=/job/perseus-trace.jsonl",
            "-e", "HARNESSEVAL_TOOL_MANIFEST=/job/tool_manifest.json",
            "-e", f"HARNESSEVAL_TOOL_ENDPOINT={product_endpoint}",
            *egress_flags(platform, "bridge"),
        ]
        for name in API_ENV:
            if name in os.environ:
                command.extend(["-e", name])
        command.extend(
            [
                "-v", f"{mode_dir}:/job:rw",
                "-v", f"{extension}:/opt/perseus/integrations/harnesseval/tool_bridge_extension.ts:ro",
                "-w", "/tmp",
                image,
                "/opt/perseus/perseus",
                "--mode", "json", "--no-session", "--print", "--no-context-files",
                "--no-skills", "--no-prompt-templates", "--no-builtin-tools",
                "--extension", "/opt/perseus/integrations/harnesseval/tool_bridge_extension.ts",
                "--tools", ",".join(tools),
                "-p", str(manifest["prompt"]),
            ]
        )
        started = time.perf_counter()
        returncode = record_json_stream(command, events_path, stderr_path)
        agent_seconds = time.perf_counter() - started
        events, malformed_events = jsonl(events_path)
        trace, malformed_trace = jsonl(mode_dir / "perseus-trace.jsonl")
        answer = assistant_text(events)
        score_answer = scorer_answer(benchmark.id, answer)
        actor = actor_metrics(events)
        bridge_result = request_json(
            f"{server_url}/final",
            {"profile": mode, "answer": answer, "committed_calls": actor["committed_calls"]},
        )
        if benchmark.id in TASK_BENCHMARKS:
            bridge_result.update(
                finalize_task(
                    platform=platform,
                    benchmark=benchmark,
                    case_id=case_id,
                    mode_dir=mode_dir,
                    handle=handle,
                )
            )
        provider_failed = actor["last_stop_reason"] == "error"
        answer_produced = not provider_failed and bool(answer.strip())
        runtime_completed = answer_produced and actor["last_stop_reason"] == "stop"
        failure_kind = None
        runtime_warning = None
        if provider_failed:
            failure_kind = "provider_error"
        elif not answer_produced:
            failure_kind = "no_final_answer"
        elif returncode != 0:
            runtime_warning = "post_answer_runtime_error"
        result = {
            "schema_version": 1,
            "status": "completed" if runtime_completed else "failed",
            "failure_kind": failure_kind,
            "benchmark": benchmark.id,
            "case_id": case_id,
            "profile": mode,
            "perseus_enabled": enabled,
            "agent_execution_seconds": agent_seconds,
            "returncode": returncode,
            "answer": answer,
            "scorer_answer": score_answer,
            "answer_produced": answer_produced,
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
        if not platform.image_exists(benchmark.adapter["image"]):
            raise SystemExit(f"Benchmark task image is missing: {benchmark.adapter['image']}")
    elif not platform.image_is_current(benchmark.adapter):
        raise SystemExit(f"Benchmark image is missing or stale: {benchmark.adapter['image']}")
    prepared = (
        None
        if benchmark.id in NATIVE_EPISODE_BENCHMARKS | TASK_BENCHMARKS
        else platform._prepare_bridge_case(benchmark, args.case, args.run_dir)
    )
    extension = Path(__file__).resolve().with_name("tool_bridge_extension.ts")
    modes = [True, False] if args.mode == "both" else [args.mode == "perseus"]
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
        result["score"] = score_result(benchmark.id, prepared, result)
        mode_dir = Path(result["artifacts"]["events"]).parent
        atomic_json(mode_dir / "result.json", result)
    pair_results = list(results)
    if args.mode != "both":
        case_slug = args.case.replace("/", "_").replace(":", "_")
        counterpart = "actor-only" if args.mode == "perseus" else "perseus"
        counterpart_path = args.run_dir.resolve() / benchmark.id / case_slug / counterpart / "result.json"
        if counterpart_path.is_file():
            stored = json.loads(counterpart_path.read_text(encoding="utf-8"))
            if isinstance(stored, dict):
                pair_results.append(stored)
    pair_results.sort(key=lambda item: 0 if item.get("profile") == "perseus" else 1)
    pair = {
        "schema_version": 1,
        "created_at": datetime.now(timezone.utc).isoformat(),
        "benchmark": benchmark.id,
        "case_id": args.case,
        "matched_variables": ["case", "prompt", "tools", "actor model", "thinking", "network"],
        "independent_variable": "PERSEUS_ENABLED",
        "results": pair_results,
    }
    case_slug = args.case.replace("/", "_").replace(":", "_")
    atomic_json(args.run_dir.resolve() / benchmark.id / case_slug / "pair.json", pair)
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
