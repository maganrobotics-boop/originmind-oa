"""Audited administrator operations, separate from the read-only diagnostics.

The model never receives a root shell. Commands run in a transient systemd
sandbox as a dedicated user; file changes are confined to an actor workspace.
Receipts precede mutations and make request IDs durable across daemon restarts.
"""

import hashlib
import json
import os
import pwd
import re
import secrets
import selectors
import shutil
import stat
import subprocess
import threading
import time


SERVICES = {
    "aliyun": ("nginx.service", "originmind-oa.service", "originmind-chat.service"),
    "tencent": ("nginx.service", "docker.service", "originmind-arena.service", "originmind-cloud-mcp.service"),
}
OPERATIONS = frozenset(("file_list", "file_read", "file_write", "file_mkdir", "file_move", "file_trash",
                        "command_start", "job_status", "job_cancel", "service"))
MUTATIONS = OPERATIONS - {"file_list", "file_read", "job_status"}
ACTOR = re.compile(r"^[a-f0-9]{64}$")
REQUEST_ID = re.compile(r"^[a-f0-9]{32,64}$")
JOB_ID = re.compile(r"^[a-f0-9]{32}$")
HASH = re.compile(r"^[a-f0-9]{64}$")
PROTECTED_NAME = re.compile(r"(?:^\.|secret|credential|password|passwd|token|private[-_]?key|api[-_]?key|\.(?:pem|p12|pfx|key)$)", re.I)
DIR_FLAGS = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC
MAX_CONTENT = 16384
MAX_OUTPUT = 16000


class OperationError(Exception):
    def __init__(self, code, status=400):
        super().__init__(code)
        self.code, self.status = code, status


def redact(value):
    value = str(value)
    if re.search(r"-----BEGIN (?:[A-Z ]*PRIVATE KEY|OPENSSH PRIVATE KEY)-----", value):
        return "[private key material redacted]"
    value = re.sub(r"\x1b\[[0-?]*[ -/]*[@-~]", "", value)
    value = "".join(c if c in "\n\t" or (c >= " " and c != "\x7f") else " " for c in value)
    value = re.sub(r"(?im)\b(authorization|cookie|set-cookie)\s*[:=].*$", r"\1=[redacted]", value)
    value = re.sub(r"(?i)\b([A-Za-z0-9_-]*(?:password|passwd|secret|token|api[-_]?key|access[-_]?key|client[-_]?secret))\b[\"']*\s*[:=]\s*(?:\"[^\"]*\"|'[^']*'|[^\s,;}]+)", r"\1=[redacted]", value)
    value = re.sub(r"(?i)\b(Bearer|Basic)\s+[A-Za-z0-9._~+/-]+=*", r"\1 [redacted]", value)
    value = re.sub(r"\b(?:sk-(?:proj-)?[A-Za-z0-9_-]{12,}|AKIA[A-Z0-9]{16})\b", "[credential redacted]", value)
    value = re.sub(r"(?i)([a-z][a-z0-9+.-]*://)[^\s/@]+:[^\s/@]+@", r"\1[redacted]@", value)
    value = re.sub(r"(?i)([?&](?:code|key|token|secret|password|signature|access_token)=)[^&\s]+", r"\1[redacted]", value)
    return value[:MAX_OUTPUT]


def valid_text(value, maximum):
    return (isinstance(value, str) and len(value.encode("utf-8", "replace")) <= maximum
            and not any(0xD800 <= ord(c) <= 0xDFFF for c in value)
            and not any(ord(c) < 32 and c not in "\n\t" for c in value))


def relative_path(value, *, root=False):
    if root and value == ".":
        return ()
    if (not isinstance(value, str) or not value or len(value) > 500 or value.startswith("/")
            or "\\" in value or not valid_text(value, 1000)):
        raise OperationError("invalid_workspace_path")
    parts = tuple(value.split("/"))
    if len(parts) > 16 or any(not part or part in (".", "..") or PROTECTED_NAME.search(part) for part in parts):
        raise OperationError("protected_workspace_path")
    return parts


def validate_operation(request, server):
    if not isinstance(request, dict) or request.get("action") != "operations" or not ACTOR.fullmatch(str(request.get("actor", ""))):
        raise OperationError("invalid_operation")
    operation = request.get("operation")
    fields = {"action", "actor", "operation"}
    if operation not in OPERATIONS:
        raise OperationError("invalid_operation")
    if operation in MUTATIONS:
        fields.add("requestId")
        if not isinstance(request.get("requestId"), str) or not REQUEST_ID.fullmatch(request["requestId"]):
            raise OperationError("invalid_request_id")
    if operation.startswith("file_"):
        fields.add("path")
        relative_path(request.get("path"), root=operation == "file_list")
        if operation == "file_write":
            fields.update(("content", "expectedSha256"))
            if not valid_text(request.get("content"), MAX_CONTENT):
                raise OperationError("invalid_file_content")
            expected = request.get("expectedSha256")
            if not isinstance(expected, str) or (expected != "new" and not HASH.fullmatch(expected)):
                raise OperationError("expected_file_version_required")
        elif operation == "file_move":
            fields.add("destination")
            relative_path(request.get("destination"))
    elif operation == "command_start":
        fields.update(("command", "timeoutSeconds"))
        if not valid_text(request.get("command"), 4000) or not request["command"].strip():
            raise OperationError("invalid_command")
        if type(request.get("timeoutSeconds")) is not int or not 10 <= request["timeoutSeconds"] <= 90:
            raise OperationError("invalid_job_timeout")
    elif operation in ("job_status", "job_cancel"):
        fields.add("jobId")
        if not isinstance(request.get("jobId"), str) or not JOB_ID.fullmatch(request["jobId"]):
            raise OperationError("invalid_job_id")
    elif operation == "service":
        fields.update(("service", "verb"))
        if request.get("service") not in SERVICES[server] or request.get("verb") not in ("start", "restart", "reload"):
            raise OperationError("invalid_service_operation")
    if set(request) != fields:
        raise OperationError("invalid_operation_fields")
    return request


class OperationsExecutor:
    def __init__(self, server, audit, *, base="/var/lib/originmind-assistant", user="originmind-assistant",
                 runner=None, redactor=redact, clock=time.time):
        if server not in SERVICES:
            raise ValueError("invalid server")
        self.server, self.audit, self.base, self.user = server, audit, base, user
        self.runner, self.redactor, self.clock = runner or self._run, redactor, clock
        self.lock, self.jobs = threading.RLock(), {}
        account = pwd.getpwnam(user)
        if account.pw_uid == 0:
            raise ValueError("command user must not be root")
        self.uid, self.gid = account.pw_uid, account.pw_gid
        self.workspaces, self.receipts = os.path.join(base, "workspaces"), os.path.join(base, "receipts")
        for path, mode in ((base, 0o711), (self.workspaces, 0o711), (self.receipts, 0o700)):
            os.makedirs(path, mode=mode, exist_ok=True)
            info = os.stat(path, follow_symlinks=False)
            if not stat.S_ISDIR(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022:
                raise ValueError("unsafe operations directory")

    def workspace(self, actor):
        path = os.path.join(self.workspaces, actor)
        try:
            os.mkdir(path, 0o700)
            os.chown(path, self.uid, self.gid, follow_symlinks=False)
        except FileExistsError:
            pass
        info = os.stat(path, follow_symlinks=False)
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != self.uid or info.st_mode & 0o077:
            raise OperationError("unsafe_actor_workspace", 409)
        return path

    def _open_directory(self, actor, parts):
        fd = os.open(self.workspace(actor), DIR_FLAGS)
        try:
            for part in parts:
                child = os.open(part, DIR_FLAGS, dir_fd=fd)
                os.close(fd)
                fd = child
                info = os.fstat(fd)
                if info.st_uid != self.uid or info.st_mode & 0o022:
                    raise OperationError("unsafe_workspace_directory", 409)
            return fd
        except BaseException:
            os.close(fd)
            raise

    @staticmethod
    def _read_file(fd, name):
        file_fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC, dir_fd=fd)
        try:
            info = os.fstat(file_fd)
            if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
                raise OperationError("unsafe_workspace_file", 409)
            if info.st_size > MAX_CONTENT:
                raise OperationError("file_too_large", 413)
            raw = os.read(file_fd, MAX_CONTENT + 1)
            if len(raw) > MAX_CONTENT:
                raise OperationError("file_too_large", 413)
            return raw, info
        finally:
            os.close(file_fd)

    def _record_path(self, actor, request_id):
        return os.path.join(self.receipts, actor + "-" + request_id + ".json")

    def _load_record(self, path):
        try:
            fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
        except FileNotFoundError:
            return None
        try:
            info = os.fstat(fd)
            if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_nlink != 1 or info.st_mode & 0o077 or info.st_size > 65536:
                raise OperationError("unsafe_operation_receipt", 503)
            return json.loads(os.read(fd, 65537))
        finally:
            os.close(fd)

    def _save_record(self, path, data):
        raw = json.dumps(data, ensure_ascii=True, separators=(",", ":")).encode("ascii")
        temporary = path + "." + secrets.token_hex(8)
        fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600)
        try:
            with os.fdopen(fd, "wb") as handle:
                handle.write(raw)
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temporary, path)
            directory_fd = os.open(self.receipts, DIR_FLAGS)
            try:
                os.fsync(directory_fd)
            finally:
                os.close(directory_fd)
        finally:
            try:
                os.unlink(temporary)
            except FileNotFoundError:
                pass

    def execute(self, request):
        validate_operation(request, self.server)
        actor, operation = request["actor"], request["operation"]
        with self.lock:
            if operation not in MUTATIONS:
                return self._perform(request)
            digest = hashlib.sha256(json.dumps(request, sort_keys=True, ensure_ascii=True, separators=(",", ":")).encode()).hexdigest()
            path = self._record_path(actor, request["requestId"])
            previous = self._load_record(path)
            if previous:
                if previous.get("digest") != digest:
                    raise OperationError("request_id_collision", 409)
                if previous.get("state") == "done":
                    return {**previous["result"], "idempotent": True}
                raise OperationError("operation_uncertain_check_state", 409)
            try:
                self.audit(actor, "operations:" + operation, "started", requestHash=digest)
                self._save_record(path, {"digest": digest, "state": "pending", "time": int(self.clock())})
            except (OSError, ValueError):
                raise OperationError("operation_audit_unavailable", 503) from None
            try:
                result = self._perform(request)
            except OperationError:
                # Keep pending when execution might have taken effect. A changed
                # request ID must never be an automatic retry of an uncertain write.
                raise
            except OSError:
                raise OperationError("operation_filesystem_unavailable", 503) from None
            result = {**result, "requestId": request["requestId"], "idempotent": False}
            self._save_record(path, {"digest": digest, "state": "done", "time": int(self.clock()), "result": result})
            self.audit(actor, "operations:" + operation, "ok", requestHash=digest)
            return result

    def _perform(self, request):
        operation, actor = request["operation"], request["actor"]
        if operation.startswith("file_") and operation in MUTATIONS and any(job["actor"] == actor and job["state"] == "running" for job in self.jobs.values()):
            raise OperationError("workspace_job_in_progress", 409)
        if operation.startswith("file_"):
            return self._file(request)
        if operation == "command_start":
            return self._start_job(request)
        if operation in ("job_status", "job_cancel"):
            return self._job(request)
        if operation == "service":
            result = self.runner(["/usr/bin/systemctl", request["verb"], request["service"]], timeout=30)
            if result.returncode != 0:
                raise OperationError("service_operation_failed", 503)
            status = self.runner(["/usr/bin/systemctl", "show", request["service"], "--property=ActiveState,SubState,MainPID", "--no-pager"], timeout=5)
            properties = dict(line.split("=", 1) for line in status.stdout.splitlines() if "=" in line)
            return {"operation": operation, "service": request["service"], "verb": request["verb"],
                    "accepted": True, "status": self.redactor(status.stdout), "statusQueried": status.returncode == 0,
                    "statusVerified": status.returncode == 0 and properties.get("ActiveState") in ("active", "reloading")}
        raise OperationError("invalid_operation")

    def _file(self, request):
        operation, actor = request["operation"], request["actor"]
        parts = relative_path(request["path"], root=operation == "file_list")
        directory = self._open_directory(actor, parts if operation == "file_list" else parts[:-1])
        try:
            result = {"operation": operation, "path": request["path"]}
            if operation == "file_list":
                entries, limited = [], False
                with os.scandir(directory) as iterator:
                    for item in iterator:
                        if len(entries) >= 100:
                            limited = True
                            break
                        if PROTECTED_NAME.search(item.name):
                            continue
                        info = item.stat(follow_symlinks=False)
                        entries.append({"name": self.redactor(item.name), "type": "directory" if stat.S_ISDIR(info.st_mode) else "file" if stat.S_ISREG(info.st_mode) else "blocked", "bytes": info.st_size})
                return {**result, "entries": entries, "limited": limited, "workspaceOnly": True}
            name = parts[-1]
            if operation == "file_read":
                raw, _ = self._read_file(directory, name)
                try:
                    content = raw.decode("utf-8")
                except UnicodeDecodeError:
                    raise OperationError("text_files_only") from None
                safe = self.redactor(content)
                return {**result, "content": safe, "sha256": hashlib.sha256(raw).hexdigest(), "redacted": safe != content}
            if operation == "file_mkdir":
                os.mkdir(name, 0o700, dir_fd=directory)
                os.chown(name, self.uid, self.gid, dir_fd=directory, follow_symlinks=False)
                os.fsync(directory)
                return {**result, "created": True}
            if operation == "file_write":
                expected = request["expectedSha256"]
                try:
                    old, _ = self._read_file(directory, name)
                    actual = hashlib.sha256(old).hexdigest()
                except FileNotFoundError:
                    actual = "new"
                if actual != expected:
                    raise OperationError("file_version_conflict", 409)
                temporary = ".assistant-write-" + secrets.token_hex(12)
                file_fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600, dir_fd=directory)
                try:
                    with os.fdopen(file_fd, "wb") as handle:
                        raw = request["content"].encode("utf-8")
                        handle.write(raw)
                        os.fchown(handle.fileno(), self.uid, self.gid)
                        handle.flush()
                        os.fsync(handle.fileno())
                    # A workspace job uses the same UID. Do not replace an entry
                    # changed between the version check and the atomic publish.
                    try:
                        current, _ = self._read_file(directory, name)
                        current_hash = hashlib.sha256(current).hexdigest()
                    except FileNotFoundError:
                        current_hash = "new"
                    if current_hash != actual:
                        raise OperationError("file_version_conflict", 409)
                    if actual != "new":
                        versions_path = os.path.join(self.workspace(actor), ".versions")
                        try:
                            os.mkdir(versions_path, 0o700)
                            os.chown(versions_path, self.uid, self.gid, follow_symlinks=False)
                        except FileExistsError:
                            pass
                        versions = os.open(versions_path, DIR_FLAGS)
                        try:
                            version_fd = os.open(request["requestId"], os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=versions)
                            with os.fdopen(version_fd, "wb") as version:
                                version.write(old)
                                os.fchown(version.fileno(), self.uid, self.gid)
                                version.flush()
                                os.fsync(version.fileno())
                            os.fsync(versions)
                        finally:
                            os.close(versions)
                    os.replace(temporary, name, src_dir_fd=directory, dst_dir_fd=directory)
                    os.fsync(directory)
                finally:
                    try:
                        os.unlink(temporary, dir_fd=directory)
                    except FileNotFoundError:
                        pass
                return {**result, "bytes": len(raw), "sha256": hashlib.sha256(raw).hexdigest(), "written": True,
                        **({"backupPath": ".versions/" + request["requestId"]} if actual != "new" else {})}
            info = os.stat(name, dir_fd=directory, follow_symlinks=False)
            if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
                raise OperationError("only_regular_files_may_move", 409)
            if operation == "file_move":
                target_parts = relative_path(request["destination"])
                target = self._open_directory(actor, target_parts[:-1])
                target_name = target_parts[-1]
            else:
                # Trash preserves data; root-managed path is never model-selected.
                target_path = os.path.join(self.workspace(actor), ".trash")
                try:
                    os.mkdir(target_path, 0o700)
                except FileExistsError:
                    pass
                target = os.open(target_path, DIR_FLAGS)
                target_name = request["requestId"]
            try:
                # Hard link creation is atomic and refuses to overwrite a target.
                # The source is then unlinked; both names remain inside workspace.
                os.link(name, target_name, src_dir_fd=directory, dst_dir_fd=target, follow_symlinks=False)
                os.unlink(name, dir_fd=directory)
                os.fsync(target)
                os.fsync(directory)
            finally:
                os.close(target)
            return {**result, "moved": True, **({"destination": request["destination"]} if operation == "file_move" else {"trashed": True})}
        finally:
            os.close(directory)

    @staticmethod
    def _run(arguments, timeout):
        try:
            return subprocess.run(arguments, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                                  text=True, timeout=timeout, check=False, close_fds=True,
                                  env={"PATH": "/usr/bin:/bin", "LC_ALL": "C", "SYSTEMD_COLORS": "0"})
        except (OSError, subprocess.TimeoutExpired):
            raise OperationError("service_operation_unavailable", 503) from None

    def command_arguments(self, actor, job_id, command, timeout):
        workspace = self.workspace(actor)
        properties = [
            "NoNewPrivileges=yes", "CapabilityBoundingSet=", "ProtectSystem=strict", "ProtectHome=yes",
            "PrivateTmp=yes", "PrivateDevices=yes", "ProtectKernelTunables=yes", "ProtectKernelModules=yes",
            "ProtectControlGroups=yes", "RestrictSUIDSGID=yes", "LockPersonality=yes", "ProtectProc=invisible",
            "InaccessiblePaths=/proc /sys",
            "ProcSubset=pid", "RestrictNamespaces=yes", "RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6",
            "IPAddressDeny=127.0.0.0/8 ::1/128 169.254.0.0/16 fe80::/10 224.0.0.0/4 ff00::/8 10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 100.64.0.0/10 fc00::/7",
            "IPAddressAllow=127.0.0.53/32",
            "UMask=0077", "MemoryMax=512M", "TasksMax=128", "CPUQuota=100%", "LimitFSIZE=268435456",
            "RuntimeMaxSec=" + str(timeout) + "s", "TimeoutStopSec=3s", "KillMode=control-group",
            "TemporaryFileSystem=/etc:ro /opt:ro /var/lib:ro /var/log:ro /run:ro",
            "BindReadOnlyPaths=-/etc/ssl/certs -/etc/resolv.conf -/etc/hosts -/etc/nsswitch.conf -/etc/ld.so.cache -/etc/passwd -/etc/group -/etc/localtime",
            "BindPaths=" + workspace, "ReadWritePaths=" + workspace,
        ]
        return ["/usr/bin/systemd-run", "--quiet", "--wait", "--pipe", "--collect", "--service-type=exec",
                "--unit=originmind-assistant-job-" + job_id, "--uid=" + str(self.uid), "--gid=" + str(self.gid),
                "--working-directory=" + workspace, "--setenv=HOME=" + workspace, "--setenv=PATH=/usr/local/bin:/usr/bin:/bin",
                "--setenv=LANG=C.UTF-8", *["--property=" + item for item in properties],
                "/usr/bin/env", "-i", "HOME=" + workspace, "PATH=/usr/local/bin:/usr/bin:/bin", "LANG=C.UTF-8",
                "/bin/bash", "--noprofile", "--norc", "-c", command]

    def _start_job(self, request):
        if sum(job["state"] == "running" for job in self.jobs.values()) >= 2:
            raise OperationError("job_capacity", 429)
        if shutil.disk_usage(self.base).free < 1024 ** 3:
            raise OperationError("workspace_disk_reserve", 409)
        job_id = secrets.token_hex(16)
        arguments = self.command_arguments(request["actor"], job_id, request["command"], request["timeoutSeconds"])
        try:
            process = subprocess.Popen(arguments, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                       close_fds=True, env={"PATH": "/usr/bin:/bin", "LC_ALL": "C", "SYSTEMD_COLORS": "0"})
        except OSError:
            raise OperationError("job_executor_unavailable", 503) from None
        job = {"jobId": job_id, "actor": request["actor"], "state": "running", "startedAt": int(self.clock()),
               "output": "", "outputLimited": False, "exitCode": None, "process": process,
               "timeout": request["timeoutSeconds"]}
        self.jobs[job_id] = job
        self._save_record(os.path.join(self.receipts, "job-" + job_id + ".json"), self._public_job(job, actor=True))
        threading.Thread(target=self._collect_job, args=(job,), daemon=True).start()
        return {"operation": "command_start", **self._public_job(job), "workspaceOnly": True, "runsAsRoot": False}

    def _collect_job(self, job):
        process, output = job["process"], bytearray()
        deadline = time.monotonic() + job["timeout"] + 10
        try:
            with selectors.DefaultSelector() as selector:
                selector.register(process.stdout, selectors.EVENT_READ)
                while time.monotonic() < deadline:
                    if shutil.disk_usage(self.base).free < 1024 ** 3:
                        job["stopReason"] = "storage_reserve"
                        break
                    if not selector.select(min(0.5, max(0, deadline - time.monotonic()))):
                        if process.poll() is not None:
                            break
                        continue
                    block = os.read(process.stdout.fileno(), 4096)
                    if not block:
                        break
                    available = MAX_OUTPUT - len(output)
                    output.extend(block[:max(0, available)])
                    if len(block) > available:
                        job["outputLimited"] = True
                    with self.lock:
                        job["output"] = self.redactor(output.decode("utf-8", "replace"))
            if process.poll() is None:
                self.runner(["/usr/bin/systemctl", "stop", "originmind-assistant-job-" + job["jobId"] + ".service"], timeout=6)
                process.wait(timeout=6)
            with self.lock:
                job["exitCode"] = process.returncode
                if job["state"] != "cancelled":
                    job["state"] = "succeeded" if process.returncode == 0 else "failed"
                job["finishedAt"] = int(self.clock())
                self._save_record(os.path.join(self.receipts, "job-" + job["jobId"] + ".json"), self._public_job(job, actor=True))
                self.audit(job["actor"], "operations:command_job", job["state"], jobId=job["jobId"], exitCode=job["exitCode"])
        except Exception:
            with self.lock:
                job["state"] = "uncertain"
        finally:
            process.stdout.close()

    @staticmethod
    def _public_job(job, actor=False):
        return {key: value for key, value in job.items() if key not in ("process", "timeout", *( () if actor else ("actor",) ))}

    def _job(self, request):
        job = self.jobs.get(request["jobId"])
        if job is None:
            saved = self._load_record(os.path.join(self.receipts, "job-" + request["jobId"] + ".json"))
            if not saved or saved.get("actor") != request["actor"]:
                raise OperationError("job_not_found", 404)
            if saved.get("state") == "running":
                # The child has RuntimeMaxSec even after this daemon restarted.
                # Its captured output is unavailable: never manufacture success.
                saved["state"], saved["output"] = "uncertain", "执行器重启；请核对工作区和服务状态。"
            if request["operation"] == "job_cancel" and saved["state"] == "uncertain":
                stopped = self.runner(["/usr/bin/systemctl", "stop", "originmind-assistant-job-" + request["jobId"] + ".service"], timeout=6)
                if stopped.returncode != 0:
                    raise OperationError("job_cancel_unconfirmed", 503)
                saved["state"] = "cancelled"
                self._save_record(os.path.join(self.receipts, "job-" + request["jobId"] + ".json"), saved)
            saved.pop("actor", None)
            return {"operation": request["operation"], **saved}
        if job["actor"] != request["actor"]:
            raise OperationError("job_not_found", 404)
        if request["operation"] == "job_cancel" and job["state"] == "running":
            result = self.runner(["/usr/bin/systemctl", "stop", "originmind-assistant-job-" + job["jobId"] + ".service"], timeout=6)
            if result.returncode != 0:
                raise OperationError("job_cancel_unconfirmed", 503)
            job["state"] = "cancelled"
        return {"operation": request["operation"], **self._public_job(job)}
