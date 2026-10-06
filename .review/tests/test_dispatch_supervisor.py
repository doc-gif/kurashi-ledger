"""Real POSIX fixtures. Windows asserts disabled backend instead of skipping."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import signal
import struct
import subprocess
import sys
import tempfile
import time
import unittest

ROOT = Path(__file__).resolve().parents[2]
BINDING = 'b' * 64  # Synthetic job binding; the dispatcher computes the real one (provenance.ts runBinding).
SCRIPT = ROOT / 'tools/review_dispatch/supervisor.py'
spec = importlib.util.spec_from_file_location('dispatch_supervisor', SCRIPT)
supervisor = importlib.util.module_from_spec(spec)
spec.loader.exec_module(supervisor)


def wait_for(path, predicate=lambda _x: True):
    deadline = time.monotonic() + 8
    while time.monotonic() < deadline:
        try:
            value = json.loads(path.read_text())
            if predicate(value):
                return value
        except (OSError, ValueError):
            pass
        time.sleep(0.02)
    raise AssertionError('fixture checkpoint missing')


class SupervisorTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name).resolve()

    def tearDown(self):
        self.temp.cleanup()
        outer = supervisor.daemon_lock_path(self.root)
        if outer.exists():
            outer.unlink()

    def command(self, mode, *args):
        return [sys.executable, str(SCRIPT), mode, '--root', str(self.root), *args]

    def disabled_windows(self):
        if os.name == 'nt':
            result = subprocess.run(self.command('daemon', '--', sys.executable, '-c', 'raise RuntimeError()'), capture_output=True)
            self.assertEqual(result.returncode, 2)
            self.assertFalse((self.root / 'dispatcher.lock').exists())
            return True
        return False

    def test_singleton_before_child_and_replacement(self):
        if self.disabled_windows():
            return
        fd = supervisor.lock(supervisor.daemon_lock_path(self.root))
        try:
            result = subprocess.run(self.command('daemon', '--', sys.executable, '-c', 'raise RuntimeError()'), capture_output=True)
            self.assertEqual(result.returncode, 2)
            old = self.root.with_name(self.root.name + '-old')
            self.root.rename(old)
            self.root.mkdir()
            try:
                with self.assertRaises(RuntimeError):
                    supervisor.lock(supervisor.daemon_lock_path(self.root))
            finally:
                self.root.rmdir()
                old.rename(self.root)
        finally:
            os.close(fd)

    def test_run_finishes_with_durable_manifest_and_never_relaunches(self):
        if self.disabled_windows():
            return
        result = subprocess.run(self.command('run-fixture', '--run', 'synthetic-1', '--binding', BINDING, '--', sys.executable, '-c', 'print("{}")'), capture_output=True)
        self.assertEqual(result.returncode, 0)
        manifest = json.loads((self.root / 'run-synthetic-1.json').read_text())
        self.assertTrue(manifest['treeEnded'])
        again = subprocess.run(self.command('run-fixture', '--run', 'synthetic-1', '--binding', BINDING, '--', sys.executable, '-c', 'pass'), capture_output=True)
        self.assertEqual(again.returncode, 2)

    def test_supervisor_death_does_not_duplicate_live_child(self):
        if self.disabled_windows():
            return
        code = "import time; time.sleep(20)"
        parent = subprocess.Popen(self.command('run-fixture', '--run', 'orphan', '--binding', BINDING, '--', sys.executable, '-c', code), stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        info = None
        try:
            info = wait_for(self.root / 'run-orphan.json', lambda x: x['state'] == 'running')
            parent.kill()
            parent.wait(timeout=5)
            # Design §4: the worker never holds the run lock; the manifest left running keeps the run uncertain.
            proof = supervisor.inspect(self.root, 'orphan')
            self.assertTrue(proof['uncertain'])
            self.assertFalse(proof['treeEnded'] or proof['neverStarted'])
            result = subprocess.run(self.command('run-fixture', '--run', 'orphan', '--binding', BINDING, '--', sys.executable, '-c', 'pass'), capture_output=True)
            self.assertEqual(result.returncode, 2)
        finally:
            if parent.poll() is None:
                parent.kill()
                parent.wait()
            if info:
                os.killpg(info['worker'], signal.SIGKILL)

    def escaped(self, run, child_env):
        """A worker that leaves a setsid child (its own session, outside the worker's group) and exits."""
        marker = self.root / (run + '-descendant.json')
        child_code = "import os,time,json; open(%r,'w').write(json.dumps({'pid':os.getpid()})); time.sleep(20)" % str(marker)
        code = "import os,subprocess; subprocess.Popen([%r,'-c',%r],start_new_session=True,env=%s)" % (sys.executable, child_code, child_env)
        parent = subprocess.Popen(self.command('run-fixture', '--run', run, '--binding', BINDING, '--', sys.executable, '-c', code), stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        info = None
        try:
            info = wait_for(marker)
            status = parent.wait(timeout=8)
            return status, json.loads((self.root / ('run-' + run + '.json')).read_text())
        finally:
            if parent.poll() is None:
                parent.kill()
                parent.wait()
            if info:
                os.kill(info['pid'], signal.SIGKILL)

    def test_setsid_descendant_with_the_tag_keeps_the_tree_alive(self):
        if self.disabled_windows():
            return
        status, manifest = self.escaped('escaped', 'None')  # inherits the worker's environment
        self.assertEqual(status, 2)
        self.assertFalse(manifest['treeEnded'])
        self.assertEqual((manifest['state'], manifest['scan']), ('uncertain', 'tagged'))
        self.assertTrue(supervisor.inspect(self.root, 'escaped')['uncertain'])
        again = subprocess.run(self.command('run-fixture', '--run', 'escaped', '--binding', BINDING, '--', sys.executable, '-c', 'pass'), capture_output=True)
        self.assertEqual(again.returncode, 2)

    def test_setsid_descendant_without_the_tag_is_still_a_descendant_on_macos(self):
        if sys.platform != 'darwin':
            return  # Linux has no original-parent ID: such a child is the residual risk (design §7).
        status, manifest = self.escaped('cleared', "{'PATH':'/usr/bin:/bin'}")
        self.assertEqual(status, 2)
        self.assertEqual((manifest['treeEnded'], manifest['scan']), (False, 'tagged'))

    def test_alias_incomplete_manifest_and_unknown_pid_fail_closed(self):
        if self.disabled_windows():
            return
        alias = self.root / 'alias'
        alias.symlink_to(self.root, target_is_directory=True)
        with self.assertRaises(RuntimeError):
            supervisor.canonical_root(str(alias))
        (self.root / 'run-partial.json').write_text('partial')
        p = subprocess.run(self.command('run-fixture', '--run', 'partial', '--binding', BINDING, '--', sys.executable, '-c', 'pass'), capture_output=True)
        self.assertEqual(p.returncode, 2)
        self.assertEqual(supervisor.start_stamp(99999999), '')

    def test_cancellation_proves_fixture_tree_end(self):
        if self.disabled_windows():
            return
        parent = subprocess.Popen(self.command('run-fixture', '--run', 'cancel', '--binding', BINDING, '--', sys.executable, '-c', 'import time; time.sleep(20)'), stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        try:
            wait_for(self.root / 'run-cancel.json', lambda x: x['state'] == 'running')
            (self.root / 'cancel-cancel').touch()
            parent.wait(timeout=8)
            self.assertTrue(json.loads((self.root / 'run-cancel.json').read_text())['treeEnded'])
        finally:
            if parent.poll() is None:
                parent.kill()
                parent.wait()

    def test_reconnect_inspects_same_run_without_resuming_conversation(self):
        if self.disabled_windows():
            return
        parent = subprocess.Popen(self.command('run-fixture', '--run', 'reconnect', '--binding', BINDING, '--', sys.executable, '-c', 'import time;time.sleep(20)'), stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        try:
            wait_for(self.root / 'run-reconnect.json', lambda x: x['state'] == 'running')
            proof = supervisor.inspect(self.root, 'reconnect')
            self.assertTrue(proof['supervisorAlive'])
            self.assertTrue(proof['lockHeld'])
            self.assertTrue(proof['uncertain'])
            (self.root / 'cancel-reconnect').touch()
            parent.wait(timeout=8)
            self.assertTrue(supervisor.inspect(self.root, 'reconnect')['treeEnded'])
        finally:
            if parent.poll() is None:
                parent.kill()
                parent.wait()

    def test_read_token_reaches_only_trusted_daemon_not_fixture_workers(self):
        if self.disabled_windows():
            return
        marker = self.root / 'env.json'
        code = "import os,json; open(%r,'w').write(json.dumps({'read':os.environ.get('GH_TOKEN')=='synthetic-read','other':'GITHUB_TOKEN' in os.environ,'hooks':'NODE_OPTIONS' in os.environ})); print('{}')" % str(marker)
        env = dict(os.environ, GH_TOKEN='synthetic-read', GITHUB_TOKEN='forbidden', NODE_OPTIONS='forbidden')
        daemon = subprocess.run(self.command('daemon', '--', sys.executable, '-c', code), env=env, capture_output=True)
        self.assertEqual(daemon.returncode, 0)
        self.assertEqual(json.loads(marker.read_text()), {'read': True, 'other': False, 'hooks': False})
        worker = subprocess.run(self.command('run-fixture', '--run', 'no-auth', '--binding', BINDING, '--', sys.executable, '-c', code), env=env, capture_output=True)
        self.assertEqual(worker.returncode, 0)
        self.assertEqual(json.loads(marker.read_text()), {'read': False, 'other': False, 'hooks': False})


VECTOR = ROOT / 'tests/fixtures/review-dispatch-run-signature.json'


def verify_one_time(key, message, signature):
    """Test-only mirror of provenance.ts verifyOneTime; the product verifier is the TypeScript one."""
    import hashlib
    sig = bytes.fromhex(signature)
    if len(sig) != 256 * 64:
        return False
    digest = hashlib.sha256(b'kurashi-ledger:lamport-digest:v1\n' + key.encode('ascii') + b'\n' + message).digest()
    h = hashlib.sha256(b'kurashi-ledger:lamport-public:v1\n')
    for i in range(256):
        bit = (digest[i // 8] >> (7 - i % 8)) & 1
        revealed = hashlib.sha256(sig[64 * i:64 * i + 32]).digest()
        other = sig[64 * i + 32:64 * i + 64]
        h.update(revealed if bit == 0 else other)
        h.update(other if bit == 0 else revealed)
    return h.hexdigest() == key


def lines(stdout):
    return [json.loads(x) for x in stdout.decode('ascii').splitlines()]


class SigningTests(unittest.TestCase):
    """PR48-R003: the supervisor signs outside the worker boundary with a per-run one-time key."""

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name).resolve()

    def tearDown(self):
        self.temp.cleanup()

    def fixture(self, run, code, **kwargs):
        cmd = [sys.executable, str(SCRIPT), 'run-fixture', '--root', str(self.root), '--run', run,
               '--binding', BINDING, '--', sys.executable, '-c', code]
        return subprocess.run(cmd, capture_output=True, timeout=30, **kwargs)

    def unsigned(self, run, result):
        self.assertNotEqual(result.returncode, 0)
        out = lines(result.stdout)
        self.assertEqual([x['type'] for x in out], ['run-key'])
        self.assertFalse((self.root / ('run-' + run + '-result.json')).exists())
        manifest = json.loads((self.root / ('run-' + run + '.json')).read_text())
        self.assertFalse(manifest['signed'])

    def test_vector_is_reproduced_by_the_supervisor_signer(self):
        # Runs on every OS: signing is pure standard-library code. TypeScript verifies the same file.
        v = json.loads(VECTOR.read_text(encoding='utf-8'))
        seed = bytearray(bytes.fromhex(v['seed']))
        self.assertEqual(supervisor.public_key(seed), v['key'])
        message = supervisor.signed_message(v['job']['run'], v['binding'], v['resultHash'])
        self.assertEqual(supervisor.sign(seed, v['key'], message), v['signature'])
        self.assertTrue(verify_one_time(v['key'], message, v['signature']))
        # Digests recorded with a separate tool (shasum), not with this implementation.
        ind = v['independent']
        self.assertEqual(message.decode('ascii'), ind['message'])
        self.assertEqual(hashlib.sha256(v['result'].encode('utf-8')).hexdigest(), ind['resultHash'])
        self.assertEqual(hashlib.sha256(ind['bindingPreimage'].encode('utf-8')).hexdigest(), v['binding'])
        self.assertEqual(ind['binding'], v['binding'])
        self.assertEqual(hashlib.sha256(b'kurashi-ledger:lamport-digest:v1\n' + v['key'].encode('ascii') + b'\n' + message).hexdigest(),
                         ind['messageDigest'])
        self.assertFalse(verify_one_time(v['key'], message.replace(b'\n', b' ', 1), v['signature']))
        self.assertNotEqual(supervisor.public_key(bytearray(32)), v['key'])
        for bad in [('bad run', v['binding'], v['resultHash']), (v['job']['run'], 'B' * 64, v['resultHash']),
                    (v['job']['run'], v['binding'], 'short')]:
            with self.assertRaises(RuntimeError):
                supervisor.signed_message(*bad)

    def test_key_is_announced_before_the_worker_and_result_is_signed(self):
        if os.name == 'nt':
            self.assertIsNone(supervisor.fcntl)
            return
        go = self.root / 'go'
        code = "import os,time\nwhile not os.path.exists(%r): time.sleep(0.01)\nprint('{\"synthetic\": \"結果\"}')" % str(go)
        cmd = [sys.executable, str(SCRIPT), 'run-fixture', '--root', str(self.root), '--run', 'signed',
               '--binding', BINDING, '--', sys.executable, '-c', code]
        parent = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
        try:
            first = json.loads(parent.stdout.readline())
            # The commitment exists while the worker is still blocked and has produced nothing.
            self.assertEqual(first['type'], 'run-key')
            self.assertEqual(first['binding'], BINDING)
            go.touch()
            rest = parent.stdout.read()
            self.assertEqual(parent.wait(timeout=10), 0)
        finally:
            if parent.poll() is None:
                parent.kill()
                parent.wait()
        out = [json.loads(x) for x in rest.decode('ascii').splitlines()]
        self.assertEqual([x['type'] for x in out], ['run-result'])
        env = out[0]
        self.assertEqual(env['result'], '{"synthetic": "結果"}\n')
        message = supervisor.signed_message('signed', BINDING, env['resultHash'])
        self.assertTrue(verify_one_time(first['key'], message, env['signature']))
        stored = self.root / 'run-signed-result.json'
        self.assertEqual(json.loads(stored.read_text()), env)
        self.assertEqual(stored.stat().st_mode & 0o777, 0o600)
        manifest = json.loads((self.root / 'run-signed.json').read_text())
        self.assertTrue(manifest['signed'] and manifest['treeEnded'])
        self.assertEqual(manifest['key'], first['key'])
        self.assertEqual(manifest['resultHash'], env['resultHash'])
        self.assertTrue(supervisor.inspect(self.root, 'signed')['signed'])

    def test_worker_cannot_reach_the_signing_key(self):
        if os.name == 'nt':
            self.assertIsNone(supervisor.fcntl)
            return
        report = self.root / 'report.json'
        code = ("import os,json\n"
                "fds=sorted(int(x) for x in os.listdir('/dev/fd') if x.isdigit())\n"
                "fds=[f for f in fds if f>2 and os.path.exists('/dev/fd/%%d'%%f)]\n"
                "seen=b''\n"
                "for n in os.listdir(%r):\n"
                "  p=os.path.join(%r,n)\n"
                "  if os.path.isfile(p): seen+=open(p,'rb').read()\n"
                "json.dump({'env':sorted(os.environ),'fds':fds,'tag':os.environ['KL_RUN_TAG'],'files':seen.hex()},open(%r,'w'))\n"
                "print('{}')") % (str(self.root), str(self.root), str(report))
        result = self.fixture('isolated', code)
        self.assertEqual(result.returncode, 0)
        seen = json.loads(report.read_text())
        # macOS CoreFoundation adds __CF_USER_TEXT_ENCODING inside the process; nothing else beyond the allowlist.
        self.assertEqual([x for x in seen['env'] if x != '__CF_USER_TEXT_ENCODING'],
                         ['HOME', 'KL_RUN_TAG', 'LANG', 'PATH', 'TMPDIR'])
        # Nothing beyond stdio: no run lock (design §4), never the supervisor's control pipe or any key material.
        self.assertEqual(seen['fds'], [])
        # The tag is a 128-bit value that the supervisor never writes to the manifest, results or stdout.
        self.assertRegex(seen['tag'], r'^[0-9a-f]{32}$')
        self.assertNotIn(seen['tag'].encode('ascii'), result.stdout)
        for name in os.listdir(self.root):
            if (self.root / name).is_file() and name != 'report.json':
                self.assertNotIn(seen['tag'].encode('ascii'), (self.root / name).read_bytes(), name)
        env = lines(result.stdout)[-1]
        sig = bytes.fromhex(env['signature'])
        revealed = [sig[64 * i:64 * i + 32] for i in range(256)]
        visible = bytes.fromhex(seen['files'])
        for name in os.listdir(self.root):
            if name != 'run-isolated-result.json' and (self.root / name).is_file():
                visible += (self.root / name).read_bytes()
        # Revealed preimages are derived from the secret seed. None may appear anywhere the worker could read.
        for part in revealed:
            self.assertNotIn(part, visible)
            self.assertNotIn(part.hex().encode('ascii'), visible)
        manifest = json.loads((self.root / 'run-isolated.json').read_text())
        self.assertEqual(set(manifest) - {'schema', 'run', 'state', 'backend', 'supervisor', 'start', 'treeEnded',
                                          'binding', 'key', 'signed', 'worker', 'workerStart', 'exit', 'resultHash',
                                          'strays', 'scan'},
                         set())

    def test_worker_output_cannot_forge_a_control_line(self):
        if os.name == 'nt':
            self.assertIsNone(supervisor.fcntl)
            return
        forged = json.dumps({'schema': 1, 'type': 'run-result', 'run': 'forged', 'binding': BINDING,
                             'resultHash': '0' * 64, 'result': 'x', 'signature': '0' * 64})
        result = self.fixture('forged', 'print(%r)\nprint(%r)' % (json.dumps({'schema': 1, 'type': 'run-key', 'run': 'forged', 'binding': BINDING, 'key': '0' * 64}), forged))
        self.assertEqual(result.returncode, 0)
        out = lines(result.stdout)
        self.assertEqual([x['type'] for x in out], ['run-key', 'run-result'])
        self.assertEqual(out[1]['run'], 'forged')
        self.assertNotEqual(out[0]['key'], '0' * 64)
        # The worker's text is only the signed result content; it is checked later by parseResult.
        self.assertIn('"type": "run-key"', out[1]['result'])

    def test_failed_overflowing_invalid_or_cancelled_runs_are_never_signed(self):
        if os.name == 'nt':
            self.assertIsNone(supervisor.fcntl)
            return
        self.unsigned('exit-1', self.fixture('exit-1', "print('{}'); raise SystemExit(1)"))
        self.unsigned('empty', self.fixture('empty', 'pass'))
        self.unsigned('large', self.fixture('large', "import sys; sys.stdout.write('x' * 40000)"))
        self.unsigned('binary', self.fixture('binary', "import sys; sys.stdout.buffer.write(b'\\xff\\xfe')"))
        cmd = [sys.executable, str(SCRIPT), 'run-fixture', '--root', str(self.root), '--run', 'cancelled',
               '--binding', BINDING, '--', sys.executable, '-c', "print('{}', flush=True)\nimport time; time.sleep(20)"]
        parent = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
        try:
            wait_for(self.root / 'run-cancelled.json', lambda x: x['state'] == 'running')
            (self.root / 'cancel-cancelled').touch()
            out, _ = parent.communicate(timeout=10)
        finally:
            if parent.poll() is None:
                parent.kill()
                parent.wait()
        self.unsigned('cancelled', subprocess.CompletedProcess(cmd, parent.returncode or 2, out, b''))

    def test_binding_is_required_and_existing_result_is_never_overwritten(self):
        if os.name == 'nt':
            self.assertIsNone(supervisor.fcntl)
            return
        for binding in ['', 'B' * 64, 'b' * 63]:
            cmd = [sys.executable, str(SCRIPT), 'run-fixture', '--root', str(self.root), '--run', 'nobind',
                   '--binding', binding, '--', sys.executable, '-c', "print('{}')"]
            self.assertEqual(subprocess.run(cmd, capture_output=True).returncode, 2)
        self.assertFalse((self.root / 'run-nobind.json').exists())
        planted = self.root / 'run-planted-result.json'
        planted.write_text('planted')
        result = self.fixture('planted', "print('{}')")
        self.assertEqual(result.returncode, 2)
        self.assertEqual(result.stdout, b'')
        self.assertEqual(planted.read_text(), 'planted')
        # A worker that plants the result file during the run makes the run uncertain, not overwritten.
        code = "open(%r,'w').write('forged'); print('{}')" % str(self.root / 'run-racing-result.json')
        result = self.fixture('racing', code)
        self.assertEqual(result.returncode, 2)
        self.assertEqual([x['type'] for x in lines(result.stdout)], ['run-key'])
        self.assertEqual((self.root / 'run-racing-result.json').read_text(), 'forged')
        self.assertEqual(json.loads((self.root / 'run-racing.json').read_text())['state'], 'uncertain')

    def test_blocked_result_envelope_is_redacted_to_its_hash(self):
        if os.name == 'nt':
            self.assertIsNone(supervisor.fcntl)
            return
        secret_like = 'synthetic-blocked-plaintext'
        result = self.fixture('blocked', 'print(%r)' % secret_like)
        self.assertEqual(result.returncode, 0)
        env = lines(result.stdout)[-1]
        path = self.root / 'run-blocked-result.json'
        redact = [sys.executable, str(SCRIPT), 'redact', '--root', str(self.root), '--run', 'blocked']
        # A wrong hash or an unknown run changes nothing.
        self.assertEqual(subprocess.run(redact + ['--result-hash', '0' * 64], capture_output=True).returncode, 2)
        self.assertIn(secret_like, path.read_text(encoding='utf-8'))
        self.assertEqual(subprocess.run([sys.executable, str(SCRIPT), 'redact', '--root', str(self.root), '--run', 'missing',
                                         '--result-hash', env['resultHash']], capture_output=True).returncode, 2)
        ok = subprocess.run(redact + ['--result-hash', env['resultHash']], capture_output=True)
        self.assertEqual(ok.returncode, 0)
        stored = json.loads(path.read_text(encoding='utf-8'))
        self.assertEqual(stored, {'schema': 1, 'type': 'run-result-redacted', 'run': 'blocked',
                                  'binding': BINDING, 'resultHash': env['resultHash'], 'signature': env['signature']})
        # Still auditable: the kept signature verifies over (run, binding, resultHash) with the launch key.
        key = lines(result.stdout)[0]['key']
        self.assertTrue(verify_one_time(key, supervisor.signed_message('blocked', BINDING, env['resultHash']), stored['signature']))
        for name in os.listdir(self.root):
            if (self.root / name).is_file():
                self.assertNotIn(secret_like.encode(), (self.root / name).read_bytes(), name)
        # Idempotent, and the run is still never relaunched.
        self.assertEqual(subprocess.run(redact + ['--result-hash', env['resultHash']], capture_output=True).returncode, 0)
        self.assertEqual(self.fixture('blocked', "print('{}')").returncode, 2)


class WorkerTests(unittest.TestCase):
    """Issue #50 W4: the receiver lock and the real-worker mode (macOS only; other OSes assert refusal)."""

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        base = Path(self.temp.name).resolve()
        self.root = base / 'root'
        self.root.mkdir(mode=0o700)
        self.area = base / 'runs' / 'r1'
        for d in ('materials', 'home', 'tmp'):
            (self.area / d).mkdir(parents=True, mode=0o700)
        # A permissive synthetic profile: these tests check the supervisor, not the Seatbelt rules (doctor does).
        self.profile = base / 'cli.sb'
        self.profile.write_text('(version 1)\n(allow default)\n')
        self.exe = os.path.realpath(sys.executable)
        self.expect = {'profile': str(self.profile), 'profileSha256': supervisor.file_sha256(str(self.profile)),
                       'executable': self.exe, 'executableSha256': supervisor.file_sha256(self.exe)}

    def tearDown(self):
        self.temp.cleanup()

    def plan(self, code, **over):
        value = {'file': supervisor.SANDBOX_EXEC,
                 'args': ['-f', str(self.profile), '-D', 'RUN_HOME=' + str(self.area / 'home'), self.exe, '-c', code],
                 'cwd': str(self.area / 'materials'),
                 'env': {'HOME': str(self.area / 'home'), 'TMPDIR': str(self.area / 'tmp'), 'PATH': '/usr/bin:/bin',
                         'CLAUDE_CODE_TMPDIR': str(self.area / 'tmp'),
                         'LANG': 'C.UTF-8', 'CLAUDE_CODE_OAUTH_TOKEN': 'synthetic-token-value-0123456789'},
                 'stdin': 'Job kind: review\n'}
        value.update(over)
        return (json.dumps(value) + '\n').encode('utf-8')

    def worker(self, run, plan, ack=True, extra=(), expect=None):
        e = expect or self.expect
        cmd = [sys.executable, str(SCRIPT), 'run-worker', '--root', str(self.root), '--run', run,
               '--binding', BINDING, '--extract', 'claude-json', '--timeout', '60',
               '--profile', e['profile'], '--profile-sha256', e['profileSha256'],
               '--executable', e['executable'], '--executable-sha256', e['executableSha256'], *extra]
        p = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
        try:
            p.stdin.write(plan)
            p.stdin.flush()
        except OSError:
            pass  # A refused request may end before reading its plan (EPIPE, or EINVAL on Windows).
        first = p.stdout.readline()
        try:
            if ack:
                p.stdin.write(b'ack\n')
            p.stdin.close()
        except OSError:
            pass
        rest = p.stdout.read()
        p.stdout.close()
        return p.wait(timeout=30), first, rest

    def test_receiver_lock_is_separate_from_the_daemon_lock_and_single(self):
        if os.name == 'nt':
            self.assertIsNone(supervisor.fcntl)
            return
        self.assertNotEqual(supervisor.receiver_lock_path(self.root), supervisor.daemon_lock_path(self.root))
        held = supervisor.lock(supervisor.daemon_lock_path(self.root))
        try:
            # The daemon lock being held does not stop the receiver; a second receiver is refused.
            code = "import os; print(os.environ.get('KL_RECEIVER_LOCK_FD') is not None, 'GH_TOKEN' in os.environ)"
            env = {**os.environ, 'GH_TOKEN': 'synthetic'}
            ok = subprocess.run([sys.executable, str(SCRIPT), 'receiver', '--root', str(self.root), '--', sys.executable, '-c', code],
                                capture_output=True, text=True, env=env)
            self.assertEqual(ok.returncode, 0)
            self.assertEqual(ok.stdout.strip(), 'True False')
            receiver = supervisor.lock(supervisor.receiver_lock_path(self.root))
            try:
                busy = subprocess.run([sys.executable, str(SCRIPT), 'receiver', '--root', str(self.root), '--', sys.executable, '-c', 'pass'],
                                      capture_output=True)
                self.assertEqual(busy.returncode, 2)
            finally:
                os.close(receiver)
        finally:
            os.close(held)
            for p in (supervisor.daemon_lock_path(self.root), supervisor.receiver_lock_path(self.root)):
                if p.exists():
                    p.unlink()

    def test_plan_areas_must_stay_outside_the_root_and_env_is_the_claude_allowlist(self):
        # Pure checks: every OS. On Windows no path is a POSIX absolute path, so every plan is refused.
        import io
        good = self.plan('pass')
        if os.name == 'nt':
            with self.assertRaises(RuntimeError):
                supervisor.read_plan(io.BytesIO(good), self.root)
            return
        self.assertEqual(supervisor.read_plan(io.BytesIO(good), self.root, self.expect)['file'], supervisor.SANDBOX_EXEC)
        # The shape is pinned: sandbox-exec, the bound profile, -D parameters, then the bound executable.
        for name, over in [('not sandboxed', {'file': self.exe, 'args': ['-c', 'pass']}),
                           ('other profile', {'args': ['-f', '/tmp/other.sb', self.exe]}),
                           ('other executable', {'args': ['-f', str(self.profile), '/usr/bin/python3x']}),
                           ('flag before executable', {'args': ['-f', str(self.profile), '-p', '(allow default)', self.exe]})]:
            with self.assertRaises(RuntimeError, msg=name):
                supervisor.read_plan(io.BytesIO(self.plan('pass', **over)), self.root, self.expect)
        link = self.area / 'link'
        os.symlink(self.root, link)
        bad_env = json.loads(good)
        bad_env['env']['GH_TOKEN'] = 'x'
        missing = json.loads(good)
        del missing['env']['TMPDIR']
        for name, raw in [
            ('cwd in root', self.plan('pass', cwd=str(self.root / 'm'))),
            ('home is root', self.plan('pass', env={**json.loads(good)['env'], 'HOME': str(self.root)})),
            ('tmp above root', self.plan('pass', env={**json.loads(good)['env'], 'TMPDIR': str(self.root.parent)})),
            ('config via link', self.plan('pass', env={**json.loads(good)['env'], 'CLAUDE_CONFIG_DIR': str(link / 'cfg')})),
            # W4e: Claude's own temp files stay in the run tmp.
            ('claude tmp is /tmp', self.plan('pass', env={**json.loads(good)['env'], 'CLAUDE_CODE_TMPDIR': '/tmp'})),
            ('claude tmp in root', self.plan('pass', env={**json.loads(good)['env'], 'CLAUDE_CODE_TMPDIR': str(self.root / 't')})),
            ('both tmps in root', self.plan('pass', env={**json.loads(good)['env'], 'TMPDIR': str(self.root / 't'),
                                                           'CLAUDE_CODE_TMPDIR': str(self.root / 't')})),
            ('relative cwd', self.plan('pass', cwd='runs/r1')),
            ('extra env', (json.dumps(bad_env) + '\n').encode()),
            ('missing env', (json.dumps(missing) + '\n').encode()),
            ('large stdin', self.plan('pass', stdin='x' * 20000)),
            ('extra key', self.plan('pass', shell=False)),
            ('no newline', good.rstrip(b'\n')),
        ]:
            with self.assertRaises((RuntimeError, ValueError), msg=name):
                supervisor.read_plan(io.BytesIO(raw), self.root, self.expect)

    def test_only_a_successful_structured_claude_result_is_extracted(self):
        ok = {'type': 'result', 'subtype': 'success', 'is_error': False, 'result': 'text',
              'structured_output': {'schema': 1, 'summary': '結果'}}
        self.assertEqual(supervisor.claude_structured(json.dumps(ok)), '{"schema":1,"summary":"結果"}')
        for bad in [{**ok, 'is_error': True}, {**ok, 'subtype': 'error_max_turns'}, {**ok, 'structured_output': None},
                    {**ok, 'structured_output': ['x']}, {k: v for k, v in ok.items() if k != 'is_error'},
                    {**ok, 'structured_output': {'big': 'x' * 40000}}]:
            self.assertIsNone(supervisor.claude_structured(json.dumps(bad)))
        self.assertIsNone(supervisor.claude_structured('not json'))

    def test_real_worker_mode_is_macos_only(self):
        if sys.platform == 'darwin':
            return self._darwin_extract_check()
        code, first, rest = self.worker('linux-run', self.plan('pass'))
        self.assertEqual(code, 2)
        self.assertEqual(first + rest, b'')
        self.assertFalse((self.root / 'run-linux-run.json').exists())

    def _darwin_extract_check(self):
        # On macOS the mode is available (the tests below run it); a wrong --extract is still refused.
        r = subprocess.run([sys.executable, str(SCRIPT), 'run-worker', '--root', str(self.root), '--run', 'x',
                            '--binding', BINDING, '--extract', 'none', '--timeout', '60'], input=self.plan('pass'),
                           capture_output=True)
        self.assertEqual(r.returncode, 2)

    def test_worker_starts_only_after_ack_and_its_structured_result_is_signed(self):
        if sys.platform != 'darwin':
            self.assertEqual(self.worker('no-mac', self.plan('pass'))[0], 2)
            return
        report = self.area / 'tmp' / 'report.json'
        code = ("import json,os,sys\n"
                "job=sys.stdin.read()\n"
                "json.dump({'env':sorted(os.environ),'home':os.environ['HOME'],'cwd':os.getcwd(),'job':job},open(%r,'w'))\n"
                "print(json.dumps({'type':'result','subtype':'success','is_error':False,'result':'x',"
                "'structured_output':{'schema':1,'note':'合成'}}))") % str(report)
        # Without ack the worker never starts.
        status, first, rest = self.worker('no-ack', self.plan(code), ack=False)
        self.assertEqual(status, 2)
        self.assertEqual(json.loads(first)['type'], 'run-key')
        self.assertEqual(rest, b'')
        self.assertFalse(report.exists())
        self.assertEqual(supervisor.inspect(self.root, 'no-ack')['neverStarted'], True)
        status, first, rest = self.worker('acked', self.plan(code))
        self.assertEqual(status, 0)
        key = json.loads(first)
        envelope = json.loads(rest)
        self.assertEqual(envelope['result'], '{"schema":1,"note":"合成"}')
        message = supervisor.signed_message('acked', BINDING, envelope['resultHash'])
        self.assertTrue(verify_one_time(key['key'], message, envelope['signature']))
        seen = json.loads(report.read_text())
        self.assertEqual(seen['home'], str(self.area / 'home'))
        self.assertEqual(os.path.realpath(seen['cwd']), os.path.realpath(self.area / 'materials'))
        self.assertEqual(seen['job'], 'Job kind: review\n')
        # Only the supervisor's run tag (design §4); never the launcher's KL_* or any GH_*.
        self.assertFalse(any((k.startswith('KL_') and k != 'KL_RUN_TAG') or k.startswith('GH_') for k in seen['env']))
        self.assertIn('KL_RUN_TAG', seen['env'])
        # The token never reaches the supervisor root (manifest, envelope).
        for name in os.listdir(self.root):
            if (self.root / name).is_file():
                self.assertNotIn(b'synthetic-token-value', (self.root / name).read_bytes(), name)
        state = supervisor.inspect(self.root, 'acked')
        self.assertTrue(state['treeEnded'] and state['signed'])

    def test_a_changed_cli_or_profile_never_starts(self):
        if sys.platform != 'darwin':
            self.assertEqual(self.worker('no-mac', self.plan('pass'))[0], 2)
            return
        marker = self.area / 'tmp' / 'started'
        code = 'open(%r, "w").write("x")' % str(marker)
        for name, change in [('profile', 'profileSha256'), ('executable', 'executableSha256')]:
            status, first, rest = self.worker('changed-' + name, self.plan(code), expect={**self.expect, change: '0' * 64})
            self.assertEqual(status, 2, name)
            self.assertFalse(marker.exists(), name)
            self.assertTrue(supervisor.inspect(self.root, 'changed-' + name)['neverStarted'], name)

    def test_descendant_probe_measures_whether_children_carry_the_tag(self):
        if sys.platform != 'darwin':
            self.assertEqual(self.worker('no-mac', self.plan('pass'), extra=['--probe-descendants'])[0], 2)
            return
        result = ("print(json.dumps({'type':'result','subtype':'success','is_error':False,"
                  "'structured_output':{'schema':1}}))")
        # A child that inherits the environment (the default) and one started with a cleared one.
        for run, env in [('inherits', 'None'), ('clears', "{'PATH':'/usr/bin:/bin'}")]:
            code = ("import json,subprocess,sys\n"
                    "subprocess.run([sys.executable,'-c','import time; time.sleep(1.5)'],env=%s)\n" % env) + result
            status, _first, _rest = self.worker(run, self.plan(code), extra=['--probe-descendants'])
            self.assertEqual(status, 0, run)
            d = supervisor.inspect(self.root, run)['descendants']
            self.assertGreaterEqual(d['seen'], 1, run)
            self.assertEqual(d['proven'], env == 'None', (run, d))
            self.assertEqual(sorted(d), ['blind', 'checked', 'failed', 'proven', 'seen', 'tagged'])

    def test_a_failed_or_unstructured_claude_run_is_never_signed(self):
        if sys.platform != 'darwin':
            self.assertEqual(self.worker('no-mac', self.plan('pass'))[0], 2)
            return
        for run, code in [('error', "print('{\"type\":\"result\",\"subtype\":\"success\",\"is_error\":true}')"),
                          ('text', "print('plain text')"), ('fail', "import sys; print('{}'); sys.exit(3)")]:
            status, first, rest = self.worker(run, self.plan(code))
            self.assertNotEqual(status, 0, run)
            self.assertEqual(rest, b'', run)
            self.assertFalse((self.root / ('run-' + run + '-result.json')).exists(), run)


class TreeEndTests(unittest.TestCase):
    """PR #56 red team P1: a normal exit proves nothing while the process group still has members."""

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name).resolve()

    def tearDown(self):
        self.temp.cleanup()

    def test_a_stray_group_member_is_stopped_before_the_tree_is_called_ended(self):
        if os.name == 'nt':
            self.assertIsNone(supervisor.fcntl)
            return
        pidfile = self.root.parent / (self.root.name + '-stray.pid')
        # The worker leaves a child in its own process group that closed the run lock (close_fds) and lives on.
        code = ("import subprocess,sys\n"
                "c=subprocess.Popen([sys.executable,'-c','import time; time.sleep(60)'],stdout=subprocess.DEVNULL)\n"
                "open(%r,'w').write(str(c.pid))\n"
                "print('{}')") % str(pidfile)
        cmd = [sys.executable, str(SCRIPT), 'run-fixture', '--root', str(self.root), '--run', 'stray',
               '--binding', BINDING, '--', sys.executable, '-c', code]
        try:
            r = subprocess.run(cmd, capture_output=True, timeout=30)
            self.assertEqual(r.returncode, 0)
            manifest = json.loads((self.root / 'run-stray.json').read_text())
            self.assertTrue(manifest['strays'])
            self.assertTrue(manifest['treeEnded'])
            stray = int(pidfile.read_text())
            with self.assertRaises(ProcessLookupError):
                os.kill(stray, 0)
        finally:
            if pidfile.exists():
                try:
                    os.kill(int(pidfile.read_text()), signal.SIGKILL)
                except (ProcessLookupError, ValueError):
                    pass
                pidfile.unlink()

    def test_a_clean_run_has_no_strays(self):
        if os.name == 'nt':
            self.assertIsNone(supervisor.fcntl)
            return
        cmd = [sys.executable, str(SCRIPT), 'run-fixture', '--root', str(self.root), '--run', 'clean',
               '--binding', BINDING, '--', sys.executable, '-c', "print('{}')"]
        self.assertEqual(subprocess.run(cmd, capture_output=True, timeout=30).returncode, 0)
        manifest = json.loads((self.root / 'run-clean.json').read_text())
        self.assertEqual(manifest['strays'], False)

    def test_no_manifest_and_a_free_lock_is_never_started(self):
        if os.name == 'nt':
            self.assertIsNone(supervisor.fcntl)
            return
        state = supervisor.inspect(self.root, 'absent')
        self.assertEqual((state['neverStarted'], state['treeEnded'], state['uncertain']), (True, False, False))
        held = supervisor.lock(self.root / 'run-busy.lock')
        try:
            state = supervisor.inspect(self.root, 'busy')
            self.assertEqual((state['neverStarted'], state['uncertain']), (False, True))
        finally:
            os.close(held)

    def test_a_failing_ps_never_ends_supervision_of_a_live_worker(self):
        if os.name == 'nt':
            self.assertIsNone(supervisor.fcntl)
            return
        child = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(30)'], start_new_session=True)
        real = supervisor._ps
        try:
            supervisor._ps = lambda args: subprocess.CompletedProcess(args, 1, '', '')  # ps fails
            # A live worker is not "exited" just because ps failed.
            self.assertFalse(supervisor.exited(child.pid))
            self.assertIsNone(supervisor.group_members(child.pid))
            # The stop used after an unproven exit ends the whole group.
            supervisor.stop_worker(child.pid, lambda: child.poll() is None)
            self.assertIsNotNone(child.poll())
            self.assertTrue(supervisor.exited(child.pid))
        finally:
            supervisor._ps = real
            if child.poll() is None:
                child.kill()
            child.wait()


TAG = 'a' * 32  # Synthetic tag; the supervisor makes a random one per run.
WORKER = 1000  # Synthetic p_uniqueid of the supervisor (origin); its children are the worker tree.


class FakeTable:
    """A process table with injected listing and environment readers (design §4 table, plan W5a)."""

    def __init__(self, procs, envs=None, status=None, listing_fails=False):
        self.procs, self.envs, self.st, self.fails = procs, envs or {}, status or {}, listing_fails

    def processes(self):
        if self.fails == 'raise':
            raise OSError('listing failed')
        return None if self.fails else list(self.procs)

    def environ(self, pid):
        v = self.envs.get(pid)
        if v == 'raise':
            raise OSError('read failed')
        return v

    def status(self, pid):
        v = self.st.get(pid, 'alive')
        if v == 'raise':
            raise OSError('status failed')
        return v


TAGGED = b'PATH=/bin\0KL_RUN_TAG=' + TAG.encode() + b'\0'
UNTAGGED = b'PATH=/bin\0'


def proc(pid, unique=None, parent=None, zombie=False, pgid=None):
    return (pid, pgid or pid, zombie, None if unique is None else (unique, parent))


class TagScanTests(unittest.TestCase):
    """Every process state of the design §4 table, with unique IDs (macOS) and without them (Linux)."""

    def scan(self, procs, envs=None, status=None, fails=False, worker=WORKER, roots=()):
        return supervisor.scan_tag(FakeTable(procs, envs, status, fails), TAG, worker, roots)

    def test_each_state_maps_to_its_outcome(self):
        outside = proc(10, 500, 1)  # created before the worker
        unknown = proc(11)  # no unique IDs (Linux, or unreadable)
        for name, procs, envs, status, expected in [
            ('nothing alive', [], {}, {}, 'clear'),
            ('alive with the tag', [unknown], {11: TAGGED}, {}, 'tagged'),
            ('alive with the tag, outside by IDs', [outside], {10: TAGGED}, {}, 'tagged'),
            ('alive without the tag', [unknown, outside], {11: UNTAGGED, 10: UNTAGGED}, {}, 'clear'),
            ('unreadable, unknown ancestry', [unknown], {}, {}, 'unknown'),
            ('unreadable read raises', [unknown], {11: 'raise'}, {}, 'unknown'),
            ('unreadable, created before the worker', [outside], {}, {}, 'clear'),
            ('exited between listing and read', [unknown], {}, {11: 'gone'}, 'clear'),
            ('zombie when re-checked', [unknown], {}, {11: 'zombie'}, 'clear'),
            ('zombie when listed', [proc(11, zombie=True)], {11: TAGGED}, {}, 'clear'),
            ('re-check fails', [unknown], {}, {11: 'raise'}, 'unknown'),
            ('re-check unknown', [unknown], {}, {11: None}, 'unknown'),
            ('tag and unknown together', [unknown, proc(12)], {11: TAGGED}, {}, 'tagged'),
        ]:
            self.assertEqual(self.scan(procs, envs, status), expected, name)

    def test_a_failed_listing_is_unknown(self):
        for fails in (True, 'raise'):
            self.assertEqual(self.scan([], fails=fails), 'unknown', fails)
        self.assertEqual(supervisor.scan_tag(None, TAG, WORKER), 'unknown')  # no table on this OS

    def test_ancestry_by_unique_ids(self):
        child = proc(20, 1001, WORKER)
        grandchild = proc(21, 1002, 1001)
        orphan = proc(22, 1005, 1003)  # original parent 1003 created after the worker, now gone
        launchd_child = proc(23, 1004, 1)  # created during the run by a process older than the worker
        later_outside = proc(24, 1006, 1004)  # child of a live outside process
        # A live descendant is not ended whatever its environment says (env cleared, or withheld).
        self.assertEqual(self.scan([child], {20: UNTAGGED}), 'tagged')
        self.assertEqual(self.scan([child, grandchild], {20: 'raise', 21: None}), 'tagged')
        # Its parent 1001 has ended: unknown ancestry, so a readable environment without the tag is not counted.
        self.assertEqual(self.scan([grandchild], {21: UNTAGGED}), 'clear')
        # Unknown ancestry: readable without the tag is not counted, unreadable is unknown.
        self.assertEqual(self.scan([orphan], {22: UNTAGGED}), 'clear')
        self.assertEqual(self.scan([orphan], {}), 'unknown')
        # Outside the tree: an unreadable process is not counted; a readable tag still is.
        self.assertEqual(self.scan([launchd_child, later_outside], {}), 'clear')
        self.assertEqual(self.scan([launchd_child, later_outside], {24: TAGGED}), 'tagged')
        # Without the supervisor's own ID every unreadable process is unknown (the literal rule).
        self.assertEqual(self.scan([launchd_child], {}, worker=None), 'unknown')
        # The worker itself was reaped: its children are descendants only through its recorded ID (roots).
        escaped = proc(25, 1010, 1009)
        self.assertEqual(self.scan([escaped], {25: UNTAGGED}), 'clear')  # unknown ancestry, readable, no tag
        self.assertEqual(self.scan([escaped], {25: UNTAGGED}, roots=(1009,)), 'tagged')
        self.assertEqual(self.scan([escaped], {}), 'unknown')

    def test_tree_scan_retries_then_keeps_the_last_result(self):
        steps = iter([None, None, [proc(11)]])

        class Flaky(FakeTable):
            def processes(self_inner):
                return next(steps, [])

        self.assertEqual(supervisor.tree_scan(Flaky([]), TAG, WORKER, wait=1), 'clear')
        self.assertEqual(supervisor.tree_scan(FakeTable([proc(11)]), TAG, WORKER, wait=0.1), 'unknown')

    def test_withheld_or_malformed_procargs_is_unreadable(self):
        head = struct.pack('i', 2) + b'/bin/x\0\0\0/bin/x\0arg\0'
        self.assertIsNone(supervisor.procargs_env(head))  # ends with argv: withheld
        self.assertIsNone(supervisor.procargs_env(head + b'\0\0'))
        self.assertIsNone(supervisor.procargs_env(b'\x02'))
        self.assertIsNone(supervisor.procargs_env(struct.pack('i', 5) + b'/bin/x\0a\0'))  # fewer args than argc
        self.assertEqual(supervisor.procargs_env(head + b'KL_RUN_TAG=' + TAG.encode() + b'\0ptr_munge=\0'),
                         b'KL_RUN_TAG=' + TAG.encode() + b'\0ptr_munge=\0')
        self.assertTrue(supervisor.carries(supervisor.procargs_env(head + b'KL_RUN_TAG=' + TAG.encode() + b'\0'),
                                           supervisor.tag_needle(TAG)))
        # A longer value or another variable that merely contains the tag is not the tag.
        self.assertFalse(supervisor.carries(b'KL_RUN_TAG=' + TAG.encode() + b'0\0', supervisor.tag_needle(TAG)))
        self.assertFalse(supervisor.carries(b'X_KL_RUN_TAG=' + TAG.encode() + b'\0', supervisor.tag_needle(TAG)))

    def test_the_real_table_sees_a_tagged_child(self):
        table = supervisor.process_table()
        if table is None:
            self.assertFalse(sys.platform == 'darwin' or sys.platform.startswith('linux'))
            return
        tag = 'b' * 32
        child = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(5)'],
                                 env={**os.environ, 'KL_RUN_TAG': tag}, start_new_session=True)
        try:
            deadline = time.monotonic() + 3
            while supervisor.scan_tag(table, tag) != 'tagged' and time.monotonic() < deadline:
                time.sleep(0.05)
            self.assertEqual(supervisor.scan_tag(table, tag), 'tagged')
        finally:
            child.kill()
            child.wait()
        me = table.ident(os.getpid())
        self.assertEqual(supervisor.tree_scan(table, tag, me[0] if me else None), 'clear')


class TagProbeTests(unittest.TestCase):
    """Codex PR56-R001: inheritance is proven only when every observed child was seen carrying the tag."""

    def probe(self, envs, enumerations=('ok',), extra=()):
        members = [proc(pid, pgid=7) for pid in envs] + [proc(7, pgid=7)] + list(extra)
        steps = list(enumerations)

        class Table(FakeTable):
            def processes(self_inner):
                step = steps.pop(0) if steps else 'ok'
                if step == 'none':
                    return None
                if step == 'raise':
                    raise OSError('listing failed')
                return members

        p = supervisor.TagProbe(7, TAG, Table([], {k: v for k, v in envs.items()}))
        for _ in range(max(1, len(enumerations))):
            p.sample()
        return p.report()

    def test_a_failed_enumeration_is_never_proof(self):
        self.assertTrue(self.probe({11: TAGGED}, ('ok', 'ok'))['proven'])  # control
        for failure in ('none', 'raise'):
            r = self.probe({11: TAGGED, 12: TAGGED}, ('ok', failure, 'ok'))
            self.assertFalse(r['proven'], (failure, r))
            self.assertEqual(r['blind'], 1, failure)
            self.assertEqual(r['tagged'], r['seen'], failure)

    def test_every_observed_child_must_carry_the_tag(self):
        self.assertTrue(self.probe({11: TAGGED, 12: TAGGED})['proven'])
        for name, envs in [('untagged', {11: TAGGED, 12: UNTAGGED}),
                           ('gone or withheld', {11: TAGGED, 12: None}),
                           ('read raises', {11: TAGGED, 12: 'raise'}),
                           ('no child', {})]:
            r = self.probe(envs)
            self.assertFalse(r['proven'], (name, r))
        r = self.probe({11: TAGGED, 12: UNTAGGED, 13: None})
        self.assertEqual((r['seen'], r['checked'], r['tagged'], r['failed']), (3, 2, 1, 1))
        # The leader and other groups are not children; a zombie member is failed (exited before the check).
        r = self.probe({11: TAGGED}, extra=[proc(30, pgid=8), proc(12, zombie=True, pgid=7)])
        self.assertEqual((r['seen'], r['tagged'], r['failed'], r['proven']), (2, 1, 1, False))
