#!/usr/bin/env python3
"""Private, fixed-action server maintenance agent. Python 3 standard library only.

Production listens exclusively on 127.0.0.1:18893. The caller cannot supply a
command, service, filename, directory, or cleanup rule. Secrets stay in a root
owned configuration file and are never returned or written to the audit log.
"""

import argparse
import collections
import hashlib
import hmac
import http.server
import json
import os
import platform
import re
import secrets
import socket
import stat
import subprocess
import threading
import time


ROOTS = (
    ("apt_packages", "/var/cache/apt/archives", False, ".deb"),
    ("maintenance_tmp", "/tmp/omindos-ai-maintenance", True, None),
    ("maintenance_cache", "/var/cache/omindos-maintenance", True, None),
)
SERVICES = {
    "aliyun": ("nginx.service", "originmind-oa.service", "originmind-chat.service"),
    "tencent": ("nginx.service", "docker.service", "originmind-arena.service", "originmind-cloud-mcp.service"),
}
MAX_BODY = 8192
MAX_FILES = 500
MAX_BYTES = 500 * 1024 * 1024
MAX_SCAN_ENTRIES = 10000
MAX_DEPTH = 16
PLAN_TTL = 600
MAX_PLANS = 32
MAX_NONCES = 4096
MIN_AGE = 7 * 24 * 3600
ACTOR_RE = re.compile(r"^[a-f0-9]{64}$")
PLAN_RE = re.compile(r"^[a-f0-9]{64}$")
NONCE_RE = re.compile(r"^[A-Za-z0-9_-]{16,128}$")
TIMESTAMP_RE = re.compile(r"^[0-9]{10}$")
AUTH_RE = re.compile(r"^Maintenance-HMAC ([a-fA-F0-9]{64})$")
PROTECTED_NAME_RE = re.compile(r"(?:^\.env(?:\.|$)|(?:key|secret|credential|password|token|database|backup|upload|deploy)|\.(?:pem|p12|pfx|crt|db|sqlite|sqlite3|log|jsonl)(?:\.|$))", re.IGNORECASE)
DIR_FLAGS = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC
FILE_FLAGS = os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC | os.O_NONBLOCK


class MaintenanceError(Exception):
    def __init__(self, code, status=400):
        super().__init__(code)
        self.code = code
        self.status = status


def identity(value):
    return (value.st_dev, value.st_ino, value.st_size, value.st_mtime_ns,
            value.st_ctime_ns, value.st_mode, value.st_uid, value.st_nlink)


def secure_directory(value):
    return stat.S_ISDIR(value.st_mode) and value.st_uid == 0 and not value.st_mode & 0o022


def regular_candidate(value):
    return (stat.S_ISREG(value.st_mode) and value.st_uid == 0 and
            value.st_nlink == 1 and not value.st_mode & 0o022)


def open_root(path):
    """Walk fixed absolute paths using directory descriptors and no symlinks."""
    if not os.path.isabs(path) or os.path.normpath(path) != path:
        raise MaintenanceError("unsafe_root", 500)
    fd = os.open("/", DIR_FLAGS)
    current = ""
    try:
        for component in path.split("/")[1:]:
            if not component or component in (".", ".."):
                raise MaintenanceError("unsafe_root", 500)
            next_fd = os.open(component, DIR_FLAGS, dir_fd=fd)
            os.close(fd)
            fd = next_fd
            current += "/" + component
            info = os.fstat(fd)
            # /tmp is a sticky root-owned ancestor, never itself a cleanup root.
            sticky_tmp = (current == "/tmp" and current != path and
                          info.st_uid == 0 and bool(info.st_mode & stat.S_ISVTX))
            if not secure_directory(info) and not sticky_tmp:
                raise MaintenanceError("unsafe_root", 409)
        return fd
    except BaseException:
        os.close(fd)
        raise


def disk_status():
    info = os.statvfs("/")
    unit = info.f_frsize
    total, used = info.f_blocks * unit, (info.f_blocks - info.f_bfree) * unit
    return {"totalBytes": total, "usedBytes": used,
            "availableBytes": info.f_bavail * unit,
            "usedPercent": round(100 * used / (used + info.f_bavail * unit), 1) if used + info.f_bavail * unit else 0}


def system_status(server):
    memory = {}
    with open("/proc/meminfo", encoding="ascii") as handle:
        for line in handle:
            name, value = line.split(":", 1)
            if name in ("MemTotal", "MemAvailable", "SwapTotal", "SwapFree"):
                memory[name] = int(value.split()[0]) * 1024
    with open("/proc/uptime", encoding="ascii") as handle:
        uptime = float(handle.read(128).split()[0])
    with open("/proc/stat", encoding="ascii") as handle:
        cpu = [int(value) for value in handle.readline(512).split()[1:]]
    services = {service: "unavailable" for service in SERVICES[server]}
    try:
        result = subprocess.run(["/usr/bin/systemctl", "is-active", *SERVICES[server]],
                                capture_output=True, timeout=3, check=False,
                                text=True, env={"PATH": "/usr/bin:/bin", "LC_ALL": "C"})
        states = result.stdout.splitlines()
        if len(states) == len(SERVICES[server]):
            for service, state in zip(SERVICES[server], states):
                services[service] = state if state in {"active", "inactive", "failed", "activating", "deactivating", "unknown", "reloading"} else "unknown"
    except (OSError, subprocess.TimeoutExpired):
        pass
    return {"hostname": socket.gethostname(), "os": platform.system(),
            "kernel": platform.release(), "cpuCount": os.cpu_count(),
            "cpuTicks": cpu, "load": list(os.getloadavg()),
            "uptimeSeconds": uptime, "memory": {"totalBytes": memory.get("MemTotal", 0), "availableBytes": memory.get("MemAvailable", 0)},
            "disk": disk_status(), "services": services}


class MaintenanceAgent:
    def __init__(self, server, secret, *, roots=ROOTS, clock=time.time,
                 audit_path="/var/log/originmind-maintenance.jsonl",
                 status_provider=system_status, disk_provider=disk_status):
        if server not in SERVICES or not isinstance(secret, str) or len(secret) < 32:
            raise ValueError("Invalid maintenance configuration")
        self.server = server
        self.secret = secret.encode("utf-8")
        self.roots = roots
        self.clock = clock
        self.audit_path = audit_path
        self.status_provider = status_provider
        self.disk_provider = disk_provider
        self.nonces = collections.OrderedDict()
        self.plans = collections.OrderedDict()
        self.lock = threading.Lock()

    def authenticate(self, headers, body):
        timestamp = headers.get("x-maintenance-time", "")
        nonce = headers.get("x-maintenance-nonce", "")
        authorization = headers.get("authorization", "")
        match = AUTH_RE.fullmatch(authorization)
        if not TIMESTAMP_RE.fullmatch(timestamp) or not NONCE_RE.fullmatch(nonce) or not match:
            raise MaintenanceError("unauthorized", 401)
        now = self.clock()
        if abs(now - int(timestamp)) > 60:
            raise MaintenanceError("expired_signature", 401)
        canonical = timestamp.encode("ascii") + b"\n" + nonce.encode("ascii") + b"\n" + body
        expected = hmac.new(self.secret, canonical, hashlib.sha256).hexdigest()
        if not hmac.compare_digest(expected, match.group(1).lower()):
            raise MaintenanceError("unauthorized", 401)
        for key, expires in list(self.nonces.items()):
            if expires < now:
                del self.nonces[key]
        if nonce in self.nonces:
            raise MaintenanceError("replayed_request", 409)
        if len(self.nonces) >= MAX_NONCES:
            raise MaintenanceError("nonce_capacity", 429)
        self.nonces[nonce] = now + 121

    @staticmethod
    def parse_request(body):
        if len(body) > MAX_BODY:
            raise MaintenanceError("body_too_large", 413)
        try:
            def pairs(entries):
                result = {}
                for key, value in entries:
                    if key in result:
                        raise ValueError("duplicate field")
                    result[key] = value
                return result
            data = json.loads(body.decode("utf-8"), object_pairs_hook=pairs)
        except (ValueError, UnicodeDecodeError, RecursionError):
            raise MaintenanceError("invalid_json") from None
        if not isinstance(data, dict) or set(data) - {"action", "actor", "planId"}:
            raise MaintenanceError("invalid_request")
        if data.get("action") not in ("status", "plan", "clean") or not isinstance(data.get("actor"), str) or not ACTOR_RE.fullmatch(data["actor"]):
            raise MaintenanceError("invalid_request")
        if data["action"] == "clean":
            if not isinstance(data.get("planId"), str) or not PLAN_RE.fullmatch(data["planId"]):
                raise MaintenanceError("invalid_plan")
        elif "planId" in data:
            raise MaintenanceError("invalid_request")
        return data

    def audit(self, actor, action, result, **metadata):
        record = {"time": int(self.clock()), "server": self.server,
                  "actor": actor, "action": action, "result": result, **metadata}
        raw = (json.dumps(record, ensure_ascii=True, separators=(",", ":")) + "\n").encode("ascii")
        fd = os.open(self.audit_path, os.O_WRONLY | os.O_APPEND | os.O_CREAT | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600)
        try:
            info = os.fstat(fd)
            if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_nlink != 1 or info.st_mode & 0o077:
                raise MaintenanceError("unsafe_audit_file", 500)
            if os.write(fd, raw) != len(raw):
                raise MaintenanceError("audit_failed", 500)
            os.fsync(fd)
        finally:
            os.close(fd)

    def plan(self, actor):
        now = self.clock()
        for key, value in list(self.plans.items()):
            if value["expires"] < now:
                del self.plans[key]
        if len(self.plans) >= MAX_PLANS:
            raise MaintenanceError("plan_capacity", 429)
        entries, categories = [], []
        total_bytes, scanned = 0, 0
        limited = False
        cutoff_ns = int((now - MIN_AGE) * 1_000_000_000)
        for category, root, recursive, suffix in self.roots:
            summary = {"name": category, "count": 0, "bytes": 0, "available": False}
            categories.append(summary)
            try:
                fd = open_root(root)
            except FileNotFoundError:
                continue
            except (OSError, MaintenanceError):
                summary["safe"] = False
                continue
            try:
                root_info = os.fstat(fd)
                summary["available"] = True
                summary["safe"] = True

                def walk(directory_fd, components, depth):
                    nonlocal total_bytes, scanned, limited
                    with os.scandir(directory_fd) as iterator:
                        for item in iterator:
                            scanned += 1
                            if scanned > MAX_SCAN_ENTRIES:
                                limited = True
                                return
                            try:
                                if PROTECTED_NAME_RE.search(item.name):
                                    continue
                                info = item.stat(follow_symlinks=False)
                                if info.st_dev != root_info.st_dev:
                                    continue
                                if stat.S_ISDIR(info.st_mode):
                                    if not recursive or not secure_directory(info):
                                        continue
                                    if depth >= MAX_DEPTH:
                                        limited = True
                                        continue
                                    child_fd = os.open(item.name, DIR_FLAGS, dir_fd=directory_fd)
                                    try:
                                        actual = os.fstat(child_fd)
                                        if actual.st_dev == root_info.st_dev and secure_directory(actual) and (actual.st_dev, actual.st_ino) == (info.st_dev, info.st_ino):
                                            walk(child_fd, components + (item.name,), depth + 1)
                                    finally:
                                        os.close(child_fd)
                                    continue
                                if suffix and not item.name.endswith(suffix):
                                    continue
                                if not regular_candidate(info) or info.st_mtime_ns > cutoff_ns:
                                    continue
                                if len(entries) >= MAX_FILES or total_bytes + info.st_size > MAX_BYTES:
                                    limited = True
                                    continue
                                entries.append({"root": root, "rootIdentity": (root_info.st_dev, root_info.st_ino),
                                                "components": components + (item.name,), "identity": identity(info)})
                                total_bytes += info.st_size
                                summary["count"] += 1
                                summary["bytes"] += info.st_size
                            except OSError:
                                continue
                walk(fd, (), 0)
            finally:
                os.close(fd)
        entropy = secrets.token_hex(32)
        plan_id = hmac.new(self.secret, (actor + "\n" + str(now) + "\n" + entropy).encode("ascii"), hashlib.sha256).hexdigest()
        self.plans[plan_id] = {"actor": actor, "expires": now + PLAN_TTL, "entries": entries, "result": None}
        return {"planId": plan_id, "expiresAt": int(now + PLAN_TTL), "categories": categories,
                "candidateCount": len(entries), "candidateBytes": total_bytes, "limited": limited,
                "disk": self.disk_provider()}

    @staticmethod
    def remove_entry(entry):
        root_fd = open_root(entry["root"])
        fd = root_fd
        try:
            root_info = os.fstat(root_fd)
            if (root_info.st_dev, root_info.st_ino) != entry["rootIdentity"]:
                return False
            for component in entry["components"][:-1]:
                child_fd = os.open(component, DIR_FLAGS, dir_fd=fd)
                info = os.fstat(child_fd)
                if not secure_directory(info) or info.st_dev != root_info.st_dev:
                    os.close(child_fd)
                    return False
                if fd != root_fd:
                    os.close(fd)
                fd = child_fd
            name = entry["components"][-1]
            file_fd = os.open(name, FILE_FLAGS, dir_fd=fd)
            try:
                actual = os.fstat(file_fd)
                if not regular_candidate(actual) or identity(actual) != entry["identity"]:
                    return False
                # The parent is root-owned, not writable by other users. Recheck
                # the directory entry while retaining an open file descriptor.
                if identity(os.stat(name, dir_fd=fd, follow_symlinks=False)) != entry["identity"]:
                    return False
                os.unlink(name, dir_fd=fd)
                return True
            finally:
                os.close(file_fd)
        finally:
            if fd != root_fd:
                os.close(fd)
            os.close(root_fd)

    def clean(self, actor, plan_id):
        plan = self.plans.get(plan_id)
        if not plan or plan["actor"] != actor:
            raise MaintenanceError("plan_not_found", 404)
        if plan["expires"] < self.clock():
            del self.plans[plan_id]
            raise MaintenanceError("plan_expired", 409)
        if plan["result"] is not None:
            return {**plan["result"], "idempotent": True}
        digest = hashlib.sha256(plan_id.encode("ascii")).hexdigest()
        try:
            self.audit(actor, "clean", "started", planHash=digest)
        except (OSError, MaintenanceError):
            raise MaintenanceError("audit_unavailable", 503) from None
        before = self.disk_provider()
        deleted_count, deleted_bytes, skipped = 0, 0, 0
        for entry in plan["entries"]:
            try:
                removed = self.remove_entry(entry)
            except (OSError, MaintenanceError):
                removed = False
            if removed:
                deleted_count += 1
                deleted_bytes += entry["identity"][2]
            else:
                skipped += 1
        result = {"planId": plan_id, "diskBefore": before, "diskAfter": self.disk_provider(),
                  "deletedCount": deleted_count, "deletedBytes": deleted_bytes,
                  "skippedCount": skipped, "idempotent": False}
        plan["result"] = result
        return result

    def handle(self, headers, body):
        with self.lock:
            if len(body) > MAX_BODY:
                raise MaintenanceError("body_too_large", 413)
            self.authenticate(headers, body)
            request = self.parse_request(body)
            action, actor = request["action"], request["actor"]
            try:
                if action == "status":
                    result = self.status_provider(self.server)
                elif action == "plan":
                    result = self.plan(actor)
                else:
                    result = self.clean(actor, request["planId"])
            except MaintenanceError as error:
                try:
                    self.audit(actor, action, error.code)
                except (OSError, MaintenanceError):
                    pass
                raise
            except Exception:
                try:
                    self.audit(actor, action, "internal_error")
                except (OSError, MaintenanceError):
                    pass
                raise MaintenanceError("internal_error", 500) from None
            audit_values = {key: result[key] for key in ("candidateCount", "candidateBytes", "deletedCount", "deletedBytes", "skippedCount", "idempotent") if key in result}
            try:
                self.audit(actor, action, "ok", **audit_values)
            except (OSError, MaintenanceError):
                # Cleanup results remain cached: retrying the same plan records
                # the completed action, without deleting any additional files.
                raise MaintenanceError("audit_pending" if action == "clean" else "audit_unavailable", 503) from None
            return {"ok": True, "server": self.server, "action": action,
                    "collectedAt": int(self.clock()), **result}


class Handler(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "MaintenanceAgent"
    sys_version = ""

    def setup(self):
        super().setup()
        self.connection.settimeout(5)

    def log_message(self, *_args):
        pass

    def reply(self, status, data):
        body = json.dumps(data, ensure_ascii=True, separators=(",", ":")).encode("ascii")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("Connection", "close")
        self.end_headers()
        self.close_connection = True
        self.wfile.write(body)

    def do_POST(self):
        try:
            if self.path != "/v1/maintenance":
                raise MaintenanceError("not_found", 404)
            if self.headers.get("Transfer-Encoding"):
                raise MaintenanceError("invalid_request")
            for name in ("Content-Length", "Content-Type", "x-maintenance-time", "x-maintenance-nonce", "Authorization"):
                if len(self.headers.get_all(name, [])) != 1:
                    raise MaintenanceError("invalid_headers")
            size_value = self.headers.get("Content-Length", "")
            if not re.fullmatch(r"[0-9]{1,5}", size_value):
                raise MaintenanceError("invalid_length")
            size = int(size_value)
            if size > MAX_BODY:
                raise MaintenanceError("body_too_large", 413)
            if self.headers.get("Content-Type", "").split(";", 1)[0].strip().lower() != "application/json":
                raise MaintenanceError("unsupported_media_type", 415)
            body = self.rfile.read(size)
            if len(body) != size:
                raise MaintenanceError("incomplete_body")
            self.reply(200, self.server.agent.handle(self.headers, body))
        except MaintenanceError as error:
            self.reply(error.status, {"ok": False, "error": error.code,
                                      **({"retrySamePlan": True} if error.code == "audit_pending" else {})})
        except (TimeoutError, socket.timeout):
            self.reply(408, {"ok": False, "error": "request_timeout"})
        except Exception:
            self.reply(500, {"ok": False, "error": "internal_error"})

    def do_GET(self):
        self.reply(405, {"ok": False, "error": "method_not_allowed"})

    do_PUT = do_GET
    do_DELETE = do_GET
    do_PATCH = do_GET


def load_config(path):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_nlink != 1 or info.st_mode & 0o077 or info.st_size > MAX_BODY:
            raise ValueError("Unsafe maintenance configuration permissions")
        with os.fdopen(fd, encoding="utf-8") as handle:
            fd = -1
            config = json.load(handle)
        if not isinstance(config, dict) or set(config) != {"server", "secret"}:
            raise ValueError("Invalid maintenance configuration")
        return config
    finally:
        if fd >= 0:
            os.close(fd)


def main():
    parser = argparse.ArgumentParser(description="Private fixed-action maintenance agent")
    parser.add_argument("--config", required=True)
    args = parser.parse_args()
    if os.geteuid() != 0:
        parser.error("The maintenance service requires its dedicated root unit")
    try:
        agent = MaintenanceAgent(**load_config(args.config))
    except (ValueError, OSError):
        parser.error("Cannot load a safe maintenance configuration")
    server = http.server.HTTPServer(("127.0.0.1", 18893), Handler)
    server.agent = agent
    server.serve_forever(poll_interval=0.5)


if __name__ == "__main__":
    main()
