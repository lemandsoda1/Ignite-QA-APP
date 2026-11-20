(() => {
  const code = eventCodeFromPath();
  const me = voterId();
  const votedKey = `qa:${code}:voted`;
  const voted = new Set(storageGet(votedKey, []));

  const form = $('#ask');
  const textEl = $('#text');
  const authorEl = $('#author');
  const sendBtn = $('#send');
  const listEl = $('#list');
  const emptyEl = $('#empty');

  let questions = [];
  let poller = null;

  $('#code').textContent = code;
  authorEl.value = storageGet('qa:author', '');

  // Most upvotes first; ties go to the older question. Answered questions leave the list.
  function visibleQuestions() {
    return questions.filter((q) => q.status === 'live').sort((a, b) => b.votes - a.votes || a.createdAt - b.createdAt);
  }

  function card(q) {
    const isVoted = voted.has(q.id);
    const vote = el('button', {
      class: `vote${isVoted ? ' voted' : ''}`,
      type: 'button',
      'aria-pressed': String(isVoted),
      'aria-label': `Upvote (${q.votes})`,
      onclick: () => toggleVote(q),
    });
    vote.innerHTML = ICON_UP;
    vote.append(el('span', {}, String(q.votes)));

    return el('li', { class: 'q' },
      el('div', {},
        el('p', { class: 'q-text' }, q.text),
        el('div', { class: 'q-meta' },
          el('span', {}, q.author || 'Anonymous'),
          el('span', {}, timeAgo(q.createdAt)))),
      vote);
  }

  function render() {
    const items = visibleQuestions();
    listEl.replaceChildren(...items.map(card));
    emptyEl.hidden = items.length > 0;
    emptyEl.textContent = 'No questions yet. Be the first to ask!';
  }

  function setVoted(q, up) {
    if (up) {
      voted.add(q.id);
      q.votes += 1;
    } else {
      voted.delete(q.id);
      q.votes = Math.max(0, q.votes - 1);
    }
    storageSet(votedKey, [...voted]);
    render();
  }

  async function toggleVote(q) {
    const up = !voted.has(q.id);
    setVoted(q, up); // optimistic; replaced by the server's count as soon as it answers
    try {
      const result = await api('POST', `/api/events/${code}/questions/${q.id}/vote`, { voterId: me, up });
      poller?.noteWrite(result.version);
      const current = questions.find((item) => item.id === q.id);
      if (current) {
        current.votes = result.votes;
        render();
      }
    } catch (error) {
      setVoted(q, !up);
      toast(error.message, true);
    }
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const text = textEl.value.trim();
    if (text.length < 3) return toast('Please write a bit more.', true);
    sendBtn.disabled = true;
    try {
      const result = await api('POST', `/api/events/${code}/questions`, { text, author: authorEl.value, voterId: me });
      poller?.noteWrite(result.version);
      storageSet('qa:author', authorEl.value.trim());
      textEl.value = '';
      // Show the new question right away instead of waiting for the next poll.
      if (result.status === 'live' && !questions.some((item) => item.id === result.question.id)) {
        questions.push(result.question);
        render();
      }
      toast(result.status === 'pending' ? 'Thanks! The host will review your question first.' : 'Question sent!');
    } catch (error) {
      toast(error.message, true);
    } finally {
      sendBtn.disabled = false;
    }
  });

  textEl.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) form.requestSubmit();
  });

  function showMissing() {
    $('#event-name').textContent = 'Event not found';
    $('#main').replaceChildren(
      el('div', { class: 'card notice' },
        el('p', { class: 'muted' }, `There is no event with the code ${code}. Check the code and try again.`),
        el('p', { class: 'mt' }, el('a', { class: 'btn', href: '/' }, 'Back to start')))
    );
  }

  async function start() {
    try {
      const info = await api('GET', `/api/events/${code}`);
      $('#event-name').textContent = info.name;
      document.title = `${info.name} · Ask a question`;
    } catch {
      return showMissing();
    }
    poller = startPolling(`/api/events/${code}/state`, {
      interval: 3000,
      pauseWhenHidden: true, // a locked phone doesn't need to keep asking
      onState: (state) => {
        questions = state.questions;
        $('#event-name').textContent = state.name;
        render();
      },
      onStatus: (status) => {
        if (status === 'closed') return showMissing();
        $('#offline').hidden = status === 'open';
      },
    });
    setInterval(render, 30_000); // keeps "5 min ago" labels fresh
  }

  start();
})();
