import { icon } from './icons.js';
export function createOzonComposer({ api, apiBase, escapeText, projectTitle }) {
  let dialog = null;
  let timer = null;
  let objectUrl = null;
  let post = null;
  let busy = false;
  let requestId = null;
  const esc = escapeText;
  const statusLabels = {
    generating: 'Готовим текст и фото…',
    regenerating: 'Генерируем новый вариант изображения…',
    ready: 'Готов к проверке',
    publishing: 'Публикуем…',
    sent: 'Опубликован',
    uncertain: 'Проверьте стену VK',
    failed: 'Подготовка не завершена',
    blocked: 'Текст не прошёл проверку',
  };
  function close() {
    clearTimeout(timer);
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    objectUrl = null;
    dialog?.remove();
    dialog = null;
    post = null;
    busy = false;
  }
  function notify(message, error = false) {
    const node = dialog?.querySelector('#ozon-notice');
    if (!node) return;
    node.textContent = message;
    node.setAttribute('role', error ? 'alert' : 'status');
  }
  function readFile(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve({ name: file.name, data: reader.result });
      reader.onerror = () => reject(new Error('Не удалось прочитать изображение.'));
      reader.readAsDataURL(file);
    });
  }
  async function updatePreview(next) {
    if (!dialog) return;
    const previousId = post?.id;
    const previousImageId = post?.imageId;
    post = next;
    requestId = null;
    dialog.querySelector('#ozon-create').hidden = true;
    const preview = dialog.querySelector('#ozon-preview');
    preview.hidden = false;
    preview.innerHTML = `<h3>${esc(post.input.name)}</h3>
      <p class="meta">${esc(projectTitle(post.input.projectId))} · ${esc(statusLabels[post.status] || post.status)}</p>
      ${post.error ? `<p role="alert">${esc(post.error)}</p>` : ''}
      ${post.status === 'ready' && !post.input.markingUrl ? '<p role="alert">В этом старом черновике не указана отдельная маркировочная ссылка. Создайте новый рекламный пост со ссылкой из задания Ozon.</p>' : ''}
      ${post.message ? `<pre class="ozon-post-text">${esc(post.message)}</pre><p class="meta">${post.message.length} / 7000 символов, включая ссылки и маркировку</p>` : ''}
      ${['ready', 'regenerating', 'publishing', 'sent', 'uncertain'].includes(post.status) ? '<img id="ozon-photo" class="ozon-photo" alt="Сгенерированное рекламное фото товара" />' : ''}
      ${post.status === 'ready' && post.imageStyle ? '<button type="button" id="ozon-regenerate">Перегенерировать изображение</button><p class="meta">Новый вариант в стиле группы по исходным референсам. Текст и маркировка сохраняются.</p>' : ''}
      ${post.status === 'ready' && post.input.markingUrl ? `<form id="ozon-publish"><label class="ozon-check"><input type="checkbox" name="reviewed" required /> Проверил текст и сходство товара на фото, права на референсы, категорию и дисклеймеры, соответствие площадки правилам, товарную ссылку и маркировку Ozon для этого задания.</label><button type="submit">Опубликовать в VK</button></form>` : ''}
      ${post.url ? `<a href="${esc(post.url)}" target="_blank" rel="noopener noreferrer">Открыть публикацию в VK ${icon('external')}</a>` : ''}
      ${!['generating', 'regenerating', 'publishing'].includes(post.status) ? '<button type="button" id="ozon-new">Новый рекламный пост</button>' : '<p class="meta" role="status">Можно закрыть окно. Результат сохранится в кабинете.</p>'}`;
    if (
      objectUrl &&
      previousId === post.id &&
      previousImageId === post.imageId &&
      preview.querySelector('#ozon-photo')
    ) {
      preview.querySelector('#ozon-photo').src = objectUrl;
    } else if (preview.querySelector('#ozon-photo')) {
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      objectUrl = null;
      const activeId = post.id;
      const activeImageId = post.imageId;
      try {
        const response = await fetch(`${apiBase}/bot/api/v1/ozon/posts/${activeId}/image`, {
          credentials: 'include',
        });
        if (!response.ok) throw new Error();
        const blob = await response.blob();
        if (
          !dialog ||
          post?.id !== activeId ||
          post.imageId !== activeImageId ||
          !preview.isConnected
        )
          return;
        objectUrl = URL.createObjectURL(blob);
        preview.querySelector('#ozon-photo').src = objectUrl;
      } catch {
        if (dialog && post?.id === activeId) {
          preview.querySelector('#ozon-photo')?.remove();
          preview.querySelector('#ozon-publish button')?.setAttribute('disabled', '');
          notify('Не удалось загрузить фото. Откройте черновик заново перед публикацией.', true);
        }
      }
    }
    preview.querySelector('#ozon-new')?.addEventListener('click', () => {
      post = null;
      preview.hidden = true;
      dialog.querySelector('#ozon-create').hidden = false;
      dialog.querySelector('#ozon-create').elements.markingUrl.value = '';
      dialog.querySelector('#ozon-name').focus();
      notify('');
    });
    preview.querySelector('#ozon-regenerate')?.addEventListener('click', async (event) => {
      if (busy) return;
      busy = true;
      event.currentTarget.disabled = true;
      preview.querySelector('#ozon-publish button')?.setAttribute('disabled', '');
      try {
        const result = await api(`/bot/api/v1/ozon/posts/${post.id}/regenerate-image`, {
          method: 'POST',
          body: JSON.stringify({ version: post.version }),
        });
        await updatePreview(result.post);
      } catch (error) {
        notify(error.message, true);
        try {
          await updatePreview((await api(`/bot/api/v1/ozon/posts/${post.id}`)).post);
        } catch {
          /* Reopen to check server status before another action. */
        }
      } finally {
        busy = false;
      }
    });
    preview.querySelector('#ozon-publish')?.addEventListener('submit', async (event) => {
      event.preventDefault();
      if (busy) return;
      busy = true;
      const button = event.currentTarget.querySelector('button');
      button.disabled = true;
      button.textContent = 'Публикуем…';
      try {
        const result = await api(`/bot/api/v1/ozon/posts/${post.id}/publish`, {
          method: 'POST',
          body: JSON.stringify({ reviewed: true, version: post.version }),
        });
        await updatePreview(result.post);
      } catch (error) {
        notify(error.message, true);
        // Reload server status before allowing another wall.post after a lost HTTP reply.
        try {
          await updatePreview((await api(`/bot/api/v1/ozon/posts/${post.id}`)).post);
        } catch {
          button.textContent = 'Откройте черновик заново для проверки';
        }
      } finally {
        busy = false;
      }
    });
    clearTimeout(timer);
    if (['generating', 'regenerating', 'publishing'].includes(post.status)) {
      const activeId = post.id;
      timer = setTimeout(async () => {
        try {
          const result = await api(`/bot/api/v1/ozon/posts/${activeId}`);
          if (dialog && post?.id === activeId) await updatePreview(result.post);
        } catch (error) {
          notify(error.message + ' Откройте черновик заново.', true);
        }
      }, 2500);
    }
  }
  async function open() {
    if (dialog) {
      dialog.focus();
      return;
    }
    dialog = document.createElement('dialog');
    dialog.className = 'ozon-dialog';
    dialog.setAttribute('aria-labelledby', 'ozon-title');
    dialog.innerHTML = `<header class="ozon-head"><h2 id="ozon-title">Выпустить рекламный пост</h2><button type="button" id="ozon-close" aria-label="Закрыть рекламу">${icon('close')}</button></header><p id="ozon-notice" role="status">Загружаем настройки…</p><div id="ozon-content"></div>`;
    document.body.append(dialog);
    dialog.showModal();
    dialog.querySelector('#ozon-close').onclick = close;
    dialog.addEventListener('cancel', (event) => {
      event.preventDefault();
      close();
    });
    try {
      const [data, history] = await Promise.all([
        api('/bot/api/v1/ozon/settings'),
        api('/bot/api/v1/ozon/posts'),
      ]);
      if (!dialog) return;
      dialog.querySelector('#ozon-content').innerHTML = `
        <details class="ozon-settings"><summary>Наши правила</summary><form id="ozon-settings">
          <label>Наши дополнительные правила<textarea name="extraRules" maxlength="8000">${esc(data.settings.extraRules)}</textarea></label>
          <p class="meta">Правила сохраняются для следующих постов. Маркировочную ссылку нужно указывать заново для каждого поста. Правила Ozon: редакция от ${esc(data.rulesDate)} из присланного документа. <a href="https://blogger-help.ozon.ru/moderaciya-i-pravila" target="_blank" rel="noopener noreferrer">Проверить актуальные требования ${icon('external')}</a></p>
          <button type="submit">Сохранить настройки</button></form></details>
        <form id="ozon-create" class="ozon-form">
          <label>Сообщество<select name="projectId" required>${data.projects.map((p) => `<option value="${esc(p.id)}" ${p.id === 'things' ? 'selected' : ''}>${esc(projectTitle(p.id))}</option>`).join('')}</select></label>
          <label>Реферальная ссылка на товар<input name="referralUrl" type="url" placeholder="https://s.ozon.ru/…" maxlength="2048" required /></label>
          <label class="ozon-wide">Ссылка на рекламодателей для этого поста<input name="markingUrl" type="url" placeholder="https://s.ozon.ru/…" maxlength="2048" required /><span class="meta">Из текущего задания Ozon. В конце добавим: «Реклама. Информация о рекламодателях по ссылке …»</span></label>
          <label>Название товара<input id="ozon-name" name="name" maxlength="250" required /></label>
          <label>Категория<select name="category">${Object.entries(data.categories)
            .map(([id, c]) => `<option value="${esc(id)}">${esc(c.label)}</option>`)
            .join('')}</select></label>
          <label class="ozon-wide">Подтверждённые характеристики товара<textarea name="facts" maxlength="6000" required placeholder="Скопируйте из карточки товара: материал, размеры, комплектацию. Цены и скидки — только актуальные."></textarea></label>
          <label class="ozon-wide">Обязательные сведения для особой категории<textarea name="details" maxlength="4000" placeholder="Возраст для детского питания или 0+/6+/12+/16+/18+ для информационной продукции; показания из инструкции; для акции или лотереи — сроки и источник полных условий."></textarea></label>
          <label class="ozon-wide">Пожелания к тексту и фото<textarea name="brief" maxlength="3000" placeholder="Какой бытовой сценарий показать, какое настроение передать"></textarea></label>
          <label class="ozon-wide">Фото товара и референсы<input name="references" type="file" accept="image/png,image/jpeg,image/webp" multiple required /><span class="meta">От 1 до 4 фото. До 2 МБ каждое, до 6 МБ суммарно. Первый референс — сам товар.</span></label>
          <div id="ozon-references" class="ozon-wide ozon-references"></div>
          <p class="meta ozon-wide">Обе ссылки относятся к текущему заданию Ozon. После подготовки будут доступны текст и фото; публикация — отдельной кнопкой.</p>
          <button type="submit" class="ozon-wide" ${data.projects.length ? '' : 'disabled'}>Подготовить рекламный пост</button>
        </form>
        <section id="ozon-preview" hidden aria-label="Предпросмотр рекламного поста"></section>
        <details class="ozon-history"><summary>Сохранённые рекламные посты · ${history.items.length}</summary><div>${history.items.map((p) => `<button type="button" data-ozon-post="${esc(p.id)}">${esc(p.input.name)} · ${esc(statusLabels[p.status] || p.status)}</button>`).join('') || '<p class="meta">Пока нет постов</p>'}</div></details>`;
      notify(
        data.projects.length ? '' : 'Нет доступных сообществ VK. Проверьте настройки проекта.',
        !data.projects.length,
      );
      dialog.querySelector('#ozon-settings').onsubmit = async (event) => {
        event.preventDefault();
        const form = event.currentTarget;
        const button = form.querySelector('button');
        button.disabled = true;
        try {
          await api('/bot/api/v1/ozon/settings', {
            method: 'POST',
            body: JSON.stringify(Object.fromEntries(new FormData(form))),
          });
          notify('Правила сохранены.');
        } catch (error) {
          notify(error.message, true);
        } finally {
          button.disabled = false;
        }
      };
      const form = dialog.querySelector('#ozon-create');
      form.elements.category.onchange = () => {
        form.elements.details.required = form.elements.category.value !== 'ordinary';
      };
      form.elements.references.onchange = async () => {
        const files = [...form.elements.references.files];
        const list = dialog.querySelector('#ozon-references');
        list.replaceChildren();
        if (
          files.length > 4 ||
          files.some((f) => f.size > 2 * 1024 * 1024) ||
          files.reduce((sum, f) => sum + f.size, 0) > 6 * 1024 * 1024
        ) {
          form.elements.references.value = '';
          notify('Добавьте до 4 фото, до 2 МБ каждое и до 6 МБ суммарно.', true);
          return;
        }
        for (const file of files) {
          const ref = await readFile(file);
          const figure = document.createElement('figure');
          const img = document.createElement('img');
          img.src = ref.data;
          img.alt = file.name;
          const caption = document.createElement('figcaption');
          caption.textContent = file.name;
          figure.append(img, caption);
          list.append(figure);
        }
      };
      form.addEventListener('input', () => {
        requestId = null;
      });
      form.onsubmit = async (event) => {
        event.preventDefault();
        if (busy) return;
        busy = true;
        const button = form.querySelector('button[type="submit"]');
        button.disabled = true;
        notify('Передаём товар и референсы…');
        requestId ||= crypto.randomUUID();
        try {
          const input = Object.fromEntries(new FormData(form));
          input.requestId = requestId;
          input.references = await Promise.all([...form.elements.references.files].map(readFile));
          const result = await api('/bot/api/v1/ozon/posts', {
            method: 'POST',
            body: JSON.stringify(input),
          });
          notify('');
          await updatePreview(result.post);
        } catch (error) {
          notify(error.message, true);
        } finally {
          button.disabled = false;
          busy = false;
        }
      };
      dialog.querySelectorAll('[data-ozon-post]').forEach((node) => {
        node.onclick = async () => {
          if (busy) return;
          try {
            await updatePreview(
              (await api(`/bot/api/v1/ozon/posts/${node.dataset.ozonPost}`)).post,
            );
          } catch (error) {
            notify(error.message, true);
          }
        };
      });
      const running = history.items.find((p) =>
        ['generating', 'regenerating', 'publishing'].includes(p.status),
      );
      if (running) await updatePreview(running);
    } catch (error) {
      notify(error.message, true);
    }
  }
  return { open, close };
}
