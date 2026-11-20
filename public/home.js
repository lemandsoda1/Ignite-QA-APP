(() => {
  const EVENTS_KEY = 'qa:events';
  const mine = $('#mine');
  const list = $('#mine-list');

  const savedEvents = () => storageGet(EVENTS_KEY, []);

  function renderMine() {
    const events = savedEvents();
    mine.hidden = events.length === 0;
    list.replaceChildren(
      ...events.map((ev) =>
        el('div', { class: 'event-row' },
          el('div', {},
            el('div', { class: 'name' }, ev.name),
            el('div', { class: 'hint' }, 'Code ', el('span', { class: 'code-pill' }, ev.code))),
          el('div', { class: 'btn-row' },
            el('a', { class: 'btn btn-sm btn-primary', href: `/host/${ev.code}#key=${ev.key}` }, 'Open dashboard'),
            el('button', {
              class: 'btn btn-sm',
              type: 'button',
              onclick: () => {
                storageSet(EVENTS_KEY, savedEvents().filter((item) => item.code !== ev.code));
                renderMine();
              },
            }, 'Forget'))))
    );
  }

  $('#create').addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = $('button', event.currentTarget);
    const errorEl = $('#create-error');
    const name = $('#name').value.trim();
    errorEl.hidden = true;
    button.disabled = true;
    try {
      const { code, hostKey } = await api('POST', '/api/events', {
        name,
        moderated: $('#moderated').checked,
        password: $('#password').value,
      });
      storageSet(EVENTS_KEY, [{ code, key: hostKey, name, createdAt: Date.now() }, ...savedEvents()]);
      location.href = `/host/${code}#key=${hostKey}`;
    } catch (error) {
      errorEl.textContent = error.message;
      errorEl.hidden = false;
      button.disabled = false;
    }
  });

  $('#join').addEventListener('submit', (event) => {
    event.preventDefault();
    const code = $('#code').value.toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (code) location.href = `/e/${code}`;
  });

  // Single-session sites send everyone straight to the one event. Otherwise the page shows,
  // with or without the password field, and stays visible even if this check fails.
  (async () => {
    try {
      const config = await api('GET', '/api/config');
      if (config.creationLocked && config.sessionCode) {
        location.replace(`/e/${config.sessionCode}`);
        return; // the page stays hidden until the browser has moved on
      }
      if (config.creationLocked) {
        $('#create').hidden = true;
        $('#locked-note').hidden = false;
      }
      $('#password-field').hidden = !config.passwordRequired;
      $('#password').required = Boolean(config.passwordRequired);
    } catch {
      /* show the page as it is */
    }
    document.body.classList.remove('checking');
  })();

  renderMine();
})();
