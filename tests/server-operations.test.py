#!/usr/bin/env python3
"""Root-only filesystem boundary and sandbox protocol checks; no real services."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest
from unittest import mock

SPEC = importlib.util.spec_from_file_location("server_operations", Path(__file__).parents[1] / "integrations/server-maintenance/server_operations.py")
ops = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(ops)
ACTOR = "a" * 64
OTHER = "b" * 64


@unittest.skipUnless(os.geteuid() == 0, "root needed to verify ownership constraints")
class OperationsTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.events, self.calls = [], []
        def runner(arguments, timeout):
            self.calls.append((arguments, timeout))
            return subprocess.CompletedProcess(arguments, 0, "ActiveState=active\nSubState=running\nMainPID=20\n")
        self.executor = ops.OperationsExecutor("aliyun", self.audit, base=self.directory.name + "/agent", user="nobody", runner=runner)
        self.counter = 0

    def tearDown(self):
        self.directory.cleanup()

    def audit(self, *args, **kwargs):
        self.events.append((args, kwargs))

    def request(self, operation, actor=ACTOR, **values):
        result = {"action": "operations", "actor": actor, "operation": operation, **values}
        if operation in ops.MUTATIONS and "requestId" not in result:
            self.counter += 1
            result["requestId"] = format(self.counter, "032x")
        return result

    def execute(self, operation, **values):
        return self.executor.execute(self.request(operation, **values))

    def write(self, path="hello.txt", content="hello", expectedSha256="new", **extra):
        return self.execute("file_write", path=path, content=content, expectedSha256=expectedSha256, **extra)

    def test_create_read_update_versions(self):
        result = self.write()
        self.assertTrue(result["written"])
        contents = self.execute("file_read", path="hello.txt")
        self.assertEqual(contents["content"], "hello")
        with self.assertRaisesRegex(ops.OperationError, "file_version_conflict"):
            self.write(content="bad")
        self.write(content="updated", expectedSha256=contents["sha256"])
        self.assertEqual(self.execute("file_read", path="hello.txt")["content"], "updated")
        self.assertEqual(os.stat(self.executor.workspace(ACTOR) + "/hello.txt").st_uid, self.executor.uid)

    def test_paths_are_relative_protected_and_exact_shape(self):
        for path in ("/etc/passwd", "../secret", "ok/../../etc/passwd", "a//b", "a/./b", ".env", "credentials.json", "key.pem", "a\\b", "a\x00b"):
            with self.subTest(path=path), self.assertRaises(ops.OperationError):
                self.execute("file_read", path=path)
        with self.assertRaisesRegex(ops.OperationError, "invalid_operation_fields"):
            self.execute("file_list", path=".", command="whoami")
        with self.assertRaisesRegex(ops.OperationError, "invalid_request_id"):
            self.write(requestId="../../outside")

    def test_symlink_and_hardlink_read_refused(self):
        workspace = self.executor.workspace(ACTOR)
        os.symlink("/etc/passwd", workspace + "/public.txt")
        with self.assertRaises(OSError):
            self.execute("file_read", path="public.txt")
        os.mkdir(workspace + "/outside", 0o700)
        os.chown(workspace + "/outside", self.executor.uid, self.executor.gid)
        os.symlink("/etc", workspace + "/link")
        with self.assertRaises(OSError):
            self.execute("file_read", path="link/os-release")
        self.write(path="one.txt")
        os.link(workspace + "/one.txt", workspace + "/two.txt")
        with self.assertRaisesRegex(ops.OperationError, "unsafe_workspace_file"):
            self.execute("file_read", path="one.txt")

    def test_durable_idempotence_and_collision(self):
        request = self.request("file_write", path="one.txt", content="one", expectedSha256="new")
        first = self.executor.execute(request)
        self.assertFalse(first["idempotent"])
        restarted = ops.OperationsExecutor("aliyun", self.audit, base=self.executor.base, user="nobody")
        again = restarted.execute(request)
        self.assertTrue(again["idempotent"])
        self.assertEqual(first["sha256"], again["sha256"])
        with self.assertRaisesRegex(ops.OperationError, "request_id_collision"):
            restarted.execute({**request, "content": "different"})
        self.assertEqual(len([event for event in self.events if event[0][2] == "started"]), 1)

    def test_pending_durable_receipt_never_repeats_write(self):
        request = self.request("file_write", path="one.txt", content="one", expectedSha256="new")
        digest = hashlib.sha256(json.dumps(request, sort_keys=True, ensure_ascii=True, separators=(",", ":")).encode()).hexdigest()
        self.executor._save_record(self.executor._record_path(ACTOR, request["requestId"]), {"digest": digest, "state": "pending"})
        with self.assertRaisesRegex(ops.OperationError, "operation_uncertain"):
            self.executor.execute(request)
        self.assertFalse(Path(self.executor.workspace(ACTOR), "one.txt").exists())

    def test_audit_failure_prevents_mutation(self):
        def unavailable(*args, **kwargs):
            raise OSError("audit unavailable")
        self.executor.audit = unavailable
        with self.assertRaisesRegex(ops.OperationError, "operation_audit_unavailable"):
            self.write()
        self.assertFalse(Path(self.executor.workspace(ACTOR), "hello.txt").exists())

    def test_move_does_not_overwrite_and_trash_preserves_contents(self):
        self.execute("file_mkdir", path="folder")
        self.write(path="hello.txt", content="preserved")
        self.execute("file_move", path="hello.txt", destination="folder/moved.txt")
        self.write(path="destination.txt")
        with self.assertRaises(ops.OperationError):
            self.execute("file_move", path="folder/moved.txt", destination="destination.txt")
        result = self.execute("file_trash", path="folder/moved.txt")
        self.assertTrue(result["trashed"])
        self.assertEqual(Path(self.executor.workspace(ACTOR), ".trash", result["requestId"]).read_text(), "preserved")

    def test_actor_workspaces_and_service_allowlist(self):
        self.write()
        with self.assertRaises(FileNotFoundError):
            self.execute("file_read", actor=OTHER, path="hello.txt")
        for service, verb in (("sshd.service", "restart"), ("nginx.service", "stop"), ("originmind-maintenance.service", "restart"), ("nginx;id", "start")):
            with self.assertRaisesRegex(ops.OperationError, "invalid_service_operation"):
                self.execute("service", service=service, verb=verb)
        result = self.execute("service", service="nginx.service", verb="reload")
        self.assertTrue(result["accepted"])
        self.assertEqual(self.calls[0][0], ["/usr/bin/systemctl", "reload", "nginx.service"])

    def test_systemd_sandbox_never_uses_root_or_inherited_environment(self):
        arguments = self.executor.command_arguments(ACTOR, "f" * 32, "python3 -c 'print(1)'", 30)
        self.assertIn("--uid=" + str(self.executor.uid), arguments)
        self.assertNotIn("--uid=0", arguments)
        self.assertIn("--property=ProtectSystem=strict", arguments)
        self.assertIn("--property=CapabilityBoundingSet=", arguments)
        self.assertIn("--property=NoNewPrivileges=yes", arguments)
        self.assertIn("--property=InaccessiblePaths=/proc /sys", arguments)
        self.assertIn("--property=IPAddressAllow=127.0.0.53/32", arguments)
        self.assertEqual(arguments[arguments.index("/usr/bin/env") + 1], "-i")
        self.assertIn("--property=RuntimeMaxSec=30s", arguments)
        self.assertIn("--property=ReadWritePaths=" + self.executor.workspace(ACTOR), arguments)
        temporary = next(arg for arg in arguments if arg.startswith("--property=TemporaryFileSystem="))
        for protected in ("/etc:ro", "/opt:ro", "/var/lib:ro", "/var/log:ro", "/run:ro"):
            self.assertIn(protected, temporary)
        self.assertNotIn("/etc/originmind", " ".join(arguments))
        self.assertEqual(arguments[-4:], ["--noprofile", "--norc", "-c", "python3 -c 'print(1)'"])

    def test_job_captured_bounded_redacted_and_actor_bound(self):
        original = subprocess.Popen
        started = []
        def start(arguments, **kwargs):
            started.append((arguments, kwargs))
            return original([sys.executable, "-c", "print('api_key=sk-testsecret123456789'); print('x' * 30000)"], **kwargs)
        with mock.patch.object(ops.subprocess, "Popen", start):
            result = self.execute("command_start", command="echo safe", timeoutSeconds=10)
        job_id = result["jobId"]
        for _ in range(100):
            result = self.execute("job_status", jobId=job_id)
            if result["state"] != "running":
                break
            time.sleep(0.01)
        self.assertEqual(result["state"], "succeeded")
        self.assertTrue(result["outputLimited"])
        self.assertLessEqual(len(result["output"]), ops.MAX_OUTPUT)
        self.assertNotIn("sk-testsecret", result["output"])
        self.assertEqual(started[0][1]["env"], {"PATH": "/usr/bin:/bin", "LC_ALL": "C", "SYSTEMD_COLORS": "0"})
        with self.assertRaisesRegex(ops.OperationError, "job_not_found"):
            self.execute("job_status", actor=OTHER, jobId=job_id)
        restarted = ops.OperationsExecutor("aliyun", self.audit, base=self.executor.base, user="nobody")
        self.assertEqual(restarted.execute(self.request("job_status", jobId=job_id))["state"], "succeeded")

    def test_workspace_write_rejected_while_job_active(self):
        self.executor.jobs["f" * 32] = {"actor": ACTOR, "state": "running"}
        with self.assertRaisesRegex(ops.OperationError, "workspace_job_in_progress"):
            self.write()

    def test_job_stops_when_host_disk_reserve_is_reached(self):
        process = subprocess.Popen([sys.executable, "-c", "import time;time.sleep(5)"], stdout=subprocess.PIPE)
        job = {"jobId": "e" * 32, "actor": ACTOR, "state": "running", "startedAt": 1,
               "output": "", "outputLimited": False, "exitCode": None, "process": process, "timeout": 10}
        def stop(arguments, timeout):
            self.assertEqual(arguments[:2], ["/usr/bin/systemctl", "stop"])
            process.kill()
            return subprocess.CompletedProcess(arguments, 0, "")
        self.executor.runner = stop
        usage = type("DiskUsage", (), {"free": 100})()
        with mock.patch.object(ops.shutil, "disk_usage", return_value=usage):
            self.executor._collect_job(job)
        self.assertEqual(job["stopReason"], "storage_reserve")
        self.assertEqual(job["state"], "failed")

    def test_redaction_and_bounds(self):
        self.write(content="api_key=sk-testsecret123456789\nhello")
        result = self.execute("file_read", path="hello.txt")
        self.assertTrue(result["redacted"])
        self.assertNotIn("sk-testsecret", result["content"])
        with self.assertRaisesRegex(ops.OperationError, "invalid_file_content"):
            self.write(content="a" * (ops.MAX_CONTENT + 1))
        with self.assertRaisesRegex(ops.OperationError, "invalid_job_timeout"):
            self.execute("command_start", command="pwd", timeoutSeconds=9000)


if __name__ == "__main__":
    unittest.main()
