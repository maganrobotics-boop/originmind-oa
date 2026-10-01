#!/usr/bin/env python3
"""Install this isolated release without changing the Chat or OA release links."""
from datetime import datetime, timezone
from pathlib import Path
import json
import os
import shutil
import subprocess
import sys
import time
import urllib.request


def run(*args):
    subprocess.run(args, check=True, timeout=30)


def main():
    if os.geteuid() != 0 or len(sys.argv) != 2:
        raise SystemExit('Run as root with an absolute prepared release directory.')
    release = Path(sys.argv[1]).resolve()
    release_root = Path('/opt/originmind-wechat-kf/releases').resolve()
    if release.parent != release_root or not (release / 'scripts/wechat-kf.mjs').is_file():
        raise SystemExit('Unexpected release path.')
    # This tree contains only repository source code. Private credentials and
    # SQLite data live elsewhere; let the dynamic service identity read code.
    for directory in [release.parent.parent, release.parent, release]:
        directory.chmod(0o755)
    for entry in release.rglob('*'):
        if entry.is_symlink():
            raise SystemExit('Refusing a release containing symbolic links.')
        entry.chmod(0o755 if entry.is_dir() else 0o644)
    nginx_path = Path('/etc/nginx/conf.d/originmind-services.conf')
    nginx_binary = Path('/usr/sbin/nginx')
    if not nginx_binary.is_file():
        raise SystemExit('The configured Nginx binary /usr/sbin/nginx is missing.')
    snippet_path = Path('/etc/nginx/snippets/originmind-wechat-kf.conf')
    service_path = Path('/etc/systemd/system/originmind-wechat-kf.service')
    current = release_root.parent / 'current'
    include = '    include /etc/nginx/snippets/originmind-wechat-kf.conf;'
    anchor = '    server_name chat.omindos.cn;'
    original = nginx_path.read_text()
    if original.count(anchor) != 1:
        raise SystemExit('The current Nginx Chat server block is not unambiguous.')
    if include in original and original.index(include) < original.index(anchor):
        raise SystemExit('The existing include is outside the expected Chat block.')
    if current.exists() and not current.is_symlink():
        raise SystemExit('Refusing to replace a non-symlink current path.')
    before_link = os.readlink(current) if current.is_symlink() else None
    prior_service = service_path.exists()
    stamp = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')
    backup = Path('/var/backups/originmind-wechat-kf') / stamp
    backup.mkdir(parents=True, mode=0o700)
    shutil.copy2(nginx_path, backup / nginx_path.name)
    for file in [snippet_path, service_path]:
        if file.exists():
            shutil.copy2(file, backup / file.name)
    run('python3', str(release / 'scripts/configure-wechat-kf.py'), '--prepare')
    candidate_link = current.with_name('current-candidate-' + stamp)
    candidate_link.symlink_to(release)
    os.replace(candidate_link, current)
    shutil.copy2(release / 'deploy/originmind-wechat-kf.service', service_path)
    service_path.chmod(0o644)
    try:
        run('systemctl', 'daemon-reload')
        run('systemctl', 'enable', 'originmind-wechat-kf')
        run('systemctl', 'restart', 'originmind-wechat-kf')
        deadline = time.monotonic() + 10
        while True:
            try:
                with urllib.request.urlopen('http://127.0.0.1:3014/health', timeout=1) as response:
                    health = json.loads(response.read(2048))
                if health.get('ok') is True:
                    break
            except (OSError, ValueError):
                pass
            if time.monotonic() >= deadline:
                raise RuntimeError('The isolated bridge did not become healthy.')
            time.sleep(0.1)
        run('systemctl', 'is-active', 'originmind-wechat-kf')
        snippet_path.parent.mkdir(exist_ok=True)
        shutil.copy2(release / 'deploy/nginx-callback.conf', snippet_path)
        snippet_path.chmod(0o644)
        if include not in original:
            nginx_path.write_text(original.replace(anchor, anchor + '\n' + include, 1))
        run(str(nginx_binary), '-t')
        run('systemctl', 'reload', 'nginx')
    except Exception:
        # Stop the candidate before restoring files or links. A failed Nginx
        # validation must not leave a process running from an unactivated release.
        subprocess.run(['systemctl', 'stop', 'originmind-wechat-kf'], check=False, timeout=30)
        if not prior_service:
            subprocess.run(['systemctl', 'disable', 'originmind-wechat-kf'], check=False, timeout=30)
        nginx_path.write_text(original)
        for file in [snippet_path, service_path]:
            saved = backup / file.name
            if saved.exists():
                shutil.copy2(saved, file)
            elif file.exists():
                file.unlink()
        if before_link is not None:
            restore_link = current.with_name('current-restore-' + stamp)
            restore_link.symlink_to(before_link)
            os.replace(restore_link, current)
        elif current.is_symlink():
            current.unlink()
        run('systemctl', 'daemon-reload')
        if before_link is not None and prior_service:
            run('systemctl', 'restart', 'originmind-wechat-kf')
        run(str(nginx_binary), '-t')
        run('systemctl', 'reload', 'nginx')
        raise
    receipt = {'release': str(release), 'nginxBackup': str(backup),
               'callback': 'https://chat.omindos.cn/integrations/wechat-kf/callback',
               'status': 'waiting_for_customer_service_configuration'}
    (backup / 'receipt.json').write_text(json.dumps(receipt, indent=2) + '\n')
    print(json.dumps(receipt))


if __name__ == '__main__':
    main()
