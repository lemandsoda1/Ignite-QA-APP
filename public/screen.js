(() => {
  const code = eventCodeFromPath();
  const questionEl = $('#question');
  const textEl = $('#q-text');
  let shownId = null;

  const sizeClass = (length) => (length <= 70 ? '' : length <= 140 ? 'l' : length <= 220 ? 'm' : 's');

  function render(state) {
    const live = state.questions.filter((q) => q.status === 'live').length;
    $('#s-count').textContent = live === 0 ? '' : `${live} question${live === 1 ? '' : 's'} so far`;

    const q = state.questions.find((item) => item.id === state.spotlightId);
    document.body.classList.toggle('has-question', Boolean(q));
    if (!q) {
      shownId = null;
      return;
    }
    textEl.textContent = q.text;
    textEl.className = sizeClass(q.text.length);
    $('#q-author').textContent = `— ${q.author || 'Anonymous'}`;
    $('#q-votes').textContent = q.votes > 0 ? `▲ ${q.votes}` : '';
    if (q.id !== shownId) {
      shownId = q.id;
      questionEl.classList.remove('rise');
      void questionEl.offsetWidth; // restart the entrance animation
      questionEl.classList.add('rise');
    }
  }

  async function start() {
    let info;
    try {
      info = await api('GET', `/api/events/${code}`);
    } catch {
      document.body.replaceChildren(el('p', { class: 'gone' }, 'This event does not exist.'));
      return;
    }
    const url = info.joinUrl.replace(/^https?:\/\//, '');
    document.title = `${info.name} · Big screen`;
    $('#s-event').textContent = info.name;
    $('#s-url').textContent = url;
    $('#b-url').textContent = url;
    $('#s-qr').src = `/api/events/${code}/qr.png`;
    $('#b-qr').src = `/api/events/${code}/qr.png`;
    startPolling(`/api/events/${code}/state`, {
      interval: 2000,
      onState: render,
      onStatus: (status) => {
        if (status === 'closed') document.body.replaceChildren(el('p', { class: 'gone' }, 'This event does not exist.'));
      },
    });
  }

  // F toggles fullscreen, D toggles the dark background (remembered in this browser).
  if (storageGet('qa:screen-dark', false)) document.body.classList.add('dark');
  document.addEventListener('keydown', (event) => {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    const key = event.key.toLowerCase();
    if (key === 'f') {
      if (document.fullscreenElement) document.exitFullscreen();
      else document.documentElement.requestFullscreen?.();
    } else if (key === 'd') {
      storageSet('qa:screen-dark', document.body.classList.toggle('dark'));
    }
  });

  start();
})();
