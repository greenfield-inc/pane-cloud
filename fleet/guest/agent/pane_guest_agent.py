#!/usr/bin/env python3
"""Pane Cloud guest agent: runs the allow-listed guest operations the host agent sends over vsock.

Protocol (fleet/README.md, "F5 guest agent protocol"): one JSON object per line in, one per line out.
  {"id": "...", "operation": "status", "parameters": {}}
  {"id": "...", "ok": true, "result": {...}}  or  {"id": "...", "ok": false, "error": {code, message, next}}

Only bootstrap, update_pane, prepare_to_stop, collect_diagnostics and status run, each with exactly the
parameters the contract allows. There is no shell command and no file write from outside. Python 3
standard library only.
"""

from __future__ import annotations

import base64
import fnmatch
import hashlib
import io
import json
import os
import pwd
import re
import socket
import stat
import subprocess
import tarfile
import threading
import time
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Callable

VSOCK_PORT = 1024
MAX_REQUEST_BYTES = 64 * 1024
PANE_USER = 'pane'
PANE_DAEMON_UNIT = 'pane-remote-daemon.service'
RELEASE_URL = 'https://github.com/greenfield-inc/Pane/releases/download/v{version}/Pane-{version}-linux-arm64.deb'
MAX_DEB_BYTES = 1024 ** 3
# A diagnostics archive carries at most the last 4 MiB of each file, so the response line stays bounded.
MAX_DIAGNOSTIC_FILE_BYTES = 4 * 1024 ** 2
MAX_DIAGNOSTIC_FILES = 16

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
    next_step = 'Send exactly {"release": {"version": "X.Y.Z", "arch": "arm64", "debSha256": "<64 lowercase hex>"}}.'
    if not isinstance(parameters, dict) or set(parameters) != {'release'}:
        raise OperationError('invalid_request', 'The parameters must be exactly {"release": {...}}.', next_step)
    release = parameters['release']
    if not isinstance(release, dict) or set(release) != {'version', 'arch', 'debSha256'}:
        raise OperationError('invalid_request', 'The release must have exactly version, arch and debSha256.', next_step)
    version, arch, sha = release['version'], release['arch'], release['debSha256']
    if not isinstance(version, str) or not VERSION.fullmatch(version):
        raise OperationError('invalid_request', 'release.version must look like 1.4.0.', next_step)
    if arch != 'arm64':
        raise OperationError('invalid_request', 'release.arch must be "arm64".', next_step)
    if not isinstance(sha, str) or not SHA256.fullmatch(sha):
        raise OperationError('invalid_request', 'release.debSha256 must be 64 lowercase hex characters.', next_step)
    return {'release': {'version': version, 'arch': arch, 'debSha256': sha}}


PARAMETER_CHECKS: dict[str, Callable[[Any], dict[str, Any]]] = {
    'bootstrap': check_release_parameters,
    'update_pane': check_release_parameters,
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
    diagnostic_files: tuple[str, ...] = DIAGNOSTIC_FILES
    # Files under these directories must have one link, so a user cannot hard-link another file in.
    user_owned_roots: tuple[str, ...] = ('/home/',)
    release_url: str = RELEASE_URL


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

    def installed_pane_version(self) -> str | None:
        code, out = self.run(['dpkg-query', '-W', '-f=${Status} ${Version}', 'pane'], timeout=30)
        if code != 0 or not out.startswith('install ok installed '):
            return None
        return out.rsplit(' ', 1)[-1].strip() or None

    def tailscale_status(self) -> dict[str, Any] | None:
        try:
            code, out = self.run(['tailscale', 'status', '--json'], timeout=10)
        except (OSError, subprocess.TimeoutExpired):
            return None
        try:
            status = json.loads(out)
        except ValueError:
            return None
        return status if isinstance(status, dict) else None

    def pane_daemon_call(self, pane_dir: str, channel: str, args: list[Any]) -> Any:
        """Calls the local Pane daemon over its control socket, as runpane does (daemonClient.ts)."""
        uid = pwd.getpwnam(PANE_USER).pw_uid
        digest = hashlib.sha256(os.path.abspath(pane_dir).encode()).hexdigest()[:16]
        path = f'/tmp/pane-daemon-{uid}-{digest}/daemon.sock'
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as conn:
            conn.settimeout(5)
            conn.connect(path)
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
        return os.path.exists(f'/home/{PANE_USER}/.config/systemd/user/{PANE_DAEMON_UNIT}')

    def restart_pane_daemon(self) -> None:
        code, out = self.run(['systemctl', '--user', f'--machine={PANE_USER}@', 'restart', PANE_DAEMON_UNIT], timeout=60)
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
        """Runs on every boot: brings Pane to the release the host names (update on boot)."""
        result = self._install_release(release)
        result['firstBoot'] = self._first_boot_state()
        return result

    def update_pane(self, release: dict[str, str]) -> dict[str, Any]:
        return self._install_release(release)

    def prepare_to_stop(self) -> dict[str, Any]:
        # Pane keeps its state in SQLite in WAL mode, which is consistent on disk once synced. The memory
        # snapshot keeps the running daemon as it is, so nothing else needs to stop.
        self.system.sync()
        return {'synced': True}

    def status(self) -> dict[str, Any]:
        return {'paneVersion': self.system.installed_pane_version(),
                'tailnet': self._tailnet(),
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
        version, sha = release['version'], release['debSha256']
        if not self._install_lock.acquire(blocking=False):
            raise OperationError('invalid_state', 'Another Pane install is running on this machine.', 'Retry when it finishes.')
        try:
            before = self.system.installed_pane_version()
            if before == version:
                return {'paneVersion': version, 'previousVersion': before, 'changed': False}
            os.makedirs(self.settings.state_dir, exist_ok=True)
            deb = os.path.join(self.settings.state_dir, f'pane-{version}-arm64.deb')
            url = self.settings.release_url.format(version=version)
            try:
                actual = self.system.download(url, deb, MAX_DEB_BYTES)
                if actual != sha:
                    raise OperationError('release_not_published',
                                         f'The .deb for Pane {version} has sha256 {actual}, not the {sha} the operation names. Nothing was installed.',
                                         'Send the debSha256 from the release\'s SHA256SUMS.txt.')
                code, out = self.system.run(['apt-get', 'install', '-y', '-q', '-o', 'DPkg::Lock::Timeout=300', '--allow-downgrades', deb], timeout=900)
                if code != 0:
                    raise OperationError('internal', f'apt-get could not install Pane {version}: {out.strip()[-300:]}',
                                         'Run collect_diagnostics, then retry update_pane.')
            finally:
                if os.path.exists(deb):
                    os.remove(deb)
            after = self.system.installed_pane_version()
            if self.system.pane_daemon_unit_exists():
                self.system.restart_pane_daemon()
            return {'paneVersion': after, 'previousVersion': before, 'changed': True}
        finally:
            self._install_lock.release()

    def _first_boot_state(self) -> str:
        if os.path.exists(os.path.join(self.settings.state_dir, 'firstboot.done')):
            return 'done'
        if os.path.exists(os.path.join(self.settings.state_dir, 'firstboot.failed')):
            return 'failed'
        return 'running'

    def _tailnet(self) -> dict[str, Any]:
        status = self.system.tailscale_status() or {}
        if status.get('BackendState') == 'Running':
            dns_name = ((status.get('Self') or {}).get('DNSName') or '').rstrip('.')
            return {'status': 'joined', 'loginUrl': None, 'hostname': dns_name or None}
        login_url = status.get('AuthURL')
        if not isinstance(login_url, str) or not login_url.startswith('https://'):
            login_url = None
        return {'status': 'awaiting_login', 'loginUrl': login_url, 'hostname': None}

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


# ---------------------------------------------------------------- transport


def serve(listener: socket.socket, agent: Agent) -> None:
    """Answers every connection on an already listening socket (AF_VSOCK in production, AF_UNIX in tests)."""
    while True:
        try:
            conn, _ = listener.accept()
        except OSError:
            return
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
    serve(vsock_listener(), Agent())


if __name__ == '__main__':
    main()
