const days = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];
const mediaLabels = { text: 'Текст', image: 'Фото', video: 'Короткое видео' };
const rubricCount = (count) =>
  `${count} ${count % 100 >= 11 && count % 100 <= 14 ? 'рубрик' : count % 10 === 1 ? 'рубрика' : count % 10 >= 2 && count % 10 <= 4 ? 'рубрики' : 'рубрик'}`;
const messages = {
  rubric_schedule_conflict:
    'В это время уже выходит другая рубрика этой группы. Выберите другое время или день.',
  rubric_version_conflict: 'Рубрика уже изменилась. Закройте окно и откройте её заново.',
  rubric_preparation_busy:
    'Сейчас готовятся публикации или есть запись с неизвестным результатом. Дождитесь подготовки и проверьте отложенные VK.',
  vk_login_required: 'Чтобы отменить подготовленные записи, сначала войдите в VK.',
  rubric_post_already_public:
    'Одна из записей уже появилась на стене VK. Обновите календарь перед повторной попыткой.',
  rubric_invalid: 'Укажите название, хотя бы один день и время в формате 18:00.',
  rubric_prompt_too_long: 'Каждый дополнительный промпт должен быть не длиннее 6000 символов.',
};

export function createRubricManager({ api, escapeText: esc, refresh, apiBase, selectProject }) {
  let dialog = null;
  let saving = false;
  const safeColor = (value) => (/^#[a-f0-9]{6}$/i.test(value || '') ? value : '#806bba');
  function render(data, projectId) {
    const groups = (data.projects || []).filter((p) => !projectId || p.id === projectId);
    return `<section class="rubrics-workspace" aria-labelledby="rubrics-title">
      <div class="rubrics-intro"><div><p class="weekly-eyebrow">Редакционный ритм</p><h1 id="rubrics-title">Рубрики</h1><p>Свой голос и расписание для каждой группы.<br>Системный стиль группы сохраняется во всех публикациях.</p></div>
      <div class="rubric-page-actions"><select id="rubrics-group-filter" aria-label="Группа рубрик"><option value="">Все группы</option>${data.projects.map((p) => `<option value="${esc(p.id)}" ${p.id === projectId ? 'selected' : ''}>${esc(p.title)}</option>`).join('')}</select><button type="button" id="refresh">Обновить</button><button type="button" class="weekly-primary" id="rubric-create">+ Новая рубрика</button></div></div>
      <div class="rubrics-guidance"><span>01 · Расписание</span><span>02 · Текст и визуальный стиль</span><span>03 · Подготовка медиа раз в неделю</span></div>
      ${groups
        .map((p) => {
          const rubrics = (data.rubrics || []).filter((r) => r.projectId === p.id);
          return `<section class="rubric-group"><div class="rubric-group-heading"><h2>${esc(p.title)}</h2><span>${rubricCount(rubrics.length)} · время Москвы</span><button type="button" data-rubric-create="${esc(p.id)}">+ Добавить</button></div>
          <div class="rubric-list">${
            rubrics.length
              ? rubrics
                  .map(
                    (
                      r,
                    ) => `<article class="rubric-card" style="--rubric-color:${safeColor(r.color)}">
            <div class="rubric-card-heading"><span class="rubric-dot" aria-hidden="true"></span><h3>${esc(r.name)}</h3><span class="rubric-media">${mediaLabels[r.media]}</span></div>
            <p class="rubric-rhythm">${r.days.map((d) => days[d - 1]).join(' · ')}<strong>${r.times.map(esc).join(' / ')}</strong></p>
            <p class="rubric-description">${esc(r.textPrompt || 'Стиль и правила из системного промпта группы')}</p>
            <div class="rubric-card-footer"><span>${r.pending ? 'Отмена записей не завершена' : r.enabled ? (r.media === 'text' ? 'Выходит по расписанию' : 'Недельная подготовка в VK') : 'На паузе'}</span><button type="button" data-rubric-edit="${esc(r.id)}">${r.pending ? 'Продолжить' : 'Настроить'} →</button></div>
          </article>`,
                  )
                  .join('')
              : '<p class="rubric-empty">Расписание свободно. Добавьте первую рубрику для этой группы.</p>'
          }</div></section>`;
        })
        .join('')}
    </section>`;
  }
  function close() {
    if (saving) return;
    dialog?.close();
    dialog?.remove();
    dialog = null;
  }
  function open(data, rubric = null, projectId = '') {
    close();
    const r = rubric || {
      name: '',
      color: '#806bba',
      days: [1, 2, 3, 4, 5],
      times: ['12:00'],
      media: 'text',
      enabled: true,
      textPrompt: '',
      mediaPrompt: '',
      projectId,
    };
    dialog = document.createElement('dialog');
    dialog.className = 'rubric-dialog';
    dialog.setAttribute('aria-labelledby', 'rubric-dialog-title');
    dialog.innerHTML = `<form id="rubric-form"><div class="rubric-dialog-head"><div><p class="weekly-eyebrow">${rubric ? 'Настройки рубрики' : 'Новая рубрика'}</p><h2 id="rubric-dialog-title">${rubric ? esc(r.name) : 'Задайте ритм публикаций'}</h2></div><button type="button" id="rubric-close" aria-label="Закрыть">×</button></div>
      <div class="rubric-fields"><label>Группа<select name="projectId" ${rubric ? 'disabled' : ''}>${data.projects.map((p) => `<option value="${esc(p.id)}" ${p.id === r.projectId ? 'selected' : ''}>${esc(p.title)}</option>`).join('')}</select></label>
      <div class="rubric-name-row"><label>Название<input name="name" required maxlength="80" value="${esc(r.name)}" placeholder="Например, вещи с историей"></label><label>Цвет<input type="color" name="color" value="${safeColor(r.color)}"></label></div>
      <fieldset class="rubric-days"><legend>Дни публикации</legend>${days.map((d, i) => `<label><input type="checkbox" name="day" value="${i + 1}" ${r.days.includes(i + 1) ? 'checked' : ''}><span>${d}</span></label>`).join('')}</fieldset>
      <label>Время публикации · Москва<input name="times" required value="${esc(r.times.join(', '))}" placeholder="10:00, 18:00"><span class="meta">Несколько времён можно указать через запятую.</span></label>
      <label>Формат<select name="media">${Object.entries(mediaLabels)
        .map(
          ([key, label]) =>
            `<option value="${key}" ${r.media === key ? 'selected' : ''}>${label}</option>`,
        )
        .join('')}</select></label>
      <div class="rubric-media-note" id="rubric-media-note"><strong>Медиа готовятся на неделю вперёд</strong><p>На вкладке «Неделя» войдите в VK и запустите подготовку. Фото и короткие видео сохраняются в отложенные записи. Пропуски текущей недели можно дополнить отдельно.</p><a href="${esc(apiBase)}/vk/legacy/login">Подключить VK ↗</a></div>
      <label>Дополнительный промпт для текста<textarea name="textPrompt" rows="5" maxlength="6000" placeholder="О чём эта рубрика, подача, структура, ограничения…">${esc(r.textPrompt)}</textarea><span class="meta">Дополняет системный промпт группы.</span></label>
      <label>Дополнительный промпт для фото и видео · необязательно<textarea name="mediaPrompt" rows="4" maxlength="6000" placeholder="Сюжеты, композиция, настроение, движение камеры…">${esc(r.mediaPrompt)}</textarea><span class="meta">Без него используется визуальный стиль группы.</span></label>
      <label class="rubric-enabled"><input type="checkbox" name="enabled" ${r.enabled ? 'checked' : ''}> Рубрика активна</label>
      <p class="rubric-change-note">Изменения применяются к ещё не вышедшим постам. Подготовленные отложенные записи отменяются; медиа понадобится подготовить заново. Опубликованные посты сохраняются.</p>
      <p class="rubric-error" role="alert" id="rubric-error"></p></div>
      <div class="rubric-dialog-footer">${rubric ? '<button type="button" class="rubric-delete" id="rubric-delete">Удалить рубрику</button>' : '<span></span>'}<button class="weekly-primary" type="submit">${rubric?.pending ? (rubric.pendingAction === 'delete' ? 'Завершить удаление' : 'Продолжить сохранение') : 'Сохранить рубрику'}</button></div>
      <div class="rubric-delete-confirm" id="rubric-delete-confirm" hidden><strong>Удалить рубрику «${esc(r.name)}»?</strong><p>Все её посты исчезнут из календаря. Будущие отложенные записи VK будут отменены. Уже опубликованные посты останутся на стене VK.</p><button type="button" id="rubric-delete-back">Вернуться</button><button type="button" class="rubric-delete" id="rubric-delete-submit">Удалить рубрику и посты</button></div>
    </form>`;
    document.body.append(dialog);
    dialog.showModal();
    dialog.addEventListener('cancel', (e) => {
      e.preventDefault();
      close();
    });
    dialog.querySelector('#rubric-close').onclick = close;
    const form = dialog.querySelector('form');
    if (rubric?.pending)
      form.querySelectorAll('input,select,textarea').forEach((node) => {
        node.disabled = true;
      });
    const note = dialog.querySelector('#rubric-media-note');
    const media = form.elements.namedItem('media');
    const syncNote = () => {
      note.hidden = media.value === 'text';
    };
    syncNote();
    media.onchange = syncNote;
    async function save(remove = false) {
      if (saving) return;
      const values = new FormData(form);
      const body = rubric?.pending
        ? { ...r }
        : {
            projectId: r.projectId || values.get('projectId'),
            revision: r.revision,
            name: values.get('name'),
            color: values.get('color'),
            days: values.getAll('day').map(Number),
            times: String(values.get('times'))
              .split(',')
              .map((t) => t.trim())
              .filter(Boolean),
            media: values.get('media'),
            textPrompt: values.get('textPrompt'),
            mediaPrompt: values.get('mediaPrompt'),
            enabled: values.has('enabled'),
          };
      saving = true;
      dialog.setAttribute('aria-busy', 'true');
      dialog.querySelectorAll('button').forEach((b) => {
        b.disabled = true;
      });
      const controls = [...form.querySelectorAll('input,select,textarea')].map((node) => [
        node,
        node.disabled,
      ]);
      controls.forEach(([node]) => {
        node.disabled = true;
      });
      dialog.querySelector('#rubric-error').textContent = '';
      try {
        const response = await api(`/bot/api/v1/rubrics${rubric ? '/' + rubric.id : ''}`, {
          method: remove ? 'DELETE' : rubric ? 'PATCH' : 'POST',
          body: JSON.stringify(body),
        });
        saving = false;
        close();
        await refresh({ id: rubric?.id, removed: response.result?.removed ?? remove });
      } catch (error) {
        if (error.status === 401) {
          saving = false;
          close();
          await refresh();
          return;
        }
        if (!dialog) return;
        dialog.querySelector('#rubric-error').textContent =
          messages[error.body?.error] ||
          'Изменение не завершено. Рубрика остановлена на время отмены записей. Повторите попытку; готовые записи повторно не отправляются.';
        dialog.querySelector('#rubric-delete-confirm').hidden = true;
      } finally {
        saving = false;
        if (dialog) {
          dialog.removeAttribute('aria-busy');
          dialog.querySelectorAll('button').forEach((b) => {
            b.disabled = false;
          });
          controls.forEach(([node, disabled]) => {
            node.disabled = disabled;
          });
        }
      }
    }
    form.onsubmit = (event) => {
      event.preventDefault();
      save(rubric?.pendingAction === 'delete');
    };
    dialog.querySelector('#rubric-delete')?.addEventListener('click', () => {
      dialog.querySelector('#rubric-delete-confirm').hidden = false;
      dialog.querySelector('#rubric-delete-submit').focus();
    });
    dialog.querySelector('#rubric-delete-back').onclick = () => {
      dialog.querySelector('#rubric-delete-confirm').hidden = true;
    };
    dialog.querySelector('#rubric-delete-submit').onclick = () => save(true);
  }
  function bind(root, data, projectId) {
    root
      .querySelector('#rubrics-group-filter')
      ?.addEventListener('change', (e) => selectProject(e.target.value));
    root
      .querySelector('#rubric-create')
      ?.addEventListener('click', () => open(data, null, projectId));
    root.querySelectorAll('[data-rubric-create]').forEach((b) => {
      b.onclick = () => open(data, null, b.dataset.rubricCreate);
    });
    root.querySelectorAll('[data-rubric-edit]').forEach((b) => {
      b.onclick = () =>
        open(
          data,
          data.rubrics.find((r) => r.id === b.dataset.rubricEdit),
        );
    });
  }
  return {
    render,
    bind,
    reset: () => {
      saving = false;
      close();
    },
  };
}
