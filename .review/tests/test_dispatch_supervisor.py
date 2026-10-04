"""Real POSIX fixtures. Windows asserts disabled backend instead of skipping."""
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
        result = subprocess.run(self.command('run-fixture', '--run', 'synthetic-1', '--', sys.executable, '-c', 'pass'), capture_output=True)
        self.assertEqual(result.returncode, 0)
        manifest = json.loads((self.root / 'run-synthetic-1.json').read_text())
        self.assertTrue(manifest['treeEnded'])
        again = subprocess.run(self.command('run-fixture', '--run', 'synthetic-1', '--', sys.executable, '-c', 'pass'), capture_output=True)
        self.assertEqual(again.returncode, 2)

    def test_supervisor_death_does_not_duplicate_live_child(self):
        if self.disabled_windows():
            return
        code = "import time; time.sleep(20)"
        parent = subprocess.Popen(self.command('run-fixture', '--run', 'orphan', '--', sys.executable, '-c', code), stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        info = None
        try:
            info = wait_for(self.root / 'run-orphan.json', lambda x: x['state'] == 'running')
            parent.kill()
            parent.wait(timeout=5)
            with self.assertRaises(RuntimeError):
                supervisor.lock(self.root / 'run-orphan.lock')
            result = subprocess.run(self.command('run-fixture', '--run', 'orphan', '--', sys.executable, '-c', 'pass'), capture_output=True)
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
        parent = subprocess.Popen(self.command('run-fixture', '--run', 'escaped', '--', sys.executable, '-c', code), stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
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
        p = subprocess.run(self.command('run-fixture', '--run', 'partial', '--', sys.executable, '-c', 'pass'), capture_output=True)
        self.assertEqual(p.returncode, 2)
        self.assertEqual(supervisor.start_stamp(99999999), '')

    def test_cancellation_proves_fixture_tree_end(self):
        if self.disabled_windows():
            return
        parent = subprocess.Popen(self.command('run-fixture', '--run', 'cancel', '--', sys.executable, '-c', 'import time; time.sleep(20)'), stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
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
        parent = subprocess.Popen(self.command('run-fixture', '--run', 'reconnect', '--', sys.executable, '-c', 'import time;time.sleep(20)'), stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
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
