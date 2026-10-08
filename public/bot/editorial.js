import { openPanel, closePanel, resizeFields } from './panels.js';
import { icon } from './icons.js';
const days = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];
const media = { text: 'Текст', image: 'GIF', video: 'Короткое видео' };
const metrics = { views: 'Просмотры', likes: 'Лайки', comments: 'Комментарии', reposts: 'Репосты' };
const states = {
  proposed: 'На рассмотрении',
  applying: 'Запуск не завершён',
  testing: 'Тест идёт',
  stopping: 'Откат не завершён',
  kept: 'Изменение сохранено',
  rolled_back: 'Настройки возвращены',
  rejected: 'Отклонено',
};
const errors = {
  rubric_version_conflict:
    'Рубрика изменилась. Обновите предложения; для завершения теста можно сохранить результат без отката.',
  rubric_schedule_conflict: 'В это время уже есть другая рубрика. Выберите свободные дни и время.',
  rubric_preparation_busy:
    'Публикация сейчас готовится или отправляется. Дождитесь завершения и повторите действие.',
  test_already_active: 'Завершите текущий тест перед запуском следующего.',
  vk_login_required: 'Для отмены подготовленных записей нужны рабочие ключи сообщества VK.',
  rubric_invalid: 'Проверьте название, дни и время публикации.',
};
export function createEditorialWorkbench({ api, escapeText: esc, refresh }) {
  let dialog,
    saving = false;
  const schedule = (c) =>
    `${c.days.map((d) => days[d - 1]).join(' · ')} / ${c.times.join(', ')} МСК · ${media[c.media]}`;
  const config = (c) =>
    `<strong>${esc(c.name)}</strong><p class="meta">${esc(schedule(c))}</p><p class="editorial-prompt">${esc(c.textPrompt || 'Системный стиль группы')}</p>${c.mediaPrompt ? `<p class="meta">Медиа: ${esc(c.mediaPrompt)}</p>` : ''}`;
  function render(bundle = {}) {
    const tests = bundle.tests || [],
      rubrics = bundle.rubrics || [];
    return `<section class="editorial-lab" aria-labelledby="editorial-lab-title">
      <div class="panel-head"><div><p class="weekly-eyebrow">Гипотеза → рубрика → результат</p><h3 id="editorial-lab-title">Лаборатория рубрик</h3><p class="meta">${rubrics.filter((r) => r.enabled).length} активных рубрик · один тест за раз</p></div><button type="button" id="editorial-own">${icon('plus')} Своя гипотеза</button></div>
      <p>Предложения используют текущее расписание и правила сообщества. Проверьте настройки, затем запустите тест. Его срок — напоминание о пересмотре; завершение выбираете вы.</p>
      ${bundle.metricsStale ? '<p class="meta">Свежих метрик недостаточно. Это редакционные гипотезы; результат появится после публикаций и импорта статистики.</p>' : ''}
      <div class="editorial-test-grid">${(bundle.suggestions || []).map((s, i) => `<article class="card"><div class="card-head"><span class="rubric-media">${s.kind === 'new' ? 'Новая рубрика' : 'Изменение рубрики'}</span></div><h4>${esc(s.title)}</h4><p>${esc(s.hypothesis)}</p><p class="meta">${esc(s.reason)}</p><p class="meta">${esc(schedule(s.config))} · ${s.targetPosts} публикаций</p><button type="button" data-test-suggestion="${i}">Проверить настройки ${icon('right')}</button></article>`).join('')}</div>
      <h3>Проверки гипотез</h3><div class="editorial-tests">${
        tests
          .map((t) => {
            const p = t.proposal,
              report = t.report,
              active = ['testing', 'applying', 'stopping'].includes(t.status);
            return `<article class="card editorial-test"><div class="card-head"><h4>${esc(p.config.name)}</h4><span class="rubric-media">${esc(states[t.status] || t.status)}</span></div><p>${esc(p.hypothesis)}</p><p class="meta">Критерий: ${esc(p.successRule)}</p>
          <details><summary>Настройки рубрики: до и после</summary><div class="editorial-test-grid"><div><h4>До</h4>${t.before ? config(t.before) : '<p>Новая рубрика: добавляет один ритм публикаций.</p>'}</div><div><h4>Предложение</h4>${config(p.config)}</div></div></details>
          ${t.startedAt ? `<div class="editorial-test-grid editorial-measures"><div><span class="meta">${esc(metrics[p.metric])} · тест</span><strong>${report.test.median ?? '—'}</strong><p class="meta">Вышло ${report.test.posts} / ${p.targetPosts}, с метриками ${report.test.measured}</p></div><div><span class="meta">До теста · медиана</span><strong>${report.baseline.median ?? '—'}</strong><p class="meta">С метриками ${report.baseline.measured} / ${report.baseline.posts}</p></div></div><p class="meta">Пересмотр: ${esc(new Date(report.reviewAt).toLocaleDateString('ru-RU', { timeZone: 'Europe/Moscow' }))}${report.reviewDue && active ? ' · пора принять решение' : ''}</p><p class="meta">${esc(report.warning)}</p>` : `<p class="meta">${p.targetPosts} публикаций · пересмотр через ${p.reviewDays} дней</p>`}
          ${report.changedManually && t.status === 'testing' ? '<p class="error-banner">Настройки изменены после запуска. Автоматический откат недоступен; сохраните вывод и проверьте рубрику вручную.</p>' : ''}
          ${['testing', 'stopping'].includes(t.status) ? `<label>Вывод по тесту<textarea data-test-note="${esc(t.id)}" rows="2" maxlength="2000" placeholder="Что узнали и что проверяем дальше"></textarea></label>` : ''}
          <div class="toolbar-group">${t.status === 'proposed' || t.status === 'applying' ? `<button type="button" class="weekly-primary" data-test-id="${esc(t.id)}" data-test-decision="apply">${t.status === 'applying' ? 'Продолжить запуск' : 'Запустить тест'}</button>${t.status === 'proposed' ? `<button type="button" data-test-id="${esc(t.id)}" data-test-decision="reject">Отклонить</button>` : ''}` : t.status === 'testing' ? `<button type="button" data-test-id="${esc(t.id)}" data-test-decision="keep">Сохранить изменение</button><button type="button" data-test-id="${esc(t.id)}" data-test-decision="rollback" ${report.changedManually ? 'disabled' : ''}>Завершить и откатить</button>` : t.status === 'stopping' ? `<button type="button" data-test-id="${esc(t.id)}" data-test-decision="rollback">Продолжить откат</button>${report.changedManually ? `<button type="button" data-test-id="${esc(t.id)}" data-test-decision="keep">Сохранить текущие настройки</button>` : ''}` : ''}<a href="?tab=rubrics&project=${encodeURIComponent(bundle.projectId || '')}">К рубрикам ${icon('right')}</a></div>
          ${t.note ? `<p>Вывод: ${esc(t.note)}</p>` : ''}<p class="rubric-error" role="alert" data-test-error="${esc(t.id)}"></p></article>`;
          })
          .join('') ||
        '<p class="rubric-empty">Выберите предложение или сформулируйте свою гипотезу. Она станет рубрикой после запуска теста.</p>'
      }</div>
    </section>`;
  }
  function close() {
    if (saving) return;
    closePanel(dialog);
    dialog?.remove();
    dialog = null;
  }
  function open(bundle, suggestion) {
    close();
    const s = suggestion || {
      kind: 'new',
      hypothesis: '',
      targetPosts: 3,
      reviewDays: 14,
      metric: 'views',
      successRule: '',
      config: {
        name: '',
        days: [3],
        times: ['14:00'],
        media: 'text',
        textPrompt: '',
        mediaPrompt: '',
        color: '#5640ad',
        enabled: true,
      },
    };
    dialog = document.createElement('dialog');
    dialog.className = 'rubric-dialog';
    dialog.setAttribute('aria-labelledby', 'test-dialog-title');
    dialog.innerHTML = `<form><div class="rubric-dialog-head"><div><p class="weekly-eyebrow">Предложение редакции</p><h2 id="test-dialog-title">Проверить гипотезу</h2></div><button type="button" data-test-close aria-label="Закрыть">${icon('close')}</button></div><div class="rubric-fields">
      <label>Что меняем<select name="target"><option value="">Создать новую рубрику</option>${(
        bundle.rubrics || []
      )
        .filter((r) => r.state === 'active' && !r.pending)
        .map(
          (r) =>
            `<option value="${esc(r.id)}" ${s.rubricId === r.id ? 'selected' : ''}>${esc(r.name)}</option>`,
        )
        .join('')}</select></label>
      <label>Гипотеза<textarea name="hypothesis" required maxlength="2000">${esc(s.hypothesis)}</textarea></label>
      <label>Название рубрики<input name="name" required maxlength="80" value="${esc(s.config.name)}"></label>
      <fieldset class="rubric-days"><legend>Дни публикации</legend>${days.map((d, i) => `<label><input type="checkbox" name="day" value="${i + 1}" ${s.config.days.includes(i + 1) ? 'checked' : ''}><span>${d}</span></label>`).join('')}</fieldset>
      <label>Время · Москва<input name="times" required value="${esc(s.config.times.join(', '))}"></label>
      <label>Формат<select name="media">${Object.entries(media)
        .map(
          ([k, v]) =>
            `<option value="${k}" ${s.config.media === k ? 'selected' : ''}>${v}</option>`,
        )
        .join('')}</select></label>
      <label>Задание для текста<textarea name="textPrompt" maxlength="6000">${esc(s.config.textPrompt)}</textarea></label>
      <label>Задание для GIF и видео<textarea name="mediaPrompt" maxlength="6000">${esc(s.config.mediaPrompt)}</textarea></label>
      <div class="editorial-test-grid"><label>Публикаций для проверки<input name="targetPosts" type="number" min="2" max="30" required value="${s.targetPosts}"></label><label>Пересмотреть через дней<input name="reviewDays" type="number" min="1" max="60" required value="${s.reviewDays}"></label></div>
      <label>Основная метрика<select name="metric">${Object.entries(metrics)
        .map(([k, v]) => `<option value="${k}" ${s.metric === k ? 'selected' : ''}>${v}</option>`)
        .join('')}</select></label>
      <label>Критерий успеха<textarea name="successRule" required maxlength="2000">${esc(s.successRule)}</textarea></label>
      <p class="rubric-change-note">Запуск меняет расписание и задания рубрики. Подготовленные будущие записи будут отменены; их потребуется подготовить заново. После теста можно сохранить изменение или вернуть прежние настройки.</p>
      <p class="rubric-error" role="alert" data-test-form-error></p></div><div class="rubric-dialog-footer"><button type="submit" class="weekly-primary">Сохранить предложение</button></div></form>`;
    document.body.append(dialog);
    openPanel(dialog, close);
    dialog.querySelector('[data-test-close]').onclick = close;
    const form = dialog.querySelector('form');
    let selected = (bundle.rubrics || []).find((r) => r.id === s.rubricId);
    form.elements.target.onchange = () => {
      selected = (bundle.rubrics || []).find((r) => r.id === form.elements.target.value);
      const c = selected || s.config;
      for (const key of ['name', 'media', 'textPrompt', 'mediaPrompt'])
        form.elements[key].value = c[key];
      form.elements.media.dispatchEvent(new Event('change'));
      form.elements.times.value = c.times.join(', ');
      form.querySelectorAll('[name=day]').forEach((el) => {
        el.checked = c.days.includes(Number(el.value));
      });
      resizeFields(dialog);
    };
    form.onsubmit = async (e) => {
      e.preventDefault();
      if (saving) return;
      const data = new FormData(form);
      const body = {
        ...s,
        projectId: bundle.projectId,
        kind: selected ? 'change' : 'new',
        rubricId: selected?.id,
        expectedRevision: selected?.revision,
        hypothesis: data.get('hypothesis'),
        successRule: data.get('successRule'),
        targetPosts: Number(data.get('targetPosts')),
        reviewDays: Number(data.get('reviewDays')),
        metric: data.get('metric'),
        config: {
          ...s.config,
          name: data.get('name'),
          days: data.getAll('day').map(Number),
          times: String(data.get('times'))
            .split(',')
            .map((v) => v.trim())
            .filter(Boolean),
          media: data.get('media'),
          textPrompt: data.get('textPrompt'),
          mediaPrompt: data.get('mediaPrompt'),
          enabled: true,
        },
      };
      saving = true;
      const controls = [...form.querySelectorAll('button,input,textarea,select')];
      controls.forEach((c) => {
        c.disabled = true;
      });
      try {
        await api('/bot/api/v1/editorial/rubric-tests', {
          method: 'POST',
          body: JSON.stringify(body),
        });
        saving = false;
        close();
        await refresh();
      } catch (error) {
        if (dialog)
          dialog.querySelector('[data-test-form-error]').textContent =
            errors[error.body?.error] || error.body?.message || error.message;
      } finally {
        saving = false;
        controls.forEach((c) => {
          c.disabled = false;
        });
      }
    };
  }
  function bind(root, bundle) {
    if (!bundle?.projectId) return;
    root.querySelector('#editorial-own')?.addEventListener('click', () => open(bundle));
    root.querySelectorAll('[data-test-suggestion]').forEach((b) => {
      b.onclick = () => open(bundle, bundle.suggestions[Number(b.dataset.testSuggestion)]);
    });
    root.querySelectorAll('[data-test-decision]').forEach((b) => {
      b.onclick = async () => {
        const id = b.dataset.testId,
          errorNode = [...root.querySelectorAll('[data-test-error]')].find(
            (el) => el.dataset.testError === id,
          );
        const card = b.closest('.editorial-test'),
          controls = [...card.querySelectorAll('button')].map((el) => [el, el.disabled]);
        controls.forEach(([el]) => {
          el.disabled = true;
        });
        errorNode.textContent = '';
        const note =
          [...root.querySelectorAll('[data-test-note]')].find((el) => el.dataset.testNote === id)
            ?.value || '';
        try {
          await api(`/bot/api/v1/editorial/rubric-tests/${encodeURIComponent(id)}/decide`, {
            method: 'POST',
            body: JSON.stringify({ decision: b.dataset.testDecision, note }),
          });
          await refresh();
        } catch (error) {
          errorNode.textContent = errors[error.body?.error] || error.body?.message || error.message;
        } finally {
          controls.forEach(([el, disabled]) => {
            el.disabled = disabled;
          });
        }
      };
    });
  }
  return { render, bind, reset: close };
}
