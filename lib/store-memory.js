'use strict';

// In-memory store for local development and tests. It implements the same interface as the
// Redis store, so everything above it behaves identically. Nothing here survives a restart.

function createMemoryStore({ now = Date.now } = {}) {
  const events = new Map(); // code -> { meta, questions: Map, voters: Set, counts: Map, version }
  const claims = new Map(); // key -> expiry timestamp
  const counters = new Map(); // key -> { count, expiresAt }

  const bump = (ev) => ++ev.version;

  function sweep() {
    const t = now();
    for (const [key, expiresAt] of claims) if (expiresAt <= t) claims.delete(key);
    for (const [key, entry] of counters) if (entry.expiresAt <= t) counters.delete(key);
  }

  return {
    async ping() {
      return true;
    },

    async createEvent({ code, name, hostKey, moderated, createdAt }) {
      if (events.has(code)) return false;
      events.set(code, {
        meta: { code, name, hostKey, moderated: Boolean(moderated), spotlightId: null, createdAt },
        questions: new Map(),
        voters: new Set(),
        counts: new Map(),
        version: 1,
      });
      return true;
    },

    async getEvent(code) {
      const ev = events.get(code);
      return ev ? { ...ev.meta } : null;
    },

    async updateEvent(code, fields) {
      const ev = events.get(code);
      if (!ev) return null;
      if ('moderated' in fields) ev.meta.moderated = Boolean(fields.moderated);
      if ('spotlightId' in fields) ev.meta.spotlightId = fields.spotlightId ?? null;
      return bump(ev);
    },

    async countQuestions(code) {
      return events.get(code)?.questions.size ?? 0;
    },

    async addQuestion(code, question) {
      const ev = events.get(code);
      if (!ev) return null;
      ev.questions.set(question.id, { ...question });
      return bump(ev);
    },

    async getQuestion(code, id) {
      const q = events.get(code)?.questions.get(id);
      return q ? { ...q } : null;
    },

    async setQuestionStatus(code, id, status) {
      const ev = events.get(code);
      const q = ev?.questions.get(id);
      if (!q) return null;
      q.status = status;
      return bump(ev);
    },

    async deleteQuestion(code, id) {
      const ev = events.get(code);
      if (!ev) return null;
      ev.questions.delete(id);
      ev.counts.delete(id);
      return bump(ev);
    },

    // Start a fresh session: every question, vote and spotlight goes; the event and its code stay.
    async clearQuestions(code) {
      const ev = events.get(code);
      if (!ev) return null;
      ev.questions.clear();
      ev.counts.clear();
      ev.voters.clear();
      ev.meta.spotlightId = null;
      return bump(ev);
    },

    // One upvote per voter and question. Returns the question's vote count and the event version.
    async vote(code, id, voterId, up) {
      const ev = events.get(code);
      if (!ev) return null;
      const member = `${id}:${voterId}`;
      let changed = false;
      if (up && !ev.voters.has(member)) {
        ev.voters.add(member);
        changed = true;
      } else if (!up && ev.voters.delete(member)) {
        changed = true;
      }
      if (changed) ev.counts.set(id, Math.max(0, (ev.counts.get(id) ?? 0) + (up ? 1 : -1)));
      return { votes: ev.counts.get(id) ?? 0, version: changed ? bump(ev) : ev.version };
    },

    async getVersion(code) {
      return events.get(code)?.version ?? null;
    },

    // Everything a view needs, in one read: the version, the event and all questions with votes.
    async getState(code) {
      const ev = events.get(code);
      if (!ev) return null;
      return {
        version: ev.version,
        event: { ...ev.meta },
        questions: [...ev.questions.values()].map((q) => ({ ...q, votes: ev.counts.get(q.id) ?? 0 })),
      };
    },

    // Set-if-absent with an expiry. True when this call took the claim.
    async claim(key, seconds) {
      sweep();
      if (claims.has(key)) return false;
      claims.set(key, now() + seconds * 1000);
      return true;
    },

    // Counter that expires `seconds` after its first increment. Returns the new count.
    async count(key, seconds) {
      sweep();
      const entry = counters.get(key) ?? { count: 0, expiresAt: now() + seconds * 1000 };
      entry.count += 1;
      counters.set(key, entry);
      return entry.count;
    },

    async peek(key) {
      sweep();
      return counters.get(key)?.count ?? 0;
    },
  };
}

module.exports = { createMemoryStore };
