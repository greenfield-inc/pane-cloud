#!/usr/bin/env python3
"""Pane Cloud guest agent: runs the allow-listed guest operations the host agent sends over vsock, and
reports the machine's processes and memory pressure to the host.

Operations, on vsock port 1024 (fleet/guest/README.md): one JSON object per line in, one per line out.
  {"id": "...", "operation": "status", "parameters": {}}
  {"id": "...", "ok": true, "result": {...}}  or  {"id": "...", "ok": false, "error": {code, message, next}}
Only bootstrap, update_pane, retry_clone, prepare_to_stop, collect_diagnostics and status run, each
with exactly the parameters the contract allows. There is no shell command and no file write from outside.

Ready, to the host (CID 2) on vsock port 5000, once per boot when the Pane daemon's socket listens:
  {"type": "ready", "uptimeSeconds": 2.1}
Reports, to the host (CID 2) on vsock port 1025: one JSON line per connection, nothing read back.
  {"type": "process_report", ...}   at start, then every 5 minutes
  {"type": "memory_pressure", ...}  when the kernel shows memory pressure, checked every 5 seconds
  {"type": "clone", "state": ...}    each change in the Session's first clone (pane-cloud-clone.service)
Run as `pane_guest_agent.py unseal-github-token`, it unseals the GitHub token once at first boot
(pane-cloud-unseal.service; see unseal_github_token).
Python 3 standard library only.
"""

from __future__ import annotations

import base64
import fnmatch
import hashlib
import io
import json
import os
import platform
import pwd
import shutil
import re
import socket
import stat
import subprocess
import sys
import tarfile
import threading
import time
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Callable

VSOCK_PORT = 1024
REPORT_PORT = 1025
# N1's readyPort: one connection once the Pane daemon's control socket listens.
READY_PORT = 5000
PROCESS_REPORT_SECONDS = 300
PRESSURE_CHECK_SECONDS = 5
# Memory pressure (cover sheet, growing memory): stalls above 10% over 60 s, more than 2 GiB of swap
# in use, or an out-of-memory kill. A signal that holds is sent again at most once a minute.
PRESSURE_PSI_AVG60 = 10.0
PRESSURE_SWAP_BYTES = 2 * 1024 ** 3
PRESSURE_REPEAT_SECONDS = 60
# A program larger than this is reported without a hash.
MAX_HASH_BYTES = 2 * 1024 ** 3
MAX_REQUEST_BYTES = 64 * 1024
PANE_USER = 'pane'
PANE_DAEMON_UNIT = 'pane-daemon.service'
CLONE_UNIT = 'pane-cloud-clone.service'
# pane-daemon.service's arguments after the executable, for update_pane's drop-in.
DAEMON_ARGUMENTS = '--ozone-platform=headless --disable-gpu --daemon-headless --pane-dir /home/pane/.pane'
RELEASE_URL = 'https://github.com/greenfield-inc/Pane/releases/download/v{version}/Pane-{version}-linux-{arch}.deb'
# The machine's Debian architecture: arm64 on the fleet, amd64 only in CI's boot check.
MACHINE_ARCH = {'aarch64': 'arm64', 'x86_64': 'amd64'}.get(platform.machine(), platform.machine())
MAX_DEB_BYTES = 1024 ** 3
# A diagnostics archive carries at most the last 4 MiB of each file, so the response line stays bounded.
MAX_DIAGNOSTIC_FILE_BYTES = 4 * 1024 ** 2
MAX_DIAGNOSTIC_FILES = 16
MAX_DIAGNOSTIC_TOTAL_BYTES = 8 * 1024 ** 2

# The contract's DIAGNOSTIC_FILES (pane-cloud-contract src/fleet.ts). Globs match file names only.
DIAGNOSTIC_FILES = (
    '/var/log/pane-cloud/guest-agent.log',
    '/var/log/pane-cloud/bootstrap.log',
    '/home/pane/.pane/logs/pane-*.log',
)

VERSION = re.compile(r'[0-9]+\.[0-9]+\.[0-9]+')
SHA256 = re.compile(r'[0-9a-f]{64}')
REQUEST_ID = re.compile(r'[A-Za-z0-9_.:-]{1,128}')


class OperationError(Exception):
    """An operation's refusal or failure, sent back as {code, message, next}."""

    def __init__(self, code: str, message: str, next_step: str):
        super().__init__(message)
        self.code = code
        self.message = message
        self.next_step = next_step


def utc_now() -> str:
    return datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')


# ---------------------------------------------------------------- parameter checks


def check_no_parameters(parameters: Any) -> dict[str, Any]:
    if parameters != {} or not isinstance(parameters, dict):
        raise OperationError('invalid_request', 'This operation takes no parameters.', 'Send "parameters": {}.')
    return {}


def check_release_parameters(parameters: Any) -> dict[str, Any]:
    next_step = f'Send exactly {{"release": {{"version": "X.Y.Z", "arch": "{MACHINE_ARCH}", "debSha256": "<64 lowercase hex>"}}}}.'
    if not isinstance(parameters, dict) or set(parameters) != {'release'}:
        raise OperationError('invalid_request', 'The parameters must be exactly {"release": {...}}.', next_step)
    release = parameters['release']
    if not isinstance(release, dict) or set(release) != {'version', 'arch', 'debSha256'}:
        raise OperationError('invalid_request', 'The release must have exactly version, arch and debSha256.', next_step)
    version, arch, sha = release['version'], release['arch'], release['debSha256']
    if not isinstance(version, str) or not VERSION.fullmatch(version):
        raise OperationError('invalid_request', 'release.version must look like 1.4.0.', next_step)
    if arch != MACHINE_ARCH:
        raise OperationError('invalid_request', f'release.arch must be this machine\'s, "{MACHINE_ARCH}".', next_step)
    if not isinstance(sha, str) or not SHA256.fullmatch(sha):
        raise OperationError('invalid_request', 'release.debSha256 must be 64 lowercase hex characters.', next_step)
    return {'release': {'version': version, 'arch': arch, 'debSha256': sha}}


PARAMETER_CHECKS: dict[str, Callable[[Any], dict[str, Any]]] = {
    'bootstrap': check_release_parameters,
    'update_pane': check_release_parameters,
    'retry_clone': check_no_parameters,
    'prepare_to_stop': check_no_parameters,
    'collect_diagnostics': check_no_parameters,
    'status': check_no_parameters,
}


# ---------------------------------------------------------------- the machine's side effects


@dataclass
class Settings:
    """Where the agent reads and writes on the machine."""

    log_path: str = '/var/log/pane-cloud/guest-agent.log'
    state_dir: str = '/var/lib/pane-cloud'
    pane_dir: str = '/home/pane/.pane'
    proc_root: str = '/proc'
    mounts_path: str = '/proc/self/mounts'
    secrets_mount: str = '/home/pane/.pane-secrets'
    diagnostic_files: tuple[str, ...] = DIAGNOSTIC_FILES
    # Files under these directories must have one link, so a user cannot hard-link another file in.
    user_owned_roots: tuple[str, ...] = ('/home/',)
    release_url: str = RELEASE_URL
    ready_marker: str = '/run/pane-cloud/ready-sent'
    # update_pane's copy of a newer Pane, on the Session disk; overlay-init deletes it at the next boot.
    hot_dir: str = '/var/lib/pane-cloud/hot'
    # Points the daemon at the hot copy; /run is gone at the next boot.
    hot_dropin: str = f'/run/systemd/system/{PANE_DAEMON_UNIT}.d/hot.conf'
    # The Pane drive's release ({"version", "arch", "debSha256"}), written by whoever builds the drive.
    pane_drive_release: str = '/opt/Pane/release.json'
    # The clone unit's progress (state.json); its done marker holds the Pane's id.
    clone_run_dir: str = '/run/pane-cloud-clone'
    clone_state_dir: str = '/var/lib/pane-cloud-clone'
    # The token the clone and its history fetch read through their credential helper, on the secrets
    # volume (never the Session disk) so a history fetch a sleep cut short can resume at the next boot;
    # the clone unit deletes it when that ends.
    clone_token: str = '/home/pane/.pane-secrets/pane-cloud/clone-token'
    pane_uid: int | None = 1000


class System:
    """Everything the agent does outside its own process. Tests replace it with a fake."""

    def download(self, url: str, dest: str, max_bytes: int) -> str:
        """Downloads url (https only, also on redirects) to dest and returns the file's sha256 hex."""
        opener = urllib.request.build_opener(HttpsOnlyRedirects())
        if not url.startswith('https://'):
            raise OperationError('internal', 'Refused a non-https download.', 'Use the official https release URL.')
        digest = hashlib.sha256()
        total = 0
        try:
            with opener.open(url, timeout=60) as response, open(dest, 'wb') as out:
                while chunk := response.read(1024 * 1024):
                    total += len(chunk)
                    if total > max_bytes:
                        raise OperationError('internal', 'The download is larger than any Pane release.', 'Check the release URL.')
                    digest.update(chunk)
                    out.write(chunk)
        except urllib.error.HTTPError as error:
            if error.code == 404:
                raise OperationError('release_not_published', f'{url} does not exist.', 'Name a published Pane release.')
            raise
        return digest.hexdigest()

    def run(self, argv: list[str], timeout: float = 600) -> tuple[int, str]:
        done = subprocess.run(argv, capture_output=True, text=True, timeout=timeout, check=False)
        return done.returncode, (done.stdout + done.stderr)[-4000:]

    def extract_deb(self, deb: str, dest: str) -> None:
        """Unpacks a .deb's files into dest without touching the package database."""
        code, out = self.run(['dpkg-deb', '-x', deb, dest], timeout=600)
        if code != 0:
            raise OperationError('internal', f'dpkg-deb could not unpack the release: {out.strip()[-300:]}',
                                 'Run collect_diagnostics, then retry update_pane.')
        # Chromium's sandbox helper must be root's and setuid, as the package's own install leaves it.
        sandbox = os.path.join(dest, 'opt/Pane/chrome-sandbox')
        if os.path.exists(sandbox):
            os.chown(sandbox, 0, 0)
            os.chmod(sandbox, 0o4755)

    def installed_pane_version(self) -> str | None:
        """The base's Pane, from its .deb."""
        code, out = self.run(['dpkg-query', '-W', '-f=${Status} ${Version}', 'pane'], timeout=30)
        if code != 0 or not out.startswith('install ok installed '):
            return None
        return out.rsplit(' ', 1)[-1].strip() or None

    def pane_daemon_call(self, pane_dir: str, channel: str, args: list[Any]) -> Any:
        """Calls the local Pane daemon over its control socket, as runpane does (daemonClient.ts)."""
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as conn:
            conn.settimeout(5)
            conn.connect(daemon_socket_path(pane_dir))
            conn.sendall((json.dumps({'type': 'request', 'id': 1, 'channel': channel, 'args': args}) + '\n').encode())
            reader = conn.makefile('r', encoding='utf-8')
            for line in reader:
                frame = json.loads(line)
                if frame.get('type') == 'response' and frame.get('id') == 1:
                    if not frame.get('ok'):
                        raise RuntimeError((frame.get('error') or {}).get('message') or 'Pane refused the call')
                    return frame.get('result')
        raise RuntimeError('Pane closed the control socket without answering')

    def pane_daemon_unit_exists(self) -> bool:
        return os.path.exists(f'/etc/systemd/system/{PANE_DAEMON_UNIT}')

    def restart_pane_daemon(self) -> None:
        self.run(['systemctl', 'daemon-reload'], timeout=60)
        code, out = self.run(['systemctl', 'restart', PANE_DAEMON_UNIT], timeout=60)
        if code != 0:
            raise OperationError('internal', f'Pane is installed but its daemon did not restart: {out.strip()[-300:]}',
                                 'Run collect_diagnostics and read bootstrap.log.')

    def sync(self) -> None:
        os.sync()


class HttpsOnlyRedirects(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):  # type: ignore[no-untyped-def]
        if not newurl.startswith('https://'):
            raise OperationError('internal', 'The release download redirected to a non-https URL.', 'Retry later.')
        return super().redirect_request(req, fp, code, msg, headers, newurl)


# ---------------------------------------------------------------- the agent


@dataclass
class Agent:
    settings: Settings = field(default_factory=Settings)
    system: System = field(default_factory=System)

    def __post_init__(self) -> None:
        self._install_lock = threading.Lock()
        self._log_lock = threading.Lock()

    # One request line in, one response object out.
    def handle_line(self, line: bytes) -> dict[str, Any]:
        started = time.monotonic()
        request_id: Any = None
        operation: Any = None
        try:
            try:
                request = json.loads(line)
            except ValueError:
                raise OperationError('invalid_request', 'The request is not valid JSON.', 'Send one JSON object per line.')
            if not isinstance(request, dict):
                raise OperationError('invalid_request', 'The request must be a JSON object.', 'Send one JSON object per line.')
            request_id = request.get('id')
            if not isinstance(request_id, str) or not REQUEST_ID.fullmatch(request_id):
                request_id = None
                raise OperationError('invalid_request', 'The request needs a string id.', 'Send {"id", "operation", "parameters"}.')
            if set(request) != {'id', 'operation', 'parameters'}:
                raise OperationError('invalid_request', 'The request must have exactly id, operation and parameters.',
                                     'Send {"id", "operation", "parameters"}.')
            operation = request['operation']
            if not isinstance(operation, str) or operation not in PARAMETER_CHECKS:
                raise OperationError('operation_not_allowed', f'"{operation}" is not an allow-listed guest operation.',
                                     f'Use one of: {", ".join(PARAMETER_CHECKS)}.')
            parameters = PARAMETER_CHECKS[operation](request['parameters'])
            result = getattr(self, operation)(**parameters)
            response: dict[str, Any] = {'id': request_id, 'ok': True, 'result': result}
        except OperationError as error:
            response = {'id': request_id, 'ok': False,
                        'error': {'code': error.code, 'message': error.message, 'next': error.next_step}}
        except Exception as error:  # noqa: BLE001 - every failure becomes a reply, never a dropped connection
            response = {'id': request_id, 'ok': False,
                        'error': {'code': 'internal', 'message': f'{type(error).__name__}: {error}',
                                  'next': 'Run collect_diagnostics and read guest-agent.log.'}}
        self._log(request_id, operation, response, time.monotonic() - started)
        return response

    def _log(self, request_id: Any, operation: Any, response: dict[str, Any], seconds: float) -> None:
        entry: dict[str, Any] = {'at': utc_now(), 'id': request_id, 'operation': operation[:64] if isinstance(operation, str) else None,
                                 'ok': response['ok'], 'ms': round(seconds * 1000)}
        if response['ok']:
            result = response['result']
            entry['result'] = {k: v for k, v in result.items() if k != 'archive'}
        else:
            entry['error'] = response['error']
        try:
            os.makedirs(os.path.dirname(self.settings.log_path), exist_ok=True)
            with self._log_lock, open(self.settings.log_path, 'a', encoding='utf-8') as log:
                log.write(json.dumps(entry) + '\n')
        except OSError:
            pass

    # ------------------------------------------------------------ operations

    def bootstrap(self, release: dict[str, str]) -> dict[str, Any]:
        """Runs on every boot: brings Pane to the release the host names (update on boot). The agent
        CLIs are in the image, so first boot has nothing left to do."""
        return {**self._install_release(release), 'firstBoot': 'done'}

    def update_pane(self, release: dict[str, str]) -> dict[str, Any]:
        return self._install_release(release)

    def retry_clone(self) -> dict[str, Any]:
        """Runs the Session's first clone again after it failed (the app's Retry)."""
        if os.path.exists(os.path.join(self.settings.clone_state_dir, 'done')):
            raise OperationError('invalid_state', 'The clone already made its Pane.', 'Open that Pane.')
        state = read_json(os.path.join(self.settings.clone_run_dir, 'state.json')) or {}
        if state.get('state') in ('cloning', 'creating'):
            raise OperationError('invalid_state', 'The clone is still running.', 'Wait for it to finish or fail.')
        code, out = self.system.run(['systemctl', 'start', '--no-block', CLONE_UNIT], timeout=30)
        if code != 0:
            raise OperationError('internal', f'The clone could not start: {out.strip()[-300:]}', 'Run collect_diagnostics.')
        return {'started': True}

    def prepare_to_stop(self) -> dict[str, Any]:
        # Pane keeps its state in SQLite in WAL mode, which is consistent on disk once synced. The memory
        # snapshot keeps the running daemon as it is, so nothing else needs to stop.
        self.system.sync()
        return {'synced': True}

    def status(self) -> dict[str, Any]:
        return {'paneVersion': self._pane_version(),
                'relay': self._relay(),
                'secretsVolume': self._secrets_volume(),
                'activity': self._activity()}

    def collect_diagnostics(self) -> dict[str, Any]:
        files: list[dict[str, Any]] = []
        skipped: list[dict[str, str]] = []
        buffer = io.BytesIO()
        with tarfile.open(fileobj=buffer, mode='w:gz') as archive:
            for path in self._diagnostic_candidates(skipped):
                if len(files) >= MAX_DIAGNOSTIC_FILES:
                    skipped.append({'path': path, 'reason': 'too many files'})
                    continue
                try:
                    data = self._read_allowed(path)
                except OperationError as refusal:
                    skipped.append({'path': path, 'reason': refusal.message})
                    continue
                if sum(f['bytes'] for f in files) + len(data) > MAX_DIAGNOSTIC_TOTAL_BYTES:
                    skipped.append({'path': path, 'reason': 'over the 8 MiB total'})
                    continue
                info = tarfile.TarInfo(path.lstrip('/'))
                info.size = len(data)
                info.mtime = int(time.time())
                archive.addfile(info, io.BytesIO(data))
                files.append({'path': path, 'bytes': len(data)})
        packed = buffer.getvalue()
        return {'files': files, 'skipped': skipped,
                'archive': {'format': 'tar+gzip', 'bytes': len(packed),
                            'sha256': hashlib.sha256(packed).hexdigest(),
                            'base64': base64.b64encode(packed).decode('ascii')}}

    # ------------------------------------------------------------ helpers

    def _install_release(self, release: dict[str, str]) -> dict[str, Any]:
        """Brings the running machine to the release without touching the package database: the .deb
        is unpacked into the hot copy and a drop-in in /run points the daemon at it. The next boot
        deletes both and runs the Pane drive the host attaches."""
        version, sha, arch = release['version'], release['debSha256'], release['arch']
        if not self._install_lock.acquire(blocking=False):
            raise OperationError('invalid_state', 'Another Pane install is running on this machine.', 'Retry when it finishes.')
        try:
            before = self._pane_version()
            if before == version:
                return {'paneVersion': version, 'previousVersion': before, 'changed': False}
            os.makedirs(self.settings.state_dir, exist_ok=True)
            deb = os.path.join(self.settings.state_dir, f'pane-{version}-{arch}.deb')
            target = os.path.join(self.settings.hot_dir, version)
            try:
                actual = self.system.download(self.settings.release_url.format(version=version, arch=arch), deb, MAX_DEB_BYTES)
                if actual != sha:
                    raise OperationError('release_not_published',
                                         f'The .deb for Pane {version} has sha256 {actual}, not the {sha} the operation names. Nothing was installed.',
                                         'Send the debSha256 from the release\'s SHA256SUMS.txt.')
                shutil.rmtree(self.settings.hot_dir, ignore_errors=True)
                os.makedirs(self.settings.hot_dir)
                self.system.extract_deb(deb, target + '.part')
                os.rename(target + '.part', target)
            finally:
                if os.path.exists(deb):
                    os.remove(deb)
            os.makedirs(os.path.dirname(self.settings.hot_dropin), exist_ok=True)
            with open(self.settings.hot_dropin, 'w') as dropin:
                dropin.write(f'# Pane {version}, unpacked by update_pane; gone at the next boot.\n[Service]\nExecStart=\n'
                             f'ExecStart={target}/opt/Pane/pane {DAEMON_ARGUMENTS}\n')
            if self.system.pane_daemon_unit_exists():
                self.system.restart_pane_daemon()
            return {'paneVersion': version, 'previousVersion': before, 'changed': True}
        finally:
            self._install_lock.release()

    def _pane_version(self) -> str | None:
        """The Pane the daemon runs: update_pane's hot copy, else the Pane drive, else the base's .deb."""
        try:
            with open(self.settings.hot_dropin) as dropin:
                return dropin.readline().split()[2].rstrip(',')
        except (OSError, IndexError):
            pass
        try:
            with open(self.settings.pane_drive_release) as drive:
                version = json.load(drive).get('version')
            return version if isinstance(version, str) and VERSION.fullmatch(version) else None
        except (OSError, ValueError, AttributeError):
            return self.system.installed_pane_version()

    def _relay(self) -> dict[str, Any]:
        """The daemon's relay identity, which the service vouches for when a client pairs (A6).

        status is Pane's relay phase (off, connecting, certificate, ready, error), or unreachable while
        the daemon does not answer. fingerprint is the SHA-256 of the computer's public key, base64url.
        """
        relay: dict[str, Any] = {'status': 'unreachable', 'id': None, 'address': None, 'fingerprint': None}
        try:
            status = self.system.pane_daemon_call(self.settings.pane_dir, 'relay:status', [])
        except Exception:  # noqa: BLE001 - no daemon yet
            return relay
        if not isinstance(status, dict):
            return relay
        relay.update(status=status.get('phase') if isinstance(status.get('phase'), str) else 'error',
                     id=status.get('id') if isinstance(status.get('id'), str) else None,
                     address=status.get('address') if isinstance(status.get('address'), str) else None)
        try:
            computer = self.system.pane_daemon_call(self.settings.pane_dir, 'relay:client:computer', [])
            if isinstance(computer, dict) and computer.get('id') == relay['id'] and isinstance(computer.get('fingerprint'), str):
                relay['fingerprint'] = computer['fingerprint']
        except Exception:  # noqa: BLE001 - not connected to the relay yet
            pass
        return relay

    def _secrets_volume(self) -> str:
        """mounted: the secrets volume is on its mount point, no-exec. missing: it is not."""
        try:
            with open(self.settings.mounts_path, encoding='utf-8') as mounts:
                for line in mounts:
                    fields = line.split()
                    if len(fields) >= 4 and fields[1] == self.settings.secrets_mount and 'noexec' in fields[3].split(','):
                        return 'mounted'
        except OSError:
            pass
        return 'missing'

    def _activity(self) -> dict[str, Any]:
        """Agents working (Pane's workspace state) and clients attached (Pane's remote host state)."""
        agents = clients = 0
        newest: str | None = None
        try:
            state = self.system.pane_daemon_call(self.settings.pane_dir, 'runpane:workspace:state', [{}])
            for entry in (state or {}).get('entries') or []:
                if not isinstance(entry, dict):
                    continue
                if entry.get('kind') == 'agent.busy':
                    agents += 1
                at = entry.get('at')
                if isinstance(at, str) and (newest is None or at > newest):
                    newest = at
        except Exception:  # noqa: BLE001 - no daemon yet means no activity
            pass
        try:
            host = self.system.pane_daemon_call(self.settings.pane_dir, 'remote-daemon:get-host-state', [])
            data = host.get('data') if isinstance(host, dict) and 'data' in host else host
            clients = len((data or {}).get('connectedClients') or [])
        except Exception:  # noqa: BLE001
            pass
        marker = os.path.join(self.settings.state_dir, 'last-activity')
        if agents or clients:
            newest = utc_now()
            try:
                os.makedirs(self.settings.state_dir, exist_ok=True)
                with open(marker, 'w', encoding='utf-8') as out:
                    out.write(newest)
            except OSError:
                pass
        else:
            try:
                with open(marker, encoding='utf-8') as recorded:
                    seen = recorded.read().strip()
                if seen and (newest is None or seen > newest):
                    newest = seen
            except OSError:
                pass
        return {'agentsRunning': agents, 'clientsConnected': clients, 'lastActivityAt': newest}

    def _diagnostic_candidates(self, skipped: list[dict[str, str]]) -> list[str]:
        """Expands the allow-list. A glob matches names inside its own directory only."""
        paths: list[str] = []
        for pattern in self.settings.diagnostic_files:
            directory, name = os.path.split(pattern)
            if not any(ch in name for ch in '*?['):
                paths.append(pattern)
                continue
            try:
                fd = self._open_dir_no_symlinks(directory)
            except OperationError as refusal:
                skipped.append({'path': pattern, 'reason': refusal.message})
                continue
            try:
                names = sorted((n for n in os.listdir(fd) if fnmatch.fnmatchcase(n, name)), reverse=True)
            finally:
                os.close(fd)
            paths.extend(os.path.join(directory, n) for n in names)
        return paths

    def _open_dir_no_symlinks(self, directory: str) -> int:
        """Opens an absolute directory one component at a time, refusing any symlink on the way."""
        fd = os.open('/', os.O_RDONLY | os.O_DIRECTORY)
        try:
            for part in [p for p in directory.split('/') if p]:
                if part in ('.', '..'):
                    raise OperationError('invalid_request', f'{directory} is not a plain path.', 'Fix the allow-list.')
                try:
                    child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
                except FileNotFoundError:
                    raise OperationError('invalid_request', f'{directory} does not exist.', 'Nothing to collect.')
                except OSError:
                    raise OperationError('invalid_request', f'{directory} is a symlink or not a directory.', 'Refused.')
                os.close(fd)
                fd = child
            return fd
        except BaseException:
            os.close(fd)
            raise

    def _read_allowed(self, path: str) -> bytes:
        """Reads the tail of one allow-listed regular file, refusing symlinks and hard links anywhere on its path."""
        directory, name = os.path.split(path)
        dir_fd = self._open_dir_no_symlinks(directory)
        try:
            try:
                fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=dir_fd)
            except FileNotFoundError:
                raise OperationError('invalid_request', 'not found', 'Nothing to collect.')
            except OSError:
                raise OperationError('invalid_request', 'a symlink or unreadable', 'Refused.')
        finally:
            os.close(dir_fd)
        try:
            info = os.fstat(fd)
            if not stat.S_ISREG(info.st_mode):
                raise OperationError('invalid_request', 'not a regular file', 'Refused.')
            if info.st_nlink != 1 and any(path.startswith(root) for root in self.settings.user_owned_roots):
                raise OperationError('invalid_request', 'a hard link', 'Refused.')
            os.lseek(fd, max(0, info.st_size - MAX_DIAGNOSTIC_FILE_BYTES), os.SEEK_SET)
            chunks = []
            remaining = MAX_DIAGNOSTIC_FILE_BYTES
            while remaining and (chunk := os.read(fd, min(remaining, 1024 * 1024))):
                chunks.append(chunk)
                remaining -= len(chunk)
            return b''.join(chunks)
        finally:
            os.close(fd)


# ---------------------------------------------------------------- reports to the host


class Reporter:
    """Reads the machine's processes and memory pressure from /proc and sends them to the host.

    A user with root can stop these reports; the host flags an awake machine whose reports stop.
    """

    def __init__(self, settings: Settings, send: Callable[[dict[str, Any]], None]):
        self.settings = settings
        self.send = send
        self._hashes: dict[tuple[int, int, int, int], str | None] = {}
        self._pressure_sent_at: float | None = None
        self._oom_kills_sent = 0

    def process_report(self) -> dict[str, Any]:
        """Every process that runs a program, with that program's SHA-256 (D1 checks it against known miners).

        Kernel threads, which run no program, are left out. Command lines and environments are never read:
        they can hold secrets.
        """
        processes = []
        for name in os.listdir(self.settings.proc_root):
            if name.isdigit():
                process = self._process(int(name))
                if process:
                    processes.append(process)
        processes.sort(key=lambda p: p['pid'])
        # Forget programs nothing runs any more, so the cache stays as small as the process list.
        live = {process.pop('_key') for process in processes} - {None}
        self._hashes = {key: value for key, value in self._hashes.items() if key in live}
        return {'type': 'process_report', 'at': utc_now(), 'bootId': self._boot_id(), 'processes': processes}

    def check_memory(self, now: float) -> None:
        """Sends the pressure signal when the kernel shows one and it is due. Until the host takes it, the
        next check (5 seconds later) tries again."""
        message = self._memory_pressure(now)
        if message:
            self.send(message)
            self._pressure_sent_at = now
            self._oom_kills_sent = message['oomKills']

    def _memory_pressure(self, now: float) -> dict[str, Any] | None:
        psi = self._psi_some_avg60()
        swap = self._swap_used_bytes()
        oom_kills = self._oom_kills()
        reasons = []
        if oom_kills > self._oom_kills_sent:
            reasons.append('oom_kill')
        if psi > PRESSURE_PSI_AVG60:
            reasons.append('psi')
        if swap > PRESSURE_SWAP_BYTES:
            reasons.append('swap')
        if not reasons:
            return None
        if 'oom_kill' not in reasons and self._pressure_sent_at is not None and now - self._pressure_sent_at < PRESSURE_REPEAT_SECONDS:
            return None
        return {'type': 'memory_pressure', 'at': utc_now(), 'bootId': self._boot_id(), 'reasons': reasons,
                'psiSomeAvg60': psi, 'swapUsedBytes': swap, 'oomKills': oom_kills}

    def run(self) -> None:
        next_report = 0.0
        while True:
            now = time.monotonic()
            if now >= next_report:
                self._quietly(lambda: self.send(self.process_report()))
                next_report = now + PROCESS_REPORT_SECONDS
            self._quietly(lambda: self.check_memory(now))
            time.sleep(PRESSURE_CHECK_SECONDS)

    @staticmethod
    def _quietly(step: Callable[[], None]) -> None:
        try:
            step()
        except Exception:  # noqa: BLE001 - a host that is not listening misses this report, not the next
            pass

    # ------------------------------------------------------------ /proc

    def _read(self, *parts: str) -> str:
        with open(os.path.join(self.settings.proc_root, *parts), encoding='utf-8', errors='replace') as source:
            return source.read()

    def _boot_id(self) -> str | None:
        try:
            return self._read('sys', 'kernel', 'random', 'boot_id').strip() or None
        except OSError:
            return None

    def _process(self, pid: int) -> dict[str, Any] | None:
        base = os.path.join(self.settings.proc_root, str(pid))
        try:
            exe = os.readlink(os.path.join(base, 'exe'))
            stat_line = self._read(str(pid), 'stat')
            status = self._read(str(pid), 'status')
        except OSError:
            return None  # a kernel thread, or a process that just exited
        name = stat_line[stat_line.index('(') + 1:stat_line.rindex(')')]
        fields = stat_line[stat_line.rindex(')') + 2:].split()
        uid = rss = None
        for line in status.splitlines():
            if line.startswith('Uid:'):
                uid = int(line.split()[1])
            elif line.startswith('VmRSS:'):
                rss = int(line.split()[1]) * 1024
        try:
            sha, key = self._program_sha256(os.path.join(base, 'exe'))
        except OSError:
            sha, key = None, None  # one unreadable program leaves the rest of the report intact
        return {'pid': pid, 'ppid': int(fields[1]), 'uid': uid, 'name': name, 'exe': exe, 'sha256': sha,
                'cpuSeconds': round((int(fields[11]) + int(fields[12])) / os.sysconf('SC_CLK_TCK'), 2),
                'rssBytes': rss, '_key': key}

    def _program_sha256(self, exe_link: str) -> tuple[str | None, tuple[int, int, int, int] | None]:
        """Hashes the program through /proc/<pid>/exe, which opens the file the process runs even if it was
        deleted or replaced. A program is hashed once while any process runs it unchanged."""
        try:
            fd = os.open(exe_link, os.O_RDONLY)
        except OSError:
            return None, None
        try:
            info = os.fstat(fd)
            key = (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns)
            if key not in self._hashes:
                digest: str | None = None
                if stat.S_ISREG(info.st_mode) and info.st_size <= MAX_HASH_BYTES:
                    hasher = hashlib.sha256()
                    while chunk := os.read(fd, 1024 * 1024):
                        hasher.update(chunk)
                    digest = hasher.hexdigest()
                self._hashes[key] = digest
            return self._hashes[key], key
        finally:
            os.close(fd)

    def _psi_some_avg60(self) -> float:
        try:
            for line in self._read('pressure', 'memory').splitlines():
                if line.startswith('some '):
                    return float(dict(field.split('=') for field in line.split()[1:])['avg60'])
        except (OSError, KeyError, ValueError):
            pass
        return 0.0

    def _swap_used_bytes(self) -> int:
        values = {}
        try:
            for line in self._read('meminfo').splitlines():
                key, _, rest = line.partition(':')
                if key in ('SwapTotal', 'SwapFree'):
                    values[key] = int(rest.split()[0]) * 1024
        except (OSError, ValueError, IndexError):
            return 0
        return max(0, values.get('SwapTotal', 0) - values.get('SwapFree', 0))

    def _oom_kills(self) -> int:
        try:
            for line in self._read('vmstat').splitlines():
                key, _, value = line.partition(' ')
                if key == 'oom_kill':
                    return int(value)
        except (OSError, ValueError):
            pass
        return 0


def read_json(path: str) -> Any:
    try:
        with open(path) as source:
            return json.load(source)
    except (OSError, ValueError):
        return None


def write_private(path: str, data: bytes, uid: int | None) -> None:
    """Writes a file only its owner reads (0600), by rename, so no reader ever sees part of it."""
    tmp = f'{path}.{os.getpid()}.tmp'
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        with os.fdopen(fd, 'wb') as out:
            out.write(data)
        if uid is not None:
            os.chown(tmp, uid, uid)
        os.replace(tmp, path)
    except BaseException:
        if os.path.exists(tmp):
            os.remove(tmp)
        raise


def unseal_github_token(settings: Settings) -> None:
    """The one-shot unseal at first boot (D-107), as root, before the Pane daemon and the clone start.

    The host wrote pane-cloud/github-token.sealed (a libsodium sealed box of the app's
    {"token", "source", "updatedAt"}) and the slot's private key pane-cloud/seal.key, root-only, on the
    secrets volume. This writes the record unchanged to incoming/github-token.json for the Pane daemon to
    import into K1's store (pane, 0600, in a 0700 folder) and the token alone to pane-cloud/clone-token
    (pane, 0600), then deletes both inputs. pane-cloud/ becomes root:pane 0710, so pane reaches its token
    file and nothing else there (the host's clone.json stays root's). Nothing sealed (a public repository, a later boot):
    nothing to do. The token is never logged: errors name the step, never the content.
    """
    sealed_dir = os.path.join(settings.secrets_mount, 'pane-cloud')
    sealed_path = os.path.join(sealed_dir, 'github-token.sealed')
    key_path = os.path.join(sealed_dir, 'seal.key')
    if not os.path.exists(sealed_path):
        return
    from nacl.public import PrivateKey, SealedBox  # PyNaCl (python3-nacl), only needed here
    with open(key_path, 'rb') as key, open(sealed_path, 'rb') as sealed:
        plaintext = SealedBox(PrivateKey(key.read())).decrypt(sealed.read())
    try:
        record = json.loads(plaintext)
    except ValueError:
        raise ValueError('The sealed GitHub token is not a JSON record.') from None
    if not isinstance(record, dict) or not isinstance(record.get('token'), str) or not record['token'].strip():
        raise ValueError('The sealed GitHub token record has no token.')
    incoming = os.path.join(settings.secrets_mount, 'incoming')
    os.makedirs(incoming, mode=0o700, exist_ok=True)
    os.chmod(incoming, 0o700)
    if settings.pane_uid is not None:
        os.chown(incoming, settings.pane_uid, settings.pane_uid)
    write_private(os.path.join(incoming, 'github-token.json'), plaintext, settings.pane_uid)
    write_private(settings.clone_token, record['token'].strip().encode(), settings.pane_uid)
    os.remove(sealed_path)
    os.remove(key_path)
    os.chmod(sealed_dir, 0o710)
    if settings.pane_uid is not None:
        os.chown(sealed_dir, 0, settings.pane_uid)


def copy_clone_request(settings: Settings) -> None:
    """Hands the clone unit (run as pane) the host's root-only pane-cloud/clone.json ({url, branch}),
    as root, before each run of the clone. The host's copy stays for retry_clone."""
    os.makedirs(settings.clone_run_dir, exist_ok=True)
    with open(os.path.join(settings.secrets_mount, 'pane-cloud', 'clone.json'), 'rb') as request:
        write_private(os.path.join(settings.clone_run_dir, 'request.json'), request.read(), settings.pane_uid)


class CloneReporter:
    """Reports each change in the clone unit's state.json to the host (port 1025), for the app's view."""

    def __init__(self, settings: Settings):
        self.settings = settings
        self._last: Any = None

    def poll(self) -> dict[str, Any] | None:
        state = read_json(os.path.join(self.settings.clone_run_dir, 'state.json'))
        if not isinstance(state, dict) or state == self._last:
            return None
        self._last = state
        try:
            with open(os.path.join(self.settings.proc_root, 'sys/kernel/random/boot_id')) as boot:
                boot_id = boot.read().strip()
        except OSError:
            boot_id = None
        return {'type': 'clone', 'at': utc_now(), 'bootId': boot_id, **state}

    def run(self, send: Callable[[dict[str, Any]], None]) -> None:
        while True:
            message = self.poll()
            if message:
                try:
                    send(message)
                except OSError:
                    self._last = None  # the host missed it: send it again
            time.sleep(0.25)


def daemon_socket_path(pane_dir: str) -> str:
    """The Pane daemon's control socket, as runpane finds it (Pane's daemonClient.ts)."""
    uid = pwd.getpwnam(PANE_USER).pw_uid
    return f'/tmp/pane-daemon-{uid}-{hashlib.sha256(os.path.abspath(pane_dir).encode()).hexdigest()[:16]}/daemon.sock'


def signal_ready(settings: Settings, send: Callable[[dict[str, Any], int], None], socket_path: str) -> None:
    """Tells the host once per boot that the Pane daemon listens: waits until its control socket
    accepts a connection, then sends one line to N1's readyPort. The marker lives in /run, so an agent
    restart does not signal twice and the next boot signals again."""
    if os.path.exists(settings.ready_marker):
        return
    while True:
        try:
            with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as probe:
                probe.connect(socket_path)
            break
        except OSError:
            time.sleep(0.01)
    with open(os.path.join(settings.proc_root, 'uptime')) as uptime:
        message = {'type': 'ready', 'uptimeSeconds': float(uptime.read().split()[0])}
    for _ in range(600):  # a minute: the host's listener may not be bound yet
        try:
            send(message, READY_PORT)
            break
        except OSError:
            time.sleep(0.1)
    os.makedirs(os.path.dirname(settings.ready_marker), exist_ok=True)
    with open(settings.ready_marker, 'w'):
        pass


def send_to_host(message: dict[str, Any], port: int = REPORT_PORT) -> None:
    """One report, one connection, to the host agent's vsock listener."""
    with socket.socket(socket.AF_VSOCK, socket.SOCK_STREAM) as conn:
        conn.settimeout(10)
        conn.connect((socket.VMADDR_CID_HOST, port))
        conn.sendall((json.dumps(message) + '\n').encode())


# ---------------------------------------------------------------- transport


def serve(listener: socket.socket, agent: Agent) -> None:
    """Answers every connection on an already listening socket (AF_VSOCK in production, AF_UNIX in tests)."""
    while True:
        try:
            conn, peer = listener.accept()
        except OSError:
            return
        if listener.family == getattr(socket, 'AF_VSOCK', None) and peer[0] != socket.VMADDR_CID_HOST:
            conn.close()  # only the host may send operations, never a process inside the guest
            continue
        threading.Thread(target=_serve_connection, args=(conn, agent), daemon=True).start()


def _serve_connection(conn: socket.socket, agent: Agent) -> None:
    with conn, conn.makefile('rb') as reader:
        while True:
            line = reader.readline(MAX_REQUEST_BYTES + 1)
            if not line:
                return
            if len(line) > MAX_REQUEST_BYTES and not line.endswith(b'\n'):
                reply = {'id': None, 'ok': False, 'error': {'code': 'invalid_request', 'message': 'The request line is too long.',
                                                            'next': f'Send at most {MAX_REQUEST_BYTES} bytes per line.'}}
                conn.sendall((json.dumps(reply) + '\n').encode())
                return
            if not line.strip():
                continue
            conn.sendall((json.dumps(agent.handle_line(line)) + '\n').encode())


def vsock_listener(port: int = VSOCK_PORT) -> socket.socket:
    listener = socket.socket(socket.AF_VSOCK, socket.SOCK_STREAM)
    listener.bind((socket.VMADDR_CID_ANY, port))
    listener.listen()
    return listener


def main() -> None:
    settings = Settings()
    if sys.argv[1:] == ['unseal-github-token']:
        unseal_github_token(settings)
        return
    if sys.argv[1:] == ['copy-clone-request']:
        copy_clone_request(settings)
        return
    threading.Thread(target=Reporter(settings, send_to_host).run, daemon=True).start()
    threading.Thread(target=signal_ready, args=(settings, send_to_host, daemon_socket_path(settings.pane_dir)), daemon=True).start()
    threading.Thread(target=CloneReporter(settings).run, args=(send_to_host,), daemon=True).start()
    serve(vsock_listener(), Agent(settings))


if __name__ == '__main__':
    main()
