import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export function acquireLock(path) {
  return new Promise((resolve, reject) => {
    const child = spawn('python3', [fileURLToPath(new URL('./lock.py', import.meta.url)), path], {
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    let ready = false;
    let output = '';
    const exited = new Promise((done) => child.once('exit', done));
    child.once('error', () => reject(new Error('Lock helper unavailable: install Python 3')));
    child.stdin.on('error', () => {});
    child.stdout.on('data', (data) => {
      output += data.toString();
      if (!ready && output.includes('READY')) {
        ready = true;
        resolve(async () => {
          child.stdin.end();
          await exited;
        });
      } else if (output.includes('BUSY')) {
        resolve(null);
      }
    });
    child.once('exit', () => {
      if (!ready && !output.includes('BUSY')) reject(new Error('Lock acquisition failed'));
    });
  });
}
