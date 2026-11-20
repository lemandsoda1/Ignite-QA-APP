'use strict';

// A small stand-in for Upstash's Redis REST API. The tests use it to exercise the real
// @upstash/redis client and lib/store-redis.js without a database account, and you can run it
// to try the app against "Redis" locally:
//
//   node dev/fake-upstash.js 4300
//   UPSTASH_REDIS_REST_URL=http://127.0.0.1:4300 UPSTASH_REDIS_REST_TOKEN=dev-token node server.js
//
// It implements only the commands this app uses, with Redis semantics (string replies for
// everything, flat arrays for HGETALL, expiry), and rejects anything else so a new command in
// the app can't slip through untested.

const http = require('http');

function createFakeUpstash({ token = 'test-token', now = Date.now } = {}) {
  const data = new Map(); // key -> { type: 'string' | 'hash' | 'set', value, expiresAt }
  const stats = { requests: 0, commands: 0 };

  function lookup(key) {
    const entry = data.get(key);
    if (entry && entry.expiresAt !== null && entry.expiresAt <= now()) {
      data.delete(key);
      return undefined;
    }
    return entry;
  }

  function typed(key, type, create = false) {
    const entry = lookup(key);
    if (entry && entry.type !== type) throw new Error('WRONGTYPE Operation against a key holding the wrong kind of value');
    if (entry || !create) return entry;
    const value = type === 'hash' ? new Map() : type === 'set' ? new Set() : '';
    const fresh = { type, value, expiresAt: null };
    data.set(key, fresh);
    return fresh;
  }

  const commands = {
    ping: () => 'PONG',
    get: ([key]) => typed(key, 'string')?.value ?? null,
    set: ([key, value, ...options]) => {
      let nx = false;
      let xx = false;
      let ttl = null;
      for (let i = 0; i < options.length; i++) {
        const option = options[i].toLowerCase();
        if (option === 'nx') nx = true;
        else if (option === 'xx') xx = true;
        else if (option === 'ex') ttl = Number(options[++i]) * 1000;
        else if (option === 'px') ttl = Number(options[++i]);
        else throw new Error(`ERR unsupported SET option ${option}`);
      }
      const exists = lookup(key) !== undefined;
      if ((nx && exists) || (xx && !exists)) return null;
      data.set(key, { type: 'string', value, expiresAt: ttl === null ? null : now() + ttl });
      return 'OK';
    },
    incr: ([key]) => {
      const entry = typed(key, 'string', true);
      const next = (entry.value === '' ? 0 : Number(entry.value)) + 1;
      entry.value = String(next);
      return next;
    },
    expire: ([key, seconds]) => {
      const entry = lookup(key);
      if (!entry) return 0;
      entry.expiresAt = now() + Number(seconds) * 1000;
      return 1;
    },
    persist: ([key]) => {
      const entry = lookup(key);
      if (!entry || entry.expiresAt === null) return 0;
      entry.expiresAt = null;
      return 1;
    },
    hset: ([key, ...pairs]) => {
      if (pairs.length === 0 || pairs.length % 2 !== 0) throw new Error("ERR wrong number of arguments for 'hset' command");
      const entry = typed(key, 'hash', true);
      let added = 0;
      for (let i = 0; i < pairs.length; i += 2) {
        if (!entry.value.has(pairs[i])) added++;
        entry.value.set(pairs[i], pairs[i + 1]);
      }
      return added;
    },
    hget: ([key, field]) => typed(key, 'hash')?.value.get(field) ?? null,
    hgetall: ([key]) => [...(typed(key, 'hash')?.value ?? [])].flat(),
    hlen: ([key]) => typed(key, 'hash')?.value.size ?? 0,
    hdel: ([key, ...fields]) => {
      const entry = typed(key, 'hash');
      if (!entry) return 0;
      let removed = 0;
      for (const field of fields) if (entry.value.delete(field)) removed++;
      if (entry.value.size === 0) data.delete(key);
      return removed;
    },
    hincrby: ([key, field, by]) => {
      const entry = typed(key, 'hash', true);
      const next = Number(entry.value.get(field) ?? 0) + Number(by);
      entry.value.set(field, String(next));
      return next;
    },
    sadd: ([key, ...members]) => {
      const entry = typed(key, 'set', true);
      let added = 0;
      for (const member of members) {
        if (!entry.value.has(member)) {
          entry.value.add(member);
          added++;
        }
      }
      return added;
    },
    srem: ([key, ...members]) => {
      const entry = typed(key, 'set');
      if (!entry) return 0;
      let removed = 0;
      for (const member of members) if (entry.value.delete(member)) removed++;
      if (entry.value.size === 0) data.delete(key);
      return removed;
    },
    del: (keys) => keys.filter((key) => lookup(key) !== undefined && data.delete(key)).length,
  };

  function execute(command) {
    const [name, ...args] = command;
    const handler = commands[String(name).toLowerCase()];
    if (!handler) throw new Error(`ERR unknown command '${name}'`);
    stats.commands++;
    // Redis receives every argument as a string, whatever the client sent.
    return handler(args.map(String));
  }

  // Newer clients can ask for base64-encoded replies ("OK" stays plain), older ones default to it.
  const encode = (value) => {
    if (typeof value === 'string') return value === 'OK' ? value : Buffer.from(value).toString('base64');
    return Array.isArray(value) ? value.map(encode) : value;
  };

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const send = (status, body) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(body));
      };
      if (req.headers.authorization !== `Bearer ${token}`) return send(401, { error: 'Unauthorized' });
      if (req.method !== 'POST') return send(405, { error: 'Method not allowed' });
      let body;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString());
      } catch {
        return send(400, { error: 'ERR invalid JSON' });
      }
      stats.requests++;
      const wantsBase64 = req.headers['upstash-encoding'] === 'base64';
      const run = (command) => {
        try {
          const result = execute(command);
          return { result: wantsBase64 ? encode(result) : result };
        } catch (err) {
          return { error: err.message };
        }
      };
      if (req.url === '/pipeline' || req.url === '/multi-exec') return send(200, body.map(run));
      if (req.url !== '/') return send(404, { error: 'Not found' });
      const out = run(body);
      send(out.error ? 400 : 200, out);
    });
  });

  return {
    token,
    stats,
    server,
    expiresAt: (key) => lookup(key)?.expiresAt ?? null,
    get url() {
      return `http://127.0.0.1:${server.address().port}`;
    },
    listen: (port = 0) => new Promise((resolve) => server.listen(port, '127.0.0.1', resolve)),
    close: () => new Promise((resolve) => {
      server.closeAllConnections?.();
      server.close(resolve);
    }),
  };
}

module.exports = { createFakeUpstash };

if (require.main === module) {
  const port = Number(process.argv[2]) || 4300;
  const fake = createFakeUpstash({ token: process.env.FAKE_UPSTASH_TOKEN || 'dev-token' });
  fake.listen(port).then(() => console.log(`Fake Upstash on http://127.0.0.1:${port} (token: ${fake.token})`));
}
