// Read-only setup check. Never logs API URLs or raw errors containing the token.
let step = 'configuration';
let reason = 'missing token or channel';
try {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) throw new Error('Missing configuration');
  const call = async (method, parameters = {}) => {
    step = method;
    reason = 'network failure or invalid response';
    const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(15_000),
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(parameters),
    });
    const body = await response.json();
    if (!response.ok || body.ok !== true) {
      reason = `HTTP ${response.status}; Telegram code ${Number.isInteger(body.error_code) ? body.error_code : 'unknown'}`;
      for (const known of [
        'user not found',
        'chat not found',
        'member list is inaccessible',
        'bot is not a member',
      ]) {
        if (typeof body.description === 'string' && body.description.toLowerCase().includes(known))
          reason += `; ${known}`;
      }
      throw new Error('Telegram rejected setup check');
    }
    return body.result;
  };
  const me = await call('getMe');
  console.log(`Authenticated bot: @${me.username}`);
  const chat = await call('getChat', { chat_id: chatId });
  const member = await call('getChatMember', { chat_id: chatId, user_id: me.id });
  const allowed =
    chat.type === 'channel' &&
    (member.status === 'creator' ||
      (member.status === 'administrator' && member.can_post_messages === true));
  console.log(`Bot: @${me.username}; channel: ${chatId}; can publish: ${allowed}`);
  if (!allowed) process.exitCode = 1;
} catch {
  console.error(
    `Telegram setup check failed at ${step}: ${reason}. Check token, channel and bot administrator permissions.`,
  );
  process.exitCode = 1;
}
