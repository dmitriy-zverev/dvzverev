export const escapeHtml = (value) =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');

// Telegram counts parsed caption text, excluding markup and hidden link URLs.
export const visibleTextLength = (html) =>
  html.replace(/<[^>]*>/g, '').replace(/&(?:amp|lt|gt|quot);/g, 'x').length;

export function formatPost(post) {
  if (post?.kind === 'digest') return formatDigest(post, true);
  for (const field of ['id', 'title', 'summary', 'why', ...(post?.kind === 'tip' ? [] : ['url'])]) {
    if (typeof post?.[field] !== 'string' || !post[field].trim()) {
      throw new Error(`Post requires a nonempty ${field}`);
    }
  }
  const url = post.kind === 'tip' ? null : new URL(post.url);
  if (url && (url.protocol !== 'https:' || url.username || url.password)) {
    throw new Error('Post URL must be HTTPS without credentials');
  }
  if (post.action !== undefined && typeof post.action !== 'string') {
    throw new Error('Post action must be a string');
  }
  const blocks = [
    post.kind === 'tip' ? '💡 <b>Вайбкодинг</b>' : '📚 <b>Что почитать вайбкодерам</b>',
    `<b>${escapeHtml(post.title)}</b>`,
    escapeHtml(post.summary),
    `<b>${post.kind === 'tip' ? 'Зачем это' : 'Зачем читать'}:</b> ${escapeHtml(post.why)}`,
  ];
  if (post.action?.trim()) blocks.push(`<b>Что попробовать:</b> ${escapeHtml(post.action)}`);
  if (url) blocks.push(`<a href="${escapeHtml(url.href)}">Читать оригинал ↗</a>`);
  const html = blocks.join('\n\n');
  // Count visible text in UTF-16 units, conservatively including surrogate pairs.
  const visible = [
    post.kind === 'tip' ? '💡 Вайбкодинг' : '📚 Что почитать вайбкодерам',
    post.title,
    post.summary,
    `${post.kind === 'tip' ? 'Зачем это' : 'Зачем читать'}: ${post.why}`,
    ...(post.action?.trim() ? [`Что попробовать: ${post.action}`] : []),
    ...(url ? ['Читать оригинал ↗'] : []),
  ].join('\n\n');
  if (visible.length > 4096)
    throw new Error(`Post ${post.id} exceeds Telegram's 4096-character limit`);
  return html;
}

export function formatVkPost(post) {
  if (post?.kind === 'digest') return formatDigest(post, false);
  formatPost(post);
  return [
    post.kind === 'tip' ? '💡 Вайбкодинг' : '📚 Что почитать вайбкодерам',
    post.title,
    post.summary,
    `${post.kind === 'tip' ? 'Зачем это' : 'Зачем читать'}: ${post.why}`,
    ...(post.action?.trim() ? [`Что попробовать: ${post.action}`] : []),
    ...(post.kind === 'tip' ? [] : [`Читать оригинал ↗ ${new URL(post.url).href}`]),
  ].join('\n\n');
}

function formatDigest(post, html) {
  if (
    typeof post.id !== 'string' ||
    !post.id ||
    typeof post.title !== 'string' ||
    !post.title.trim() ||
    !Array.isArray(post.items) ||
    post.items.length < 5 ||
    post.items.length > 10
  )
    throw new Error('Invalid digest');
  const urls = new Set();
  const lines = [html ? `<b>${escapeHtml(post.title)}</b>` : post.title];
  const plain = [post.title];
  for (const [index, item] of post.items.entries()) {
    if (
      typeof item.title !== 'string' ||
      !item.title.trim() ||
      typeof item.teaser !== 'string' ||
      !item.teaser.trim() ||
      !/^\d{4}-\d{2}-\d{2}$/.test(item.date)
    )
      throw new Error('Invalid digest item');
    const url = new URL(item.url);
    if (url.protocol !== 'https:' || url.username || url.password || urls.has(url.href))
      throw new Error('Invalid digest URL');
    urls.add(url.href);
    const title = `${index + 1}. ${item.title.replace(/^Препринт:\s*/i, '')}`;
    const teaser = item.teaser.replace(/^Препринт:\s*/i, '');
    plain.push(`${title}\n\n${teaser}\n\n→ Читать источник: ${url.href}`);
    lines.push(
      html
        ? `<b>${escapeHtml(title)}</b>\n\n${escapeHtml(teaser)}\n\n→ <a href="${escapeHtml(url.href)}">Читать источник</a>`
        : plain.at(-1),
    );
  }
  if (plain.join('\n\n').length > 3900) throw new Error('Digest too long');
  return lines.join('\n\n');
}
