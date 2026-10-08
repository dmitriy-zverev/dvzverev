import test from 'node:test';
import assert from 'node:assert/strict';
import { oauthStatusPage } from '../../bot/vk-oauth/pages.mjs';

test('OAuth status content is escaped while its nonce authorizes only its own styles', () => {
  const page = oauthStatusPage('<script>unsafe</script>', '<img src=x onerror=alert(1)>');
  assert.match(page.nonce, /^[A-Za-z0-9+/]+$/);
  assert.ok(page.html.includes(`<style nonce="${page.nonce}">`));
  assert.ok(page.html.includes('&lt;script&gt;unsafe&lt;/script&gt;'));
  assert.ok(page.html.includes('&lt;img src=x onerror=alert(1)&gt;'));
  assert.ok(!page.html.includes('<img src=x'));
  assert.ok(page.html.includes('role="status"'));
  assert.notEqual(page.nonce, oauthStatusPage('Следующая страница', '').nonce);
});
