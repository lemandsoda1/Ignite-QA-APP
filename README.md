# Live Q&A

A small Slido-style app for events. Put a QR code on your slide, the audience scans it, asks and upvotes questions, and you see them live and choose what goes on the big screen.

It runs on Vercel (serverless functions plus a Redis database) and also on your own computer.

## Use it in a presentation

1. **Create an event** on the start page. You get a 6-character code (e.g. `B4BCH6`) and a host dashboard.
2. **Get the QR code.** On the dashboard, click **Download PNG** (or SVG) and drop the image onto a slide. It points to `…/e/CODE`, the audience page.
3. **Audience:** scans the code, types a question (name optional), upvotes others. No app, no account.
4. **You:** keep the dashboard open on a laptop or second screen. For each question you can **Show on screen**, **Mark answered**, or **Hide** it.
5. **Big screen:** click **Open big screen** and share that window in your presentation (or put it on a projector). It shows the invite and QR code until you pick a question, then shows that question large. Press `F` for fullscreen.

**Approve questions first** (on the dashboard or when creating the event) holds new questions in the *Pending* tab until you approve them. Pressing *Show on screen* on a pending question approves it too.

The host dashboard is tied to the browser that created the event. To open it on another device, use **Copy host link** on the dashboard. Anyone with that link can moderate, so keep it private.

Updates arrive by polling, so they take a moment: your own actions show up immediately for you, the host sees new questions within about 2 seconds, and the audience and big screen within about 3 to 4 seconds.

## One permanent session with one QR code

For a single recurring session, use one event and never create another. The QR code points to `…/e/CODE`, and the code never changes.

- **Never expires:** normal events disappear 30 days after their last activity. An event listed in the `PERMANENT_EVENTS` setting (comma-separated codes) never does.
- **Fresh start between sessions:** on the host dashboard, **Clear all questions** deletes every question, vote and big-screen choice but keeps the event, its code and its QR code.
- **Keep the host link:** the host dashboard link (it contains a secret key) is the only way to moderate the event. Store it somewhere safe, for example in a password manager. The key is also remembered in the browser that created the event, separately for each web address.
- **No other events:** with `LOCK_CREATION=1` nobody can create events (the server answers 403), and the start page sends everyone straight to the first event in `PERMANENT_EVENTS`. It is off by default, so the start page lets you create events. To switch it on: `npx vercel env add LOCK_CREATION production --value 1 --no-sensitive --yes`, then deploy again; the base address then opens the question page of the permanent session. To switch it off again: `npx vercel env rm LOCK_CREATION production --confirm-name LOCK_CREATION`, then deploy again. The stress test (`npm run stress`) creates its own event, so it needs the lock off or a local server.
- To pin a different event: `npx vercel env add PERMANENT_EVENTS production --force --value CODE --no-sensitive --yes`, deploy again, and make the event's existing keys permanent once (they still carry the old 30-day limit until then).

## Deploying

The app runs on Vercel with an Upstash Redis database from Vercel's Marketplace (connect it to the project under **Storage**). The functions are pinned to Frankfurt (`fra1`) in [vercel.json](vercel.json); change `regions` there if your audience is elsewhere.

**Plan:** Vercel's free Hobby plan is for personal, non-commercial use, and its [fair use guidelines](https://vercel.com/docs/limits/fair-use-guidelines) count work done by a paid employee or consultant as commercial. For work events you'd need Pro.

### Deploy a change

```bash
cd ~/Desktop/live-qa && npx vercel --prod
```

`npx vercel` without `--prod` creates a preview deployment that only you can open (it's behind your Vercel login).

### Add a creation password

Run this, type a long password of your choice when asked, then deploy again so it applies:

```bash
cd ~/Desktop/live-qa && npx vercel env add CREATE_PASSWORD production
```

The start page then asks for the password when someone creates an event. The audience never needs it.

### Check that it's healthy

`https://<your-app>.vercel.app/healthz` should say `ok (redis)`. If it reports that the database isn't connected, the Redis integration is missing from the project: connect it under **Storage** in the Vercel dashboard and deploy again.

### Credentials on this computer

`.env.local` in this folder holds the database credentials (written by the Vercel CLI). It is excluded from git and from Vercel uploads. Don't share it. `npm start` ignores it, so local runs never touch the live database.

## Run it locally

```bash
cd ~/Desktop/live-qa
npm install      # first time only
npm start
```

Open <http://localhost:4000>. The terminal also prints a `Network:` address that phones on the same Wi-Fi can use. Locally, questions are kept in memory and are lost when you stop the server.

`npm test` runs the test suite (34 tests, against both the memory store and the Redis store).

## Stress test

`npm run stress -- <address>` simulates a room full of people on one event: everyone opens the page, asks a question, polls the list like the real page does and upvotes three other questions, while a simulated host watches the dashboard. At the end it checks that no question was lost and no vote was counted twice, and prints timings. It exits with an error if anything fails, if a request returns an error, or if asking takes longer than 3 seconds at the 95th percentile.

```bash
npm run stress -- http://localhost:4000 --users 100 --spread 0 --watch 30 --cleanup
```

Options: `--users` (default 100), `--spread` in milliseconds to spread the questions out instead of sending them all at the same instant (default 0), `--watch` seconds (default 30), `--votes` per person (default 3), `--cleanup` to delete the questions afterwards. Against a deployed site it creates a real event and uses roughly 5,000 database commands for 100 people, so keep an eye on your Upstash usage, and don't point it at someone else's server.

Example result on a deployed instance, 100 people asking at the same instant: 100 of 100 questions stored, 300 of 300 votes counted, no failed requests. Asking took 105 ms at the median and 126 ms at the 95th percentile; people saw their own question on screen after about 3.2 seconds and all 100 questions after about 3.9 seconds (mostly the polling interval); the host dashboard had all 100 within 1.8 seconds.

## How it works

- **Pages** (`public/`): plain HTML and JavaScript, no build step. `ask` is the audience page, `host` the dashboard, `screen` the big screen. On Vercel they are served from the CDN, and the rewrites in [vercel.json](vercel.json) map `/e/CODE`, `/host/CODE` and `/screen/CODE` to them.
- **Server** (`server.js`): an Express app. Vercel runs it as a single function; `npm start` runs it as a normal server.
- **Storage** (`lib/`): the app talks to one small store interface. `store-redis.js` keeps each event under `qa:<CODE>:*` in Redis and lets it expire 30 days after its last write; `store-memory.js` is used locally. Every write bumps a version number, and writes and the version bump happen in one transaction.
- **Live updates:** the pages poll. The audience and big screen poll one public endpoint that is the same for everyone, so Vercel's CDN serves it from cache for a second. A whole room therefore costs the function and database roughly one read per second, not one per person. The host dashboard polls an uncached endpoint and only receives data when something changed.
- **Host access:** creating an event returns a secret host key. It sits in the dashboard link (after the `#`) and is stored in the browser that created the event. Host actions send it in a request header, never in a URL.
- **Upvotes:** one per browser, tracked by an anonymous id kept in local storage. Fine for a town hall, but not tamper-proof.
- **Spam protection:** light only. 300 characters per question, a short cooldown between questions per browser, a cap of 2,000 questions per event, and limited wrong guesses at the creation password. Question text is always rendered as plain text.

## Settings

| Variable | Default | Meaning |
| --- | --- | --- |
| `KV_REST_API_URL` / `KV_REST_API_TOKEN` (or `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN`) | none | Redis connection. Vercel's Upstash integration sets the `KV_` names. Without them the app uses memory locally, and reports an error on Vercel. |
| `CREATE_PASSWORD` | none | When set, creating an event requires this password |
| `PERMANENT_EVENTS` | none | Comma-separated event codes that never expire |
| `LOCK_CREATION` | off | `1` turns off event creation and redirects the start page to the first `PERMANENT_EVENTS` code |
| `PUBLIC_URL` | derived from the request | Public base URL used in links and QR codes. Not needed on Vercel. |
| `PORT` | `4000` | Port for `npm start` |

To try the Redis path locally without touching the live database, run the test double and point the app at it:

```bash
node dev/fake-upstash.js 4300
```

```bash
UPSTASH_REDIS_REST_URL=http://127.0.0.1:4300 UPSTASH_REDIS_REST_TOKEN=dev-token npm start
```

## Design

The pages follow NoA Ignite's look as seen on [noaignite.com](https://noaignite.com): white paper, near-black ink (`#151d1f`), a pale mist blue (`#c2e0e7`), magenta (`#ff0abd`) for live and on-screen markers, a serif for headlines, a grotesk for everything else, thin lines, 4px corners and uppercase labels. All colours and fonts are set as variables at the top of [public/style.css](public/style.css).

- **Logo:** `public/brand/` holds the NoA Ignite primary lockup in a dark and a white version, copied from `Assets/NY logo/Primary Lockup`. The big screen switches to the white one in dark mode.
- **Fonts:** the official NoA type files ("Final NoaType"), used the way noaignite.com uses them: **NoA Serif** for headlines, **NoA Grotesk** for labels, buttons, tabs and metadata (it is an all-caps face), and **Inter** for reading text such as questions and form fields. Only the web files that are used are in `public/fonts/` (NoA Serif Regular, NoA Grotesk Regular, Inter Regular and Medium); the rest of the family is in the original zip. The NoA fonts are proprietary: a deployed site serves them to every visitor, so make sure that is covered by your licence. Inter is open source (SIL Open Font License, licence in `public/fonts/`). They are set in `public/style.css` as `--font-serif`, `--font-label` and `--font-sans`.
- **Big screen:** light mist background by default. Press `D` for a dark version (remembered per browser) and `F` for fullscreen.

## Security notes

- **No secrets in this repository.** The database credentials come from environment variables set in Vercel (or in a local `.env.local`, which git ignores). The only token in the code, `dev-token`, belongs to the local test server in `dev/`.
- **Creating events is open by default.** Anyone who knows the address can create events, and the per-person limits are light. For a public deployment set `CREATE_PASSWORD` (or `LOCK_CREATION`, see above).
- **Host access** is a secret key in the host link, sent in a request header and compared in constant time. Anyone with the link can moderate that event.
- **Brand assets:** the NoA Ignite logo and the NoA Serif and NoA Grotesk typefaces in `public/brand` and `public/fonts` belong to their owners and are included for this deployment only. Replace them if you fork the project.

## Not included

User accounts, polls and quizzes, and exporting questions.
