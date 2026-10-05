"""Hold a kernel advisory lock until the parent closes stdin (including crashes)."""
import fcntl
import os
import sys

fd = os.open(sys.argv[1], os.O_CREAT | os.O_RDWR, 0o600)
try:
    fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
except BlockingIOError:
    print('BUSY', flush=True)
    sys.exit(0)
print('READY', flush=True)
sys.stdin.buffer.read()
os.close(fd)
