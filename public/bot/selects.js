import { icon } from './icons.js';
let opened;
let sequence = 0;
document.addEventListener('click', (event) => {
  if (opened && !opened.wrapper.contains(event.target)) opened.close();
});

export function enhanceSelects(root) {
  root.querySelectorAll('select:not([data-custom])').forEach((select) => {
    select.dataset.custom = 'true';
    const label = select.labels[0];
    const name =
      select.getAttribute('aria-label') ||
      [...(label?.childNodes || [])]
        .filter((node) => node.nodeType === Node.TEXT_NODE)
        .map((node) => node.textContent)
        .join('')
        .trim();
    const wrapper = document.createElement('div');
    wrapper.className = 'custom-select';
    select.before(wrapper);
    wrapper.append(select);
    select.hidden = true;
    const trigger = document.createElement('button');
    trigger.type = 'button';
    trigger.className = 'custom-select-trigger';
    trigger.setAttribute('role', 'combobox');
    trigger.setAttribute('aria-label', name);
    trigger.setAttribute('aria-haspopup', 'listbox');
    if (select.required) trigger.setAttribute('aria-required', 'true');
    trigger.setAttribute('aria-expanded', 'false');
    trigger.disabled = select.disabled;
    const value = document.createElement('span');
    trigger.append(value);
    trigger.insertAdjacentHTML('beforeend', icon('down'));
    label?.addEventListener('click', (event) => {
      if (event.target === label) {
        event.preventDefault();
        trigger.focus();
      }
    });
    const menu = document.createElement('div');
    menu.className = 'custom-select-menu';
    menu.id = `select-menu-${++sequence}`;
    menu.setAttribute('role', 'listbox');
    menu.setAttribute('aria-label', name);
    menu.hidden = true;
    trigger.setAttribute('aria-controls', menu.id);
    wrapper.append(trigger, menu);
    let index = select.selectedIndex;
    let search = '',
      lastKey = 0;
    const options = [...select.options].map((option, i) => {
      const row = document.createElement('div');
      row.className = 'custom-select-option';
      row.id = `${menu.id}-${i}`;
      row.setAttribute('role', 'option');
      row.setAttribute('aria-disabled', String(option.disabled));
      row.textContent = option.text;
      row.insertAdjacentHTML('beforeend', icon('check'));
      row.onmousedown = (event) => event.preventDefault();
      row.onclick = (event) => {
        event.preventDefault();
        if (!option.disabled) choose(i);
      };
      menu.append(row);
      return row;
    });
    function highlight(i) {
      index = i;
      options.forEach((row, n) => row.classList.toggle('is-active', n === i));
      if (!menu.hidden) trigger.setAttribute('aria-activedescendant', options[i]?.id || '');
    }
    function sync() {
      value.textContent = select.selectedOptions[0]?.text || 'Выберите значение';
      options.forEach((row, i) =>
        row.setAttribute('aria-selected', String(i === select.selectedIndex)),
      );
      highlight(select.selectedIndex);
    }
    function close() {
      menu.hidden = true;
      trigger.setAttribute('aria-expanded', 'false');
      trigger.removeAttribute('aria-activedescendant');
      if (opened?.wrapper === wrapper) opened = null;
    }
    function open() {
      opened?.close();
      menu.hidden = false;
      trigger.setAttribute('aria-expanded', 'true');
      opened = { wrapper, close };
      highlight(select.selectedIndex);
    }
    function choose(i) {
      select.selectedIndex = i;
      close();
      sync();
      trigger.focus({ preventScroll: true });
      select.dispatchEvent(new Event('input', { bubbles: true }));
      select.dispatchEvent(new Event('change', { bubbles: true }));
    }
    trigger.onclick = () => (menu.hidden ? open() : close());
    trigger.onkeydown = (event) => {
      const key = event.key;
      if (key === 'Tab') {
        close();
        return;
      }
      if (key === 'Escape' && !menu.hidden) {
        event.preventDefault();
        event.stopPropagation();
        close();
        return;
      }
      if (['ArrowDown', 'ArrowUp', 'Home', 'End', 'Enter', ' '].includes(key)) {
        event.preventDefault();
        if (menu.hidden) {
          open();
          return;
        }
        if (key === 'Enter' || key === ' ') {
          if (!select.options[index]?.disabled) choose(index);
          return;
        }
        const step = key === 'ArrowUp' || key === 'End' ? -1 : 1;
        let next = key === 'Home' ? 0 : key === 'End' ? options.length - 1 : index + step;
        while (select.options[next]?.disabled) next += step;
        if (next >= 0 && next < options.length) {
          highlight(next);
          options[next].scrollIntoView({ block: 'nearest' });
        }
      } else if (key.length === 1 && !event.ctrlKey && !event.metaKey) {
        event.preventDefault();
        if (menu.hidden) open();
        search = Date.now() - lastKey > 700 ? key : search + key;
        lastKey = Date.now();
        const next = [...select.options].findIndex(
          (option) =>
            !option.disabled &&
            option.text.toLocaleLowerCase().startsWith(search.toLocaleLowerCase()),
        );
        if (next >= 0) highlight(next);
      }
    };
    wrapper.addEventListener('focusout', (event) => {
      if (!wrapper.contains(event.relatedTarget)) close();
    });
    select.addEventListener('change', sync);
    select.addEventListener('invalid', (event) => {
      event.preventDefault();
      trigger.focus();
      open();
    });
    select.form?.addEventListener('reset', () => queueMicrotask(sync));
    sync();
  });
}
