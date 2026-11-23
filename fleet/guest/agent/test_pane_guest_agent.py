"""The guest agent's protocol, driven over a real socket (AF_UNIX here, AF_VSOCK on a machine)."""

import base64
import importlib.util
import io
import json
import os
import shutil
import socket
import subprocess
import sys
import tarfile
import tempfile
import threading
import time
import unittest

from pane_guest_agent import MACHINE_ARCH, READY_PORT, Agent, CloneReporter, Reporter, Settings, System, copy_clone_request, serve, signal_ready, unseal_github_token

SHA256_OF_ABC = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
RELEASE = {'version': '2.4.215', 'arch': MACHINE_ARCH, 'debSha256': SHA256_OF_ABC}
RELAY_READY = {'enabled': True, 'phase': 'ready', 'id': 'k7d2m4q9x3abcd5e', 'domain': 'runpane.net',
               'address': 'https://k7d2m4q9x3abcd5e.runpane.net', 'relay': 'us.relay.runpane.net', 'region': 'us',
               'localAddresses': [], 'certificate': None, 'lastError': None, 'certificateLimit': None}
RELAY_COMPUTER = {'id': 'k7d2m4q9x3abcd5e', 'name': 'pane-1a2b3c4d', 'domain': 'runpane.net',
                  'address': 'https://k7d2m4q9x3abcd5e.runpane.net', 'local': [],
                  'fingerprint': 'q1w2e3r4t5y6u7i8o9p0a1s2d3f4g5h6j7k8l9z0x1c'}


class FakeSystem(System):
    """The machine: a release server that serves b'abc', the base's Pane package and the Pane daemon."""

    def __init__(self):
        self.version = '2.4.214'
        self.downloads = []
        self.commands = []
        self.restarts = 0
        self.extracted = []
        self.workspace_state = None
        self.host_state = None
        self.relay_status = None
        self.relay_computer = None

    def download(self, url, dest, max_bytes):
        self.downloads.append(url)
        with open(dest, 'wb') as out:
            out.write(b'abc')
        return SHA256_OF_ABC

    def run(self, argv, timeout=600):
        self.commands.append(argv)
        return 0, ''

    def extract_deb(self, deb, dest):
        self.extracted.append(deb)
        os.makedirs(f'{dest}/opt/Pane')
        with open(f'{dest}/opt/Pane/pane', 'w') as binary:
            binary.write('pane')

    def installed_pane_version(self):
        return self.version

    def pane_daemon_call(self, pane_dir, channel, args):
        answer = {'runpane:workspace:state': self.workspace_state, 'remote-daemon:get-host-state': self.host_state,
                  'relay:status': self.relay_status, 'relay:client:computer': self.relay_computer}[channel]
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
            mounts_path=self.path('proc/self/mounts'),
            secrets_mount='/home/pane/.pane-secrets',
            hot_dir=self.path('var/lib/pane-cloud/hot'),
            hot_dropin=self.path('run/systemd/system/pane-daemon.service.d/hot.conf'),
            pane_drive_release=self.path('opt/Pane/release.json'),
            clone_run_dir=self.path('run/pane-cloud-clone'),
            clone_state_dir=self.path('var/lib/pane-cloud-clone'),
            clone_token=self.path('home/pane/.pane-secrets/pane-cloud/clone-token'),
            pane_uid=None,
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
            'missing checksum': ('bootstrap', {'release': {'version': '2.4.215', 'arch': MACHINE_ARCH}}),
            'another architecture\'s build': ('update_pane', {'release': {**RELEASE, 'arch': 'i386'}}),
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

    def test_update_pane_unpacks_the_release_beside_the_package_database_and_restarts_on_it(self):
        reply = self.send('update_pane', {'release': RELEASE})

        self.assertTrue(reply['ok'], reply)
        self.assertEqual(reply['result'], {'paneVersion': '2.4.215', 'previousVersion': '2.4.214', 'changed': True})
        self.assertEqual(self.system.downloads,
                         [f'https://github.com/greenfield-inc/Pane/releases/download/v2.4.215/Pane-2.4.215-linux-{MACHINE_ARCH}.deb'])
        self.assertTrue(os.path.exists(self.path('var/lib/pane-cloud/hot/2.4.215/opt/Pane/pane')))
        with open(self.path('run/systemd/system/pane-daemon.service.d/hot.conf')) as dropin:
            self.assertIn(f"ExecStart={self.path('var/lib/pane-cloud/hot/2.4.215/opt/Pane/pane')} ", dropin.read())
        self.assertEqual(self.system.restarts, 1)
        self.assertFalse(any(c[0] in ('apt-get', 'dpkg') for c in self.system.commands))
        self.assertEqual(sorted(os.listdir(self.path('var/lib/pane-cloud'))), ['hot'])
        self.assertEqual(self.send('status', {})['result']['paneVersion'], '2.4.215')

    def test_update_pane_refuses_a_deb_whose_checksum_does_not_match(self):
        reply = self.send('update_pane', {'release': {**RELEASE, 'debSha256': '0' * 64}})

        self.assertFalse(reply['ok'])
        self.assertEqual(reply['error']['code'], 'release_not_published')
        self.assertEqual(self.system.extracted, [])
        self.assertEqual(self.system.restarts, 0)
        self.assertEqual(os.listdir(self.path('var/lib/pane-cloud')), [])

    def test_bootstrap_does_nothing_when_the_pane_drive_has_the_release(self):
        self.write('opt/Pane/release.json', json.dumps({'version': '2.4.215', 'arch': MACHINE_ARCH, 'debSha256': SHA256_OF_ABC}))

        reply = self.send('bootstrap', {'release': RELEASE})

        self.assertEqual(reply['result'], {'paneVersion': '2.4.215', 'previousVersion': '2.4.215', 'changed': False,
                                           'firstBoot': 'done'})
        self.assertEqual(self.system.downloads, [])
        self.assertEqual(self.system.restarts, 0)

    # ------------------------------------------------------------ clone

    def failed_clone(self):
        self.write('run/pane-cloud-clone/state.json', json.dumps({'status': {
            'repo': 'owner/repo', 'branch': 'main', 'state': 'failed', 'phase': None, 'percent': None, 'line': None,
            'startedAt': '2026-11-23T05:00:00Z', 'finishedAt': '2026-11-23T05:00:03Z',
            'error': {'message': 'remote: Invalid username or token.'}, 'paneId': None}, 'history': None}))

    def test_retry_clone_starts_the_clone_again_after_it_failed(self):
        self.failed_clone()

        reply = self.send('retry_clone', {})

        self.assertEqual(reply['result'], {'started': True})
        self.assertIn(['systemctl', 'start', '--no-block', 'pane-cloud-clone.service'], self.system.commands)
        self.assertEqual(self.send('status', {})['result']['clone']['error'], {'message': 'remote: Invalid username or token.'})

    @unittest.skipUnless(importlib.util.find_spec('nacl'), 'PyNaCl is not installed')
    def test_retry_clone_takes_a_fresh_token_sealed_to_the_vms_own_key(self):
        from nacl.public import PrivateKey, SealedBox
        self.failed_clone()
        self.settings.secrets_mount = self.path('home/pane/.pane-secrets')
        key = PrivateKey.generate()
        record = {'token': 'ghp_FRESHtoken0123456789abcdefghijklmn', 'source': 'mac', 'updatedAt': '2026-11-23T06:00:00Z'}
        sealed = base64.urlsafe_b64encode(SealedBox(key.public_key).encrypt(json.dumps(record).encode())).decode().rstrip('=')

        reply = self.send('retry_clone', {'sealedGitHubToken': sealed,
                                          'sealingKey': base64.urlsafe_b64encode(bytes(key)).decode().rstrip('=')})

        self.assertEqual(reply.get('result'), {'started': True}, reply)
        with open(self.settings.clone_token) as token:
            self.assertEqual(token.read(), record['token'])
        self.assertNotIn(record['token'], open(self.settings.log_path).read())

    def test_retry_clone_refuses_unless_the_clone_failed(self):
        self.assertEqual(self.send('retry_clone', {})['error']['code'], 'invalid_state')
        self.write('run/pane-cloud-clone/state.json', json.dumps({'status': {'state': 'cloning'}, 'history': None}))
        self.assertEqual(self.send('retry_clone', {})['error']['code'], 'invalid_state')
        self.failed_clone()
        self.write('var/lib/pane-cloud-clone/done', '{"paneId": "p-1", "dest": "/home/pane/repo"}')
        self.assertEqual(self.send('retry_clone', {})['error']['code'], 'invalid_state')
        self.assertEqual(self.send('retry_clone', {'force': True})['error']['code'], 'invalid_request')
        self.assertEqual(self.system.commands, [])

    # ------------------------------------------------------------ status

    def test_status_before_the_daemon_answers(self):
        reply = self.send('status', {})

        self.assertEqual(reply['result'], {
            'paneVersion': '2.4.214',
            'clone': None,
            'relay': {'status': 'unreachable', 'id': None, 'address': None, 'fingerprint': None},
            'secretsVolume': 'missing',
            'activity': {'agentsRunning': 0, 'clientsConnected': 0, 'lastActivityAt': None},
        })

    def test_status_reports_the_relay_identity_clients_pin(self):
        self.system.relay_status = RELAY_READY
        self.system.relay_computer = RELAY_COMPUTER

        relay = self.send('status', {})['result']['relay']

        self.assertEqual(relay, {'status': 'ready', 'id': 'k7d2m4q9x3abcd5e', 'address': 'https://k7d2m4q9x3abcd5e.runpane.net',
                                 'fingerprint': 'q1w2e3r4t5y6u7i8o9p0a1s2d3f4g5h6j7k8l9z0x1c'})

    def test_status_reports_no_fingerprint_until_the_relay_connects(self):
        self.system.relay_status = {**RELAY_READY, 'phase': 'connecting', 'address': None}

        relay = self.send('status', {})['result']['relay']

        self.assertEqual(relay, {'status': 'connecting', 'id': 'k7d2m4q9x3abcd5e', 'address': None, 'fingerprint': None})

    def test_status_reports_the_secrets_volume_only_when_it_is_mounted_noexec(self):
        cases = {
            'mounted': ('/dev/vdb /home/pane/.pane-secrets ext4 rw,nosuid,nodev,noexec,noatime 0 0\n', 'mounted'),
            'mounted with exec': ('/dev/vdb /home/pane/.pane-secrets ext4 rw,nosuid,nodev,noatime 0 0\n', 'missing'),
            'not mounted': ('/dev/vda / ext4 rw,noatime 0 0\n', 'missing'),
        }
        for name, (mounts, expected) in cases.items():
            with self.subTest(name):
                self.write('proc/self/mounts', mounts)
                self.assertEqual(self.send('status', {})['result']['secretsVolume'], expected)

    def test_status_counts_working_agents_and_connected_clients(self):
        self.system.workspace_state = {'ok': True, 'epoch': 'e', 'generation': 3, 'entries': [
            {'kind': 'agent.busy', 'at': '2026-11-06T05:58:00Z', 'paneId': 'p1', 'paneName': 'a', 'source': 'agent'},
            {'kind': 'agent.busy', 'at': '2026-11-06T05:59:00Z', 'paneId': 'p2', 'paneName': 'b', 'source': 'agent'},
            {'kind': 'agent.idle', 'at': '2026-11-06T05:30:00Z', 'paneId': 'p3', 'paneName': 'c', 'source': 'agent'},
        ]}
        self.system.host_state = {'success': True, 'data': {'connectedClients': [{'id': 'c1'}]}}

        result = self.send('status', {})['result']

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

    def test_collect_diagnostics_keeps_the_archive_under_8_mib(self):
        for day in ('03', '04', '05'):
            self.write(f'home/pane/.pane/logs/pane-2026-11-{day}.log', 'x' * (3 * 1024 ** 2))

        result = self.send('collect_diagnostics', {})['result']

        self.assertEqual([os.path.basename(f['path']) for f in result['files']], ['pane-2026-11-05.log', 'pane-2026-11-04.log'])
        self.assertIn({'path': self.path('home/pane/.pane/logs/pane-2026-11-03.log'), 'reason': 'over the 8 MiB total'}, result['skipped'])

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



class ReporterTest(unittest.TestCase):
    def setUp(self):
        self.root = os.path.realpath(tempfile.mkdtemp(prefix='pgr-', dir='/tmp'))
        self.addCleanup(shutil.rmtree, self.root)

    def fake_proc(self, psi_avg60='0.00', swap_total_kb=0, swap_free_kb=0, oom_kills=0):
        proc = os.path.join(self.root, 'proc')
        os.makedirs(os.path.join(proc, 'pressure'), exist_ok=True)
        with open(os.path.join(proc, 'pressure', 'memory'), 'w') as out:
            out.write(f'some avg10=0.00 avg60={psi_avg60} avg300=0.00 total=1\nfull avg10=0.00 avg60=0.00 avg300=0.00 total=0\n')
        with open(os.path.join(proc, 'meminfo'), 'w') as out:
            out.write(f'MemTotal:        8135000 kB\nSwapTotal:       {swap_total_kb} kB\nSwapFree:        {swap_free_kb} kB\n')
        with open(os.path.join(proc, 'vmstat'), 'w') as out:
            out.write(f'pgfault 1234\noom_kill {oom_kills}\n')
        return proc

    @unittest.skipUnless(sys.platform.startswith('linux'), 'reads the real /proc')
    def test_process_report_names_a_miner_and_catches_a_renamed_copy_by_its_hash(self):
        program = shutil.which('sleep')
        miner = os.path.join(self.root, 'xmrig')
        renamed = os.path.join(self.root, 'build-cache')
        for copy in (miner, renamed):
            shutil.copy(program, copy)
        expected_sha = subprocess.run(['sha256sum', program], capture_output=True, text=True, check=True).stdout.split()[0]
        running = [subprocess.Popen([copy, '30']) for copy in (miner, renamed)]
        for process in running:
            self.addCleanup(process.wait)
            self.addCleanup(process.kill)

        report = Reporter(Settings(), send=lambda message: None).process_report()

        by_pid = {p['pid']: p for p in report['processes']}
        seen_miner, seen_renamed = by_pid[running[0].pid], by_pid[running[1].pid]
        self.assertEqual(report['type'], 'process_report')
        self.assertEqual((seen_miner['name'], seen_miner['exe'], seen_miner['sha256']), ('xmrig', miner, expected_sha))
        self.assertEqual((seen_renamed['name'], seen_renamed['sha256']), ('build-cache', expected_sha))
        self.assertEqual(seen_miner['uid'], os.getuid())
        self.assertNotIn('cmdline', seen_miner)

    def reporter(self, **proc):
        sent = []
        reporter = Reporter(Settings(proc_root=self.fake_proc(**proc)), send=sent.append)
        return reporter, sent

    def test_memory_pressure_is_sent_when_stalls_pass_10_percent_and_repeats_at_most_once_a_minute(self):
        reporter, sent = self.reporter(psi_avg60='3.10')
        reporter.check_memory(now=1000)
        self.assertEqual(sent, [])

        self.fake_proc(psi_avg60='12.50')
        for now in (1005, 1035, 1066):
            reporter.check_memory(now=now)

        self.assertEqual([{k: m[k] for k in ('type', 'reasons', 'psiSomeAvg60', 'swapUsedBytes', 'oomKills')} for m in sent],
                         [{'type': 'memory_pressure', 'reasons': ['psi'], 'psiSomeAvg60': 12.5, 'swapUsedBytes': 0, 'oomKills': 0}] * 2)

    def test_an_out_of_memory_kill_is_sent_at_once_and_retried_until_the_host_takes_it(self):
        reporter, sent = self.reporter(psi_avg60='12.50')
        reporter.check_memory(now=1000)
        self.fake_proc(psi_avg60='12.50', oom_kills=1)

        def host_not_listening(message):
            raise ConnectionRefusedError
        reporter.send = host_not_listening
        with self.assertRaises(ConnectionRefusedError):
            reporter.check_memory(now=1002)
        reporter.send = sent.append
        reporter.check_memory(now=1007)
        reporter.check_memory(now=1012)

        self.assertEqual([m['reasons'] for m in sent], [['psi'], ['oom_kill', 'psi']])

    def test_more_than_2_gib_of_swap_in_use_is_pressure(self):
        gib_kb = 1024 * 1024
        reporter, sent = self.reporter(swap_total_kb=4 * gib_kb, swap_free_kb=2 * gib_kb + 1)
        reporter.check_memory(now=0)
        self.assertEqual(sent, [])

        self.fake_proc(swap_total_kb=4 * gib_kb, swap_free_kb=gib_kb)
        reporter.check_memory(now=5)
        self.assertEqual([(m['reasons'], m['swapUsedBytes']) for m in sent], [(['swap'], 3 * 1024 ** 3)])

class ReadySignalTest(unittest.TestCase):
    """The guest tells the host once the Pane daemon's control socket listens (N1's readyPort)."""

    def setUp(self):
        self.root = os.path.realpath(tempfile.mkdtemp(prefix='pga-ready-', dir='/tmp'))
        self.addCleanup(shutil.rmtree, self.root)
        os.makedirs(f'{self.root}/proc')
        with open(f'{self.root}/proc/uptime', 'w') as uptime:
            uptime.write('1.25 0.50\n')
        self.settings = Settings(proc_root=f'{self.root}/proc', ready_marker=f'{self.root}/run/ready-sent')
        self.sock = f'{self.root}/daemon.sock'
        self.sent = []

    def send(self, message, port):
        self.sent.append((port, message))

    def listen_later(self, seconds):
        def listen():
            time.sleep(seconds)
            listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            listener.bind(self.sock)
            listener.listen()
            self.addCleanup(listener.close)
        threading.Thread(target=listen, daemon=True).start()

    def test_signals_ready_once_the_daemon_socket_listens(self):
        self.listen_later(0.2)

        signal_ready(self.settings, self.send, self.sock)

        self.assertEqual(self.sent, [(READY_PORT, {'type': 'ready', 'uptimeSeconds': 1.25})])

    def test_signals_once_per_boot_even_if_the_agent_restarts(self):
        self.listen_later(0)
        signal_ready(self.settings, self.send, self.sock)

        signal_ready(self.settings, self.send, self.sock)

        self.assertEqual(len(self.sent), 1)


class UnsealTest(unittest.TestCase):
    """The one-shot unseal at first boot (D-107): the sealed GitHub token becomes K1's drop file and the
    clone's token file, and its inputs are deleted."""

    RECORD = {'token': 'ghp_EXAMPLE0123456789abcdefghijklmnopqrst', 'source': 'gh', 'updatedAt': '2026-11-23T05:00:00Z'}

    def setUp(self):
        self.root = os.path.realpath(tempfile.mkdtemp(prefix='pga-unseal-', dir='/tmp'))
        self.addCleanup(shutil.rmtree, self.root)
        self.settings = Settings(secrets_mount=f'{self.root}/secrets', clone_token=f'{self.root}/secrets/pane-cloud/clone-token',
                                 pane_uid=None)
        os.makedirs(f'{self.root}/secrets/pane-cloud', mode=0o700)

    def seal(self, plaintext):
        from nacl.public import PrivateKey, SealedBox
        key = PrivateKey.generate()
        with open(f'{self.root}/secrets/pane-cloud/seal.key', 'wb') as out:
            out.write(bytes(key))
        with open(f'{self.root}/secrets/pane-cloud/github-token.sealed', 'w') as out:
            out.write(base64.urlsafe_b64encode(SealedBox(key.public_key).encrypt(plaintext)).decode().rstrip('='))

    def mode(self, path):
        return os.stat(path).st_mode & 0o7777

    @unittest.skipUnless(importlib.util.find_spec('nacl'), 'PyNaCl is not installed')
    def test_writes_the_drop_file_and_the_clone_token_then_deletes_the_sealed_input(self):
        self.seal(json.dumps(self.RECORD).encode())

        unseal_github_token(self.settings)

        drop = f'{self.root}/secrets/incoming/github-token.json'
        with open(drop) as source:
            self.assertEqual(json.load(source), self.RECORD)
        self.assertEqual((self.mode(drop), self.mode(os.path.dirname(drop))), (0o600, 0o700))
        with open(self.settings.clone_token) as source:
            self.assertEqual(source.read(), self.RECORD['token'])
        self.assertEqual(self.mode(self.settings.clone_token), 0o600)
        self.assertEqual(os.listdir(f'{self.root}/secrets/pane-cloud'), ['clone-token'])
        self.assertEqual(self.mode(f'{self.root}/secrets/pane-cloud'), 0o710)
        self.assertEqual(sorted(os.listdir(f'{self.root}/secrets/incoming')), ['github-token.json'])

    @unittest.skipUnless(importlib.util.find_spec('nacl'), 'PyNaCl is not installed')
    def test_a_record_without_a_token_writes_nothing_and_never_echoes_the_payload(self):
        self.seal(b'{"token": "", "secret-ish": "ghp_SHOULD_NOT_APPEAR"}')

        with self.assertRaises(ValueError) as refused:
            unseal_github_token(self.settings)

        self.assertNotIn('ghp_SHOULD_NOT_APPEAR', str(refused.exception))
        self.assertFalse(os.path.exists(f'{self.root}/secrets/incoming'))
        self.assertFalse(os.path.exists(self.settings.clone_token))

    def test_hands_the_clone_its_request_and_keeps_the_hosts_copy_for_a_retry(self):
        with open(f'{self.root}/secrets/pane-cloud/clone.json', 'w') as out:
            out.write('{"url": "https://github.com/owner/repo.git", "branch": "main"}')
        self.settings.clone_run_dir = f'{self.root}/run/pane-cloud-clone'

        copy_clone_request(self.settings)

        with open(f'{self.root}/run/pane-cloud-clone/request.json') as request:
            self.assertEqual(json.load(request), {'url': 'https://github.com/owner/repo.git', 'branch': 'main'})
        self.assertEqual(self.mode(f'{self.root}/run/pane-cloud-clone/request.json'), 0o600)
        self.assertTrue(os.path.exists(f'{self.root}/secrets/pane-cloud/clone.json'))

    def test_a_public_repository_has_nothing_to_unseal(self):
        unseal_github_token(self.settings)

        self.assertFalse(os.path.exists(f'{self.root}/secrets/incoming'))
        self.assertFalse(os.path.exists(self.settings.clone_token))


class CloneReporterTest(unittest.TestCase):
    def setUp(self):
        self.root = os.path.realpath(tempfile.mkdtemp(prefix='pga-clone-', dir='/tmp'))
        self.addCleanup(shutil.rmtree, self.root)
        self.settings = Settings(clone_run_dir=f'{self.root}/run', proc_root=f'{self.root}/proc')
        os.makedirs(f'{self.root}/proc/sys/kernel/random')
        with open(f'{self.root}/proc/sys/kernel/random/boot_id', 'w') as boot:
            boot.write('boot-1\n')

    def test_reports_each_change_in_the_clone_progress_once(self):
        reporter = CloneReporter(self.settings)
        self.assertIsNone(reporter.poll())
        os.makedirs(f'{self.root}/run')
        with open(f'{self.root}/run/state.json', 'w') as state:
            json.dump({'status': {'state': 'cloning', 'repo': 'owner/repo', 'phase': 'receiving', 'percent': 45},
                       'history': None, 'startedUptime': 1.4}, state)

        message = reporter.poll()

        self.assertEqual({k: message[k] for k in ('type', 'status', 'history', 'bootId')},
                         {'type': 'clone', 'status': {'state': 'cloning', 'repo': 'owner/repo', 'phase': 'receiving', 'percent': 45},
                          'history': None, 'bootId': 'boot-1'})
        self.assertIsNone(reporter.poll())


class CloneProgressTest(unittest.TestCase):
    """clone.py's progress file: the contract's CloneStatus, with credentials stripped from git's lines."""

    def setUp(self):
        sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '../rootfs/usr/local/lib/pane-cloud'))
        import clone
        self.clone = clone
        self.root = os.path.realpath(tempfile.mkdtemp(prefix='pga-progress-', dir='/tmp'))
        self.addCleanup(shutil.rmtree, self.root)
        os.makedirs(f'{self.root}/pane-cloud')
        with open(f'{self.root}/pane-cloud/clone-token', 'w') as token:
            token.write('ghp_REALtoken0123456789abcdefghijklmnop')
        for name, value in (('RUN', self.root), ('TOKEN', f'{self.root}/pane-cloud/clone-token')):
            self.addCleanup(setattr, clone, name, getattr(clone, name))
            setattr(clone, name, value)
        self.addCleanup(setattr, clone, 'uptime', clone.uptime)
        clone.uptime = lambda: 1.5

    def written(self):
        with open(f'{self.root}/state.json') as state:
            return json.load(state)

    def test_reports_phase_and_percent_from_gits_progress(self):
        state = self.clone.State('owner/repo', 'main')
        state.set(line='Receiving objects:  45% (450/1000), 1.20 MiB | 3.00 MiB/s')
        status = self.written()['status']
        self.assertEqual((status['state'], status['phase'], status['percent']), ('cloning', 'receiving', 45))
        state.set(line='Resolving deltas: 100% (80/80), done.')
        self.assertEqual((self.written()['status']['phase'], self.written()['status']['percent']), ('resolving', 100))

    def test_no_credential_reaches_the_progress_file(self):
        state = self.clone.State('owner/repo', 'main')
        state.set(line='Cloning https://x-access-token:ghp_REALtoken0123456789abcdefghijklmnop@github.com/owner/repo')
        state.set(state='failed', error='fatal: could not read from https://bob:hunter2@github.com/owner/repo '
                                         'with ghp_REALtoken0123456789abcdefghijklmnop and github_pat_ABCDEFGH12345678')

        text = open(f'{self.root}/state.json').read()

        for secret in ('ghp_REALtoken', 'hunter2', 'github_pat_ABCDEFGH', 'bob:'):
            self.assertNotIn(secret, text)
        status = self.written()['status']
        self.assertEqual(status['state'], 'failed')
        self.assertTrue(status['error']['message'].startswith('fatal: could not read from'))
        self.assertIsNotNone(status['finishedAt'])


if __name__ == '__main__':
    unittest.main()
