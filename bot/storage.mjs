import { open, rename, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

// Flush both contents and the rename before performing an external side effect.
export async function writeAtomic(path, value) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  let file;
  try {
    file = await open(temporary, 'wx', 0o600);
    await file.writeFile(JSON.stringify(value) + '\n');
    await file.sync();
    await file.close();
    file = null;
    await rename(temporary, path);
    const directory = await open(dirname(path), 'r');
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } finally {
    if (file) await file.close();
    await rm(temporary, { force: true });
  }
}
