'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');
const QRCode = require('qrcode');
const { createMemoryStore } = require('./lib/store-memory');

const PORT = Number(process.env.PORT) || 4000;
const PUBLIC_DIR = path.join(__dirname, 'public');

const MAX_QUESTION_LENGTH = 300;
const MAX_NAME_LENGTH = 40;
const MAX_QUESTIONS_PER_EVENT = 2000;
const ASK_COOLDOWN_SECONDS = 3;
const CREATE_ATTEMPT_LIMIT = 8; // wrong passwords allowed per client address and window
const CREATE_ATTEMPT_WINDOW_SECONDS = 10 * 60;
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no I/O/0/1, easy to read out loud
const AUDIENCE_STATUSES = new Set(['live', 'answered']);
const HOST_STATUSES = new Set(['live', 'answered', 'hidden']);

// ------------------------------------------------------------------ helpers

function newCode() {
  let code = '';
  for (const byte of crypto.randomBytes(6)) code += CODE_ALPHABET[byte % CODE_ALPHABET.length];
  return code;
}

function cleanText(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function lanAddress() {
  const candidates = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if ((a.family === 'IPv4' || a.family === 4) && !a.internal) candidates.push({ name, address: a.address });
    }
  }
  const wifiOrEthernet = candidates.find((c) => /^(en|eth|wlan|wl)/.test(c.name));
  return (wifiOrEthernet || candidates[0])?.address ?? null;
}

function toPublicQuestion(q) {
  return {
    id: q.id,
    text: q.text,
    author: q.author,
    createdAt: q.createdAt,
    status: q.status,
    votes: q.votes ?? 0,
  };
}

// What a viewer receives. The audience never sees pending or hidden questions; the host sees all.
function viewOf(state, isHost) {
  const questions = state.questions
    .filter((q) => isHost || AUDIENCE_STATUSES.has(q.status))
    .map(toPublicQuestion)
    .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  const spotlightVisible = questions.some((q) => q.id === state.event.spotlightId);
  return {
    version: state.version,
    code: state.event.code,
    name: state.event.name,
    moderated: state.event.moderated,
    spotlightId: spotlightVisible ? state.event.spotlightId : null,
    questions,
  };
}

// Redis when credentials are present (Vercel's Upstash integration sets either naming), memory
// otherwise. On Vercel, memory would silently give every serverless instance its own data, so a
// missing database is reported as an error instead.
function chooseStore(env = process.env) {
  const url = env.UPSTASH_REDIS_REST_URL || env.KV_REST_API_URL;
  const token = env.UPSTASH_REDIS_REST_TOKEN || env.KV_REST_API_TOKEN;
  if (url && token) {
    const { createRedisStore } = require('./lib/store-redis');
    // PERMANENT_EVENTS="CODE1,CODE2" keeps those events (and their QR codes) alive forever.
    const permanentCodes = String(env.PERMANENT_EVENTS || '').split(',').map((code) => code.trim()).filter(Boolean);
    return { store: createRedisStore({ url, token, permanentCodes }), kind: 'redis' };
  }
  if (env.VERCEL) return { store: null, kind: 'missing' };
  return { store: createMemoryStore(), kind: 'memory' };
}

// ------------------------------------------------------------------ app

function createApp(store, { kind = 'memory', publicUrl = '', createPassword = '', lockCreation = false, sessionCode = '', publicDir = PUBLIC_DIR } = {}) {
  const app = express();
  app.disable('x-powered-by');
  app.disable('etag');
  app.set('trust proxy', 1); // hosting platforms put one proxy in front; this makes req.ip the real client
  app.use((req, res, next) => {
    res.set({ 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY' });
    next();
  });
  app.use(express.json({ limit: '4kb' }));
  app.use(express.static(publicDir)); // ignored on Vercel, which serves public/ from its CDN

  // Pretty page URLs. On Vercel the CDN normally serves the pages (via public/ and the rewrites in
  // vercel.json) before the request gets here; if that ever doesn't happen, redirect to the static page.
  const page = (file) => (req, res) => {
    const filePath = path.join(publicDir, file);
    if (fs.existsSync(filePath)) return res.sendFile(filePath);
    const { code } = req.params;
    res.redirect(302, `/${file}${code ? `?code=${encodeURIComponent(code)}` : ''}`);
  };
  app.get('/', page('index.html'));
  app.get('/e/:code', page('ask.html'));
  app.get('/host/:code', page('host.html'));
  app.get('/screen/:code', page('screen.html'));

  if (!store) {
    app.use(['/api', '/healthz'], (req, res) => {
      res.status(503).json({
        error: 'The database is not connected yet. Add a Redis database to this Vercel project and redeploy (see the README).',
      });
    });
    return app;
  }

  const codeOf = (req) => String(req.params.code).toUpperCase();
  const notFound = (res) => res.status(404).json({ error: 'This event does not exist.' });
  const questionNotFound = (res) => res.status(404).json({ error: 'Question not found.' });

  function baseUrl(req) {
    if (publicUrl) return publicUrl;
    const proto = req.get('x-forwarded-proto') || req.protocol;
    let host = req.get('x-forwarded-host') || req.get('host') || `localhost:${PORT}`;
    const [, hostname, port] = host.match(/^(\[[^\]]+\]|[^:]+)(?::(\d+))?$/) || [];
    const lan = lanAddress();
    if (lan && ['localhost', '127.0.0.1', '[::1]'].includes(hostname)) host = port ? `${lan}:${port}` : lan;
    return `${proto}://${host}`;
  }
  const joinUrl = (req, code) => `${baseUrl(req)}/e/${code}`;

  async function loadEvent(req, res, next) {
    const ev = await store.getEvent(codeOf(req));
    if (!ev) return notFound(res);
    req.ev = ev;
    next();
  }

  function requireHost(req, res, next) {
    if (!safeEqual(req.get('x-host-key') || '', req.ev.hostKey)) {
      return res.status(401).json({ error: 'Invalid host key.' });
    }
    next();
  }

  // API responses are never cached unless a route says so.
  app.use('/api', (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });

  app.get('/healthz', async (req, res) => {
    let ok = false;
    try {
      ok = await store.ping();
    } catch (err) {
      console.error('Store check failed:', err.message);
    }
    res.set('Cache-Control', 'no-store');
    res.status(ok ? 200 : 503).type('text').send(ok ? `ok (${kind})` : `${kind} store unreachable`);
  });

  // Lets the start page know whether to ask for a password, or, in single-session mode, where to go.
  app.get('/api/config', (req, res) => {
    res.json({
      passwordRequired: Boolean(createPassword),
      creationLocked: lockCreation,
      sessionCode: lockCreation ? sessionCode : '',
    });
  });

  // Create an event. The host key is returned once and is what unlocks the host dashboard.
  app.post('/api/events', async (req, res) => {
    if (lockCreation) return res.status(403).json({ error: 'New events cannot be created on this site.' });
    if (createPassword) {
      const failKey = `fail:${req.ip}`;
      if ((await store.peek(failKey)) >= CREATE_ATTEMPT_LIMIT) {
        return res.status(429).json({ error: 'Too many wrong passwords. Try again in a few minutes.' });
      }
      if (!safeEqual(req.body?.password ?? '', createPassword)) {
        await store.count(failKey, CREATE_ATTEMPT_WINDOW_SECONDS);
        return res.status(401).json({ error: 'Wrong password.' });
      }
    }
    const name = cleanText(req.body?.name);
    if (!name) return res.status(400).json({ error: 'Give your event a name.' });
    if (name.length > 80) return res.status(400).json({ error: 'The event name is too long (80 characters max).' });

    const hostKey = crypto.randomBytes(16).toString('hex');
    for (let attempt = 0; attempt < 5; attempt++) {
      const code = newCode();
      const created = await store.createEvent({ code, name, hostKey, moderated: Boolean(req.body?.moderated), createdAt: Date.now() });
      if (created) return res.status(201).json({ code, hostKey });
    }
    res.status(503).json({ error: 'Could not allocate an event code. Please try again.' });
  });

  app.get('/api/events/:code', loadEvent, (req, res) => {
    const { code, name, moderated } = req.ev;
    res.json({ code, name, moderated, joinUrl: joinUrl(req, code) });
  });

  // What the audience and the big screen poll. It is identical for everyone, so Vercel's CDN may
  // serve it from cache for a second: a whole room polling costs about one database read a second.
  app.get('/api/events/:code/state', async (req, res) => {
    const state = await store.getState(codeOf(req));
    if (!state) return notFound(res);
    res.set('Cache-Control', 'public, max-age=0, s-maxage=1');
    res.json(viewOf(state, false));
  });

  // What the host dashboard polls: all questions, never cached. ?since=<version> answers
  // { unchanged: true } when nothing happened, which keeps the polling cheap.
  app.get('/api/events/:code/host-state', async (req, res) => {
    const state = await store.getState(codeOf(req));
    if (!state) return notFound(res);
    if (!safeEqual(req.get('x-host-key') || '', state.event.hostKey)) {
      return res.status(401).json({ error: 'Invalid host key.' });
    }
    if (req.query.since !== undefined && String(state.version) === String(req.query.since)) {
      return res.json({ version: state.version, unchanged: true });
    }
    res.json(viewOf(state, true));
  });

  // Audience: ask a question.
  app.post('/api/events/:code/questions', loadEvent, async (req, res) => {
    const { ev } = req;
    const text = cleanText(req.body?.text);
    const author = cleanText(req.body?.author);
    const voterId = String(req.body?.voterId ?? '');

    if (!/^[\w-]{8,64}$/.test(voterId)) return res.status(400).json({ error: 'Missing client id.' });
    if (text.length < 3) return res.status(400).json({ error: 'Please write a bit more.' });
    if (text.length > MAX_QUESTION_LENGTH) {
      return res.status(400).json({ error: `Questions can be ${MAX_QUESTION_LENGTH} characters at most.` });
    }
    if (author.length > MAX_NAME_LENGTH) return res.status(400).json({ error: 'That name is too long.' });

    if (!(await store.claim(`ask:${ev.code}:${voterId}`, ASK_COOLDOWN_SECONDS))) {
      return res.status(429).json({ error: 'Slow down a little, then send again.' });
    }
    if ((await store.countQuestions(ev.code)) >= MAX_QUESTIONS_PER_EVENT) {
      return res.status(429).json({ error: 'This event has reached its question limit.' });
    }

    const question = {
      id: crypto.randomBytes(6).toString('hex'),
      text,
      author: author || null,
      createdAt: Date.now(),
      status: ev.moderated ? 'pending' : 'live',
    };
    const version = await store.addQuestion(ev.code, question);
    res.status(201).json({ id: question.id, status: question.status, version, question: toPublicQuestion(question) });
  });

  // Audience: upvote or withdraw an upvote. Idempotent, so the client decides the desired state.
  app.post('/api/events/:code/questions/:id/vote', async (req, res) => {
    const code = codeOf(req);
    const voterId = String(req.body?.voterId ?? '');
    if (!/^[\w-]{8,64}$/.test(voterId)) return res.status(400).json({ error: 'Missing client id.' });
    const q = await store.getQuestion(code, req.params.id);
    if (!q || !AUDIENCE_STATUSES.has(q.status)) return questionNotFound(res);
    const { votes, version } = await store.vote(code, q.id, voterId, Boolean(req.body?.up));
    res.json({ votes, version });
  });

  // Host: event settings.
  app.patch('/api/events/:code', loadEvent, requireHost, async (req, res) => {
    let { moderated } = req.ev;
    let version = null;
    if (typeof req.body?.moderated === 'boolean') {
      moderated = req.body.moderated;
      version = await store.updateEvent(req.ev.code, { moderated });
    }
    res.json({ moderated, version });
  });

  // Host: approve, mark as answered, or hide a question.
  app.patch('/api/events/:code/questions/:id', loadEvent, requireHost, async (req, res) => {
    const { code, spotlightId } = req.ev;
    const { status } = req.body || {};
    if (!HOST_STATUSES.has(status)) return res.status(400).json({ error: 'Invalid status.' });
    const q = await store.getQuestion(code, req.params.id);
    if (!q) return questionNotFound(res);
    let version = await store.setQuestionStatus(code, q.id, status);
    // A question leaves the big screen once it is answered or hidden.
    if (status !== 'live' && spotlightId === q.id) version = await store.updateEvent(code, { spotlightId: null });
    res.json({ id: q.id, status, version });
  });

  app.delete('/api/events/:code/questions/:id', loadEvent, requireHost, async (req, res) => {
    const { code, spotlightId } = req.ev;
    const q = await store.getQuestion(code, req.params.id);
    if (!q) return questionNotFound(res);
    let version = await store.deleteQuestion(code, q.id);
    if (spotlightId === q.id) version = await store.updateEvent(code, { spotlightId: null });
    res.json({ version });
  });

  // Host: choose which question is shown on the big screen (null clears it).
  app.put('/api/events/:code/spotlight', loadEvent, requireHost, async (req, res) => {
    const { code } = req.ev;
    const id = req.body?.id ?? null;
    if (id !== null) {
      const q = await store.getQuestion(code, String(id));
      if (!q) return questionNotFound(res);
      // Showing a question implies approving it.
      if (!AUDIENCE_STATUSES.has(q.status)) await store.setQuestionStatus(code, q.id, 'live');
    }
    const spotlightId = id === null ? null : String(id);
    const version = await store.updateEvent(code, { spotlightId });
    res.json({ spotlightId, version });
  });

  // Host: delete every question and start a fresh session. The event, its code and its QR code stay.
  app.post('/api/events/:code/clear', loadEvent, requireHost, async (req, res) => {
    const version = await store.clearQuestions(req.ev.code);
    res.json({ version });
  });

  // QR code that points to the audience page, for slides (PNG) or print (SVG).
  const qrOptions = { margin: 2, errorCorrectionLevel: 'M' };

  app.get('/api/events/:code/qr.png', async (req, res) => {
    const code = codeOf(req);
    if ((await store.getVersion(code)) === null) return notFound(res);
    const png = await QRCode.toBuffer(joinUrl(req, code), { ...qrOptions, type: 'png', width: 1024 });
    res.set('Cache-Control', 'public, max-age=300');
    if (req.query.download !== undefined) res.attachment(`qa-${code}.png`);
    res.type('png').send(png);
  });

  app.get('/api/events/:code/qr.svg', async (req, res) => {
    const code = codeOf(req);
    if ((await store.getVersion(code)) === null) return notFound(res);
    const svg = await QRCode.toString(joinUrl(req, code), { ...qrOptions, type: 'svg' });
    res.set('Cache-Control', 'public, max-age=300');
    if (req.query.download !== undefined) res.attachment(`qa-${code}.svg`);
    res.type('image/svg+xml').send(svg);
  });

  app.use('/api', (req, res) => res.status(404).json({ error: 'Not found.' }));

  app.use((err, req, res, next) => {
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON.' });
    if (err.type === 'entity.too.large') return res.status(413).json({ error: 'Request too large.' });
    console.error(err);
    res.status(500).json({ error: 'Something went wrong.' });
  });

  return app;
}

// ------------------------------------------------------------------ start

const { store, kind } = chooseStore();
const publicUrl = (process.env.PUBLIC_URL || '').replace(/\/+$/, '');
const createPassword = process.env.CREATE_PASSWORD || '';
// LOCK_CREATION=1 turns the site into a single-session site: nobody can create events, and the
// start page sends visitors to the first event in PERMANENT_EVENTS.
const lockCreation = ['1', 'true', 'yes'].includes(String(process.env.LOCK_CREATION || '').toLowerCase());
const sessionCode = String(process.env.PERMANENT_EVENTS || '').split(',').map((code) => code.trim().toUpperCase()).filter(Boolean)[0] || '';
const app = createApp(store, { kind, publicUrl, createPassword, lockCreation, sessionCode });

// Vercel imports this file and calls the exported app; `node server.js` listens by itself.
module.exports = app;
module.exports.createApp = createApp;
module.exports.chooseStore = chooseStore;

if (require.main === module) {
  app.listen(PORT, () => {
    console.log('Live Q&A is running');
    console.log(`  Local:   http://localhost:${PORT}`);
    const lan = lanAddress();
    if (lan) console.log(`  Network: http://${lan}:${PORT}  (phones on the same Wi-Fi can open this)`);
    if (publicUrl) console.log(`  Public:  ${publicUrl}`);
    console.log(
      kind === 'redis'
        ? '  Storage: Redis'
        : '  Storage: memory (questions are lost when the server stops; set UPSTASH_REDIS_REST_URL and _TOKEN to keep them)'
    );
    if (createPassword) console.log('  Creating events requires the CREATE_PASSWORD.');
    else if (publicUrl) console.warn('  Warning: PUBLIC_URL is set but CREATE_PASSWORD is not, so anyone with the address can create events.');
  });
}
