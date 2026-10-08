import { enhanceSelects } from './selects.js';
let active = null;
const focusable =
  'button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), summary, [tabindex="0"]';
export function resizeFields(root = document) {
  enhanceSelects(root);
  root.querySelectorAll('textarea').forEach((field) => {
    if (!field.getClientRects().length) return;
    field.style.height = 'auto';
    field.style.height = `${Math.max(120, field.scrollHeight + 4)}px`;
  });
}
export function openPanel(element, onClose) {
  if (active?.element === element) return;
  const returnFocus = document.activeElement;
  const returnY = window.scrollY;
  const parent = element.parentNode;
  const next = element.nextSibling;
  const page = document.createElement('div');
  page.className = 'cabinet cabinet-dialog-page';
  document.body.append(page);
  page.append(element);
  document.body.classList.add('cabinet-panel-open');
  document.getElementById('app').inert = true;
  if (element instanceof HTMLDialogElement) {
    element.setAttribute('aria-modal', 'true');
    element.show();
  }
  const keydown = (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      onClose();
    }
    if (event.key !== 'Tab') return;
    const fields = [...element.querySelectorAll(focusable)].filter(
      (field) => field.getClientRects().length,
    );
    const first = fields[0],
      last = fields.at(-1);
    if (
      (event.shiftKey && document.activeElement === first) ||
      (!event.shiftKey && document.activeElement === last)
    ) {
      event.preventDefault();
      (event.shiftKey ? last : first)?.focus();
    }
  };
  const input = () => resizeFields(element);
  const observer = new MutationObserver(input);
  observer.observe(element, { childList: true, subtree: true });
  element.addEventListener('input', input);
  element.addEventListener('toggle', input, true);
  document.addEventListener('keydown', keydown);
  active = { element, page, parent, next, returnFocus, returnY, keydown, observer, input };
  window.scrollTo(0, 0);
  resizeFields(element);
  element.querySelector(focusable)?.focus({ preventScroll: true });
}
export function closePanel(element) {
  if (!active || active.element !== element) return;
  const saved = active;
  active = null;
  saved.observer.disconnect();
  element.removeEventListener('input', saved.input);
  element.removeEventListener('toggle', saved.input, true);
  document.removeEventListener('keydown', saved.keydown);
  if (element instanceof HTMLDialogElement) element.close();
  if (saved.parent?.isConnected)
    saved.parent.insertBefore(element, saved.next?.parentNode === saved.parent ? saved.next : null);
  else element.remove();
  saved.page.remove();
  document.body.classList.remove('cabinet-panel-open');
  document.getElementById('app').inert = false;
  window.scrollTo(0, saved.returnY);
  (saved.returnFocus?.isConnected
    ? saved.returnFocus
    : document.querySelector('.slot, .cabinet-tab')
  )?.focus({ preventScroll: true });
}
