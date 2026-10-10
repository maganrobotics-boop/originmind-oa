#!/usr/bin/env python3
"""Create a private configuration file. Secret entry and display require a local TTY."""
import argparse
import base64
import getpass
import os
from pathlib import Path
import re
import secrets
import stat
import sys
import tempfile

CONFIG_DIR = Path('/etc/originmind-wechat-kf')
CONFIG_PATH = CONFIG_DIR / 'env'
KEYS = ['WECHAT_KF_CORP_ID', 'WECHAT_KF_SECRET', 'WECHAT_KF_OPEN_KF_ID', 'WECHAT_KF_TOKEN', 'WECHAT_KF_ENCODING_AES_KEY']


def read_config():
    values = {key: '' for key in KEYS}
    if CONFIG_PATH.is_symlink():
        raise ValueError('Configuration must not be a symbolic link.')
    if CONFIG_PATH.exists():
        mode = CONFIG_PATH.stat().st_mode
        if not stat.S_ISREG(mode) or mode & 0o077:
            raise ValueError('Existing configuration must be a private regular file (0600).')
        for line in CONFIG_PATH.read_text().splitlines():
            if not line or line.startswith('#'):
                continue
            key, sep, value = line.partition('=')
            if not sep or key not in KEYS:
                raise ValueError('Unexpected existing configuration entry.')
            values[key] = value.strip()
    return values


def write_config(values):
    if CONFIG_DIR.is_symlink():
        raise ValueError('Configuration directory must not be a symbolic link.')
    CONFIG_DIR.mkdir(mode=0o700, parents=True, exist_ok=True)
    os.chmod(CONFIG_DIR, 0o700)
    fd, temporary_path = tempfile.mkstemp(prefix='.env-', dir=CONFIG_DIR)
    try:
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, 'w') as output:
            output.write('# Private configuration. Do not paste this file into chat or logs.\n')
            for key in KEYS:
                output.write(f'{key}={values[key]}\n')
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary_path, CONFIG_PATH)
        directory_fd = os.open(CONFIG_DIR, os.O_DIRECTORY)
        try:
            os.fsync(directory_fd)
        finally:
            os.close(directory_fd)
    finally:
        if os.path.exists(temporary_path):
            os.unlink(temporary_path)


def require_tty():
    if not sys.stdin.isatty() or not sys.stdout.isatty():
        raise ValueError('This operation requires your interactive server terminal; do not run it through tool output.')


def main():
    parser = argparse.ArgumentParser(description='Configure the independent WeChat customer-service bridge.')
    action = parser.add_mutually_exclusive_group(required=True)
    action.add_argument('--prepare', action='store_true', help='Generate callback keys without displaying them; preserve existing values.')
    action.add_argument('--configure', action='store_true', help='Enter CorpID, permitted application Secret, and OpenKfID in your server terminal.')
    action.add_argument('--show-callback', action='store_true', help='Display URL and callback keys only in your interactive server terminal.')
    arguments = parser.parse_args()
    if os.geteuid() != 0:
        raise ValueError('Run this command with sudo.')
    values = read_config()
    if arguments.show_callback:
        require_tty()
        if not values['WECHAT_KF_TOKEN'] or not values['WECHAT_KF_ENCODING_AES_KEY']:
            raise ValueError('Run --prepare first.')
        print('URL: https://chat.omindos.cn/integrations/wechat-kf/callback')
        print('Token: ' + values['WECHAT_KF_TOKEN'])
        print('EncodingAESKey: ' + values['WECHAT_KF_ENCODING_AES_KEY'])
        print('仅在企业微信的微信客服 API 配置中填写；不要截图或发到聊天中。')
        return
    values['WECHAT_KF_TOKEN'] = values['WECHAT_KF_TOKEN'] or secrets.token_hex(16)
    values['WECHAT_KF_ENCODING_AES_KEY'] = values['WECHAT_KF_ENCODING_AES_KEY'] or base64.b64encode(secrets.token_bytes(32)).decode().rstrip('=')
    if arguments.configure:
        require_tty()
        print('输入微信客服配置；直接按回车保留现有值。Secret 不回显。')
        for key, label in [('WECHAT_KF_CORP_ID', '企业 ID（CorpID）'), ('WECHAT_KF_SECRET', '已获微信客服 API 权限的自建应用 Secret'), ('WECHAT_KF_OPEN_KF_ID', '客服账号 ID（OpenKfID）')]:
            value = getpass.getpass(label + ': ').strip() if key.endswith('_SECRET') else input(label + ': ').strip()
            if value:
                if len(value) > 256 or not re.fullmatch(r'[A-Za-z0-9_-]+', value):
                    raise ValueError('Invalid identifier or Secret format; nothing was saved.')
                values[key] = value
    write_config(values)
    print('Private configuration saved. No secrets were displayed.')
    if arguments.configure:
        print('下一步：sudo systemctl restart originmind-wechat-kf')


if __name__ == '__main__':
    try:
        main()
    except (ValueError, OSError, EOFError) as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
