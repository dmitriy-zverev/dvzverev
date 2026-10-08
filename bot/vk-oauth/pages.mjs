import { randomBytes } from 'node:crypto';

// Self-contained styles: OAuth pages use a nonce CSP and cannot load cabinet assets.
export const oauthPageStyles = `    *{box-sizing:border-box}body{margin:0;padding:32px 24px;background:#f4f2ed;color:#20201e;font:16px/1.6 Arial,sans-serif;min-height:100dvh;display:grid;place-items:center}
    main{width:100%;max-width:680px;padding:40px;background:#fffefa;border:2px solid #20201e;border-radius:4px;box-shadow:6px 6px 0 #20201e}
    h1{margin:24px 0 16px;font:800 36px/1.2 'Arial Black',Arial,sans-serif;letter-spacing:-.035em}h2{font-size:20px;margin:32px 0 12px}p{color:#55554e}
    a{color:#5640ad;display:inline-flex;align-items:center;gap:8px}.oauth-icon{display:block;width:20px;height:20px;flex:0 0 20px}label{display:block;margin:24px 0 10px;font-weight:700}
    input{width:100%;min-height:52px;padding:14px;border:2px solid #20201e;border-radius:4px;background:#fff;color:#20201e;font:inherit}
    .action,button{display:inline-flex;align-items:center;justify-content:center;min-height:48px;padding:12px 20px;border:2px solid #20201e;border-radius:4px;background:#ffe36a;color:#20201e;font:700 15px/1.4 Arial,sans-serif;text-decoration:none;cursor:pointer;box-shadow:3px 3px 0 #20201e}
    button{margin-top:24px}button:disabled{opacity:.55;cursor:wait}:focus-visible{outline:3px solid #5640ad;outline-offset:4px}
    #feedback{color:#a52632;min-height:24px}small{display:block;color:#55554e;margin-top:12px}
    @media(max-width:640px){body{padding:20px 16px}main{padding:24px}h1{font-size:30px}}
`;

export function oauthIcon(name) {
  const path = name === 'left' ? 'M20 12H4m6-6-6 6 6 6' : 'M7 17 17 7M7 7h10v10';
  return `<svg class="oauth-icon" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="${path}"/></svg>`;
}

export function oauthStatusPage(title, message) {
  const nonce = randomBytes(18).toString('base64');
  const escape = (value) =>
    String(value)
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;');
  return {
    nonce,
    html: `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex,nofollow"><meta name="theme-color" content="#f4f2ed"><title>${escape(title)} · Редакционный кабинет</title><style nonce="${nonce}">${oauthPageStyles}</style></head><body><main><a href="/bot/">${oauthIcon('left')} В кабинет</a><h1>${escape(title)}</h1><p role="status">${escape(message)}</p></main></body></html>`,
  };
}
