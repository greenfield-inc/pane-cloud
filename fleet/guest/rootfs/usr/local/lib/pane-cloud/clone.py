#!/usr/bin/env python3
"""The Session's first clone (D-107, D-112), run as pane by pane-cloud-clone.service as soon as systemd
starts, beside the Pane daemon's start.

Reads the request the host wrote onto the secrets volume (pane-cloud/clone.json: url, optional branch and
name; copied to /run/pane-cloud-clone/request.json by the unit's root step) and makes a shallow clone:
the newest commit of the branch and its files, with submodules the same way. Once the clone and the Pane
daemon are both ready it registers the repo and creates its Pane locally with runpane. Then, at low
priority, it fetches everything behind that commit: the full history and every branch and tag, so the
repository ends up as a plain git clone. Every git command signs in through a credential helper given
on git's command line (git-credential-clone, reading pane-cloud/clone-token on the secrets volume), so the token
never reaches .git/config, the repository, this unit's output or the progress file.

Progress goes to /run/pane-cloud-clone/state.json, which the guest agent reports to the host:
  {"status": <the contract's CloneStatus: repo, branch, state cloning|ready|failed, phase, percent, line,
              startedAt, finishedAt, error {message}, paneId>,
   "history": "fetching" | "done" | "failed" | null, "startedUptime": <guest seconds at the start>}
Anything that looks like a credential, and the clone token itself, is stripped from git's lines.
A failed clone leaves no clone and no Pane; the guest agent's retry_clone runs this unit again. Once the
Pane exists, /var/lib/pane-cloud-clone/done holds its id and the clone's folder, so a later boot does not
clone again: if a sleep cut the history fetch short, it only resumes that, and history-done ends it all.
Python 3 standard library only.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import socket
import subprocess
import sys
import time

RUN = '/run/pane-cloud-clone'
STATE_DIR = '/var/lib/pane-cloud-clone'
HOME = '/home/pane'
PANE_DIR = f'{HOME}/.pane'
RUNPANE = f'{PANE_DIR}/bin/runpane'
GIT = '/usr/bin/git'
REQUEST = f'{RUN}/request.json'
# A command-line credential helper: clears any configured helper, then asks only this one.
CREDENTIALS = ['-c', 'credential.helper=', '-c', 'credential.helper=/usr/local/lib/pane-cloud/git-credential-clone']
TOKEN = f'{HOME}/.pane-secrets/pane-cloud/clone-token'
# git's progress lines end in \r while they update and \n when they finish.
LINE_END = re.compile(rb'[\r\n]')
PHASES = (('Receiving objects', 'receiving'), ('Resolving deltas', 'resolving'),
          ('Updating files', 'checking_out'), ('Checking out files', 'checking_out'))
CREDENTIAL_LIKE = re.compile(r'(?<=://)[^/\s@]+@|\b(?:gh[pousr]_|github_pat_)[A-Za-z0-9_]{8,}|x-access-token:\S+')


def redact(text: str | None) -> str | None:
    """Removes the clone token and anything credential-like from a line git printed."""
    if text is None:
        return None
    try:
        with open(TOKEN) as token_file:
            token = token_file.read().strip()
        if token:
            text = text.replace(token, '***')
    except OSError:
        pass
    return CREDENTIAL_LIKE.sub('***', text)


def utc_now() -> str:
    return time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())


def uptime() -> float:
    with open('/proc/uptime') as up:
        return float(up.read().split()[0])


class State:
    """The clone's CloneStatus and the history fetch after it, written for the guest agent to report."""

    def __init__(self, repo: str, branch: str | None):
        self.status = {'repo': repo, 'branch': branch or 'HEAD', 'state': 'cloning', 'phase': None, 'percent': None,
                       'line': None, 'startedAt': utc_now(), 'finishedAt': None, 'error': None, 'paneId': None}
        self.history: str | None = None
        self.started = uptime()
        self.written = 0.0

    def set(self, force: bool = True, history: str | None = None, error: str | None = None, line: str | None = None,
            **changes) -> None:
        if history is not None:
            self.history = history
        if line is not None:
            line = redact(line)[-300:]
            changes['line'] = line
            phase = next((name for prefix, name in PHASES if line.startswith(prefix)), None)
            percent = re.search(r'(\d{1,3})%', line)
            if phase and self.status['state'] == 'cloning':
                changes.update(phase=phase, percent=min(100, int(percent.group(1))) if percent else None)
        if error is not None:
            changes['error'] = {'message': redact(error)[-4000:] or 'The clone failed.'}
        if changes.get('state') in ('ready', 'failed'):
            changes.setdefault('finishedAt', utc_now())
            changes.setdefault('phase', None)
        self.status.update(changes)
        if not force and time.monotonic() - self.written < 0.25:
            return
        tmp = f'{RUN}/state.json.tmp'
        with open(tmp, 'w') as out:
            json.dump({'status': self.status, 'history': self.history, 'startedUptime': self.started}, out)
        os.replace(tmp, f'{RUN}/state.json')
        self.written = time.monotonic()


def repo_name(url: str) -> str:
    """owner/repo for a GitHub URL, else the URL's last two path parts."""
    path = re.sub(r'\.git$', '', re.sub(r'^[a-z]+://[^/]+/|^[^@]+@[^:]+:', '', url.strip().rstrip('/')))
    return '/'.join(path.split('/')[-2:])


def git(argv: list[str], state: State | None = None, low_priority: bool = False) -> str | None:
    """Runs git with the clone's credential helper, passing its progress to state; returns git's error,
    or None when it worked."""
    prefix = ['nice', '-n', '19', 'ionice', '-c', '3'] if low_priority else []
    child = subprocess.Popen([*prefix, GIT, *CREDENTIALS, *argv], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                             stderr=subprocess.PIPE, env={**os.environ, 'GIT_TERMINAL_PROMPT': '0'})
    lines: list[str] = []
    pending = b''
    while chunk := child.stderr.read1(4096):
        pending += chunk
        *done, pending = LINE_END.split(pending)
        for raw in done:
            if line := raw.decode('utf-8', 'replace').strip():
                lines = (lines + [line])[-40:]
                if state:
                    state.set(force=False, line=line)
    if child.wait() == 0:
        if state and lines:
            state.set(line=lines[-1])
        return None
    errors = [line for line in lines if line.startswith(('fatal:', 'error:', 'remote:'))] or lines[-5:]
    return '\n'.join(errors)[-2000:] or f'git {argv[0]} exited {child.returncode}'


def clone(url: str, branch: str | None, dest: str, state: State) -> str | None:
    """The shallow clone: the newest commit of the branch and its files, submodules alike."""
    argv = ['clone', '--progress', '--depth=1', '--recurse-submodules', '--shallow-submodules']
    return git(argv + (['--branch', branch] if branch else []) + ['--', url, dest], state)


def fetch_history(dest: str, state: State) -> str | None:
    """Everything behind the shallow clone, at the lowest CPU and disk priority: the full history of every
    branch and every tag, then the submodules' history. Afterwards the repository is a plain clone."""
    error = git(['-C', dest, 'remote', 'set-branches', 'origin', '*'])
    if not error and subprocess.run([GIT, '-C', dest, 'rev-parse', '--is-shallow-repository'], capture_output=True,
                                    text=True).stdout.strip() == 'true':
        error = git(['-C', dest, 'fetch', '--progress', '--unshallow', '--tags', 'origin'], state, low_priority=True)
    return error or git(['-C', dest, 'submodule', 'foreach', '--recursive',
                         'git remote set-branches origin "*" && { [ "$(git rev-parse --is-shallow-repository)" = false ] '
                         '|| git fetch --unshallow --tags origin; }'], low_priority=True)


def daemon_socket() -> str:
    return f'/tmp/pane-daemon-{os.getuid()}-{hashlib.sha256(PANE_DIR.encode()).hexdigest()[:16]}/daemon.sock'


def wait_for_daemon(seconds: float = 300) -> bool:
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        try:
            with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as probe:
                probe.connect(daemon_socket())
            if os.access(RUNPANE, os.X_OK):
                return True
        except OSError:
            pass
        time.sleep(0.02)
    return False


def daemon_calls(*calls: tuple[str, dict]) -> list:
    """Requests to the Pane daemon on one control-socket connection, as runpane sends them (Pane's
    daemonClient.ts), without starting a runpane process for each."""
    results = []
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as conn:
        conn.settimeout(300)
        conn.connect(daemon_socket())
        reader = conn.makefile('r', encoding='utf-8')
        for number, (channel, request) in enumerate(calls, 1):
            conn.sendall((json.dumps({'type': 'request', 'id': number, 'channel': channel, 'args': [request]}) + '\n').encode())
            for line in reader:
                frame = json.loads(line)
                if frame.get('type') == 'response' and frame.get('id') == number:
                    if not frame.get('ok'):
                        raise RuntimeError((frame.get('error') or {}).get('message') or f'{channel} was refused')
                    results.append(frame.get('result'))
                    break
            else:
                raise RuntimeError('The Pane daemon closed its socket without answering.')
    return results


def runpane(*args: str) -> tuple[int, str]:
    done = subprocess.run([RUNPANE, *args, '--yes', '--json'], capture_output=True, text=True, timeout=300,
                          stdin=subprocess.DEVNULL)
    return done.returncode, done.stdout + done.stderr


def create_pane(dest: str, name: str) -> tuple[str | None, str | None]:
    """Registers the repo and creates its Pane, straight on the daemon's socket in one connection; falls
    back to the runpane CLI if the daemon refuses that. Returns (paneId, error)."""
    try:
        _, created = daemon_calls(('runpane:repos:add', {'path': dest, 'name': name}),
                                  ('runpane:panes:create', {'repo': name, 'panes': [{'name': name, 'pinned': True}],
                                                            'noFocus': True, 'source': 'user'}))
        pane_id = created['items'][0].get('paneId')
        if pane_id:
            print('created the Pane on the daemon socket', file=sys.stderr)
            return pane_id, None
    except (OSError, RuntimeError, ValueError, KeyError, IndexError, TypeError):
        pass
    # The CLI, for a daemon that answers the direct calls differently.
    code, out = runpane('repos', 'add', '--path', dest, '--name', name)
    if code != 0 and 'already' not in out.lower():
        return None, f'runpane repos add: {out.strip()[-1000:]}'
    # --no-fetch: the clone is seconds old. Pane versions before the daemon fast start don't know it yet.
    code, out = runpane('panes', 'create', '--repo', name, '--name', name, '--no-focus', '--no-fetch')
    if code != 0 and 'no-fetch' in out:
        code, out = runpane('panes', 'create', '--repo', name, '--name', name, '--no-focus')
    try:
        pane_id = json.loads(out[out.index('{'):])['items'][0].get('paneId') if code == 0 else None
    except (ValueError, KeyError, IndexError):
        pane_id = None
    return (pane_id, None) if pane_id else (None, f'runpane panes create: {out.strip()[-1000:]}')


def finish_history(dest: str, state: State) -> int:
    """The history behind the shallow clone; the CloneStatus stays ready, with the Pane open."""
    state.set(history='fetching')
    if fetch_history(dest, None):
        state.set(history='failed')  # resumes at the next boot
        return 0
    open(f'{STATE_DIR}/history-done', 'w').close()
    state.set(history='done')
    return 0


def main() -> int:
    with open(REQUEST) as request_file:
        request = json.load(request_file)
    made = None
    if os.path.exists(f'{STATE_DIR}/done'):
        with open(f'{STATE_DIR}/done') as done:
            made = json.load(done)
    if made:  # a later boot: the Pane exists, only the history fetch is left
        state = State(repo_name(request['url']), request.get('branch'))
        state.set(state='ready', paneId=made['paneId'], percent=100)
        return finish_history(made['dest'], state)
    url, branch = request['url'], request.get('branch') or None
    name = request.get('name') or repo_name(url).split('/')[-1]
    dest = f'{HOME}/{name}'
    state = State(repo_name(url), branch)
    state.set()
    if os.path.lexists(dest):
        shutil.rmtree(dest)  # a clone a failed attempt left behind
    error = clone(url, branch, dest, state)
    if error:
        shutil.rmtree(dest, ignore_errors=True)
        state.set(state='failed', error=error)
        return 1
    state.set(phase='creating_pane', percent=None, line=None)
    if not wait_for_daemon():
        shutil.rmtree(dest, ignore_errors=True)
        state.set(state='failed', error='The Pane daemon did not start within 5 minutes.')
        return 1
    pane_id, error = create_pane(dest, name)
    if error:
        shutil.rmtree(dest, ignore_errors=True)
        state.set(state='failed', error=error)
        return 1
    with open(f'{STATE_DIR}/done', 'w') as done:
        json.dump({'paneId': pane_id, 'dest': dest}, done)
    state.set(state='ready', paneId=pane_id, percent=100)
    return finish_history(dest, state)


if __name__ == '__main__':
    sys.exit(main())
