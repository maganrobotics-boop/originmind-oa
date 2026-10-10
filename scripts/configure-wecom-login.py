#!/usr/bin/env python3
"""Prepare the self-built OA application's credentials without enabling login."""
import getpass
import os
from pathlib import Path
import re
import sys
import tempfile


def configuration(corp_id, agent_id, secret):
    if not re.fullmatch(r"[A-Za-z0-9_-]{4,128}", corp_id):
        raise ValueError("CorpID 格式不正确")
    if not re.fullmatch(r"[1-9][0-9]{0,19}", agent_id):
        raise ValueError("AgentID 格式不正确")
    if not re.fullmatch(r"[A-Za-z0-9_+/=.:-]{16,256}", secret):
        raise ValueError("应用 Secret 格式不正确")
    return (
        "OA_PUBLIC_ORIGIN=https://oa.omindos.cn\n"
        "OA_UNIFIED_QR_LOGIN_ENABLED=false\n"
        "WECOM_LOGIN_ENABLED=true\n"
        f"WECOM_LOGIN_CORP_ID={corp_id}\n"
        f"WECOM_LOGIN_AGENT_ID={agent_id}\n"
        f"WECOM_LOGIN_APP_SECRET={secret}\n"
    )


def main():
    if os.geteuid() != 0 or not sys.stdin.isatty():
        raise SystemExit("请在服务器交互终端用 sudo 运行；不要通过聊天或命令参数传入 Secret。")
    target = Path("/etc/originmind-oa/wecom-login.env")
    if target.exists() or target.is_symlink():
        raise SystemExit("已有企微登录配置，未覆盖；请由维护者核对。")
    corp_id = input("企业 CorpID: ").strip()
    agent_id = input("自建 OA 应用 AgentID: ").strip()
    secret = getpass.getpass("同一自建应用的 Secret（输入不回显）: ").strip()
    try:
        content = configuration(corp_id, agent_id, secret)
    except ValueError as error:
        raise SystemExit(str(error) + "，未写入配置。") from None
    if not target.parent.is_dir() or target.parent.is_symlink():
        raise SystemExit("OA 配置目录不存在或不是预期目录，未写入配置。")
    descriptor, temporary = tempfile.mkstemp(prefix=".wecom-login-", dir=target.parent)
    try:
        with os.fdopen(descriptor, "w") as handle:
            handle.write(content)
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(temporary, 0o600)
        os.link(temporary, target)  # Exclusive publication: never overwrite another operator.
    except Exception:
        raise SystemExit("配置写入失败，未覆盖已有配置；请由维护者检查文件状态。") from None
    finally:
        Path(temporary).unlink(missing_ok=True)
    print("企微配置已保存，密钥未回显；未启用双登录、未修改服务或重启。")
    print("请告知维护者配置已保存，继续验证应用凭据、可信域名、IP 和手机扫码。")


if __name__ == "__main__":
    main()
