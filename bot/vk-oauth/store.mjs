import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

export class OAuthStore {
  constructor(path, encodedKey) {
    this.key = Buffer.from(encodedKey || '', 'hex');
    if (this.key.length !== 32 || !/^[a-f0-9]{64}$/i.test(encodedKey || ''))
      throw new Error('VK_OAUTH_ENCRYPTION_KEY must contain 64 hex characters');
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    chmodSync(path, 0o600);
    this.db.exec(
      'PRAGMA busy_timeout=5000; PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS oauth_values (key TEXT PRIMARY KEY, encrypted TEXT NOT NULL);',
    );
  }
  get(key) {
    const row = this.db.prepare('SELECT encrypted FROM oauth_values WHERE key=?').get(key);
    if (!row) return null;
    const [iv, tag, ciphertext] = row.encrypted.split('.').map((s) => Buffer.from(s, 'base64'));
    const decipher = createDecipheriv('aes-256-gcm', this.key, iv);
    decipher.setAuthTag(tag);
    return JSON.parse(Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString());
  }
  set(key, value) {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
    const encrypted = [iv, cipher.getAuthTag(), ciphertext]
      .map((b) => b.toString('base64'))
      .join('.');
    this.db
      .prepare(
        'INSERT INTO oauth_values VALUES (?,?) ON CONFLICT(key) DO UPDATE SET encrypted=excluded.encrypted',
      )
      .run(key, encrypted);
  }
  takeState(key) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const value = this.get('state:' + key);
      this.db.prepare('DELETE FROM oauth_values WHERE key=?').run('state:' + key);
      this.db.exec('COMMIT');
      return value;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  clearStates() {
    this.db.prepare("DELETE FROM oauth_values WHERE key LIKE 'state:%'").run();
  }
  close() {
    this.db.close();
  }
}
