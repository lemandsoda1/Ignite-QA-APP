(() => {
  const code = eventCodeFromPath();
  const keyStore = `qa:hostkey:${code}`;
  const hashKey = new URLSearchParams(location.hash.slice(1)).get('key');
  if (hashKey) storageSet(keyStore, hashKey);
  const key = hashKey || storageGet(keyStore);

  const hostApi = (method, path, body) => api(method, `/api/events/${code}${path}`, body, { 'x-host-key': key });
  let poller = null;
  // After any host action, fetch fresh state right away instead of waiting for the next poll.
  const run = (promise) => promise.then(() => poller?.refresh()).catch((error) => toast(error.message, true));

  const TABS = [
    ['live', 'Live'],
    ['pending', 'Pending'],
    ['answered', 'Answered'],
    ['hidden', 'Hidden'],
  ];
  const EMPTY_TEXT = {
    live: 'No live questions yet. They show up here the moment someone sends one.',
    pending: 'Nothing waiting for approval.',
    answered: 'No answered questions yet.',
    hidden: 'No hidden questions.',
  };
  const SORTS = {
    popular: (a, b) => b.votes - a.votes || a.createdAt - b.createdAt,
    newest: (a, b) => b.createdAt - a.createdAt,
    oldest: (a, b) => a.createdAt - b.createdAt,
  };

  let info = null;
  let state = { questions: [], spotlightId: null, moderated: false };
  let tab = 'live';
  let sort = 'popular';
  let knownIds = null; // null until the first update, so existing questions don't flash
  const arrivedAt = new Map();

  function showNoKey(message) {
    $('#dashboard').hidden = true;
    $('#nokey').hidden = false;
    $('#nokey-text').textContent = message;
  }

  // ---------------------------------------------------------------- rendering

  const button = (label, onclick, extra = '') =>
    el('button', { class: `btn btn-sm ${extra}`.trim(), type: 'button', onclick }, label);

  const setStatus = (question, status) => run(hostApi('PATCH', `/questions/${question.id}`, { status }));
  const setSpotlight = (id) => run(hostApi('PUT', '/spotlight', { id }));
  const remove = (question) => {
    if (confirm('Delete this question for good?')) run(hostApi('DELETE', `/questions/${question.id}`));
  };

  function actionsFor(q) {
    const onScreen = q.id === state.spotlightId;
    const show = onScreen
      ? button('Remove from screen', () => setSpotlight(null))
      : button('Show on screen', () => setSpotlight(q.id), 'btn-primary');
    switch (q.status) {
      case 'pending':
        return [button('Approve', () => setStatus(q, 'live'), 'btn-primary'), show, button('Hide', () => setStatus(q, 'hidden'))];
      case 'live':
        return [show, button('Mark answered', () => setStatus(q, 'answered')), button('Hide', () => setStatus(q, 'hidden'))];
      case 'answered':
        return [show, button('Reopen', () => setStatus(q, 'live')), button('Hide', () => setStatus(q, 'hidden'))];
      default:
        return [button('Restore', () => setStatus(q, 'live'), 'btn-primary'), button('Delete', () => remove(q), 'btn-danger')];
    }
  }

  function voteBadge(q) {
    const node = el('div', { class: 'vote static', title: `${q.votes} upvotes` });
    node.innerHTML = ICON_UP;
    node.append(el('span', {}, String(q.votes)));
    return node;
  }

  function card(q) {
    const onScreen = q.id === state.spotlightId;
    const age = Date.now() - (arrivedAt.get(q.id) ?? 0);
    const node = el('li', { class: `q${onScreen ? ' on-screen' : ''}` },
      el('div', {},
        el('p', { class: 'q-text' }, q.text),
        el('div', { class: 'q-meta' },
          el('span', {}, q.author || 'Anonymous'),
          el('span', {}, timeAgo(q.createdAt)),
          onScreen && el('span', { class: 'badge' }, 'On screen'),
          q.status === 'pending' && el('span', { class: 'badge warn' }, 'Needs approval'))),
      voteBadge(q),
      el('div', { class: 'q-actions' }, actionsFor(q)));
    if (age < 2400) {
      // Replays the highlight from where it left off when a re-render happens mid-animation.
      node.classList.add('is-new');
      node.style.animationDelay = `-${age}ms`;
    }
    return node;
  }

  function renderSpotlight() {
    const q = state.questions.find((item) => item.id === state.spotlightId);
    const box = $('#spotlight');
    box.classList.toggle('empty-state', !q);
    if (!q) {
      box.replaceChildren(el('p', {}, 'Nothing on the big screen. Press "Show on screen" on a question to display it.'));
      return;
    }
    box.replaceChildren(
      el('p', { class: 'eyebrow' }, 'On the big screen now'),
      el('p', { class: 'q-text' }, q.text),
      el('p', { class: 'q-meta' }, el('span', {}, q.author || 'Anonymous'), el('span', {}, `${q.votes} upvote${q.votes === 1 ? '' : 's'}`)),
      el('div', { class: 'btn-row' },
        button('Remove from screen', () => setSpotlight(null)),
        button('Mark answered', () => setStatus(q, 'answered'), 'btn-primary'))
    );
  }

  function render() {
    const groups = { live: [], pending: [], answered: [], hidden: [] };
    for (const q of state.questions) groups[q.status]?.push(q);

    const tabs = TABS.filter(([id]) => id !== 'pending' || state.moderated || groups.pending.length > 0);
    if (!tabs.some(([id]) => id === tab)) tab = 'live';

    $('#tabs').replaceChildren(
      ...tabs.map(([id, label]) =>
        el('button', {
          class: 'tab',
          role: 'tab',
          'aria-selected': String(id === tab),
          onclick: () => {
            tab = id;
            render();
          },
        }, label, el('span', { class: 'n' }, String(groups[id].length))))
    );

    const items = groups[tab].slice().sort(SORTS[sort]);
    $('#list').replaceChildren(...items.map(card));
    $('#empty').hidden = items.length > 0;
    $('#empty').textContent = EMPTY_TEXT[tab];

    renderSpotlight();
    $('#moderated').checked = state.moderated;
    $('#event-name').textContent = state.name || info.name;
  }

  function onState(next) {
    state = next;
    const ids = new Set(next.questions.map((q) => q.id));
    if (knownIds) for (const id of ids) if (!knownIds.has(id)) arrivedAt.set(id, Date.now());
    knownIds = ids;
    render();
  }

  // ---------------------------------------------------------------- setup

  function setupSidebar() {
    const joinUrl = new URL(info.joinUrl);
    $('#event-name').textContent = info.name;
    document.title = `${info.name} · Host dashboard`;
    $('#code').textContent = code;
    $('#qr').src = `/api/events/${code}/qr.png`;
    $('#join-url').textContent = info.joinUrl.replace(/^https?:\/\//, '');
    $('#dl-png').href = `/api/events/${code}/qr.png?download`;
    $('#dl-svg').href = `/api/events/${code}/qr.svg?download`;
    $('#open-screen').href = `/screen/${code}`;

    $('#copy-join').addEventListener('click', async () => {
      await copyText(info.joinUrl);
      toast('Join link copied');
    });
    $('#copy-host').addEventListener('click', async () => {
      await copyText(`${joinUrl.origin}/host/${code}#key=${key}`);
      toast('Host link copied. Keep it private.');
    });
    $('#moderated').addEventListener('change', (event) => {
      run(hostApi('PATCH', '', { moderated: event.target.checked }));
    });
    $('#sort').addEventListener('change', (event) => {
      sort = event.target.value;
      render();
    });

    $('#clear').addEventListener('click', () => {
      const count = state.questions.length;
      if (count === 0) return toast('There are no questions to clear.');
      if (!confirm(`Delete all ${count} question${count === 1 ? '' : 's'} and start a fresh session? The QR code stays the same.`)) return;
      run(hostApi('POST', '/clear', {}));
      toast('Cleared. Ready for a fresh session.');
    });

    const banner = $('#reach-banner');
    if (/^(localhost|127\.|\[::1\])/.test(joinUrl.hostname)) {
      banner.textContent = 'The join link points to this computer, so phones cannot open it. Connect to Wi-Fi or start the app with a PUBLIC_URL (see the README).';
      banner.hidden = false;
    } else if (/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(joinUrl.hostname)) {
      banner.textContent = 'This link only works for phones on the same Wi-Fi as this computer. For a remote audience, start the app with a PUBLIC_URL (see the README).';
      banner.hidden = false;
    }
  }

  async function start() {
    if (!key) return showNoKey('Open the host link you received when you created this event, or create a new event.');
    try {
      info = await api('GET', `/api/events/${code}`);
    } catch {
      return showNoKey(`There is no event with the code ${code}.`);
    }
    $('#dashboard').hidden = false;
    setupSidebar();

    let receivedState = false;
    poller = startPolling(`/api/events/${code}/host-state`, {
      headers: { 'x-host-key': key },
      interval: 1500,
      useSince: true,
      onState: (next) => {
        receivedState = true;
        onState(next);
      },
      onStatus: (status) => {
        if (status === 'closed' && !receivedState) return showNoKey('This host link is not valid for this event.');
        const status$ = $('#status');
        status$.textContent = status === 'open' ? 'Live' : 'Reconnecting…';
        status$.classList.toggle('off', status !== 'open');
      },
    });
    setInterval(render, 30_000); // keeps "5 min ago" labels fresh
  }

  start();
})();
