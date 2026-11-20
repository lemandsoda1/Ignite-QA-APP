// Small helpers shared by every page.

const $ = (selector, root = document) => root.querySelector(selector);

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === 'class') node.className = value;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else if (value === true) node.setAttribute(key, '');
    else if (value !== false && value != null) node.setAttribute(key, value);
  }
  node.append(...children.flat().filter((child) => child != null && child !== false));
  return node;
}

async function api(method, url, body, headers = {}) {
  const res = await fetch(url, {
    method,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = res.status === 204 ? {} : await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || `Request failed (${res.status})`), { status: res.status });
  return data;
}

function storageGet(key, fallback = null) {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? fallback : JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function storageSet(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* private mode or storage disabled: the page still works, it just forgets */
  }
}

// Anonymous per-browser id, used to keep one upvote per person. crypto.randomUUID is
// unavailable on plain http (e.g. a phone on the Wi-Fi), so build the id from getRandomValues.
function voterId() {
  let id = storageGet('qa:voter');
  if (!id) {
    id = [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, '0')).join('');
    storageSet('qa:voter', id);
  }
  return id;
}

function timeAgo(timestamp) {
  const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000));
  if (seconds < 45) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return `${Math.round(hours / 24)} d ago`;
}

let toastTimer;
function toast(message, isError = false) {
  const node = $('#toast');
  if (!node) return;
  node.textContent = message;
  node.classList.toggle('error', isError);
  node.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => node.classList.remove('show'), isError ? 4200 : 2600);
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // navigator.clipboard needs https; fall back for http on the local network.
    const area = el('textarea', { readonly: true, style: 'position:fixed;opacity:0' });
    area.value = text;
    document.body.append(area);
    area.select();
    document.execCommand('copy');
    area.remove();
  }
}

// Polls a JSON endpoint on a timer. Every response carries a `version`; onState is called only
// when it changed. Responses older than our own latest write (noteWrite) are ignored for a few
// seconds, because the CDN may still serve a snapshot from a moment ago. With useSince the server
// answers { unchanged: true } when nothing happened. Calls onStatus with 'open', 'reconnecting'
// or 'closed' (the event is gone or the host key is wrong).
function startPolling(url, { headers = {}, interval = 3000, useSince = false, pauseWhenHidden = false, onState, onStatus }) {
  let applied = null; // version of the last state handed to onState
  let floor = 0;
  let floorUntil = 0;
  let failures = 0;
  let timer = null;
  let busy = false;
  let stopped = false;

  const nextDelay = () => {
    const base = failures ? Math.min(20_000, interval * 2 ** Math.min(failures, 4)) : interval;
    return base * (0.85 + Math.random() * 0.3); // jitter, so a whole room doesn't poll in lockstep
  };
  const schedule = () => {
    clearTimeout(timer);
    if (!stopped) timer = setTimeout(tick, nextDelay());
  };

  async function tick() {
    clearTimeout(timer);
    if (stopped || busy) return;
    if (pauseWhenHidden && document.hidden) return schedule();
    busy = true;
    try {
      const res = await fetch(useSince && applied !== null ? `${url}?since=${applied}` : url, { headers });
      if (res.status === 404 || res.status === 401) {
        stopped = true;
        onStatus?.('closed');
        return;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      failures = 0;
      onStatus?.('open');
      const stale = data.version < floor && Date.now() < floorUntil;
      if (!stale && !data.unchanged && data.version !== applied) {
        applied = data.version;
        onState(data);
      }
    } catch {
      failures += 1;
      if (failures >= 2) onStatus?.('reconnecting');
    } finally {
      busy = false;
      schedule();
    }
  }

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) tick();
  });
  tick();

  return {
    refresh: tick,
    noteWrite(version) {
      floor = Math.max(floor, Number(version) || 0);
      floorUntil = Date.now() + 8000;
    },
    stop() {
      stopped = true;
      clearTimeout(timer);
    },
  };
}

// /e/CODE, /host/CODE and /screen/CODE carry the code in the path; the static fallback pages
// (/ask.html?code=CODE) carry it in the query string.
const eventCodeFromPath = () => {
  const fromPath = location.pathname.match(/^\/(?:e|host|screen)\/([^/]+)/);
  const code = (fromPath?.[1] || new URLSearchParams(location.search).get('code') || '').toUpperCase();
  // Event codes are letters and digits only. Anything else (for example "../" in a crafted link)
  // is dropped, so the code can never steer the page's requests to another API path.
  return /^[A-Z0-9]{1,12}$/.test(code) ? code : '';
};

const ICON_UP =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 15l6-6 6 6"/></svg>';
