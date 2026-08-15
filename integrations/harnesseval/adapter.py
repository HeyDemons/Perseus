from __future__ import annotations

import argparse
import json
import os
import subprocess
import time
from pathlib import Path
from typing import Any


JOB_ROOT = Path("/job")


def atomic_json(path: Path, value: dict[str, Any]) -> None:
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    os.replace(temporary, path)


def jsonl(path: Path) -> tuple[list[dict[str, Any]], int]:
    if not path.is_file():
        return [], 0
    rows: list[dict[str, Any]] = []
    malformed = 0
    with path.open(encoding="utf-8") as stream:
        for line in stream:
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


def assistant_text(events: list[dict[str, Any]]) -> str:
    texts: list[str] = []
    for event in events:
        if event.get("type") != "message_end":
            continue
        message = event.get("message")
        if not isinstance(message, dict) or message.get("role") != "assistant":
            continue
        content = message.get("content")
        if not isinstance(content, list):
            continue
        current = [
            item.get("text", "")
            for item in content
            if isinstance(item, dict) and item.get("type") == "text" and isinstance(item.get("text"), str)
        ]
        if current:
            texts.append("\n".join(current))
    return texts[-1] if texts else ""


def require_job_path(value: str) -> Path:
    path = Path(value).resolve()
    if not path.is_relative_to(JOB_ROOT.resolve()):
        raise ValueError(f"Output path must be under /job: {value}")
    return path


def run(request_path: Path) -> int:
    request = json.loads(request_path.read_text(encoding="utf-8"))
    if request.get("schema_version") != 1:
        raise ValueError("Unsupported request schema")

    task = request.get("task")
    if not isinstance(task, dict) or not isinstance(task.get("prompt"), str):
        raise ValueError("Request requires task.prompt")
    tools = request.get("tools")
    safe_tools = request.get("safe_tools")
    if not isinstance(tools, list) or not all(isinstance(item, str) and item for item in tools):
        raise ValueError("Request requires a non-empty string tools list")
    if not isinstance(safe_tools, list) or not all(isinstance(item, str) and item for item in safe_tools):
        raise ValueError("Request requires a non-empty string safe_tools list")
    if not set(safe_tools).issubset(tools):
        raise ValueError("safe_tools must be a subset of tools")

    working_directory = Path(request.get("working_directory", "/workspace")).resolve()
    if not working_directory.is_dir():
        raise FileNotFoundError(f"Working directory does not exist: {working_directory}")
    answer_path = require_job_path(str(request.get("answer_file", "/job/answer.txt")))
    expected = str(request.get("expected", ""))

    trace_path = JOB_ROOT / "perseus-trace.jsonl"
    events_path = JOB_ROOT / "perseus-events.jsonl"
    stderr_path = JOB_ROOT / "perseus-stderr.log"
    environment = os.environ.copy()
    environment.update(
        {
            "PERSEUS_ENABLED": environment.get("PERSEUS_ENABLED", "1"),
            "PERSEUS_SAFE_TOOLS": ",".join(safe_tools),
            "PERSEUS_TRACE_FILE": str(trace_path),
            "PERSEUS_STATE_DIR": str(JOB_ROOT / "state"),
            "PERSEUS_HARNESS_RUNTIME": "/opt/perseus/harness",
        }
    )
    command = [
        "/opt/perseus/perseus",
        "--mode",
        "json",
        "--no-session",
        "--print",
        "--no-context-files",
        "--tools",
        ",".join(tools),
        "-p",
        task["prompt"],
    ]

    started = time.perf_counter()
    with events_path.open("w", encoding="utf-8") as stdout, stderr_path.open("w", encoding="utf-8") as stderr:
        completed = subprocess.run(
            command,
            cwd=working_directory,
            env=environment,
            stdout=stdout,
            stderr=stderr,
            text=True,
            check=False,
        )
    execution_seconds = time.perf_counter() - started

    events, malformed_events = jsonl(events_path)
    trace, malformed_trace = jsonl(trace_path)
    tool_starts = [event for event in events if event.get("type") == "tool_execution_start"]
    tool_names = [str(event.get("toolName", "")) for event in tool_starts]
    mechanism_counts: dict[str, int] = {}
    for event in trace:
        name = str(event.get("event", "unknown"))
        mechanism_counts[name] = mechanism_counts.get(name, 0) + 1

    actual = answer_path.read_text(encoding="utf-8") if answer_path.is_file() else ""
    exact = actual.strip() == expected
    tool_contract = tool_names.count("read") >= 2 and tool_names.count("write") >= 1
    speculative_path = (
        mechanism_counts.get("prediction_completed", 0) >= 1
        and mechanism_counts.get("candidate_prelaunched", 0) >= 1
    )
    passed = completed.returncode == 0 and exact and tool_contract and speculative_path

    harness_result = {
        "schema_version": 1,
        "system": "PERSEUS",
        "task_id": task.get("id"),
        "status": "completed" if passed else "failed",
        "execution_seconds": execution_seconds,
        "actor": {
            "provider": environment.get("PERSEUS_ACTOR_PROVIDER", "openai-compatible"),
            "model": environment.get("PERSEUS_ACTOR_MODEL", ""),
            "thinking": environment.get("PERSEUS_ACTOR_THINKING", "high"),
            "final_text": assistant_text(events),
        },
        "speculator": {
            "provider": environment.get(
                "PERSEUS_SPECULATOR_PROVIDER",
                environment.get("PERSEUS_ACTOR_PROVIDER", "openai-compatible"),
            ),
            "model": environment.get("PERSEUS_SPECULATOR_MODEL", environment.get("PERSEUS_ACTOR_MODEL", "")),
            "top_k": int(environment.get("PERSEUS_TOP_K", "3")),
            "safe_tools": safe_tools,
            "events": mechanism_counts,
        },
        "tools": {"calls": len(tool_starts), "names": tool_names},
        "artifacts": {
            "events": str(events_path),
            "trace": str(trace_path),
            "stderr": str(stderr_path),
            "answer": str(answer_path),
        },
        "parse_health": {
            "event_rows": len(events),
            "malformed_event_rows": malformed_events,
            "trace_rows": len(trace),
            "malformed_trace_rows": malformed_trace,
        },
    }
    payload = {
        "schema_version": 1,
        "oracle_smoke": True,
        "scores": {
            "exact_file": 1.0 if exact else 0.0,
            "tool_contract": 1.0 if tool_contract else 0.0,
            "speculative_path": 1.0 if speculative_path else 0.0,
            "end_to_end": 1.0 if passed else 0.0,
        },
        "answer": actual,
        "expected": expected,
    }
    atomic_json(JOB_ROOT / "harness_result.json", harness_result)
    atomic_json(JOB_ROOT / "payload.json", payload)
    print(json.dumps({"status": harness_result["status"], "scores": payload["scores"]}, ensure_ascii=False))
    return 0 if passed else 1


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--request", type=Path, required=True)
    args = parser.parse_args()
    raise SystemExit(run(args.request))


if __name__ == "__main__":
    main()
