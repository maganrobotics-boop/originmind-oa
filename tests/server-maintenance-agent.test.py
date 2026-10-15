#!/usr/bin/env python3
"""Security and behavior tests for the private maintenance agent."""

import hashlib
import hmac
import http.client
import http.server
import importlib.util
import io
import json
import os
from pathlib import Path
import sys
import tempfile
import threading
import unittest
from unittest import mock


SOURCE = Path(__file__).resolve().parents[1] / "integrations/server-maintenance/agent.py"
SPEC = importlib.util.spec_from_file_location("maintenance_agent", SOURCE)
agent_module = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(agent_module)
ACTOR = "a" * 64
OTHER_ACTOR = "b" * 64
SECRET = "test-only-maintenance-secret-" + "c" * 32
NOW = 1792044000.0
DISK = {"totalBytes": 1000, "usedBytes": 600, "availableBytes": 400, "usedPercent": 60.0}


@unittest.skipUnless(os.geteuid() == 0, "Filesystem security tests require root ownership")
class MaintenanceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="maintenance-agent-tests-")
        self.base = Path(self.temp.name)
        self.apt = self.base / "apt"
        self.cache = self.base / "cache"
        self.tmp = self.base / "tmp"
        for root in (self.apt, self.cache, self.tmp):
            root.mkdir(mode=0o700)
        self.now = NOW
        self.audit = self.base / "audit.jsonl"
        self.agent = agent_module.MaintenanceAgent(
            "aliyun", SECRET,
            roots=(("apt_packages", str(self.apt), False, ".deb"),
                   ("maintenance_tmp", str(self.tmp), True, None),
                   ("maintenance_cache", str(self.cache), True, None)),
            clock=lambda: self.now, audit_path=str(self.audit),
            disk_provider=lambda: dict(DISK),
            status_provider=lambda server: {"disk": dict(DISK), "services": {"nginx.service": "active"}})

    def tearDown(self):
        self.temp.cleanup()

    def create_file(self, path, data=b"cache", old=True):
        path.write_bytes(data)
        path.chmod(0o600)
        modified = NOW - agent_module.MIN_AGE - 60 if old else NOW - 30
        os.utime(path, (modified, modified))
        return path

    def signed(self, payload, *, timestamp=None, nonce=None, secret=SECRET):
        body = json.dumps(payload, separators=(",", ":")).encode()
        timestamp = str(int(self.now)) if timestamp is None else str(timestamp)
        nonce = os.urandom(16).hex() if nonce is None else nonce
        canonical = timestamp.encode() + b"\n" + nonce.encode() + b"\n" + body
        signature = hmac.new(secret.encode(), canonical, hashlib.sha256).hexdigest()
        return {"x-maintenance-time": timestamp, "x-maintenance-nonce": nonce,
                "authorization": "Maintenance-HMAC " + signature}, body

    def call(self, action="status", actor=ACTOR, **kwargs):
        headers, body = self.signed({"action": action, "actor": actor, **kwargs})
        return self.agent.handle(headers, body)

    def assert_error(self, code, callback):
        with self.assertRaises(agent_module.MaintenanceError) as caught:
            callback()
        self.assertEqual(caught.exception.code, code)

    def test_status_and_audit_contains_no_secret_or_paths(self):
        result = self.call()
        self.assertTrue(result["ok"])
        self.assertEqual(result["server"], "aliyun")
        self.assertEqual(result["disk"], DISK)
        audit = self.audit.read_text()
        self.assertIn(ACTOR, audit)
        self.assertNotIn(SECRET, audit)
        self.assertNotIn(str(self.base), audit)

    def test_invalid_signature_and_stale_request_rejected(self):
        headers, body = self.signed({"action": "status", "actor": ACTOR}, secret="wrong")
        self.assert_error("unauthorized", lambda: self.agent.handle(headers, body))
        for stamp in (int(self.now) - 61, int(self.now) + 61):
            headers, body = self.signed({"action": "status", "actor": ACTOR}, timestamp=stamp)
            self.assert_error("expired_signature", lambda: self.agent.handle(headers, body))

    def test_nonce_replay_rejected_and_signed_body_cannot_change(self):
        headers, body = self.signed({"action": "status", "actor": ACTOR})
        self.agent.handle(headers, body)
        self.assert_error("replayed_request", lambda: self.agent.handle(headers, body))
        self.assert_error("unauthorized", lambda: self.agent.handle(headers, body + b" "))

    def test_nonce_capacity_rejects_new_requests_instead_of_evicting(self):
        self.agent.nonces = {str(i): self.now + 100 for i in range(agent_module.MAX_NONCES)}
        self.assert_error("nonce_capacity", self.call)
        self.now += 122
        self.assertTrue(self.call()["ok"])

    def test_exact_schema_rejects_arbitrary_path_command_service_and_actors(self):
        for extra in ({"path": "/etc"}, {"command": "rm"}, {"server": "tencent"}, {"service": "sshd"}):
            self.assert_error("invalid_request", lambda extra=extra: self.call(**extra))
        self.assert_error("invalid_request", lambda: self.call(actor="admin"))
        self.assert_error("invalid_request", lambda: self.call("execute"))
        self.assert_error("invalid_request", lambda: self.call(planId="a" * 64))

    def test_duplicate_json_fields_and_large_body_rejected(self):
        body = ('{"action":"status","actor":"' + ACTOR + '","action":"clean"}').encode()
        self.assert_error("invalid_json", lambda: self.agent.parse_request(body))
        self.assert_error("body_too_large", lambda: self.agent.handle({}, b"x" * (agent_module.MAX_BODY + 1)))

    def test_plan_selects_old_eligible_files_only_and_does_not_delete(self):
        old = self.create_file(self.apt / "old.deb", b"123")
        self.create_file(self.apt / "new.deb", old=False)
        self.create_file(self.apt / "not-package.txt")
        nested = self.apt / "nested"
        nested.mkdir(mode=0o700)
        self.create_file(nested / "nested.deb")
        self.create_file(self.cache / "cache.bin", b"1234")
        result = self.call("plan")
        self.assertEqual(result["candidateCount"], 2)
        self.assertEqual(result["candidateBytes"], 7)
        self.assertEqual(result["categories"][0]["name"], "apt_packages")
        self.assertTrue(old.exists())
        self.assertNotIn(str(self.base), json.dumps(result))

    def test_recursive_cleanup_and_idempotence(self):
        nested = self.tmp / "nested"
        nested.mkdir(mode=0o700)
        old = self.create_file(nested / "old.bin", b"123456")
        plan = self.call("plan")
        clean = self.call("clean", planId=plan["planId"])
        self.assertEqual(clean["deletedCount"], 1)
        self.assertEqual(clean["deletedBytes"], 6)
        self.assertEqual(clean["diskBefore"], DISK)
        self.assertEqual(clean["diskAfter"], DISK)
        self.assertFalse(old.exists())
        repeat = self.call("clean", planId=plan["planId"])
        self.assertTrue(repeat["idempotent"])
        self.assertEqual(repeat["deletedCount"], 1)

    def test_missing_plan_wrong_actor_and_expired_plan_do_not_delete(self):
        old = self.create_file(self.cache / "old.bin")
        self.assert_error("plan_not_found", lambda: self.call("clean", planId="f" * 64))
        plan = self.call("plan")
        self.assert_error("plan_not_found", lambda: self.call("clean", actor=OTHER_ACTOR, planId=plan["planId"]))
        self.now += agent_module.PLAN_TTL + 1
        self.assert_error("plan_expired", lambda: self.call("clean", planId=plan["planId"]))
        self.assertTrue(old.exists())

    def test_symlinks_hardlinks_and_insecure_directories_excluded(self):
        target = self.create_file(self.base / "outside.bin")
        (self.cache / "link.bin").symlink_to(target)
        os.link(target, self.cache / "hard.bin")
        nested = self.cache / "insecure"
        nested.mkdir(mode=0o777)
        nested.chmod(0o777)
        self.create_file(nested / "old.bin")
        self.assertEqual(self.call("plan")["candidateCount"], 0)
        self.assertTrue(target.exists())

    def test_root_symlink_or_world_writable_root_rejected(self):
        self.cache.chmod(0o777)
        self.assertEqual(self.call("plan")["candidateCount"], 0)
        self.cache.chmod(0o700)
        self.cache.rmdir()
        self.cache.symlink_to(self.tmp, target_is_directory=True)
        self.create_file(self.tmp / "one.bin")
        result = self.call("plan")
        self.assertEqual(result["candidateCount"], 1)
        self.assertFalse(result["categories"][2]["safe"])

    def test_credentials_databases_logs_and_business_directories_excluded(self):
        for name in (".env", "private.key", "access-token", "application.log", "oa.sqlite3", "database.db", "uploaded-file", "deploy.tar"):
            self.create_file(self.cache / name)
        sensitive = self.cache / "keys"
        sensitive.mkdir(mode=0o700)
        self.create_file(sensitive / "innocent.bin")
        self.assertEqual(self.call("plan")["candidateCount"], 0)

    def test_changed_mtime_inode_and_replaced_symlink_skipped(self):
        files = [self.create_file(self.cache / (name + ".bin")) for name in ("mtime", "inode", "symlink")]
        outside = self.create_file(self.base / "outside.bin")
        plan = self.call("plan")
        os.utime(files[0], None)
        files[1].unlink()
        self.create_file(files[1], b"different")
        files[2].unlink()
        files[2].symlink_to(outside)
        result = self.call("clean", planId=plan["planId"])
        self.assertEqual(result["deletedCount"], 0)
        self.assertEqual(result["skippedCount"], 3)
        self.assertTrue(outside.exists())

    def test_parent_directory_swap_and_root_replacement_skipped(self):
        nested = self.cache / "nested"
        nested.mkdir(mode=0o700)
        outside = self.base / "outside"
        outside.mkdir(mode=0o700)
        self.create_file(nested / "old.bin")
        self.create_file(outside / "old.bin")
        plan = self.call("plan")
        nested.rename(self.cache / "moved")
        nested.symlink_to(outside, target_is_directory=True)
        result = self.call("clean", planId=plan["planId"])
        self.assertEqual(result["skippedCount"], 1)
        self.assertTrue((outside / "old.bin").exists())
        self.cache.rename(self.base / "old-root")
        self.cache.mkdir(mode=0o700)
        self.create_file(self.cache / "new.bin")
        self.assertFalse(self.agent.remove_entry(self.agent.plans[plan["planId"]]["entries"][0]))

    def test_cross_device_directory_and_file_excluded(self):
        self.create_file(self.cache / "old.bin")
        original_scandir = os.scandir

        class DifferentDeviceEntry:
            name = "old.bin"

            def stat(inner_self, follow_symlinks):
                original = (self.cache / "old.bin").stat()
                values = list(original)
                values[2] = original.st_dev + 1
                return os.stat_result(values)

        class DifferentDeviceScan:
            def __enter__(inner_self):
                return iter([DifferentDeviceEntry()])

            def __exit__(inner_self, *args):
                pass

        def scan(directory_fd):
            if os.fstat(directory_fd).st_ino == self.cache.stat().st_ino:
                return DifferentDeviceScan()
            return original_scandir(directory_fd)

        with mock.patch.object(agent_module.os, "scandir", side_effect=scan):
            self.assertEqual(self.call("plan")["candidateCount"], 0)
        # A mount point is refused by its device ID before traversal.
        entry = self.call("plan")
        manifest = self.agent.plans[entry["planId"]]["entries"][0]
        manifest["rootIdentity"] = (manifest["rootIdentity"][0] + 1, manifest["rootIdentity"][1])
        self.assertFalse(self.agent.remove_entry(manifest))

    def test_file_count_and_byte_limits(self):
        for number in range(4):
            self.create_file(self.cache / (str(number) + ".bin"), b"123")
        with mock.patch.object(agent_module, "MAX_FILES", 2):
            result = self.call("plan")
            self.assertEqual(result["candidateCount"], 2)
            self.assertTrue(result["limited"])
        with mock.patch.object(agent_module, "MAX_BYTES", 5):
            result = self.call("plan")
            self.assertEqual(result["candidateCount"], 1)
            self.assertEqual(result["candidateBytes"], 3)
            self.assertTrue(result["limited"])

    def test_plan_cache_bounded_and_expiration_releases_capacity(self):
        with mock.patch.object(agent_module, "MAX_PLANS", 2):
            self.call("plan")
            self.call("plan")
            self.assert_error("plan_capacity", lambda: self.call("plan"))
            self.now += agent_module.PLAN_TTL + 1
            self.assertTrue(self.call("plan")["ok"])

    def test_audit_failure_prevents_cleanup(self):
        old = self.create_file(self.cache / "old.bin")
        plan = self.call("plan")
        self.audit.unlink()
        self.audit.symlink_to(self.base / "never-create")
        self.assert_error("audit_unavailable", lambda: self.call("clean", planId=plan["planId"]))
        self.assertTrue(old.exists())
        self.assertFalse((self.base / "never-create").exists())

    def test_post_cleanup_audit_failure_is_pending_and_retry_is_idempotent(self):
        old = self.create_file(self.cache / "old.bin")
        plan = self.call("plan")
        original_audit = self.agent.audit

        def fail_completion(actor, action, result, **metadata):
            if action == "clean" and result == "ok":
                raise OSError("test audit failure")
            return original_audit(actor, action, result, **metadata)

        with mock.patch.object(self.agent, "audit", side_effect=fail_completion):
            self.assert_error("audit_pending", lambda: self.call("clean", planId=plan["planId"]))
        self.assertFalse(old.exists())
        retry = self.call("clean", planId=plan["planId"])
        self.assertTrue(retry["idempotent"])
        self.assertEqual(retry["deletedCount"], 1)

    def test_config_permission_and_extra_keys_rejected(self):
        config = self.base / "config.json"
        config.write_text(json.dumps({"server": "aliyun", "secret": SECRET}))
        config.chmod(0o600)
        self.assertEqual(agent_module.load_config(str(config))["server"], "aliyun")
        config.chmod(0o644)
        with self.assertRaises(ValueError):
            agent_module.load_config(str(config))
        config.chmod(0o600)
        config.write_text(json.dumps({"server": "aliyun", "secret": SECRET, "roots": ["/"]}))
        with self.assertRaises(ValueError):
            agent_module.load_config(str(config))

    def test_diagnostic_schema_is_topic_specific_and_server_specific(self):
        valid = {"topic": "service", "service": "nginx.service"}
        with mock.patch.object(self.agent, "diagnostic_provider", return_value={"topic": "service", "properties": {"ActiveState": "active"}}) as provider:
            result = self.call("diagnostic", **valid)
            self.assertTrue(result["ok"])
            self.assertEqual(result["action"], "diagnostic")
            provider.assert_called_once_with("aliyun", {"action": "diagnostic", "actor": ACTOR, **valid})
        self.assertIn('"topic":"service"', self.audit.read_text())
        for arguments, error in (
            ({"topic": "shell", "command": "id"}, "invalid_request"),
            ({"topic": "processes", "path": "/"}, "invalid_request"),
            ({"topic": "processes", "planId": "a" * 64}, "invalid_request"),
            ({"topic": "service", "service": "ssh.service"}, "invalid_service"),
            ({"topic": "service", "service": "docker.service"}, "invalid_service"),
            ({"topic": "logs", "service": "nginx.service;id"}, "invalid_service"),
            ({"topic": "logs"}, "invalid_service"),
            ({"topic": "disk", "path": "/etc"}, "invalid_diagnostic_path"),
            ({"topic": "disk", "path": "/var/../etc"}, "invalid_diagnostic_path"),
            ({"topic": "disk", "path": "/var/"}, "invalid_diagnostic_path"),
            ({"topic": ["disk"]}, "invalid_diagnostic"),
        ):
            self.assert_error(error, lambda arguments=arguments: self.call("diagnostic", **arguments))

    def test_service_diagnostics_only_request_fixed_properties(self):
        output = "Id=nginx.service\nActiveState=active\nMainPID=123\nEnvironment=not-allowed\n"
        with mock.patch.object(agent_module, "bounded_command", return_value=(output, False)) as command:
            result = agent_module.service_diagnostic("nginx.service")
        self.assertEqual(result["properties"], {"Id": "nginx.service", "ActiveState": "active", "MainPID": "123"})
        arguments = command.call_args.args[0]
        self.assertEqual(arguments[:3], ["/usr/bin/systemctl", "show", "nginx.service"])
        self.assertNotIn("Environment", " ".join(arguments))
        self.assertNotIn("ExecStart", " ".join(arguments))

    def test_journal_diagnostics_redact_secrets_and_bound_response(self):
        messages = [
            'BAILIAN_API_KEY=very-private-value password="private value with spaces"',
            'Authorization: Bearer private-bearer-value',
            '{"Cookie":"private-cookie-value"}',
            'postgres://user:private-db-password@localhost/db user@example.com',
            'https://example.test/path?access_token=private-query-value&ok=1',
            '-----BEGIN PRIVATE KEY----- private-key-material',
            '\x1b[31m正常服务\x00运行',
        ]
        output = "\n".join(json.dumps({"MESSAGE": message, "__REALTIME_TIMESTAMP": "1792044000000000", "PRIORITY": "3"}) for message in messages)
        with mock.patch.object(agent_module, "bounded_command", return_value=(output, False)) as command:
            result = agent_module.log_diagnostic("nginx.service")
        encoded = json.dumps(result)
        for secret in ("very-private-value", "private value with spaces", "private-bearer-value", "private-cookie-value", "private-db-password", "user@example.com", "private-query-value", "private-key-material"):
            self.assertNotIn(secret, encoded)
        self.assertTrue(result["redacted"])
        self.assertTrue(result["sourceIsUntrusted"])
        self.assertEqual(result["entries"][-1]["message"], "正常服务 运行")
        self.assertIn("--lines=50", command.call_args.args[0])
        self.assertIn("--since=-1 hour", command.call_args.args[0])
        huge = "\n".join(json.dumps({"MESSAGE": "中" * 400}) for _ in range(50))
        with mock.patch.object(agent_module, "bounded_command", return_value=(huge, False)):
            bounded = agent_module.log_diagnostic("nginx.service")
        self.assertTrue(bounded["limited"])
        self.assertLess(len(json.dumps(bounded, ensure_ascii=True).encode()), 17000)

    def test_bounded_command_limits_output_and_runtime(self):
        output, limited = agent_module.bounded_command([sys.executable, "-c", "print('x' * 10000)"], max_bytes=64)
        self.assertEqual(len(output), 64)
        self.assertTrue(limited)
        output, limited = agent_module.bounded_command([sys.executable, "-c", "import time; time.sleep(10)"], timeout=0.05)
        self.assertEqual(output, "")
        self.assertTrue(limited)
        self.assert_error("diagnostic_unavailable", lambda: agent_module.bounded_command(["/does/not/exist"]))
        with mock.patch.dict(os.environ, {"TEST_MAINTENANCE_CREDENTIAL": "test-only-sensitive-value"}):
            output, limited = agent_module.bounded_command([sys.executable, "-c", "import os; print(os.environ.get('TEST_MAINTENANCE_CREDENTIAL', 'absent'))"])
        self.assertEqual(output.strip(), "absent")
        self.assertFalse(limited)

    def test_process_sample_reads_stat_only_and_parses_names_with_parentheses(self):
        fields = ["S"] + ["0"] * 21
        fields[11], fields[12], fields[19], fields[21] = "12", "3", "500", "7"
        raw = "42 (worker (safe)) " + " ".join(fields)

        class ProcessEntry:
            name = "42"

            def stat(inner_self, follow_symlinks):
                return mock.Mock(st_uid=1000)

        class ProcessScan:
            def __enter__(inner_self):
                return iter([ProcessEntry()])

            def __exit__(inner_self, *args):
                pass

        with mock.patch.object(agent_module.os, "scandir", return_value=ProcessScan()), mock.patch("builtins.open", return_value=io.StringIO(raw)) as opened:
            result = agent_module.process_sample()
        opened.assert_called_once_with("/proc/42/stat", encoding="utf-8", errors="replace")
        self.assertEqual(result[42]["name"], "worker (safe)")
        self.assertEqual(result[42]["cpuTicks"], 15)
        self.assertEqual(result[42]["uid"], 1000)
        self.assertEqual(result[42]["residentBytes"], 7 * os.sysconf("SC_PAGE_SIZE"))

    def test_process_diagnostics_use_samples_without_arguments_or_environments(self):
        first = {1: {"pid": 1, "name": "one", "uid": 0, "state": "S", "residentBytes": 100, "cpuTicks": 10, "started": 1},
                 2: {"pid": 2, "name": "two", "uid": 1000, "state": "R", "residentBytes": 200, "cpuTicks": 1, "started": 2}}
        second = {1: {**first[1], "cpuTicks": 11}, 2: {**first[2], "cpuTicks": 30},
                  3: {"pid": 3, "name": "new", "uid": 0, "state": "S", "residentBytes": 300, "cpuTicks": 100, "started": 3}}
        with mock.patch.object(agent_module, "process_sample", side_effect=[first, second]), mock.patch.object(agent_module.time, "sleep"), mock.patch.object(agent_module.time, "monotonic", side_effect=[10, 10.2]):
            result = agent_module.process_diagnostic()
        self.assertEqual(result["topCpu"][0]["pid"], 2)
        self.assertEqual(result["topMemory"][0]["pid"], 3)
        self.assertEqual(result["topMemory"][0]["cpuPercent"], 0)
        self.assertEqual(set(result["topCpu"][0]), {"pid", "name", "uid", "state", "residentBytes", "cpuTicks", "cpuPercent"})

    def test_disk_diagnostics_only_read_metadata_and_skip_private_names_and_links(self):
        directory = self.base / "data"
        directory.mkdir(mode=0o700)
        public_file = self.create_file(directory / "public-filename-never-returned", b"public data")
        secret_file = self.create_file(directory / "private-secret", b"secret content")
        outside = self.create_file(self.base / "outside", b"outside data")
        (directory / "symlink").symlink_to(outside)
        self.create_file(self.base / "direct-filename-never-returned", b"direct data")
        permitted = frozenset((str(self.base), str(directory)))
        with mock.patch.object(agent_module, "DIAGNOSTIC_PATHS", permitted), mock.patch("builtins.open", side_effect=AssertionError("file contents must never be read")):
            result = agent_module.disk_diagnostic(str(self.base))
        encoded = json.dumps(result)
        self.assertNotIn(public_file.name, encoded)
        self.assertNotIn(secret_file.name, encoded)
        self.assertNotIn("secret content", encoded)
        self.assertNotIn("direct-filename-never-returned", encoded)
        self.assertTrue(result["metadataOnly"])
        self.assertGreaterEqual(result["skippedEntries"], 2)
        item = next(item for item in result["directories"] if item["name"] == "data")
        self.assertTrue(item["queryable"])
        self.assertTrue(item["complete"])
        self.assertTrue(result["complete"])
        self.assertFalse(result["limited"])
        self.assertEqual(result["bytes"], result["scannedBytes"])
        self.assertEqual(item["bytes"], directory.stat().st_blocks * 512 + public_file.stat().st_blocks * 512)
        self.assert_error("invalid_diagnostic_path", lambda: agent_module.disk_diagnostic(str(self.base)))

    def test_disk_diagnostics_scan_limit_and_symlink_root_are_safe(self):
        self.create_file(self.cache / "one")
        self.create_file(self.cache / "two")
        with mock.patch.object(agent_module, "DIAGNOSTIC_PATHS", frozenset((str(self.cache),))), mock.patch.object(agent_module, "DIAGNOSTIC_MAX_ENTRIES", 1):
            result = agent_module.disk_diagnostic(str(self.cache))
        self.assertTrue(result["limited"])
        self.assertFalse(result["complete"])
        self.assertIsNone(result["bytes"])
        self.assertIsNone(result["directFilesBytes"])
        self.assertGreaterEqual(result["scannedBytes"], self.cache.stat().st_blocks * 512)
        self.assertEqual(result["measurement"], "allocated_bytes_partial_lower_bound")
        self.cache.rename(self.base / "real-cache")
        self.cache.symlink_to(self.base / "real-cache", target_is_directory=True)
        with mock.patch.object(agent_module, "DIAGNOSTIC_PATHS", frozenset((str(self.cache),))):
            self.assert_error("diagnostic_path_unavailable", lambda: agent_module.disk_diagnostic(str(self.cache)))

    def test_partial_disk_measurement_cannot_present_lower_bounds_as_totals(self):
        small = self.cache / "small"
        large = self.cache / "large"
        untouched = self.cache / "untouched"
        for directory in (small, large, untouched):
            directory.mkdir(mode=0o700)
        self.create_file(small / "one")
        for name in ("one", "two", "three", "four"):
            self.create_file(large / name)
        self.create_file(untouched / "one")
        # Directory names are discovered before deep traversal. The first
        # completed sibling keeps a total; incomplete siblings expose only a
        # lower bound, including a sibling not traversed at all.
        original_scandir = agent_module.os.scandir

        class SortedScan:
            def __init__(inner_self, fd):
                inner_self.iterator = original_scandir(fd)

            def __enter__(inner_self):
                return iter(sorted(inner_self.iterator, key=lambda item: ({"small": 0, "large": 1, "untouched": 2}.get(item.name, 3), item.name)))

            def __exit__(inner_self, *args):
                inner_self.iterator.close()

        with mock.patch.object(agent_module, "DIAGNOSTIC_PATHS", frozenset((str(self.cache),))), mock.patch.object(agent_module, "DIAGNOSTIC_MAX_ENTRIES", 6), mock.patch.object(agent_module.os, "scandir", side_effect=SortedScan):
            result = agent_module.disk_diagnostic(str(self.cache))
        rows = {item["name"]: item for item in result["directories"]}
        self.assertEqual(set(rows), {"small", "large", "untouched"})
        self.assertTrue(rows["small"]["complete"])
        self.assertIsNotNone(rows["small"]["bytes"])
        self.assertFalse(rows["large"]["complete"])
        self.assertIsNone(rows["large"]["bytes"])
        self.assertGreater(rows["large"]["scannedBytes"], 0)
        self.assertFalse(rows["untouched"]["complete"])
        self.assertIsNone(rows["untouched"]["bytes"])
        self.assertEqual(rows["untouched"]["scannedBytes"], 0)
        self.assertIsNone(result["bytes"])
        self.assertTrue(result["limited"])

    def test_disk_deadline_and_display_truncation_have_distinct_completeness(self):
        self.create_file(self.cache / "one")
        with mock.patch.object(agent_module, "DIAGNOSTIC_PATHS", frozenset((str(self.cache),))), mock.patch.object(agent_module.time, "monotonic", side_effect=[0, 6]):
            timed_out = agent_module.disk_diagnostic(str(self.cache))
        self.assertTrue(timed_out["limited"])
        self.assertFalse(timed_out["complete"])
        self.assertIsNone(timed_out["bytes"])
        for number in range(21):
            (self.cache / ("dir-" + str(number))).mkdir(mode=0o700)
        with mock.patch.object(agent_module, "DIAGNOSTIC_PATHS", frozenset((str(self.cache),))):
            complete = agent_module.disk_diagnostic(str(self.cache))
        self.assertTrue(complete["complete"])
        self.assertFalse(complete["limited"])
        self.assertIsNotNone(complete["bytes"])
        self.assertTrue(complete["directoryListTruncated"])
        self.assertEqual(len(complete["directories"]), 20)

    def test_http_signature_headers_endpoint_body_limit_and_status(self):
        server = http.server.HTTPServer(("127.0.0.1", 0), agent_module.Handler)
        server.agent = self.agent
        worker = threading.Thread(target=server.serve_forever, daemon=True)
        worker.start()
        try:
            def request(method, path, body=None, headers=None):
                client = http.client.HTTPConnection("127.0.0.1", server.server_port, timeout=3)
                client.request(method, path, body=body, headers=headers or {})
                response = client.getresponse()
                status, result = response.status, json.loads(response.read())
                client.close()
                return status, result
            headers, body = self.signed({"action": "status", "actor": ACTOR})
            headers["Content-Type"] = "application/json"
            status, data = request("POST", "/v1/maintenance", body, headers)
            self.assertEqual(status, 200)
            self.assertTrue(data["ok"])
            with mock.patch.object(self.agent, "diagnostic_provider", return_value={"topic": "processes", "processCount": 3}):
                diagnostic_headers, diagnostic_body = self.signed({"action": "diagnostic", "actor": ACTOR, "topic": "processes"})
                diagnostic_headers["Content-Type"] = "application/json"
                diagnostic_status, diagnostic_data = request("POST", "/v1/maintenance", diagnostic_body, diagnostic_headers)
            self.assertEqual(diagnostic_status, 200)
            self.assertEqual(diagnostic_data["processCount"], 3)
            self.assertEqual(request("GET", "/v1/maintenance")[0], 405)
            self.assertEqual(request("POST", "/other", b"{}")[0], 404)
            self.assertEqual(request("POST", "/v1/maintenance", b"{}", {"Content-Type": "application/json"})[0], 400)
            large_headers = {**headers, "Content-Length": str(agent_module.MAX_BODY + 1)}
            self.assertEqual(request("POST", "/v1/maintenance", b"x" * (agent_module.MAX_BODY + 1), large_headers)[0], 413)
        finally:
            server.shutdown()
            server.server_close()
            worker.join(timeout=2)


if __name__ == "__main__":
    unittest.main(verbosity=2)
