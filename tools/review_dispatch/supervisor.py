"""POSIX lifetime locks for the default-off dispatcher and synthetic worker probes.

No AI launcher, credentials, shell interpolation or PID/timeout lease stealing.
Windows is explicitly unsupported; deployment requires a separately reviewed backend.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import time

try:
    import fcntl
except ImportError:
    fcntl = None


def canonical_root(raw):
    root = Path(raw)
    if not root.is_absolute() or str(root.resolve()) != raw:
        raise RuntimeError("canonical dispatcher root required")
    for p in [root, *root.parents]:
        if (p / '.git').exists() or p.is_symlink() or not p.is_dir():
            raise RuntimeError("unsafe dispatcher root")
    return root


def daemon_lock_path(root):
    return root.parent / ('.kurashi-dispatch-' + hashlib.sha256(str(root).encode()).hexdigest() + '.lock')


def lock(path):
    if fcntl is None:
        raise RuntimeError("POSIX lock backend unavailable; disabled")
    fd = os.open(path, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    if not os.path.isfile(path) or os.fstat(fd).st_nlink != 1:
        os.close(fd)
        raise RuntimeError("unsafe lock")
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        os.close(fd)
        raise RuntimeError("resource already owned") from None
    os.set_inheritable(fd, True)
    return fd


def durable(path, value):
    temp = path.with_suffix('.new')
    fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        with os.fdopen(fd, 'w') as stream:
            json.dump(value, stream)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temp, path)
        parent = os.open(path.parent, os.O_RDONLY)
        try:
            os.fsync(parent)
        finally:
            os.close(parent)
    finally:
        if temp.exists():
            temp.unlink()


def start_stamp(pid):
    # Server OS start time, not a guessed heartbeat. PID alone never establishes ownership.
    if not isinstance(pid, int) or pid < 1:
        return ''
    try:
        p = subprocess.run(['/bin/ps', '-p', str(pid), '-o', 'lstart='], capture_output=True, text=True, check=False, timeout=2)
        return p.stdout.strip() if p.returncode == 0 else ''
    except (OSError, subprocess.TimeoutExpired):
        return ''


def run(root, mode, run_id, command):
    if not command or not Path(command[0]).is_absolute():
        raise RuntimeError("fixed absolute executable required")
    if mode == 'daemon':
        lock_path = daemon_lock_path(root)
    else:
        if not run_id or not all(c.isalnum() or c == '-' for c in run_id) or len(run_id) > 100:
            raise RuntimeError("invalid run ID")
        lock_path = root / ('run-' + run_id + '.lock')
    fd = lock(lock_path)
    identity = root.stat()
    manifest = root / ('run-' + run_id + '.json') if mode != 'daemon' else None
    if manifest and manifest.exists():
        os.close(fd)
        raise RuntimeError("existing run requires reconciliation, never relaunch")
    value = {'schema': 1, 'run': run_id, 'state': 'launching', 'backend': 'fixture',
             'supervisor': os.getpid(), 'start': start_stamp(os.getpid()), 'treeEnded': False}
    if not value['start']:
        os.close(fd)
        raise RuntimeError('supervisor identity unavailable')
    if manifest:
        durable(manifest, value)  # Committed before spawn; interrupted window is uncertain.
    env = {'PATH': '/usr/bin:/bin', 'HOME': str(root), 'TMPDIR': str(root),
           'LANG': 'C.UTF-8', 'KL_DISPATCH_LOCK_FD' if mode == 'daemon' else 'KL_RUN_LOCK_FD': str(fd)}
    child = None
    cancel = False

    def stop(_signum, _frame):
        nonlocal cancel
        cancel = True
    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    try:
        child = subprocess.Popen(command, env=env, pass_fds=(fd,), start_new_session=True,
                                 stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL if manifest else None,
                                 stderr=subprocess.DEVNULL if manifest else None)
        value.update(state='running', worker=child.pid, workerStart=start_stamp(child.pid))
        if manifest:
            durable(manifest, value)
        while child.poll() is None:
            current = root.stat()
            if (identity.st_dev, identity.st_ino) != (current.st_dev, current.st_ino):
                cancel = True
            if manifest and (root / ('cancel-' + run_id)).exists():
                cancel = True
            if cancel:
                if not value['workerStart'] or start_stamp(child.pid) != value['workerStart']:
                    raise RuntimeError('process identity uncertain')
                os.killpg(child.pid, signal.SIGTERM)
                try:
                    child.wait(timeout=2)
                except subprocess.TimeoutExpired:
                    if start_stamp(child.pid) != value['workerStart']:
                        raise RuntimeError('process identity uncertain')
                    os.killpg(child.pid, signal.SIGKILL)
                    child.wait(timeout=2)
                break
            time.sleep(0.03)
        if mode == 'daemon':
            return child.returncode
        # Workers/descendants must inherit this descriptor. An escaped setsid descendant keeps it.
        os.close(fd)
        fd = -1
        try:
            probe = lock(lock_path)
        except RuntimeError:
            value.update(state='uncertain', treeEnded=False)
            durable(manifest, value)
            return 2
        os.close(probe)
        # This proof is only for synthetic lock-inheriting fixtures; actual CLI capabilities remain disabled.
        value.update(state='finished', treeEnded=True, exit=child.returncode)
        durable(manifest, value)
        return child.returncode
    except BaseException:
        if manifest:
            value.update(state='uncertain', treeEnded=False)
            try:
                durable(manifest, value)
            except OSError:
                pass
        raise
    finally:
        if fd >= 0:
            os.close(fd)


def inspect(root, run_id):
    if not run_id or not all(c.isalnum() or c == '-' for c in run_id) or len(run_id) > 100:
        raise RuntimeError('invalid run ID')
    path = root / ('run-' + run_id + '.json')
    if path.is_symlink() or path.stat().st_size > 16384:
        raise RuntimeError('invalid manifest')
    value = json.loads(path.read_text())
    if value.get('schema') != 1 or value.get('run') != run_id or value.get('backend') != 'fixture':
        raise RuntimeError('unknown manifest')
    live = bool(value.get('start')) and start_stamp(value.get('supervisor', -1)) == value['start']
    locked = True
    try:
        fd = lock(root / ('run-' + run_id + '.lock'))
        os.close(fd)
        locked = False
    except RuntimeError:
        pass
    ended = value.get('state') == 'finished' and value.get('treeEnded') is True and not locked and not live
    return {'run': run_id, 'treeEnded': ended, 'neverStarted': False,
            'uncertain': not ended, 'supervisorAlive': live, 'lockHeld': locked}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('mode', choices=['daemon', 'run-fixture', 'inspect'])
    parser.add_argument('--root', required=True)
    parser.add_argument('--run', default='')
    args, command = parser.parse_known_args()
    if command and command[0] == '--':
        command = command[1:]
    try:
        root = canonical_root(args.root)
        if args.mode == 'inspect':
            print(json.dumps(inspect(root, args.run)))
            return 0
        return run(root, args.mode, args.run, command)
    except (RuntimeError, OSError, ValueError):
        # Never echo arbitrary command/output or keys.
        print('dispatcher supervisor unavailable or ownership uncertain', file=sys.stderr)
        return 2


if __name__ == '__main__':
    sys.exit(main())
