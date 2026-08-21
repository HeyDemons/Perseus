#!/usr/bin/env python3
from __future__ import annotations

import importlib.util
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock


ROOT = Path(__file__).resolve().parents[1]
RUNNER = ROOT / "integrations" / "harnesseval" / "run-benchmark-pair.py"
SPEC = importlib.util.spec_from_file_location("harnesseval_pair_runner", RUNNER)
assert SPEC is not None and SPEC.loader is not None
runner = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = runner
SPEC.loader.exec_module(runner)


class HarnessEvalRunnerTests(unittest.TestCase):
    class DockerPlatform:
        @staticmethod
        def _docker(*arguments):
            return ["docker", *arguments]

        @staticmethod
        def _egress_env(_network):
            return [
                "-e",
                "NO_PROXY=localhost",
                "-e",
                "no_proxy=localhost",
            ]

    def test_static_benchmarks_start_in_the_shared_case_workspace(self) -> None:
        expected = "/job/benchmark_server/case_workspace/workspace"
        for benchmark in runner.STATIC_BENCHMARKS:
            with self.subTest(benchmark=benchmark):
                self.assertEqual(runner.product_working_directory(benchmark), expected)

    def test_episode_and_task_benchmarks_keep_their_existing_workdir(self) -> None:
        for benchmark in runner.NATIVE_EPISODE_BENCHMARKS | runner.TASK_BENCHMARKS:
            with self.subTest(benchmark=benchmark):
                self.assertEqual(runner.product_working_directory(benchmark), "/tmp")

    def test_rootless_docker_uses_rootlesskit_host_loopback(self) -> None:
        completed = subprocess.CompletedProcess(
            [], 0, '["name=seccomp,profile=builtin","name=rootless"]\n', ""
        )
        with (
            mock.patch.dict(runner.os.environ, {}, clear=True),
            mock.patch.object(runner.subprocess, "run", return_value=completed),
        ):
            alias = runner.docker_host_alias(self.DockerPlatform())
        self.assertEqual(alias, "host.docker.internal:10.0.2.2")

    def test_rootful_docker_keeps_standard_host_gateway(self) -> None:
        completed = subprocess.CompletedProcess(
            [], 0, '["name=seccomp,profile=builtin"]\n', ""
        )
        with (
            mock.patch.dict(runner.os.environ, {}, clear=True),
            mock.patch.object(runner.subprocess, "run", return_value=completed),
        ):
            alias = runner.docker_host_alias(self.DockerPlatform())
        self.assertEqual(alias, "host.docker.internal:host-gateway")

    def test_agent_image_preflight_uses_selected_host_alias(self) -> None:
        completed = subprocess.CompletedProcess([], 0, "ok tools=4\n", "")
        with tempfile.TemporaryDirectory() as directory:
            log_path = Path(directory) / "preflight.log"
            with mock.patch.object(
                runner.subprocess, "run", return_value=completed
            ) as run:
                runner.preflight_tool_endpoint(
                    platform=self.DockerPlatform(),
                    image="perseus:test",
                    endpoint="http://host.docker.internal:12345",
                    host_alias="host.docker.internal:10.0.2.2",
                    direct_hosts=("host.docker.internal",),
                    log_path=log_path,
                )
            command = run.call_args.args[0]
            log = log_path.read_text()
        self.assertIn("host.docker.internal:10.0.2.2", command)
        self.assertIn("http://host.docker.internal:12345", command)
        self.assertIn("returncode=0", log)

    def test_missing_environment_calls_is_an_infrastructure_failure(self) -> None:
        message = runner.tool_bridge_failure(
            "terminal-bench-2",
            {"tool_calls": 9, "environment_tool_calls": 0},
        )
        self.assertIn("9 committed tool call", message or "")
        self.assertIsNone(
            runner.tool_bridge_failure(
                "terminal-bench-2",
                {"tool_calls": 9, "environment_tool_calls": 9},
            )
        )
        self.assertIsNone(
            runner.tool_bridge_failure(
                "tau2", {"tool_calls": 9, "environment_tool_calls": 0}
            )
        )

    def test_bfcl_commits_only_the_first_assistant_tool_batch(self) -> None:
        events = [
            {
                "type": "message_end",
                "message": {
                    "role": "assistant",
                    "content": [
                        {
                            "type": "toolCall",
                            "id": "first",
                            "name": "lookup",
                            "arguments": {"id": 7},
                        }
                    ],
                },
            },
            {
                "type": "message_end",
                "message": {
                    "role": "assistant",
                    "content": [
                        {
                            "type": "toolCall",
                            "id": "retry",
                            "name": "lookup",
                            "arguments": {"id": 8},
                        }
                    ],
                },
            },
        ]

        self.assertEqual(
            runner.first_assistant_tool_calls(events),
            [
                {
                    "id": "first",
                    "name": "lookup",
                    "arguments": {"id": 7},
                }
            ],
        )

    def test_bridge_failure_cannot_be_reported_as_an_official_zero(self) -> None:
        score = runner.score_result(
            "terminal-bench-2",
            None,
            {
                "failure_kind": "tool_bridge_infrastructure",
                "native": {
                    "native_score_status": "completed",
                    "native_score": 0.0,
                    "native_reward": 0.0,
                },
            },
        )
        self.assertEqual(score["status"], "infra_failed")
        self.assertIsNone(score["score"])
        self.assertIsNone(score["reward"])

    def test_product_agent_wall_clock_timeout_returns_124(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            result = runner.record_json_stream(
                [sys.executable, "-c", "import time; time.sleep(30)"],
                root / "events.jsonl",
                root / "stderr.log",
                timeout_sec=0.05,
            )
            stderr = (root / "stderr.log").read_text()
        self.assertEqual(result, 124)
        self.assertIn("Agent phase timed out", stderr)

    def test_terminal_finalize_scores_zero_in_the_original_task_container(self) -> None:
        calls = []

        class FakePlatform:
            def _terminal_run_shared_verifier(self, **kwargs):
                calls.append(("verify", kwargs))
                return {
                    "status": "completed",
                    "scores": {"reward": 0.0},
                    "returncode": 1,
                    "attempts": 1,
                    "termination_reason": "official_shared_verifier",
                    "error": None,
                }

            def _terminal_copy_workdir(self, **kwargs):
                calls.append(("copy", kwargs))
                return subprocess.CompletedProcess([], 0, "", "")

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            server_dir = root / "benchmark_server"
            task_dir = root / "task"
            server_dir.mkdir()
            task_dir.mkdir()
            handle = runner.ToolServerHandle(
                process=None,
                log=None,
                url="http://unused",
                task_container="agent-task-container",
                context={
                    "server_dir": server_dir,
                    "task_dir": task_dir,
                    "task_metadata": {"verifier": {"env": {}}},
                    "settings": SimpleNamespace(verifier_timeout_sec=900),
                    "default_workdir": "/workspace",
                },
            )
            result = runner.finalize_task(
                platform=FakePlatform(),
                benchmark=SimpleNamespace(id="terminal-bench-2", adapter={}),
                case_id="prove-plus-comm",
                mode_dir=root,
                handle=handle,
            )

        self.assertEqual(result["native_score_status"], "completed")
        self.assertEqual(result["native_score"], 0.0)
        verify = calls[0][1]
        self.assertEqual(verify["container"], "agent-task-container")
        self.assertEqual(calls[1][1]["workdir"], "/workspace")


if __name__ == "__main__":
    unittest.main()
