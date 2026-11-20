'use strict';

// Runs the same API checks against the in-memory store and against the Redis store, the latter
// through the real @upstash/redis client talking to dev/fake-upstash.js.

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createApp, chooseStore } = require('../server');
const { createMemoryStore } = require('../lib/store-memory');
const { createRedisStore } = require('../lib/store-redis');
const { createFakeUpstash } = require('../dev/fake-upstash');

// Both stores read this clock, so cooldowns and lockouts can be tested without waiting.
const clock = { t: Date.now() };
const now = () => clock.t;

function listen(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () =>
      resolve({
        base: `http://127.0.0.1:${server.address().port}`,
        close: () =>
          new Promise((done) => {
            server.closeAllConnections?.();
            server.close(done);
          }),
      })
    );
  });
}

async function http(base, method, path, body, headers = {}) {
  const res = await fetch(base + path, {
    method,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
    redirect: 'manual',
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* not JSON */
  }
  return { status: res.status, json, text, headers: res.headers };
}

const stores = {
  memory: async () => ({ store: createMemoryStore({ now }), fake: null, cleanup: async () => {} }),
  redis: async () => {
    const fake = createFakeUpstash({ now });
    await fake.listen();
    return { store: createRedisStore({ url: fake.url, token: fake.token }), fake, cleanup: () => fake.close() };
  },
};

let voterSeq = 0;
const voter = () => `voter-${String(++voterSeq).padStart(8, '0')}`;

for (const kind of Object.keys(stores)) {
  describe(`live Q&A API (${kind} store)`, () => {
    let ctx;
    let plain;
    let locked;

    before(async () => {
      ctx = await stores[kind]();
      plain = await listen(createApp(ctx.store, { kind }));
      locked = await listen(createApp(ctx.store, { kind, createPassword: 'correct-horse-battery' }));
    });
    after(async () => {
      await plain.close();
      await locked.close();
      await ctx.cleanup();
    });

    const call = (method, path, body, headers) => http(plain.base, method, path, body, headers);
    const q = (code, part = '') => `/api/events/${code}${part}`;
    const ask = (code, text, who = voter(), author) => call('POST', q(code, '/questions'), { text, author, voterId: who });
    const state = async (code) => (await call('GET', q(code, '/state'))).json;
    const hostState = async (code, host) => (await call('GET', q(code, '/host-state'), null, host)).json;
    async function newEvent(extra = {}) {
      const r = await call('POST', '/api/events', { name: 'Test event', ...extra });
      assert.equal(r.status, 201, r.text);
      return { code: r.json.code, host: { 'x-host-key': r.json.hostKey } };
    }

    test('creates events and validates input', async () => {
      assert.equal((await call('POST', '/api/events', { name: '   ' })).status, 400);
      assert.equal((await call('POST', '/api/events', { name: 'x'.repeat(81) })).status, 400);
      const { code } = await newEvent();
      assert.match(code, /^[A-HJ-NP-Z2-9]{6}$/);
      const info = await call('GET', q(code));
      assert.equal(info.status, 200);
      assert.equal(info.json.name, 'Test event');
      assert.match(info.json.joinUrl, new RegExp(`/e/${code}$`));
      assert.equal((await call('GET', q(code.toLowerCase()))).status, 200, 'codes are case-insensitive');
      for (const part of ['', '/state', '/host-state', '/qr.png', '/qr.svg']) {
        assert.equal((await call('GET', q('ZZZZZZ', part))).status, 404, `unknown event ${part}`);
      }
    });

    test('asking validates input, tidies text and rate-limits one person', async () => {
      const { code } = await newEvent();
      const who = voter();
      assert.equal((await ask(code, 'hi', who)).status, 400);
      assert.equal((await ask(code, 'x'.repeat(301), who)).status, 400);
      assert.equal((await ask(code, 'a valid question', 'short')).status, 400);
      assert.equal((await ask(code, 'a valid question', who, 'n'.repeat(41))).status, 400);

      // none of the rejected attempts used up this person's cooldown
      const ok = await ask(code, '  What  is\nthe   plan?  ', who, '  Ada   Lovelace ');
      assert.equal(ok.status, 201);
      assert.equal(ok.json.status, 'live');
      assert.equal(typeof ok.json.version, 'number');
      assert.deepEqual(
        { text: ok.json.question.text, author: ok.json.question.author, votes: ok.json.question.votes },
        { text: 'What is the plan?', author: 'Ada Lovelace', votes: 0 }
      );

      assert.equal((await ask(code, 'a second question quickly', who)).status, 429);
      assert.equal((await ask(code, 'asked by someone else', voter())).status, 201);
      clock.t += 4000; // the cooldown has passed
      assert.equal((await ask(code, 'a second question, later', who)).status, 201);
    });

    test('numeric-looking text stays text', async () => {
      const { code } = await newEvent({ name: '2026' });
      assert.equal((await ask(code, '12345', voter(), '2024')).status, 201);
      const s = await state(code);
      assert.equal(s.name, '2026');
      assert.equal(s.questions[0].text, '12345');
      assert.equal(s.questions[0].author, '2024');
    });

    test('public state exposes only what the audience may see, and may be cached briefly', async () => {
      const { code, host } = await newEvent();
      await ask(code, 'a visible question', voter());
      const r = await call('GET', q(code, '/state'));
      assert.equal(r.status, 200);
      assert.equal(r.headers.get('cache-control'), 'public, max-age=0, s-maxage=1');
      assert.equal(typeof r.json.version, 'number');
      assert.deepEqual(Object.keys(r.json).sort(), ['code', 'moderated', 'name', 'questions', 'spotlightId', 'version']);
      assert.deepEqual(Object.keys(r.json.questions[0]).sort(), ['author', 'createdAt', 'id', 'status', 'text', 'votes']);
      assert.ok(!r.text.includes(host['x-host-key']), 'the host key must not leak');
      assert.equal((await call('GET', q(code))).headers.get('cache-control'), 'no-store');
    });

    test('voting is idempotent, reversible and versioned', async () => {
      const { code } = await newEvent();
      const id = (await ask(code, 'please vote on me', voter())).json.id;
      const [a, b] = [voter(), voter()];
      const vote = (who, up) => call('POST', q(code, `/questions/${id}/vote`), { voterId: who, up });

      let r = await vote(a, true);
      assert.equal(r.json.votes, 1);
      const first = r.json.version;
      r = await vote(a, true);
      assert.equal(r.json.votes, 1, 'the same voter twice counts once');
      assert.equal(r.json.version, first, 'a repeated vote changes nothing');
      r = await vote(b, true);
      assert.equal(r.json.votes, 2);
      assert.ok(r.json.version > first);
      r = await vote(b, false);
      assert.equal(r.json.votes, 1);
      r = await vote(b, false);
      assert.equal(r.json.votes, 1, 'withdrawing twice is harmless');
      assert.equal((await state(code)).questions[0].votes, 1);
      assert.equal((await call('POST', q(code, '/questions/nope/vote'), { voterId: a, up: true })).status, 404);
      assert.equal((await vote('x', true)).status, 400);
    });

    test('host endpoints need the host key', async () => {
      const { code, host } = await newEvent();
      const id = (await ask(code, 'a question to moderate', voter())).json.id;
      for (const headers of [{}, { 'x-host-key': 'wrong' }]) {
        assert.equal((await call('GET', q(code, '/host-state'), null, headers)).status, 401);
        assert.equal((await call('PATCH', q(code, `/questions/${id}`), { status: 'answered' }, headers)).status, 401);
        assert.equal((await call('PUT', q(code, '/spotlight'), { id }, headers)).status, 401);
        assert.equal((await call('DELETE', q(code, `/questions/${id}`), null, headers)).status, 401);
        assert.equal((await call('PATCH', q(code), { moderated: true }, headers)).status, 401);
      }
      const r = await call('GET', q(code, '/host-state'), null, host);
      assert.equal(r.status, 200);
      assert.equal(r.headers.get('cache-control'), 'no-store');
      assert.equal(r.json.questions.length, 1);
      assert.equal((await call('GET', q(code, `/host-state?key=${host['x-host-key']}`))).status, 401, 'a key in the URL is not accepted');
    });

    test('host-state says "unchanged" when nothing happened since the given version', async () => {
      const { code, host } = await newEvent();
      const first = await hostState(code, host);
      const same = await call('GET', q(code, `/host-state?since=${first.version}`), null, host);
      assert.deepEqual(same.json, { version: first.version, unchanged: true });
      await ask(code, 'something new happened', voter());
      const changed = await call('GET', q(code, `/host-state?since=${first.version}`), null, host);
      assert.equal(changed.json.unchanged, undefined);
      assert.ok(changed.json.version > first.version);
      assert.equal(changed.json.questions.length, 1);
    });

    test('hosts can spotlight, answer, hide and delete questions', async () => {
      const { code, host } = await newEvent();
      const ids = [];
      for (const text of ['first question', 'second question', 'third question']) {
        ids.push((await ask(code, text, voter())).json.id);
      }
      const [id1, id2, id3] = ids;
      const patch = (id, status) => call('PATCH', q(code, `/questions/${id}`), { status }, host);
      const spotlight = (id) => call('PUT', q(code, '/spotlight'), { id }, host);

      let r = await spotlight(id1);
      assert.equal(r.status, 200);
      assert.equal(r.json.spotlightId, id1);
      assert.equal((await state(code)).spotlightId, id1);

      await patch(id1, 'answered');
      let s = await state(code);
      assert.equal(s.spotlightId, null, 'answering takes it off the screen');
      assert.equal(s.questions.find((x) => x.id === id1).status, 'answered');

      await spotlight(id2);
      await patch(id2, 'hidden');
      s = await state(code);
      assert.equal(s.spotlightId, null);
      assert.ok(!s.questions.some((x) => x.id === id2), 'hidden questions disappear for the audience');
      assert.ok((await hostState(code, host)).questions.some((x) => x.id === id2 && x.status === 'hidden'), 'but not for the host');
      assert.equal((await patch(id2, 'bogus')).status, 400);
      assert.equal((await patch('nope', 'live')).status, 404);

      await spotlight(id3);
      r = await call('DELETE', q(code, `/questions/${id3}`), null, host);
      assert.equal(r.status, 200);
      assert.equal(typeof r.json.version, 'number');
      s = await state(code);
      assert.equal(s.spotlightId, null);
      assert.ok(!s.questions.some((x) => x.id === id3));
      assert.equal((await spotlight('nope')).status, 404);

      await spotlight(id1); // an answered question can be shown again
      assert.equal((await state(code)).spotlightId, id1);
      await spotlight(null);
      assert.equal((await state(code)).spotlightId, null);
    });

    test('moderation holds questions until the host approves them', async () => {
      const { code, host } = await newEvent({ moderated: true });
      const posted = await ask(code, 'needs approval first', voter());
      assert.equal(posted.json.status, 'pending');
      assert.equal((await state(code)).questions.length, 0);
      assert.equal((await call('POST', q(code, `/questions/${posted.json.id}/vote`), { voterId: voter(), up: true })).status, 404);
      assert.equal((await hostState(code, host)).questions[0].status, 'pending');

      await call('PATCH', q(code, `/questions/${posted.json.id}`), { status: 'live' }, host);
      assert.equal((await state(code)).questions.length, 1);

      const second = await ask(code, 'also waiting for approval', voter());
      await call('PUT', q(code, '/spotlight'), { id: second.json.id }, host);
      const s = await state(code);
      assert.equal(s.spotlightId, second.json.id, 'showing a pending question approves it');
      assert.equal(s.questions.find((x) => x.id === second.json.id).status, 'live');

      let r = await call('PATCH', q(code), { moderated: false }, host);
      assert.equal(r.json.moderated, false);
      assert.equal((await ask(code, 'now questions are open', voter())).json.status, 'live');
      r = await call('PATCH', q(code), { moderated: true }, host);
      assert.equal(r.json.moderated, true);
      assert.equal((await state(code)).moderated, true);
    });

    test('every write moves the version forward and the response reports it', async () => {
      const { code, host } = await newEvent();
      let last = (await state(code)).version;
      const check = async (write) => {
        const r = await write();
        assert.ok(r.json.version > last, `version ${r.json.version} should exceed ${last}`);
        const s = await state(code);
        assert.ok(s.version >= r.json.version, 'a later read is at least as new as the write');
        last = s.version;
        return r;
      };
      const id = (await check(() => ask(code, 'a question for versions', voter()))).json.id;
      await check(() => call('POST', q(code, `/questions/${id}/vote`), { voterId: voter(), up: true }));
      await check(() => call('PUT', q(code, '/spotlight'), { id }, host));
      await check(() => call('PATCH', q(code, `/questions/${id}`), { status: 'answered' }, host));
      await check(() => call('PATCH', q(code), { moderated: true }, host));
      await check(() => call('DELETE', q(code, `/questions/${id}`), null, host));
    });

    test('serves QR codes as PNG and SVG', async () => {
      const { code } = await newEvent();
      const png = await fetch(plain.base + q(code, '/qr.png?download'));
      const bytes = new Uint8Array(await png.arrayBuffer());
      assert.equal(png.headers.get('content-type'), 'image/png');
      assert.deepEqual([...bytes.slice(1, 4)], [0x50, 0x4e, 0x47]);
      assert.match(png.headers.get('content-disposition'), new RegExp(`attachment; filename="?qa-${code}\\.png"?`));
      const svg = await call('GET', q(code, '/qr.svg'));
      assert.match(svg.headers.get('content-type'), /image\/svg\+xml/);
      assert.ok(svg.text.includes('<svg'));
    });

    test('serves the pages, a health check and security headers', async () => {
      const { code } = await newEvent();
      for (const path of ['/', `/e/${code}`, `/host/${code}`, `/screen/${code}`, '/style.css', '/app.js', '/screen.css']) {
        assert.equal((await call('GET', path)).status, 200, path);
      }
      const health = await call('GET', '/healthz');
      assert.equal(health.text, `ok (${kind})`);
      assert.equal(health.headers.get('x-content-type-options'), 'nosniff');
      assert.equal(health.headers.get('referrer-policy'), 'no-referrer');
      assert.equal(health.headers.get('x-powered-by'), null);
      assert.equal((await call('GET', '/api/nothing')).status, 404);
      const broken = await fetch(plain.base + '/api/events', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{broken',
      });
      assert.equal(broken.status, 400);
    });

    test('the creation password is enforced and wrong guesses are limited per client address', async () => {
      const create = (extra, headers) => http(locked.base, 'POST', '/api/events', { name: 'Locked', ...extra }, headers);
      const password = 'correct-horse-battery';
      assert.equal((await http(locked.base, 'GET', '/api/config')).json.passwordRequired, true);
      assert.equal((await http(plain.base, 'GET', '/api/config')).json.passwordRequired, false);
      assert.equal((await create({})).status, 401);
      assert.equal((await create({ password: 'wrong' })).status, 401);
      assert.equal((await create({ password: { nested: 1 } })).status, 401);
      const ok = await create({ password });
      assert.equal(ok.status, 201);

      const one = { 'x-forwarded-for': '203.0.113.1' };
      const two = { 'x-forwarded-for': '203.0.113.2' };
      for (let i = 0; i < 8; i++) assert.equal((await create({ password: `guess${i}` }, one)).status, 401);
      assert.equal((await create({ password: 'guess8' }, one)).status, 429);
      assert.equal((await create({ password }, one)).status, 429, 'locked out even with the right password');
      assert.equal((await create({ password }, two)).status, 201, 'other addresses are unaffected');

      const audience = await http(locked.base, 'POST', q(ok.json.code, '/questions'), { text: 'the audience needs no password', voterId: voter() });
      assert.equal(audience.status, 201);

      clock.t += (10 * 60 + 1) * 1000;
      assert.equal((await create({ password }, one)).status, 201, 'the lockout ends');
    });

    test('a locked site creates no new events but keeps running the existing one', async () => {
      const { code, host } = await newEvent({ name: 'The one session' });
      const single = await listen(createApp(ctx.store, { kind, lockCreation: true, sessionCode: code, createPassword: 'correct-horse-battery' }));
      try {
        const get = (path, headers) => http(single.base, 'GET', path, null, headers);
        const config = await get('/api/config');
        assert.deepEqual(config.json, { passwordRequired: true, creationLocked: true, sessionCode: code });
        assert.equal((await http(single.base, 'GET', '/api/config')).json.sessionCode, code);

        // nobody can create events, not even with the right password
        const create = await http(single.base, 'POST', '/api/events', { name: 'Another one', password: 'correct-horse-battery' });
        assert.equal(create.status, 403);
        assert.match(create.json.error, /cannot be created/);

        // the existing event keeps working for the audience and the host
        const asked = await http(single.base, 'POST', q(code, '/questions'), { text: 'still works when locked', voterId: voter() });
        assert.equal(asked.status, 201);
        assert.equal((await get(q(code, '/state'))).json.questions.length, 1);
        assert.equal((await http(single.base, 'POST', q(code, '/clear'), {}, host)).status, 200);
        assert.equal((await get(q(code, '/state'))).json.questions.length, 0);
      } finally {
        await single.close();
      }
      // an unlocked site reports no session
      assert.deepEqual((await call('GET', '/api/config')).json, { passwordRequired: false, creationLocked: false, sessionCode: '' });
    });

    test('falls back to the static pages when public/ is not part of the function', async () => {
      const bare = await listen(createApp(ctx.store, { kind, publicDir: '/nonexistent' }));
      try {
        for (const [path, file] of [['/e/ABC123', 'ask.html'], ['/host/ABC123', 'host.html'], ['/screen/ABC123', 'screen.html']]) {
          const r = await http(bare.base, 'GET', path);
          assert.equal(r.status, 302, path);
          assert.equal(r.headers.get('location'), `/${file}?code=ABC123`);
        }
        const home = await http(bare.base, 'GET', '/');
        assert.equal(home.status, 302);
        assert.equal(home.headers.get('location'), '/index.html');
      } finally {
        await bare.close();
      }
    });

    test('the host can clear all questions and start a fresh session with the same event', async () => {
      const { code, host } = await newEvent({ name: 'The one session' });
      const ids = [];
      for (const text of ['first question', 'second question', 'third question']) ids.push((await ask(code, text, voter())).json.id);
      await call('POST', q(code, `/questions/${ids[0]}/vote`), { voterId: voter(), up: true });
      await call('PUT', q(code, '/spotlight'), { id: ids[1] }, host);
      const before = (await state(code)).version;

      assert.equal((await call('POST', q(code, '/clear'), {})).status, 401, 'needs the host key');
      assert.equal((await call('POST', q(code, '/clear'), {}, { 'x-host-key': 'wrong' })).status, 401);
      assert.equal((await call('POST', q('ZZZZZZ', '/clear'), {}, host)).status, 404);

      const cleared = await call('POST', q(code, '/clear'), {}, host);
      assert.equal(cleared.status, 200);
      assert.ok(cleared.json.version > before);
      const s = await state(code);
      assert.equal(s.questions.length, 0, 'no questions left');
      assert.equal(s.spotlightId, null, 'nothing on the big screen');
      assert.equal(s.name, 'The one session', 'the event itself stays');
      assert.equal((await call('GET', q(code))).json.joinUrl.endsWith(`/e/${code}`), true, 'same code, same QR link');
      assert.equal((await hostState(code, host)).questions.length, 0);

      // a question deleted by the clear can no longer be voted on, and new ones start at zero votes
      assert.equal((await call('POST', q(code, `/questions/${ids[0]}/vote`), { voterId: voter(), up: true })).status, 404);
      const fresh = await ask(code, 'a question in the fresh session', voter());
      assert.equal(fresh.status, 201);
      assert.equal((await state(code)).questions[0].votes, 0);
    });

    test('claims and counters expire with the clock', async () => {
      const { store } = ctx;
      assert.equal(await store.claim('t:one', 3), true);
      assert.equal(await store.claim('t:one', 3), false);
      clock.t += 3500;
      assert.equal(await store.claim('t:one', 3), true);

      assert.equal(await store.count('t:n', 10), 1);
      assert.equal(await store.count('t:n', 10), 2);
      assert.equal(await store.peek('t:n'), 2);
      clock.t += 11_000;
      assert.equal(await store.peek('t:n'), 0);
      assert.equal(await store.count('t:n', 10), 1);
    });

    if (kind === 'redis') {
      test('a public state read is a single database round trip', async () => {
        const { code } = await newEvent();
        await ask(code, 'something to read', voter());
        const before = ctx.fake.stats.requests;
        assert.equal((await call('GET', q(code, '/state'))).status, 200);
        assert.equal(ctx.fake.stats.requests - before, 1);
      });

      test('permanent events never expire, however often they are written to', async () => {
        const fake = createFakeUpstash({ now });
        await fake.listen();
        try {
          const store = createRedisStore({ url: fake.url, token: fake.token, permanentCodes: ['pinned'] });
          const when = Date.now();
          const question = { id: 'q1', text: 'still here', author: null, createdAt: when, status: 'live' };
          assert.equal(await store.createEvent({ code: 'PINNED', name: 'Pinned', hostKey: 'k'.repeat(32), moderated: false, createdAt: when }), true);
          assert.equal(await store.createEvent({ code: 'NORMAL', name: 'Normal', hostKey: 'k'.repeat(32), moderated: false, createdAt: when }), true);
          for (const code of ['PINNED', 'NORMAL']) {
            await store.addQuestion(code, question);
            await store.vote(code, 'q1', 'voter-aaaaaaaa1', true);
          }
          const parts = ['ver', 'meta', 'q', 'vc', 'votes'];
          for (const part of parts) {
            assert.equal(fake.expiresAt(`qa:PINNED:${part}`), null, `pinned ${part} has no expiry`);
            assert.notEqual(fake.expiresAt(`qa:NORMAL:${part}`), null, `normal ${part} expires`);
          }

          // clearing and asking again must not bring an expiry back
          await store.clearQuestions('PINNED');
          await store.addQuestion('PINNED', { ...question, id: 'q2' });
          for (const part of ['ver', 'meta', 'q']) assert.equal(fake.expiresAt(`qa:PINNED:${part}`), null, `${part} after clear`);

          clock.t += 400 * 24 * 3600 * 1000; // more than a year later
          assert.equal((await store.getEvent('PINNED'))?.name, 'Pinned');
          assert.equal((await store.getState('PINNED')).questions.length, 1);
          assert.equal(await store.getEvent('NORMAL'), null, 'a normal event is long gone');
        } finally {
          await fake.close();
        }
      });

      test('event data expires 30 days after its last write', async () => {
        const { code } = await newEvent();
        await ask(code, 'this keeps the event alive', voter());
        const month = 30 * 24 * 3600 * 1000;
        for (const part of ['ver', 'meta', 'q']) {
          assert.equal(ctx.fake.expiresAt(`qa:${code}:${part}`), clock.t + month, part);
        }
      });
    }
  });
}

describe('without a database', () => {
  test('the API explains what is missing while the pages still load', async () => {
    const app = await listen(createApp(null, { kind: 'missing' }));
    try {
      const config = await http(app.base, 'GET', '/api/config');
      assert.equal(config.status, 503);
      assert.match(config.json.error, /database/i);
      assert.equal((await http(app.base, 'POST', '/api/events', { name: 'x' })).status, 503);
      assert.equal((await http(app.base, 'GET', '/healthz')).status, 503);
      assert.equal((await http(app.base, 'GET', '/e/ABC123')).status, 200);
    } finally {
      await app.close();
    }
  });
});

describe('choosing the store', () => {
  test('picks memory, Redis or "missing" from the environment', () => {
    assert.equal(chooseStore({}).kind, 'memory');
    assert.deepEqual(chooseStore({ VERCEL: '1' }), { store: null, kind: 'missing' });
    assert.equal(chooseStore({ UPSTASH_REDIS_REST_URL: 'https://x.example.com', UPSTASH_REDIS_REST_TOKEN: 't' }).kind, 'redis');
    assert.equal(chooseStore({ KV_REST_API_URL: 'https://x.example.com', KV_REST_API_TOKEN: 't', VERCEL: '1' }).kind, 'redis');
    assert.equal(chooseStore({ KV_REST_API_URL: 'https://x.example.com' }).kind, 'memory', 'a URL without a token is not enough');
  });
});
