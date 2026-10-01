import { apiBroken, tokenize, terminalScenes } from './terminal-scenes';

const terminal = document.querySelector<HTMLElement>('[data-code-terminal]');
if (terminal) {
  const code = terminal.querySelector<HTMLElement>('[data-terminal-code]')!;
  const file = terminal.querySelector<HTMLElement>('[data-terminal-file]')!;
  const logs = terminal.querySelector<HTMLElement>('[data-terminal-logs]')!;
  const status = terminal.querySelector<HTMLElement>('[data-terminal-status]')!;
  const pause = terminal.querySelector<HTMLButtonElement>('[data-terminal-pause]')!;
  const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const width = window.matchMedia('(min-width: 52.01rem)');
  let visible = false;
  let paused = false;
  let timer: number | undefined;
  let sceneIndex = 0;
  let stepIndex = 0;
  let elapsed = 0;
  let previous = performance.now();
  let rendered = '';
  let logKey = '';

  function renderCode(source: string, active: boolean, errorLine?: number, activeLine?: number) {
    const key = source + active + errorLine + activeLine;
    if (key === rendered) return;
    rendered = key;
    const lines = source.split('\n');
    const fragment = document.createDocumentFragment();
    lines.forEach((text, index) => {
      const line = document.createElement('span');
      line.className = 'terminal-line';
      line.dataset.line = String(index + 1);
      if (active && index === (activeLine ?? lines.length - 1)) line.dataset.active = '';
      if (errorLine === index + 1) line.dataset.error = '';
      for (const token of tokenize(text)) {
        const span = document.createElement('span');
        span.className = 'token-' + token.kind;
        span.textContent = token.text;
        line.append(span);
      }
      fragment.append(line);
    });
    code.replaceChildren(fragment);
  }

  function tick() {
    timer = undefined;
    const now = performance.now();
    elapsed += Math.min(now - previous, 120);
    previous = now;
    const scene = terminalScenes[sceneIndex];
    let step = scene.steps[stepIndex];
    if (elapsed >= step.duration) {
      elapsed = 0;
      stepIndex++;
      if (stepIndex === scene.steps.length) {
        stepIndex = 0;
        sceneIndex = (sceneIndex + 1) % terminalScenes.length;
      }
      step = terminalScenes[sceneIndex].steps[stepIndex];
    }
    const currentScene = terminalScenes[sceneIndex];
    const progress = Math.min(1, elapsed / step.duration);
    const lastStep = stepIndex === currentScene.steps.length - 1;
    const fade = lastStep ? Math.min(1, (step.duration - elapsed) / 400)
      : stepIndex === 0 ? Math.min(1, elapsed / 400) : 1;
    code.style.transform = `translateY(${(1 - fade) * 6}px)`;
    logs.style.transform = `translateY(${(1 - fade) * 6}px)`;
    file.textContent = currentScene.file;
    status.textContent = step.status;
    let source = step.source;
    let activeLine: number | undefined;
    if (step.mode === 'type') source = source.slice(0, Math.floor(source.length * progress));
    if (step.mode === 'import') {
      const addition = 'from uuid import uuid4\n';
      source = addition.trimEnd().slice(0, Math.floor((addition.length - 1) * progress)) + '\n' + apiBroken;
      activeLine = 0;
    }
    if (step.mode === 'await') {
      source = source.replace('await ', 'await '.slice(0, Math.floor(6 * progress)));
      activeLine = 8;
    }
    renderCode(source, Boolean(step.mode), step.errorLine, activeLine);
    const nextLogKey = sceneIndex + ':' + stepIndex;
    if (nextLogKey !== logKey) {
      logKey = nextLogKey;
      logs.replaceChildren(
        ...step.logs.map((item) => {
          const line = document.createElement('div');
          line.textContent = item.text;
          if (item.tone) line.dataset.tone = item.tone;
          return line;
        }),
      );
    }
    timer = window.setTimeout(tick, 16);
  }

  function synchronize() {
    if (timer !== undefined) window.clearTimeout(timer);
    timer = undefined;
    pause.hidden = motion.matches || !width.matches;
    const running = visible && !paused && !motion.matches && width.matches && !document.hidden;
    if (running) {
      previous = performance.now();
      timer = window.setTimeout(tick, 16);
    }
    if (motion.matches) {
      code.style.transform = 'none';
      logs.style.transform = 'none';
      const final = terminalScenes[0].steps.at(-1)!;
      renderCode(final.source, false);
      file.textContent = 'api.py';
      status.textContent = 'API готов';
      logs.replaceChildren(
        ...final.logs.map((item) => {
          const line = document.createElement('div');
          line.textContent = item.text;
          if (item.tone) line.dataset.tone = item.tone;
          return line;
        }),
      );
      logKey = '';
    }
  }
  pause.addEventListener('click', () => {
    paused = !paused;
    pause.textContent = paused ? 'Продолжить' : 'Пауза';
    pause.setAttribute('aria-pressed', String(paused));
    pause.setAttribute(
      'aria-label',
      paused ? 'Продолжить анимацию кода' : 'Приостановить анимацию кода',
    );
    synchronize();
  });
  new IntersectionObserver(
    ([entry]) => {
      visible = entry.isIntersecting;
      synchronize();
    },
    { threshold: 0.15 },
  ).observe(terminal);
  motion.addEventListener('change', synchronize);
  width.addEventListener('change', synchronize);
  document.addEventListener('visibilitychange', synchronize);
  synchronize();
}
