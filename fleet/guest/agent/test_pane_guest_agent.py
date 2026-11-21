"""The guest agent's protocol, driven over a real socket (AF_UNIX here, AF_VSOCK on a machine)."""

import base64
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
import unittest

from pane_guest_agent import Agent, Reporter, Settings, System, serve

SHA256_OF_ABC = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
RELEASE = {'version': '2.4.215', 'arch': 'arm64', 'debSha256': SHA256_OF_ABC}
RELAY_READY = {'enabled': True, 'phase': 'ready', 'id': 'k7d2m4q9x3abcd5e', 'domain': 'runpane.net',
               'address': 'https://k7d2m4q9x3abcd5e.runpane.net', 'relay': 'us.relay.runpane.net', 'region': 'us',
               'localAddresses': [], 'certificate': None, 'lastError': None, 'certificateLimit': None}
RELAY_COMPUTER = {'id': 'k7d2m4q9x3abcd5e', 'name': 'pane-1a2b3c4d', 'domain': 'runpane.net',
                  'address': 'https://k7d2m4q9x3abcd5e.runpane.net', 'local': [],
                  'fingerprint': 'q1w2e3r4t5y6u7i8o9p0a1s2d3f4g5h6j7k8l9z0x1c'}


class FakeSystem(System):
    """The machine: a release server that serves b'abc', apt and the Pane daemon."""

    def __init__(self):
        self.version = '2.4.214'
        self.downloads = []
        self.commands = []
        self.restarts = 0
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
        if argv[:2] == ['apt-get', 'install']:
            self.version = '2.4.215'
        return 0, ''

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

    def test_status_before_the_daemon_answers(self):
        reply = self.send('status', {})

        self.assertEqual(reply['result'], {
            'paneVersion': '2.4.214',
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

    def test_memory_pressure_is_sent_when_stalls_pass_10_percent_and_repeats_at_most_once_a_minute(self):
        settings = Settings(proc_root=self.fake_proc(psi_avg60='3.10'))
        reporter = Reporter(settings, send=lambda message: None)
        self.assertIsNone(reporter.memory_pressure(now=1000))

        self.fake_proc(psi_avg60='12.50')
        signal = reporter.memory_pressure(now=1005)
        self.assertEqual({k: signal[k] for k in ('type', 'reasons', 'psiSomeAvg60', 'swapUsedBytes', 'oomKills')},
                         {'type': 'memory_pressure', 'reasons': ['psi'], 'psiSomeAvg60': 12.5, 'swapUsedBytes': 0, 'oomKills': 0})
        self.assertIsNone(reporter.memory_pressure(now=1035))
        self.assertEqual(reporter.memory_pressure(now=1066)['reasons'], ['psi'])

    def test_an_out_of_memory_kill_is_sent_at_once(self):
        reporter = Reporter(Settings(proc_root=self.fake_proc(psi_avg60='12.50')), send=lambda message: None)
        reporter.memory_pressure(now=1000)

        self.fake_proc(psi_avg60='12.50', oom_kills=1)
        self.assertEqual(reporter.memory_pressure(now=1002)['reasons'], ['oom_kill', 'psi'])
        self.assertIsNone(reporter.memory_pressure(now=1004))

    def test_more_than_2_gib_of_swap_in_use_is_pressure(self):
        gib_kb = 1024 * 1024
        reporter = Reporter(Settings(proc_root=self.fake_proc(swap_total_kb=4 * gib_kb, swap_free_kb=2 * gib_kb + 1)),
                            send=lambda message: None)
        self.assertIsNone(reporter.memory_pressure(now=0))

        self.fake_proc(swap_total_kb=4 * gib_kb, swap_free_kb=gib_kb)
        signal = reporter.memory_pressure(now=5)
        self.assertEqual((signal['reasons'], signal['swapUsedBytes']), (['swap'], 3 * 1024 ** 3))


if __name__ == '__main__':
    unittest.main()
