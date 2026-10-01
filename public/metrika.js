(function (m, e, t, r, i, k, a) {
  m[i] = m[i] || function () { (m[i].a = m[i].a || []).push(arguments); };
  m[i].l = 1 * new Date();
  for (var j = 0; j < document.scripts.length; j++) {
    if (document.scripts[j].src === r) return;
  }
  k = e.createElement(t);
  a = e.getElementsByTagName(t)[0];
  k.async = 1;
  k.src = r;
  a.parentNode.insertBefore(k, a);
})(window, document, 'script', 'https://mc.yandex.ru/metrika/tag.js?id=113254290', 'ym');

window.ym(113254290, 'init', {
  ssr: true,
  webvisor: true,
  clickmap: true,
  ecommerce: 'dataLayer',
  referrer: document.referrer,
  url: location.href,
  accurateTrackBounce: true,
  trackLinks: true,
});

document.addEventListener('click', function (event) {
  const link = event.target.closest?.('a[href]');
  if (!link) return;
  if (link.href.startsWith('https://t.me/')) window.ym(113254290, 'reachGoal', 'telegram_click');
  if (link.href.startsWith('mailto:')) window.ym(113254290, 'reachGoal', 'email_click');
});
document.addEventListener('submit', function (event) {
  if (event.target.matches('form[action^="https://t.me/"]')) {
    window.ym(113254290, 'reachGoal', 'telegram_draft');
  }
});
