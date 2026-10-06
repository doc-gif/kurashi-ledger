"""POSIX lifetime locks for the default-off dispatcher and synthetic worker probes.

No AI launcher, credentials, shell interpolation or PID/timeout lease stealing.
Windows is explicitly unsupported; deployment requires a separately reviewed backend.

Run results are signed here, outside the worker boundary (PR48-R003). Each run gets a fresh
one-time key that exists only in this process's memory. The public commitment is announced on
this process's own stdout before the worker starts; the dispatcher and Broker only verify
(scripts/lib/review-dispatch/provenance.ts) and never hold a signing key.
"""
import argparse
import hashlib
import hmac
import json
import os
from pathlib import Path
import re
import secrets
import select
import signal
import stat
import subprocess
import sys
import threading
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


def receiver_lock_path(root):
    # The Webhook receiver is long-lived and only appends to the Inbox, so it has its own singleton lock (W4).
    return root.parent / ('.kurashi-dispatch-' + hashlib.sha256(str(root).encode()).hexdigest() + '.receiver.lock')


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


RESULT_LIMIT = 32768  # Same bound as the Broker's parseResult.
OUTPUT_LIMIT = 1024 * 1024  # Claude's --output-format json envelope around the structured result.
PLAN_LIMIT = 256 * 1024
ACK_TIMEOUT = 30
# launcher.ts ENV_KEYS.claude: the only names a real worker may receive.
WORKER_ENV = frozenset(['CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_TMPDIR',
                        'CLAUDE_CONFIG_DIR', 'DISABLE_AUTOUPDATER', 'HOME', 'LANG', 'NO_COLOR', 'PATH', 'TMPDIR', 'USE_BUILTIN_RIPGREP'])
HEX64 = re.compile(r'[a-f0-9]{64}')


# One-time hash-based signature (Lamport over a SHA-256 digest), standard library only.
# A key signs exactly one message: the supervisor signs one result per run and then discards the key.
# Private material is a 32-byte seed in a bytearray; every secret preimage is derived from it with HMAC-SHA256.
def _secret(seed, index, bit):
    return hmac.new(seed, b'kurashi-ledger:lamport-key:v1' + index.to_bytes(2, 'big') + bytes([bit]),
                    hashlib.sha256).digest()


def public_key(seed):
    h = hashlib.sha256(b'kurashi-ledger:lamport-public:v1\n')
    for index in range(256):
        for bit in (0, 1):
            h.update(hashlib.sha256(_secret(seed, index, bit)).digest())
    return h.hexdigest()


def signed_message(run_id, binding, result_hash):
    if not valid_run(run_id) or not HEX64.fullmatch(binding) or not HEX64.fullmatch(result_hash):
        raise RuntimeError('invalid signing input')
    return ('kurashi-ledger:dispatch-result:v1\n%s\n%s\n%s\n' % (run_id, binding, result_hash)).encode('ascii')


def sign(seed, key, message):
    if not HEX64.fullmatch(key):
        raise RuntimeError('invalid key')
    digest = hashlib.sha256(b'kurashi-ledger:lamport-digest:v1\n' + key.encode('ascii') + b'\n' + message).digest()
    parts = []
    for index in range(256):
        bit = (digest[index // 8] >> (7 - index % 8)) & 1
        parts.append(_secret(seed, index, bit))  # revealed preimage
        parts.append(hashlib.sha256(_secret(seed, index, 1 - bit)).digest())  # other public half
    return b''.join(parts).hex()


def valid_run(run_id):
    return bool(run_id) and len(run_id) <= 100 and all(c.isascii() and (c.isalnum() or c == '-') for c in run_id)


class Capture:
    """Drains the worker's stdout pipe. Keeps at most `limit` bytes; more is an overflow."""

    def __init__(self, fd, limit=RESULT_LIMIT):
        self.data = bytearray()
        self.limit = limit
        self.overflow = False
        self.done = threading.Event()
        threading.Thread(target=self._read, args=(fd,), daemon=True).start()

    def _read(self, fd):
        try:
            while True:
                chunk = os.read(fd, 65536)
                if not chunk:
                    break
                if not self.overflow:
                    if len(self.data) + len(chunk) > self.limit:
                        self.overflow = True
                        self.data.clear()
                    else:
                        self.data.extend(chunk)
        except OSError:
            self.overflow = True
        finally:
            self.done.set()


def emit(value):
    # Control channel to the launcher. The worker never holds this pipe. Values are JSON, so worker text cannot forge a line.
    sys.stdout.write(json.dumps(value, ensure_ascii=True, separators=(',', ':')) + '\n')
    sys.stdout.flush()


def write_new(path, value):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'w') as stream:
        json.dump(value, stream, ensure_ascii=True)
        stream.flush()
        os.fsync(stream.fileno())
    parent = os.open(path.parent, os.O_RDONLY)
    try:
        os.fsync(parent)
    finally:
        os.close(parent)


def _overlaps(root, raw):
    if not isinstance(raw, str) or not raw.startswith('/') or '\0' in raw:
        return True
    real = os.path.realpath(raw)
    r = str(root)
    return real == r or real.startswith(r + '/') or r.startswith(real + '/')


SANDBOX_EXEC = '/usr/bin/sandbox-exec'
PARAM = re.compile(r'[A-Z_]{1,32}=[^\0\n]*')


def file_sha256(path):
    h = hashlib.sha256()
    # O_NOFOLLOW exists on every POSIX system; Windows (no real worker backend) only hashes in tests.
    fd = os.open(path, os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0) | getattr(os, 'O_BINARY', 0))
    try:
        while True:
            chunk = os.read(fd, 1 << 20)
            if not chunk:
                break
            h.update(chunk)
    finally:
        os.close(fd)
    return h.hexdigest()


def read_plan(stream, root, expect=None):
    """One JSON line from the trusted launcher (active.ts): the plan launcher.ts built and checked.

    Re-checked here because this process is the boundary that keeps the signing key, manifest and envelope
    out of the worker's reach (W4 row 4): the worker's cwd, HOME, TMPDIR and config dir must not overlap the
    supervisor root, and only the Claude allowlist of env names passes. Nothing of the plan is written anywhere.
    """
    line = stream.readline(PLAN_LIMIT + 1)
    if len(line) > PLAN_LIMIT or not line.endswith(b'\n'):
        raise RuntimeError('invalid plan')
    plan = json.loads(line.decode('utf-8'))
    if not isinstance(plan, dict) or sorted(plan) != ['args', 'cwd', 'env', 'file', 'stdin']:
        raise RuntimeError('invalid plan')
    file, args, env, cwd, text = plan['file'], plan['args'], plan['env'], plan['cwd'], plan['stdin']
    if (not isinstance(file, str) or not file.startswith('/') or not isinstance(args, list)
            or not all(isinstance(a, str) and '\0' not in a for a in args)
            or not isinstance(env, dict) or not set(env) <= WORKER_ENV or not {'HOME', 'TMPDIR', 'PATH'} <= set(env)
            or not all(isinstance(v, str) and '\0' not in v and '\n' not in v for v in env.values())
            or not isinstance(text, str) or len(text.encode('utf-8')) > 16384
            # Claude's own temp files (W4e) go to the run tmp, never elsewhere.
            or env.get('CLAUDE_CODE_TMPDIR', env['TMPDIR']) != env['TMPDIR']):
        raise RuntimeError('invalid plan')
    places = [cwd, env['HOME'], env['TMPDIR']] + ([env['CLAUDE_CONFIG_DIR']] if 'CLAUDE_CONFIG_DIR' in env else [])
    if any(_overlaps(root, p) for p in places):
        raise RuntimeError('worker area overlaps the supervisor root')
    if expect is not None:
        # A real Claude worker always has its own config dir (fresh_config checks it right before the start).
        if 'CLAUDE_CONFIG_DIR' not in env:
            raise RuntimeError('invalid plan')
        # Defence in depth (PR #56 red team P3): the shape is fixed here too, not only in launcher.ts:
        # sandbox-exec -f <the bound cli.sb> -D NAME=value ... <the bound executable> <CLI args>.
        i = 2
        while i + 1 < len(args) and args[i] == '-D' and PARAM.fullmatch(args[i + 1]):
            i += 2
        if (file != SANDBOX_EXEC or len(args) < 3 or args[0] != '-f' or args[1] != expect['profile']
                or i >= len(args) or args[i] != expect['executable']):
            raise RuntimeError('plan is not the bound sandboxed CLI')
    return plan


def check_bound_files(expect):
    """Immediately before the worker starts: cli.sb and the CLI executable are the files the doctor measured."""
    if (file_sha256(expect['profile']) != expect['profileSha256']
            or file_sha256(expect['executable']) != expect['executableSha256']):
        raise RuntimeError('bound file changed')


def fresh_config(path):
    """Issue #50 W5c (ISSUE50-P001): the worker's CLAUDE_CONFIG_DIR is this run's own new directory: not a link,
    owned by this user, mode 0700 and empty right before the worker starts. Nothing is shared with another run."""
    st = os.lstat(path)
    if (not stat.S_ISDIR(st.st_mode) or st.st_uid != os.getuid() or stat.S_IMODE(st.st_mode) != 0o700
            or os.listdir(path)):
        raise RuntimeError('config dir is not fresh')


def _ps(args):
    p = subprocess.run(['/bin/ps', *args], capture_output=True, text=True, check=False, timeout=5)
    return p


def exited(pid):
    """True once the worker is a zombie (or gone). It is NOT reaped here, so its PID (and process group ID)
    cannot be reused while the group is checked."""
    try:
        p = _ps(['-o', 'stat=', '-p', str(pid)])
    except (OSError, subprocess.TimeoutExpired):
        return False
    if p.returncode == 0:
        return p.stdout.strip().startswith('Z')
    # ps failed: only a process that no longer exists counts as ended (a transient ps failure does not).
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return True
    except PermissionError:
        return False
    return False


def stop_worker(pgid, still_alive):
    """The same stop as a cancel (TERM, then KILL, to the whole group) for a worker the loop no longer
    supervises; the run stays uncertain whatever happens (PR #56 red team round 2 P3)."""
    for sig in (SIGTERM, SIGKILL):
        try:
            os.killpg(pgid, sig)
        except (ProcessLookupError, PermissionError):
            return
        deadline = time.monotonic() + 2
        while still_alive() and time.monotonic() < deadline:
            time.sleep(0.03)
        if not still_alive():
            return


GROUP_LINE = re.compile(r'\s*(\d+)\s+(\d+)\s+(\S+)\s*')
GROUP_WAIT = 2  # seconds per signal before the group check gives up (uncertain)
# POSIX numbers where the platform lacks the name: Windows has no SIGKILL. No backend runs there (the pure checks
# below are still tested on every OS); the values are the POSIX ones the macOS supervisor sends.
SIGTERM = getattr(signal, 'SIGTERM', 15)
SIGKILL = getattr(signal, 'SIGKILL', 9)


def group_members(pgid):
    """Live members of the worker's process group, the leader included unless it is a zombie.

    None when unknown: ps failed, a line did not parse, or the leader's own row (pid == pgid) is missing,
    so the answer cannot be shown to cover the group. [] means only the unreaped (zombie) leader is left.
    """
    try:
        p = _ps(['-A', '-o', 'pid=', '-o', 'pgid=', '-o', 'stat='])
    except (OSError, subprocess.TimeoutExpired):
        return None
    if p.returncode != 0:
        return None
    out, leader = [], False
    for line in p.stdout.splitlines():
        if not line.strip():
            continue
        m = GROUP_LINE.fullmatch(line)
        if not m:
            return None
        pid, group, state = int(m.group(1)), int(m.group(2)), m.group(3)
        if group != pgid:
            continue
        if pid == pgid:
            leader = True
        if not state.startswith('Z'):
            out.append(pid)
    return out if leader else None


def _killpg(pgid, sig):
    getattr(os, 'killpg')(pgid, sig)  # POSIX only; never reached on Windows (no backend)


def end_group(pgid, members=None):
    """Issue #50 W5c (ISSUE50-P002): stop the worker's process group and see it empty. Returns (ended, strays).

    The caller has not reaped the leader, so its PID and process group ID cannot be reused meanwhile. Only an
    enumeration that shows no live member proves the group empty; a successful killpg alone never does. A failed
    or invalid enumeration, PermissionError and the wait limit are "not ended" (the run stays uncertain). The group
    is signalled only while the enumeration shows live members: macOS answers EPERM for a group whose only member
    is the zombie leader. A child that left the group is not seen here (design §7, residual risk).
    """
    members = members or group_members

    def look():
        try:
            return members(pgid)
        except Exception:  # noqa: BLE001 - an enumeration that raised is unknown, never "empty"
            return None
    strays = False
    for sig in (SIGTERM, SIGKILL):
        live = look()
        if live is None:
            return False, strays
        if not live:
            return True, strays
        strays = True
        try:
            _killpg(pgid, sig)
        except ProcessLookupError:
            pass  # The enumeration below decides.
        except PermissionError:
            return False, strays
        deadline = time.monotonic() + GROUP_WAIT
        while time.monotonic() < deadline:
            live = look()
            if live is None:
                return False, strays
            if not live:
                return True, strays
            time.sleep(0.05)
    return False, strays


def claude_structured(raw):
    """The structured result of `claude -p --output-format json --json-schema` (field structured_output).

    Anything else (an error result, no structured output, another shape) yields None: nothing is signed.
    """
    try:
        v = json.loads(raw)
    except ValueError:
        return None
    if (not isinstance(v, dict) or v.get('type') != 'result' or v.get('subtype') != 'success'
            or v.get('is_error') is not False or not isinstance(v.get('structured_output'), dict)):
        return None
    out = json.dumps(v['structured_output'], ensure_ascii=False, separators=(',', ':'))
    return out if len(out.encode('utf-8')) <= RESULT_LIMIT else None


def wait_ack(stream, timeout):
    """The launcher persists the run key, then writes "ack". Without it the worker never starts."""
    ready, _, _ = select.select([stream], [], [], timeout)
    if not ready:
        return False
    return stream.readline(16) == b'ack\n'


def start_stamp(pid):
    # Server OS start time, not a guessed heartbeat. PID alone never establishes ownership.
    if not isinstance(pid, int) or pid < 1:
        return ''
    try:
        p = subprocess.run(['/bin/ps', '-p', str(pid), '-o', 'lstart='], capture_output=True, text=True, check=False, timeout=2)
        return p.stdout.strip() if p.returncode == 0 else ''
    except (OSError, subprocess.TimeoutExpired):
        return ''


def run(root, mode, run_id, command, binding='', extract='', timeout=0, expect=None):
    plan = None
    if mode == 'run-worker':
        # Real backends sign on macOS only (W4 row 4); the dispatcher runs on the owner's Mac.
        if sys.platform != 'darwin':
            raise RuntimeError('real worker backend is macOS-only')
        if (command or extract != 'claude-json' or not 0 < timeout <= 4 * 3600 or not expect
                or not all(isinstance(expect.get(k), str) and expect[k] for k in
                           ('profile', 'profileSha256', 'executable', 'executableSha256'))
                or not HEX64.fullmatch(expect['profileSha256']) or not HEX64.fullmatch(expect['executableSha256'])):
            raise RuntimeError('invalid run-worker request')
        plan = read_plan(sys.stdin.buffer, root, expect)
        command = [plan['file'], *plan['args']]
    if not command or not Path(command[0]).is_absolute():
        raise RuntimeError("fixed absolute executable required")
    if mode in ('daemon', 'receiver'):
        lock_path = daemon_lock_path(root) if mode == 'daemon' else receiver_lock_path(root)
    else:
        if not valid_run(run_id):
            raise RuntimeError("invalid run ID")
        if not HEX64.fullmatch(binding):
            raise RuntimeError("job binding required")
        lock_path = root / ('run-' + run_id + '.lock')
    fd = lock(lock_path)
    identity = root.stat()
    manifest = root / ('run-' + run_id + '.json') if mode in ('run-fixture', 'run-worker') else None
    signed_path = root / ('run-' + run_id + '-result.json') if manifest else None
    if manifest and (manifest.exists() or signed_path.exists() or signed_path.is_symlink()):
        os.close(fd)
        raise RuntimeError("existing run requires reconciliation, never relaunch")
    # Manifest schema 2 (Issue #50 W5c): groupEnded is the worker's process group, seen empty after the stop.
    # Whether every descendant ended is never proven (a child may leave the group): allDescendants stays
    # "unproven" (design §7, residual risk).
    value = {'schema': 2, 'run': run_id, 'state': 'launching', 'backend': 'claude' if plan else 'fixture',
             'supervisor': os.getpid(), 'start': start_stamp(os.getpid()), 'groupEnded': False,
             'allDescendants': 'unproven'}
    if not value['start']:
        os.close(fd)
        raise RuntimeError('supervisor identity unavailable')
    # Per-run one-time key: memory only, never in files, env or descriptors given to the worker.
    seed = bytearray(secrets.token_bytes(32)) if manifest else bytearray()
    capture = None
    # The daemon and the receiver hold their lock through their child. A run's lock stays with this process only
    # (the lease's "supervisor alive" evidence); the worker never inherits it.
    lock_env = {'daemon': 'KL_DISPATCH_LOCK_FD', 'receiver': 'KL_RECEIVER_LOCK_FD'}.get(mode)
    env = {'PATH': '/usr/bin:/bin', 'HOME': str(root), 'TMPDIR': str(root), 'LANG': 'C.UTF-8'}
    if lock_env:
        env[lock_env] = str(fd)
    if plan:
        # The real worker gets exactly the launcher's env (its own HOME/TMPDIR/config outside this root).
        env = dict(plan['env'])
    # Only the trusted daemon receives its reduced read token; worker/fixture environments never inherit it.
    if mode == 'daemon' and os.environ.get('GH_TOKEN'):
        env['GH_TOKEN'] = os.environ['GH_TOKEN']
    child = None
    cancel = False

    def stop(_signum, _frame):
        nonlocal cancel
        cancel = True
    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    try:
        if manifest:
            key = public_key(seed)
            value.update(binding=binding, key=key, signed=False)  # Public commitment only; verifiers use the launch record.
            durable(manifest, value)  # Committed before spawn; interrupted window is uncertain.
            emit({'schema': 1, 'type': 'run-key', 'run': run_id, 'binding': binding, 'key': key})
            if plan and not wait_ack(sys.stdin.buffer, ACK_TIMEOUT):
                # The launcher did not confirm that it stored the key: never start the worker.
                value.update(state='finished', neverStarted=True)
                durable(manifest, value)
                return 2
            if plan:
                try:
                    check_bound_files(expect)
                    fresh_config(plan['env']['CLAUDE_CONFIG_DIR'])
                except (RuntimeError, OSError):
                    value.update(state='finished', neverStarted=True)
                    durable(manifest, value)
                    return 2
        child = subprocess.Popen(command, env=env, pass_fds=(fd,) if lock_env else (), start_new_session=True,
                                 cwd=plan['cwd'] if plan else None,
                                 stdin=subprocess.PIPE if plan else subprocess.DEVNULL,
                                 stdout=subprocess.PIPE if manifest else None,
                                 stderr=subprocess.DEVNULL if manifest else None)
        if plan:
            try:
                child.stdin.write(plan['stdin'].encode('utf-8'))
                child.stdin.close()
            except OSError:
                pass  # The worker ended early; its exit status decides.
        if manifest:
            capture = Capture(child.stdout.fileno(), OUTPUT_LIMIT if plan else RESULT_LIMIT)
        started = time.monotonic()
        value.update(state='running', worker=child.pid, workerStart=start_stamp(child.pid))
        if manifest:
            durable(manifest, value)
        # Daemons are reaped normally. A run's worker is only observed until it is a zombie, so the group check
        # below runs while its PID and process group ID are still reserved.
        alive = (lambda: child.poll() is None) if not manifest else (lambda: not exited(child.pid))
        while alive():
            current = root.stat()
            if (identity.st_dev, identity.st_ino) != (current.st_dev, current.st_ino):
                cancel = True
            if manifest and (root / ('cancel-' + run_id)).exists():
                cancel = True
            if plan and time.monotonic() - started > timeout:
                cancel = True
            if cancel:
                if not value['workerStart'] or start_stamp(child.pid) != value['workerStart']:
                    raise RuntimeError('process identity uncertain')
                os.killpg(child.pid, signal.SIGTERM)
                deadline = time.monotonic() + 2
                while alive() and time.monotonic() < deadline:
                    time.sleep(0.03)
                if alive():
                    if start_stamp(child.pid) != value['workerStart']:
                        raise RuntimeError('process identity uncertain')
                    os.killpg(child.pid, signal.SIGKILL)
                    deadline = time.monotonic() + 2
                    while alive() and time.monotonic() < deadline:
                        time.sleep(0.03)
                break
            time.sleep(0.03)
        if mode in ('daemon', 'receiver'):
            return child.returncode
        # At the end and after a timeout or cancel alike: stop the whole group and see it empty, before the leader
        # is reaped. The group being empty is necessary, never sufficient: stdout EOF, a normal exit, no cancel and
        # the result checks below still decide (ISSUE50-P002).
        ended, strays = end_group(child.pid) if not alive() else (False, False)
        if not ended:
            if alive():
                stop_worker(child.pid, alive)
            value.update(state='uncertain', groupEnded=False, strays=strays)
            durable(manifest, value)
            return 2
        child.wait(timeout=5)  # reap the leader only now
        value.update(groupEnded=True, strays=strays)
        if not capture.done.wait(2):
            # A process outside the group still holds the worker's stdout: the result is not complete.
            value.update(state='uncertain', stdoutOpen=True)
            durable(manifest, value)
            return 2
        # Sign only a complete, bounded, UTF-8 result of a run whose group ended after a normal exit, not cancelled.
        raw = None
        if not cancel and child.returncode == 0 and not capture.overflow and capture.data:
            try:
                raw = bytes(capture.data).decode('utf-8')
            except UnicodeDecodeError:
                raw = None
            if raw is not None and plan:
                raw = claude_structured(raw)
        if raw is None:
            value.update(state='finished', exit=child.returncode)
            durable(manifest, value)
            return child.returncode if child.returncode != 0 else 2
        result_hash = hashlib.sha256(raw.encode('utf-8')).hexdigest()
        envelope = {'schema': 1, 'type': 'run-result', 'run': run_id, 'binding': binding,
                    'resultHash': result_hash, 'result': raw,
                    'signature': sign(seed, value['key'], signed_message(run_id, binding, result_hash))}
        write_new(signed_path, envelope)  # Never overwrites; a pre-existing file makes the run uncertain.
        value.update(state='finished', exit=0, resultHash=result_hash, signed=True)
        durable(manifest, value)
        try:
            emit(envelope)
        except (BrokenPipeError, OSError):
            pass  # The durable signed file remains; the verifier still needs the launch-recorded key.
        return 0
    except BaseException:
        if manifest:
            value.update(state='uncertain')
            try:
                durable(manifest, value)
            except OSError:
                pass
        raise
    finally:
        for i in range(len(seed)):
            seed[i] = 0
        if fd >= 0:
            os.close(fd)


def inspect(root, run_id):
    if not valid_run(run_id):
        raise RuntimeError('invalid run ID')
    path = root / ('run-' + run_id + '.json')
    if not path.exists() and not path.is_symlink():
        # No manifest: the supervisor writes it before any worker can start. If the run lock is also free,
        # nothing of this run is alive or ever ran (PR #56 red team P3).
        try:
            fd = lock(root / ('run-' + run_id + '.lock'))
        except RuntimeError:
            return {'run': run_id, 'groupEnded': False, 'allDescendants': 'unproven', 'neverStarted': False,
                    'uncertain': True, 'supervisorAlive': False, 'lockHeld': True, 'signed': False}
        os.close(fd)
        return {'run': run_id, 'groupEnded': False, 'allDescendants': 'unproven', 'neverStarted': True,
                'uncertain': False, 'supervisorAlive': False, 'lockHeld': False, 'signed': False}
    if path.is_symlink() or path.stat().st_size > 16384:
        raise RuntimeError('invalid manifest')
    value = json.loads(path.read_text())
    # Schema 1 (the descendant-lock proof) is unknown here: such a run stays uncertain.
    if value.get('schema') != 2 or value.get('run') != run_id or value.get('backend') not in ('fixture', 'claude'):
        raise RuntimeError('unknown manifest')
    live = bool(value.get('start')) and start_stamp(value.get('supervisor', -1)) == value['start']
    locked = True
    try:
        fd = lock(root / ('run-' + run_id + '.lock'))
        os.close(fd)
        locked = False
    except RuntimeError:
        pass
    done = value.get('state') == 'finished' and not locked and not live
    never = done and value.get('neverStarted') is True
    ended = done and not never and value.get('groupEnded') is True
    # 'signed' only reports the manifest; the signature itself is checked against the launch-recorded key.
    return {'run': run_id, 'groupEnded': ended, 'allDescendants': 'unproven', 'neverStarted': never,
            'uncertain': not (ended or never), 'supervisorAlive': live, 'lockHeld': locked,
            'signed': ended and value.get('signed') is True}


def redact(root, run_id, result_hash):
    """Replace a signed envelope with its hash-only form after the publication check blocked the result.

    Keeps the run, binding, result hash and signature (the signature covers only those values, so the run stays
    auditable against the launch-recorded key and is never relaunched); drops the plaintext result. Refuses while the run lock is held or when the hash does not match.
    """
    if not valid_run(run_id) or not HEX64.fullmatch(result_hash):
        raise RuntimeError('invalid redact request')
    fd = lock(root / ('run-' + run_id + '.lock'))
    try:
        path = root / ('run-' + run_id + '-result.json')
        if path.is_symlink() or not path.is_file() or path.stat().st_size > 1024 * 1024:
            raise RuntimeError('invalid signed result')
        value = json.loads(path.read_text(encoding='utf-8'))
        if value.get('run') != run_id or value.get('resultHash') != result_hash:
            raise RuntimeError('signed result does not match')
        if value.get('type') == 'run-result-redacted':
            return 0
        if (value.get('type') != 'run-result' or not HEX64.fullmatch(str(value.get('binding', '')))
                or not re.fullmatch(r'[a-f0-9]{32768}', str(value.get('signature', '')))):
            raise RuntimeError('unknown signed result')
        durable(path, {'schema': 1, 'type': 'run-result-redacted', 'run': run_id, 'binding': value['binding'],
                       'resultHash': result_hash, 'signature': value['signature']})
        return 0
    finally:
        os.close(fd)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('mode', choices=['daemon', 'receiver', 'run-fixture', 'run-worker', 'inspect', 'redact'])
    parser.add_argument('--root', required=True)
    parser.add_argument('--run', default='')
    parser.add_argument('--binding', default='')
    parser.add_argument('--result-hash', default='')
    parser.add_argument('--extract', default='')
    parser.add_argument('--timeout', type=int, default=0)
    parser.add_argument('--profile', default='')
    parser.add_argument('--profile-sha256', default='')
    parser.add_argument('--executable', default='')
    parser.add_argument('--executable-sha256', default='')
    args, command = parser.parse_known_args()
    if command and command[0] == '--':
        command = command[1:]
    try:
        root = canonical_root(args.root)
        if args.mode == 'inspect':
            print(json.dumps(inspect(root, args.run)))
            return 0
        if args.mode == 'redact':
            return redact(root, args.run, args.result_hash)
        expect = {'profile': args.profile, 'profileSha256': args.profile_sha256,
                  'executable': args.executable, 'executableSha256': args.executable_sha256}
        return run(root, args.mode, args.run, command, args.binding, args.extract, args.timeout,
                   expect if args.mode == 'run-worker' else None)
    except (RuntimeError, OSError, ValueError):
        # Never echo arbitrary command/output or keys.
        print('dispatcher supervisor unavailable or ownership uncertain', file=sys.stderr)
        return 2


if __name__ == '__main__':
    sys.exit(main())
