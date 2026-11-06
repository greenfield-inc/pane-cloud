"""The guest agent's protocol, driven over a real socket (AF_UNIX here, AF_VSOCK on a machine)."""

import base64
import io
import json
import os
import shutil
import socket
import tarfile
import tempfile
import threading
import unittest

from pane_guest_agent import Agent, Settings, System, serve

SHA256_OF_ABC = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
RELEASE = {'version': '2.4.215', 'arch': 'arm64', 'debSha256': SHA256_OF_ABC}


class FakeSystem(System):
    """The machine: a release server that serves b'abc', apt, tailscale and the Pane daemon."""

    def __init__(self):
        self.version = '2.4.214'
        self.downloads = []
        self.commands = []
        self.restarts = 0
        self.tailscale = {'BackendState': 'NeedsLogin', 'AuthURL': 'https://login.tailscale.com/a/1a2b3c'}
        self.workspace_state = None
        self.host_state = None

    def download(self, url, dest, max_bytes):
        self.downloads.append(url)
        with open(dest, 'wb') as out:
            out.write(b'abc')
        return SHA256_OF_ABC

    def run(self, argv, timeout=600):
        self.commands.append(argv)
        if argv[:2] == ['apt-get', 'install']:
            self.version = '2.4.215'
        return 0, ''

    def installed_pane_version(self):
        return self.version

    def tailscale_status(self):
        return self.tailscale

    def pane_daemon_call(self, pane_dir, channel, args):
        answer = {'runpane:workspace:state': self.workspace_state, 'remote-daemon:get-host-state': self.host_state}[channel]
        if answer is None:
            raise ConnectionRefusedError('no daemon')
        return answer

    def pane_daemon_unit_exists(self):
        return True

    def restart_pane_daemon(self):
        self.restarts += 1

    def sync(self):
        self.commands.append(['sync'])


class GuestAgentTest(unittest.TestCase):
    def setUp(self):
        # realpath: the agent refuses symlinks on the way, and macOS's /tmp is one.
        self.root = os.path.realpath(tempfile.mkdtemp(prefix='pga-', dir='/tmp'))
        self.addCleanup(shutil.rmtree, self.root)
        self.system = FakeSystem()
        self.settings = Settings(
            log_path=self.path('var/log/pane-cloud/guest-agent.log'),
            state_dir=self.path('var/lib/pane-cloud'),
            pane_dir=self.path('home/pane/.pane'),
            diagnostic_files=(
                self.path('var/log/pane-cloud/guest-agent.log'),
                self.path('var/log/pane-cloud/bootstrap.log'),
                self.path('home/pane/.pane/logs/pane-*.log'),
            ),
            user_owned_roots=(self.path('home') + '/',),
        )
        sock_path = self.path('agent.sock')
        listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        listener.bind(sock_path)
        listener.listen()
        self.addCleanup(listener.close)
        threading.Thread(target=serve, args=(listener, Agent(self.settings, self.system)), daemon=True).start()
        self.client = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.client.connect(sock_path)
        self.addCleanup(self.client.close)
        self.replies = self.client.makefile('r', encoding='utf-8')

    def path(self, relative):
        return os.path.join(self.root, relative)

    def write(self, relative, content):
        os.makedirs(os.path.dirname(self.path(relative)), exist_ok=True)
        with open(self.path(relative), 'w', encoding='utf-8') as out:
            out.write(content)

    def send_raw(self, line):
        self.client.sendall(line.encode() + b'\n')
        return json.loads(self.replies.readline())

    def send(self, operation, parameters, request_id='req-1'):
        return self.send_raw(json.dumps({'id': request_id, 'operation': operation, 'parameters': parameters}))

    # ------------------------------------------------------------ allow-list and parameters

    def test_refuses_operations_outside_the_allow_list(self):
        for operation in ('run_command', 'write_file', 'create', 'stop', '__init__', '_install_release'):
            with self.subTest(operation=operation):
                reply = self.send(operation, {}, request_id='r-9')
                self.assertEqual(reply['id'], 'r-9')
                self.assertFalse(reply['ok'])
                self.assertEqual(reply['error']['code'], 'operation_not_allowed')
                self.assertTrue(reply['error']['next'])
        self.assertEqual(self.system.commands, [])

    def test_refuses_any_parameter_the_contract_does_not_allow(self):
        cases = {
            'extra release field': ('update_pane', {'release': {**RELEASE, 'url': 'https://evil.example/pane.deb'}}),
            'extra parameter': ('update_pane', {'release': RELEASE, 'force': True}),
            'missing checksum': ('bootstrap', {'release': {'version': '2.4.215', 'arch': 'arm64'}}),
            'x86 build': ('update_pane', {'release': {**RELEASE, 'arch': 'amd64'}}),
            'version with a path': ('update_pane', {'release': {**RELEASE, 'version': '2.4.215/../../x'}}),
            'non-ascii digits': ('update_pane', {'release': {**RELEASE, 'version': '٢.4.215'}}),
            'uppercase checksum': ('update_pane', {'release': {**RELEASE, 'debSha256': SHA256_OF_ABC.upper()}}),
            'short checksum': ('update_pane', {'release': {**RELEASE, 'debSha256': SHA256_OF_ABC[:63]}}),
            'status with parameters': ('status', {'verbose': True}),
            'diagnostics with a path': ('collect_diagnostics', {'path': '/etc/shadow'}),
            'parameters not an object': ('prepare_to_stop', []),
        }
        for name, (operation, parameters) in cases.items():
            with self.subTest(name):
                reply = self.send(operation, parameters)
                self.assertFalse(reply['ok'])
                self.assertEqual(reply['error']['code'], 'invalid_request')
        self.assertEqual(self.system.downloads, [])
        self.assertEqual(self.system.commands, [])

    def test_refuses_malformed_requests_and_keeps_the_connection(self):
        for line in ('not json', '[1, 2]', '{"operation": "status", "parameters": {}}',
                     '{"id": "a", "operation": "status", "parameters": {}, "shell": "id"}'):
            with self.subTest(line=line):
                reply = self.send_raw(line)
                self.assertEqual(reply['error']['code'], 'invalid_request')
        self.assertTrue(self.send('status', {})['ok'])

    # ------------------------------------------------------------ install

    def test_update_pane_installs_the_release_deb_after_checking_its_checksum(self):
        reply = self.send('update_pane', {'release': RELEASE})

        self.assertTrue(reply['ok'], reply)
        self.assertEqual(reply['result'], {'paneVersion': '2.4.215', 'previousVersion': '2.4.214', 'changed': True})
        self.assertEqual(self.system.downloads,
                         ['https://github.com/greenfield-inc/Pane/releases/download/v2.4.215/Pane-2.4.215-linux-arm64.deb'])
        deb = self.path('var/lib/pane-cloud/pane-2.4.215-arm64.deb')
        self.assertEqual([c[-1] for c in self.system.commands if c[:2] == ['apt-get', 'install']], [deb])
        self.assertEqual(self.system.restarts, 1)
        self.assertFalse(os.path.exists(deb))

    def test_update_pane_refuses_a_deb_whose_checksum_does_not_match(self):
        reply = self.send('update_pane', {'release': {**RELEASE, 'debSha256': '0' * 64}})

        self.assertFalse(reply['ok'])
        self.assertEqual(reply['error']['code'], 'release_not_published')
        self.assertEqual(self.system.commands, [])
        self.assertEqual(self.system.restarts, 0)
        self.assertEqual(os.listdir(self.path('var/lib/pane-cloud')), [])

    def test_bootstrap_leaves_the_named_release_alone_when_it_is_installed(self):
        self.system.version = '2.4.215'

        reply = self.send('bootstrap', {'release': RELEASE})

        self.assertEqual(reply['result'], {'paneVersion': '2.4.215', 'previousVersion': '2.4.215', 'changed': False,
                                           'firstBoot': 'running'})
        self.assertEqual(self.system.downloads, [])

    # ------------------------------------------------------------ status

    def test_status_before_the_user_logs_in_to_tailscale(self):
        reply = self.send('status', {})

        self.assertEqual(reply['result'], {
            'paneVersion': '2.4.214',
            'tailnet': {'status': 'awaiting_login', 'loginUrl': 'https://login.tailscale.com/a/1a2b3c', 'hostname': None},
            'activity': {'agentsRunning': 0, 'clientsConnected': 0, 'lastActivityAt': None},
        })

    def test_status_counts_working_agents_and_connected_clients(self):
        self.system.tailscale = {'BackendState': 'Running', 'Self': {'DNSName': 'pane-m1.tail1234.ts.net.'}}
        self.system.workspace_state = {'ok': True, 'epoch': 'e', 'generation': 3, 'entries': [
            {'kind': 'agent.busy', 'at': '2026-11-06T05:58:00Z', 'paneId': 'p1', 'paneName': 'a', 'source': 'agent'},
            {'kind': 'agent.busy', 'at': '2026-11-06T05:59:00Z', 'paneId': 'p2', 'paneName': 'b', 'source': 'agent'},
            {'kind': 'agent.idle', 'at': '2026-11-06T05:30:00Z', 'paneId': 'p3', 'paneName': 'c', 'source': 'agent'},
        ]}
        self.system.host_state = {'success': True, 'data': {'connectedClients': [{'id': 'c1'}]}}

        result = self.send('status', {})['result']

        self.assertEqual(result['tailnet'], {'status': 'joined', 'loginUrl': None, 'hostname': 'pane-m1.tail1234.ts.net'})
        self.assertEqual(result['activity']['agentsRunning'], 2)
        self.assertEqual(result['activity']['clientsConnected'], 1)
        self.assertRegex(result['activity']['lastActivityAt'], r'^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$')

    def test_status_reports_the_last_pane_activity_once_idle(self):
        self.system.workspace_state = {'ok': True, 'epoch': 'e', 'generation': 1, 'entries': [
            {'kind': 'agent.idle', 'at': '2026-11-06T05:30:00Z', 'paneId': 'p3', 'paneName': 'c', 'source': 'agent'},
        ]}
        self.system.host_state = {'success': True, 'data': {'connectedClients': []}}

        activity = self.send('status', {})['result']['activity']

        self.assertEqual(activity, {'agentsRunning': 0, 'clientsConnected': 0, 'lastActivityAt': '2026-11-06T05:30:00Z'})

    # ------------------------------------------------------------ diagnostics

    def test_collect_diagnostics_reads_only_the_allow_listed_files(self):
        self.write('var/log/pane-cloud/bootstrap.log', 'grew the disk\n')
        self.write('home/pane/.pane/logs/pane-2026-11-05.log', 'daemon started\n')
        self.write('home/pane/.pane/logs/notes.txt', 'not a Pane log\n')
        self.write('home/pane/.pane/config.json', '{"secret": true}\n')
        self.write('etc/shadow', 'root:SECRET\n')
        self.write('etc/gshadow', 'root:SECRET\n')
        os.symlink(self.path('etc/shadow'), self.path('home/pane/.pane/logs/pane-symlink.log'))
        os.link(self.path('etc/gshadow'), self.path('home/pane/.pane/logs/pane-hardlink.log'))
        os.mkfifo(self.path('home/pane/.pane/logs/pane-fifo.log'))
        self.send('status', {})  # writes guest-agent.log

        result = self.send('collect_diagnostics', {})['result']

        self.assertEqual(sorted(f['path'] for f in result['files']), [
            self.path('home/pane/.pane/logs/pane-2026-11-05.log'),
            self.path('var/log/pane-cloud/bootstrap.log'),
            self.path('var/log/pane-cloud/guest-agent.log'),
        ])
        self.assertEqual(sorted(s['path'] for s in result['skipped']), [
            self.path('home/pane/.pane/logs/pane-fifo.log'),
            self.path('home/pane/.pane/logs/pane-hardlink.log'),
            self.path('home/pane/.pane/logs/pane-symlink.log'),
        ])
        packed = base64.b64decode(result['archive']['base64'])
        self.assertEqual(len(packed), result['archive']['bytes'])
        with tarfile.open(fileobj=io.BytesIO(packed), mode='r:gz') as archive:
            contents = {m.name: archive.extractfile(m).read() for m in archive.getmembers()}
        self.assertEqual(contents[self.path('var/log/pane-cloud/bootstrap.log').lstrip('/')], b'grew the disk\n')
        self.assertNotIn(b'SECRET', b''.join(contents.values()))

    def test_collect_diagnostics_refuses_a_symlinked_log_directory(self):
        self.write('etc/shadow', 'root:SECRET\n')
        os.makedirs(self.path('home/pane/.pane'))
        os.symlink(self.path('etc'), self.path('home/pane/.pane/logs'))
        os.symlink(self.path('etc/shadow'), self.path('etc/pane-x.log'))
        self.write('etc/pane-y.log', 'outside the allow-list\n')

        result = self.send('collect_diagnostics', {})['result']

        self.assertEqual([f['path'] for f in result['files']], [])
        packed = base64.b64decode(result['archive']['base64'])
        self.assertNotIn(b'outside the allow-list', packed)

    # ------------------------------------------------------------ stop and log

    def test_prepare_to_stop_syncs_and_every_operation_is_logged(self):
        self.assertEqual(self.send('prepare_to_stop', {}, request_id='s-1')['result'], {'synced': True})
        self.send('run_command', {'cmd': 'id'}, request_id='s-2')

        with open(self.settings.log_path, encoding='utf-8') as log:
            entries = [json.loads(line) for line in log]
        self.assertEqual(self.system.commands, [['sync']])
        self.assertEqual([(e['id'], e['operation'], e['ok']) for e in entries],
                         [('s-1', 'prepare_to_stop', True), ('s-2', 'run_command', False)])


if __name__ == '__main__':
    unittest.main()
