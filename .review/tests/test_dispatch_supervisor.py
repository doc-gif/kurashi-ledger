"""Real POSIX fixtures. Windows asserts disabled backend instead of skipping."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import signal
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
            with self.assertRaises(RuntimeError):
                supervisor.lock(self.root / 'run-orphan.lock')
            result = subprocess.run(self.command('run-fixture', '--run', 'orphan', '--binding', BINDING, '--', sys.executable, '-c', 'pass'), capture_output=True)
            self.assertEqual(result.returncode, 2)
        finally:
            if parent.poll() is None:
                parent.kill()
                parent.wait()
            if info:
                os.killpg(info['worker'], signal.SIGKILL)

    def test_setsid_descendant_inherits_lock_after_wrapper_and_worker_exit(self):
        if self.disabled_windows():
            return
        marker = self.root / 'descendant.json'
        child_code = "import os,time,json; open(%r,'w').write(json.dumps({'pid':os.getpid()})); time.sleep(20)" % str(marker)
        code = "import os,subprocess; fd=int(os.environ['KL_RUN_LOCK_FD']); subprocess.Popen([%r,'-c',%r],pass_fds=(fd,),start_new_session=True)" % (sys.executable, child_code)
        parent = subprocess.Popen(self.command('run-fixture', '--run', 'escaped', '--binding', BINDING, '--', sys.executable, '-c', code), stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        info = None
        try:
            info = wait_for(marker)
            self.assertEqual(parent.wait(timeout=8), 2)
            self.assertFalse(json.loads((self.root / 'run-escaped.json').read_text())['treeEnded'])
            with self.assertRaises(RuntimeError):
                supervisor.lock(self.root / 'run-escaped.lock')
        finally:
            if parent.poll() is None:
                parent.kill()
                parent.wait()
            if info:
                os.kill(info['pid'], signal.SIGKILL)

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
                "json.dump({'env':sorted(os.environ),'fds':fds,'lock':int(os.environ['KL_RUN_LOCK_FD']),'files':seen.hex()},open(%r,'w'))\n"
                "print('{}')") % (str(self.root), str(self.root), str(report))
        result = self.fixture('isolated', code)
        self.assertEqual(result.returncode, 0)
        seen = json.loads(report.read_text())
        # macOS CoreFoundation adds __CF_USER_TEXT_ENCODING inside the process; nothing else beyond the allowlist.
        self.assertEqual([x for x in seen['env'] if x != '__CF_USER_TEXT_ENCODING'],
                         ['HOME', 'KL_RUN_LOCK_FD', 'LANG', 'PATH', 'TMPDIR'])
        # Only the inherited run lock beyond stdio; never the supervisor's control pipe or any key material.
        self.assertEqual(seen['fds'], [seen['lock']])
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
                                          'binding', 'key', 'signed', 'worker', 'workerStart', 'exit', 'resultHash'},
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
                                  'binding': BINDING, 'resultHash': env['resultHash']})
        for name in os.listdir(self.root):
            if (self.root / name).is_file():
                self.assertNotIn(secret_like.encode(), (self.root / name).read_bytes(), name)
        # Idempotent, and the run is still never relaunched.
        self.assertEqual(subprocess.run(redact + ['--result-hash', env['resultHash']], capture_output=True).returncode, 0)
        self.assertEqual(self.fixture('blocked', "print('{}')").returncode, 2)
