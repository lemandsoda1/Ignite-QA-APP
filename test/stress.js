#!/usr/bin/env node
'use strict';

// Stress test: many people use one event at the same time, the way a room does after the host
// says "scan the code". It runs against any address, local or live:
//
//   node test/stress.js https://your-app.vercel.app
//   node test/stress.js http://localhost:4000 --users 200 --spread 5000
//
// Every simulated phone opens the page, asks one question, then polls the list every ~3 seconds
// like the real page and upvotes a few other people's questions. A simulated host polls the
// dashboard. At the end it checks that no question was lost and no vote was counted twice.
//
// Options (all optional):
//   --users N    people in the room (default 100)
//   --spread MS  spread the questions over this many ms; 0 means all at the same instant (default 0)
//   --watch S    how long people keep the page open, in seconds (default 30)
//   --votes N    upvotes per person (default 3)
//   --poll MS    audience polling interval (default 3000, same as the page)
//   --cleanup    delete the test questions afterwards

const args = process.argv.slice(2);
const base = (args.find((a, i) => !a.startsWith('--') && !args[i - 1]?.startsWith('--')) || 'http://localhost:4000').replace(/\/+$/, '');
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? Number(args[i + 1]) : fallback;
};
const USERS = opt('users', 100);
const SPREAD = opt('spread', 0);
const WATCH = opt('watch', 30) * 1000;
const VOTES = Math.min(opt('votes', 3), USERS - 1);
const POLL = opt('poll', 3000);
const CLEANUP = args.includes('--cleanup');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const jitter = (ms) => ms * (0.85 + Math.random() * 0.3);
const runId = Math.random().toString(36).slice(2, 8);
const stats = {}; // label -> { ms: [], status: {}, cache: {} }

async function call(label, method, path, body, headers = {}) {
  const entry = (stats[label] ??= { ms: [], status: {}, cache: {} });
  const started = performance.now();
  let status = 'error';
  let json = null;
  let cache = null;
  try {
    const res = await fetch(base + path, {
      method,
      headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(20_000),
    });
    status = res.status;
    cache = res.headers.get('x-vercel-cache');
    const text = await res.text();
    try {
      json = JSON.parse(text);
    } catch {
      /* pages are HTML */
    }
  } catch (err) {
    status = err.name === 'TimeoutError' ? 'timeout' : 'error';
  }
  const ms = performance.now() - started;
  entry.ms.push(ms);
  entry.status[status] = (entry.status[status] || 0) + 1;
  if (cache) entry.cache[cache] = (entry.cache[cache] || 0) + 1;
  return { status, json, ms };
}

const pct = (values, p) => {
  if (values.length === 0) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
};
const fmt = (ms) => (Number.isNaN(ms) ? '-' : ms >= 10_000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`);
const ok = (status) => typeof status === 'number' && status >= 200 && status < 300;

async function main() {
  console.log(`Stress test: ${USERS} people, questions spread over ${SPREAD} ms, ${WATCH / 1000}s watching, ${VOTES} votes each`);
  console.log(`Target: ${base}\n`);

  const created = await call('create event', 'POST', '/api/events', { name: `Stress test ${runId}` });
  if (!ok(created.status)) {
    console.error('Could not create the event:', created.status, created.json);
    process.exit(1);
  }
  const { code, hostKey } = created.json;
  const host = { 'x-host-key': hostKey };
  const api = (part = '') => `/api/events/${code}${part}`;
  console.log(`Event ${code} created\n`);

  const people = Array.from({ length: USERS }, (_, i) => ({
    i,
    voterId: `stress-${runId}-${String(i).padStart(4, '0')}`,
    questionId: null,
    askedAt: 0,
    sawOwnAfter: null,
    sawAllAfter: null,
    voted: false,
  }));
  const expectedVotes = new Map(); // question id -> votes we expect it to end with
  const T0 = Date.now();
  const deadline = T0 + WATCH;
  let hostSawAllAfter = null;

  async function person(me) {
    if (SPREAD) await sleep(Math.random() * SPREAD);
    // Opening the link on a phone: the page, the event info and the first list.
    await Promise.all([call('page', 'GET', `/e/${code}`), call('event info', 'GET', api()), call('state (poll)', 'GET', api('/state'))]);

    me.askedAt = Date.now();
    const asked = await call('ask a question', 'POST', api('/questions'), {
      text: `Question ${me.i + 1}: what happens when ${USERS} people ask at once?`,
      author: me.i % 3 === 0 ? `Person ${me.i + 1}` : '',
      voterId: me.voterId,
    });
    me.questionId = asked.json?.id ?? null;

    while (Date.now() < deadline) {
      await sleep(jitter(POLL));
      const state = await call('state (poll)', 'GET', api('/state'));
      const questions = state.json?.questions;
      if (!questions) continue;
      if (me.sawOwnAfter === null && me.questionId && questions.some((q) => q.id === me.questionId)) {
        me.sawOwnAfter = Date.now() - me.askedAt;
      }
      if (me.sawAllAfter === null && questions.length >= USERS) me.sawAllAfter = Date.now() - T0;
      if (!me.voted && questions.length >= Math.min(USERS, VOTES + 5)) {
        me.voted = true;
        const others = questions.filter((q) => q.id !== me.questionId);
        for (let n = 0; n < VOTES; n++) {
          const pick = others.splice(Math.floor(Math.random() * others.length), 1)[0];
          const result = await call('upvote', 'POST', api(`/questions/${pick.id}/vote`), { voterId: me.voterId, up: true });
          if (ok(result.status)) expectedVotes.set(pick.id, (expectedVotes.get(pick.id) || 0) + 1);
        }
      }
    }
  }

  async function hostLoop() {
    while (Date.now() < deadline) {
      const state = await call('host dashboard (poll)', 'GET', api('/host-state'), null, host);
      if (hostSawAllAfter === null && state.json?.questions?.length >= USERS) hostSawAllAfter = Date.now() - T0;
      await sleep(1500);
    }
  }

  await Promise.all([hostLoop(), ...people.map(person)]);

  // ---- verification: read the final truth straight from the host endpoint (never cached)
  await sleep(1500);
  const final = await call('final check', 'GET', api('/host-state'), null, host);
  const questions = final.json?.questions ?? [];
  const problems = [];
  const ids = new Set(questions.map((q) => q.id));
  if (questions.length !== USERS) problems.push(`expected ${USERS} questions, found ${questions.length}`);
  if (ids.size !== questions.length) problems.push('duplicate question ids');
  const lost = people.filter((p) => p.questionId && !ids.has(p.questionId)).length;
  if (lost) problems.push(`${lost} accepted question(s) are missing`);
  const rejected = people.filter((p) => !p.questionId).length;
  if (rejected) problems.push(`${rejected} question(s) were rejected or failed`);
  let wrongVotes = 0;
  let totalVotes = 0;
  for (const q of questions) {
    totalVotes += q.votes;
    if (q.votes !== (expectedVotes.get(q.id) || 0)) wrongVotes++;
  }
  const expectedTotal = [...expectedVotes.values()].reduce((a, b) => a + b, 0);
  if (wrongVotes) problems.push(`${wrongVotes} question(s) have the wrong vote count`);
  if (totalVotes !== expectedTotal) problems.push(`votes: counted ${totalVotes}, expected ${expectedTotal}`);
  const pending = questions.filter((q) => q.status !== 'live').length;
  if (pending) problems.push(`${pending} question(s) are not live`);
  const stragglers = people.filter((p) => p.sawAllAfter === null).length;
  if (stragglers) problems.push(`${stragglers} people never saw all ${USERS} questions on their screen`);
  for (const [label, entry] of Object.entries(stats)) {
    if (label === 'final check') continue;
    const bad = Object.entries(entry.status).filter(([s]) => !/^2\d\d$/.test(s));
    if (bad.length) problems.push(`${label}: ${bad.map(([s, n]) => `${n}x ${s}`).join(', ')}`);
  }
  const askP95 = pct(stats['ask a question']?.ms ?? [], 95);
  if (askP95 > 3000) problems.push(`asking is slow: p95 ${fmt(askP95)} (limit 3s)`);

  // ---- report
  const row = (cells) => cells.map((c, i) => String(c).padEnd([26, 7, 7, 8, 8, 8][i])).join('');
  console.log(row(['request', 'count', 'failed', 'p50', 'p95', 'max']));
  for (const [label, entry] of Object.entries(stats)) {
    const failed = Object.entries(entry.status).filter(([s]) => !/^2\d\d$/.test(s)).reduce((n, [, c]) => n + c, 0);
    console.log(row([label, entry.ms.length, failed, fmt(pct(entry.ms, 50)), fmt(pct(entry.ms, 95)), fmt(Math.max(...entry.ms))]));
  }
  const cache = stats['state (poll)']?.cache ?? {};
  if (Object.keys(cache).length) {
    console.log(`\nList reads by CDN cache: ${Object.entries(cache).map(([k, v]) => `${k} ${v}`).join(', ')}`);
  }
  const own = people.map((p) => p.sawOwnAfter).filter((v) => v !== null);
  const all = people.map((p) => p.sawAllAfter).filter((v) => v !== null);
  console.log(`\nSeeing their own question on screen:  p50 ${fmt(pct(own, 50))}  p95 ${fmt(pct(own, 95))}  max ${fmt(Math.max(...own))}  (${own.length}/${USERS} people)`);
  console.log(`Seeing all ${USERS} questions on screen:     p50 ${fmt(pct(all, 50))}  p95 ${fmt(pct(all, 95))}  max ${fmt(Math.max(...all))}  (${all.length}/${USERS} people)`);
  console.log(`Host dashboard saw all ${USERS} questions: ${hostSawAllAfter === null ? 'never' : `after ${fmt(hostSawAllAfter)}`}`);
  console.log(`Questions stored: ${questions.length}/${USERS}   votes counted: ${totalVotes}/${expectedTotal}`);

  if (CLEANUP) {
    let deleted = 0;
    for (let n = 0; n < questions.length; n += 10) {
      const batch = await Promise.all(questions.slice(n, n + 10).map((q) => call('cleanup', 'DELETE', api(`/questions/${q.id}`), null, host)));
      deleted += batch.filter((r) => ok(r.status)).length;
    }
    console.log(`Cleanup: deleted ${deleted} questions (the empty event ${code} expires on its own)`);
  }

  console.log(problems.length ? `\nFAILED\n- ${problems.join('\n- ')}` : '\nPASSED: nothing lost, nothing counted twice, no errors');
  console.log(`EVENT ${code}`);
  process.exit(problems.length ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
