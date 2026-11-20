'use strict';

const { Redis } = require('@upstash/redis');

// Redis store (Upstash over HTTPS, which works from serverless functions). Same interface as the
// memory store. Everything for one event lives under qa:<CODE>:* and expires 30 days after its
// last write, so old events clean themselves up.
//
//   qa:<CODE>:ver    event version, bumped on every write (viewers poll this to spot changes)
//   qa:<CODE>:meta   hash: name, hostKey, moderated, spotlightId, createdAt
//   qa:<CODE>:q      hash: question id -> question JSON (text, author, createdAt, status)
//   qa:<CODE>:vc     hash: question id -> vote count
//   qa:<CODE>:votes  set of "<question id>:<voter id>", which makes one vote per voter atomic
const TTL_SECONDS = 30 * 24 * 60 * 60;
const PARTS = ['ver', 'meta', 'q', 'vc', 'votes'];

function createRedisStore({ url, token, permanentCodes = [] }) {
  // Events listed here never expire: their keys are persisted instead of getting a time limit.
  const permanent = new Set(permanentCodes.map((code) => code.toUpperCase()));
  // Automatic deserialization is off so strings stay strings: a question reading "12345" must not
  // come back as a number. With it off the client also returns HGETALL as a flat array.
  const redis = new Redis({ url, token, automaticDeserialization: false });
  const key = (code, part) => `qa:${code}:${part}`;

  function toObject(flat) {
    if (!Array.isArray(flat)) return flat ?? {};
    const object = {};
    for (let i = 0; i < flat.length; i += 2) object[flat[i]] = flat[i + 1];
    return object;
  }

  function parseMeta(code, meta) {
    return {
      code,
      name: meta.name,
      hostKey: meta.hostKey,
      moderated: meta.moderated === '1',
      spotlightId: meta.spotlightId || null,
      createdAt: Number(meta.createdAt),
    };
  }

  // Runs the caller's commands plus the version bump in one MULTI/EXEC, so a reader can never see a
  // new version next to old data. Returns the new version and the results of the caller's commands.
  async function write(code, build) {
    const tx = redis.multi();
    build(tx);
    tx.incr(key(code, 'ver'));
    for (const part of PARTS) {
      if (permanent.has(code)) tx.persist(key(code, part));
      else tx.expire(key(code, part), TTL_SECONDS);
    }
    const results = await tx.exec();
    const versionIndex = results.length - PARTS.length - 1;
    return { version: Number(results[versionIndex]), results: results.slice(0, versionIndex) };
  }

  async function getQuestion(code, id) {
    const raw = await redis.hget(key(code, 'q'), id);
    return raw ? JSON.parse(raw) : null;
  }

  return {
    async ping() {
      return (await redis.ping()) === 'PONG';
    },

    async createEvent({ code, name, hostKey, moderated, createdAt }) {
      const claimed = await redis.set(key(code, 'ver'), '1', permanent.has(code) ? { nx: true } : { nx: true, ex: TTL_SECONDS });
      if (claimed !== 'OK') return false;
      const tx = redis.multi().hset(key(code, 'meta'), {
        name,
        hostKey,
        moderated: moderated ? '1' : '0',
        spotlightId: '',
        createdAt: String(createdAt),
      });
      if (!permanent.has(code)) tx.expire(key(code, 'meta'), TTL_SECONDS);
      await tx.exec();
      return true;
    },

    async getEvent(code) {
      const meta = toObject(await redis.hgetall(key(code, 'meta')));
      return meta.hostKey ? parseMeta(code, meta) : null;
    },

    async updateEvent(code, fields) {
      const values = {};
      if ('moderated' in fields) values.moderated = fields.moderated ? '1' : '0';
      if ('spotlightId' in fields) values.spotlightId = fields.spotlightId ?? '';
      if (Object.keys(values).length === 0) return this.getVersion(code);
      return (await write(code, (tx) => tx.hset(key(code, 'meta'), values))).version;
    },

    async countQuestions(code) {
      return Number(await redis.hlen(key(code, 'q')));
    },

    async addQuestion(code, question) {
      return (await write(code, (tx) => tx.hset(key(code, 'q'), { [question.id]: JSON.stringify(question) }))).version;
    },

    getQuestion,

    async setQuestionStatus(code, id, status) {
      const question = await getQuestion(code, id);
      if (!question) return null;
      question.status = status;
      return (await write(code, (tx) => tx.hset(key(code, 'q'), { [id]: JSON.stringify(question) }))).version;
    },

    async deleteQuestion(code, id) {
      return (
        await write(code, (tx) => {
          tx.hdel(key(code, 'q'), id);
          tx.hdel(key(code, 'vc'), id);
        })
      ).version;
    },

    // Start a fresh session: every question, vote and spotlight goes; the event and its code stay.
    async clearQuestions(code) {
      return (
        await write(code, (tx) => {
          tx.del(key(code, 'q'));
          tx.del(key(code, 'vc'));
          tx.del(key(code, 'votes'));
          tx.hset(key(code, 'meta'), { spotlightId: '' });
        })
      ).version;
    },

    // SADD/SREM tell us atomically whether this voter's vote actually changed, so two taps or two
    // devices can't count twice. Returns the question's vote count and the event version.
    async vote(code, id, voterId, up) {
      const member = `${id}:${voterId}`;
      const changed = Number(up ? await redis.sadd(key(code, 'votes'), member) : await redis.srem(key(code, 'votes'), member));
      if (changed) {
        const { version, results } = await write(code, (tx) => tx.hincrby(key(code, 'vc'), id, up ? 1 : -1));
        return { votes: Math.max(0, Number(results[0])), version };
      }
      const [votes, version] = await redis.multi().hget(key(code, 'vc'), id).get(key(code, 'ver')).exec();
      return { votes: Math.max(0, Number(votes ?? 0)), version: Number(version ?? 0) };
    },

    async getVersion(code) {
      const version = await redis.get(key(code, 'ver'));
      return version === null ? null : Number(version);
    },

    // One round trip, consistent: version, event, questions and vote counts together.
    async getState(code) {
      const [version, rawMeta, rawQuestions, rawCounts] = await redis
        .multi()
        .get(key(code, 'ver'))
        .hgetall(key(code, 'meta'))
        .hgetall(key(code, 'q'))
        .hgetall(key(code, 'vc'))
        .exec();
      const meta = toObject(rawMeta);
      if (version === null || !meta.hostKey) return null;
      const counts = toObject(rawCounts);
      const questions = [];
      for (const raw of Object.values(toObject(rawQuestions))) {
        try {
          const question = JSON.parse(raw);
          questions.push({ ...question, votes: Math.max(0, Number(counts[question.id] ?? 0)) });
        } catch {
          /* skip an entry that isn't valid JSON rather than breaking the whole event */
        }
      }
      return { version: Number(version), event: parseMeta(code, meta), questions };
    },

    async claim(key_, seconds) {
      return (await redis.set(key_, '1', { nx: true, ex: seconds })) === 'OK';
    },

    async count(key_, seconds) {
      const count = Number(await redis.incr(key_));
      if (count === 1) await redis.expire(key_, seconds);
      return count;
    },

    async peek(key_) {
      return Number((await redis.get(key_)) ?? 0);
    },
  };
}

module.exports = { createRedisStore };
