#!/usr/bin/env python3
"""Create new bot-only configuration without reading the existing OA secrets."""
import getpass
import os
from pathlib import Path
import re
import secrets
import tempfile


def main():
    if os.geteuid() != 0:
        raise SystemExit("请用 sudo 运行本脚本。")
    directory = Path("/etc/originmind-wecom-bot")
    bot_file = directory / "env"
    bridge_file = directory / "bridge.env"
    drop_in = Path("/etc/systemd/system/originmind-oa.service.d/30-wecom-bot.conf")
    if any(path.exists() for path in (bot_file, bridge_file, drop_in)):
        raise SystemExit("已有机器人配置，未覆盖。请由维护者核对后更新。")
    bot_id = input("Bot ID: ").strip()
    bot_secret = getpass.getpass("Bot Secret（输入不回显）: ").strip()
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,127}", bot_id):
        raise SystemExit("Bot ID 格式不正确，未写入配置。")
    if not re.fullmatch(r"[A-Za-z0-9_+/=.:-]{16,256}", bot_secret):
        raise SystemExit("Bot Secret 格式不正确，未写入配置。")
    bridge_secret = secrets.token_urlsafe(32)
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    os.chmod(directory, 0o700)
    drop_in.parent.mkdir(mode=0o755, parents=True, exist_ok=True)
    contents = {
        bot_file: f"WECOM_BOT_ID={bot_id}\nWECOM_BOT_SECRET={bot_secret}\nWECOM_BOT_BRIDGE_SECRET={bridge_secret}\nWECOM_BOT_BRIDGE_URL=http://127.0.0.1:3000/api/integrations/wecom-bot/messages\n",
        bridge_file: f"WECOM_BOT_ENABLED=true\nWECOM_BOT_ID={bot_id}\nWECOM_BOT_BRIDGE_SECRET={bridge_secret}\nOA_PUBLIC_ORIGIN=https://oa.omindos.cn\n",
        drop_in: "[Service]\nEnvironmentFile=/etc/originmind-wecom-bot/bridge.env\n",
    }
    staged = []
    published = []
    try:
        for path, content in contents.items():
            descriptor, temporary = tempfile.mkstemp(prefix=".wecom-bot-", dir=path.parent)
            staged.append(Path(temporary))
            with os.fdopen(descriptor, "w") as handle:
                handle.write(content)
                handle.flush()
                os.fsync(handle.fileno())
            os.chmod(temporary, 0o600 if path != drop_in else 0o644)
            # Exclusive link fails if a concurrent operator has configured it.
            os.link(temporary, path)
            published.append(path)
        print("机器人配置已写入；未显示密钥，未启动或重启服务。")
        print("由维护者完成代码与迁移核对后，再启动机器人并重启 OA。")
    except Exception:
        for path in published:
            path.unlink(missing_ok=True)
        raise SystemExit("配置未完成，已撤销本次写入。") from None
    finally:
        for path in staged:
            path.unlink(missing_ok=True)


if __name__ == "__main__":
    main()
