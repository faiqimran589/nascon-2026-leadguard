# LeadGuard: Unified Business Management Platform

LeadGuard is a multi-tenant CRM. It guarantees that **every incoming lead has exactly one accountable owner**, escalates the lead automatically when that owner ignores it, and keeps every action traceable. It connects to real services:

- **Twilio WhatsApp/SMS** for messaging
- **Stripe (test mode)** for payments
- **Google Calendar (OAuth 2.0)** for appointments
- **Telegram** for escalation alerts

Built for the NASCON 2026 Web Development competition.

| What the judges asked for | Where to see it |
|---|---|
| Sign-up creates a workspace and its Owner; three levels; configurable permissions; masked values; server-side checks; workspace isolation (F1) | Sign-up, **Team**, **Roles & permissions** |
| Contacts, companies, opportunities; custom fields; per-pipeline fields; required fields per stage; editable pipeline; filters and saved lists; activity timeline; complete customer view (F2) | **Contacts**, **Opportunities**, **Pipelines & fields** |
| Intake from web form, WhatsApp and manual entry; availability; round-robin with a limit; acknowledgement countdown; escalation chain; absence handling; recovery queue; no double escalation; Telegram alerts (F3) | **Leads**, **Recovery queue**, **Assignment rules** |
| Tamper-proof audit history (F4) | **Audit log** |
| Live dashboard with drill-down, role-aware, customizable (F5) | **Dashboard** |
| Integrations page, sync history, retries, encrypted per-workspace secrets (I1–I5) | **Integrations** |

`docs/MASTER_PROMPT.md` is the full specification. Give it to any AI assistant to rebuild or extend the app. `docs/DEMO.md` is a 5-minute demo script.

---

## 1. How it is built

```
Browser (React + Vite)  ──HTTPS──▶  Express server (Render)  ──▶  PostgreSQL (Neon)
                                     ├─ REST API  /api/*          (auth, CRM, leads, dashboard, audit)
                                     ├─ Webhooks  /webhooks/*     (Twilio, Stripe — signature-verified)
                                     ├─ OAuth     /oauth/google/callback
                                     ├─ Live updates  /api/events (Server-Sent Events)
                                     └─ Worker (every 2 s): escalations, Telegram alerts, message retries
                                          ├──▶ Twilio      ├──▶ Stripe
                                          ├──▶ Google Calendar  └──▶ Telegram
```

- **One server, one URL.** The same Express app serves the API and the React app, so there are no CORS or cookie problems.
- **Timers live in the database.** Each lead has an `ack_deadline` column, and the worker checks it every few seconds. If the server restarts, nothing is lost.
- **No double escalation.** Due leads are claimed with `SELECT … FOR UPDATE SKIP LOCKED`, one transaction per lead, so it is safe even with several servers.

```
server/src/
  routes/        HTTP endpoints (auth, team, crm, opportunities, config, leads, engage, integrations, webhooks, public)
  services/      business rules (leads engine, metrics, messaging, payments, calendar, permissions, audit, worker)
  integrations/  provider clients (twilio, stripe, google, telegram) + encrypted credential store
  db/            schema.sql (auto-applied on start), seed.js, pool.js
  middleware/    sessions, permissions, CSRF
client/src/      React pages, components, styles
docs/            MASTER_PROMPT.md, DEMO.md
```

---

## 2. Run it on your computer (Windows)

You need **Node.js 20 or newer** (`node -v` should print v20 or higher) and a free **Neon** database.

1. **Install the libraries.** In VS Code, open **Terminal → New Terminal**, then run:
   ```powershell
   cd nascon-2026-leadguard
   npm install
   ```
   If you see *"running scripts is disabled on this system"*, run `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`, answer `Y`, and run `npm install` again.

2. **Create your `.env` file:**
   ```powershell
   Copy-Item .env.example .env
   ```
   Open `.env` and fill in two values:
   - `DATABASE_URL`: go to https://console.neon.tech, open your project, click **Connect**, and copy the connection string. If it ends with `&channel_binding=require`, delete that part.
   - `ENCRYPTION_KEY`: generate one with the command below, then paste the output:
     ```powershell
     node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
     ```
   **Keep this key forever.** Integration secrets are encrypted with it. If you change it, you have to reconnect your integrations.

3. **Start the app:**
   ```powershell
   npm run dev
   ```
   When it works, you see `LeadGuard running at http://localhost:3000`. The database tables are created automatically.

4. **Add demo data (optional, recommended).** Open a second terminal and run:
   ```powershell
   npm run seed
   ```
   This creates **Sunrise Solar (Demo)**. Log in as `owner@sunrise.demo`, password `Demo@12345`. The other accounts are `manager@`, `ayesha@`, `bilal@`, `omar@` (cannot see values), `backup@` and `admin@sunrise.demo`, all with the same password.

5. **Run the self-test (optional).** With `npm run dev` still running:
   ```powershell
   npm test
   ```
   It runs 65 end-to-end checks and should end with `65 passed, 0 failed`. It creates two throw-away workspaces.

> Webhooks (Twilio and Stripe) need a public HTTPS address, which your laptop does not have. Test those on the deployed Render URL (section 3). If you really want to test them locally, use a tunnel such as `cloudflared tunnel --url http://localhost:3000` and set `APP_URL` in `.env` to the tunnel URL.

---

## 3. Deploy for free (Render + Neon)

Do these in order:

1. **Push to GitHub** (your `.env` is ignored and never uploaded):
   ```powershell
   git add .
   git commit -m "LeadGuard"
   git push
   ```
2. **Create the web service.** On https://dashboard.render.com, click **New → Web Service**, connect GitHub, and pick `nascon-2026-leadguard`. Use these settings:

   | Setting | Value |
   |---|---|
   | Runtime | Node |
   | Region | the one closest to you, e.g. Singapore |
   | Build Command | `npm install && npm run build` |
   | Start Command | `npm start` |
   | Instance Type | Free |
   | Health Check Path (Advanced) | `/api/health` |

3. **Set environment variables** under **Environment**:
   - `DATABASE_URL`: the same Neon connection string you use locally
   - `ENCRYPTION_KEY`: **the same** key you use locally
   - `NODE_VERSION`: `22` (optional)

   You do **not** need `APP_URL`, because Render provides `RENDER_EXTERNAL_URL` automatically.
4. **Deploy.** Click **Create Web Service** and wait for "Live". Then open `https://<your-app>.onrender.com/api/health`. You should see `{"ok":true,...}`.
5. **Connect the integrations** on the live site's **Integrations** page (section 4). Use the URLs that page shows: they already contain your Render address and your workspace's secret token.

**Free-tier facts (check them on the providers' pricing pages; they change over time):**

- Render free web services **go to sleep after about 15 minutes without traffic**. The first request afterwards takes up to about a minute. While the service sleeps, the escalation timer is paused. When it wakes, the worker immediately processes everything that became due, because deadlines are stored in the database.
- **Before a demo, open the site a few minutes early** so the service is awake.
- Neon's free plan needs no card. Its database pauses when idle and wakes in about a second.

---

## 4. Connect the real services

Each workspace enters **its own** credentials on the **Integrations** page (Owner/Admin, or anyone with the "Manage integrations" permission). When you save, the app tests the credentials first and saves nothing if the test fails. Secrets are encrypted, never shown again in full, and never sent to the browser. Each card on the page also has a "How to set it up" section.

> Menu names on provider websites change from time to time. If a button is named slightly differently, look for the closest match.

### Twilio WhatsApp Sandbox (messaging)
1. Create a free account at https://www.twilio.com/try-twilio.
2. On the Console home page, under **Account Info**, copy the **Account SID** (starts with `AC`) and the **Auth Token**.
3. Go to **Messaging → Try it out → Send a WhatsApp message**. Note the sandbox number (usually `+1 415 523 8886`) and the **join phrase**.
4. From your phone, send the join phrase on WhatsApp to the sandbox number. Every customer phone used in the demo must do this once.
5. In LeadGuard's **Integrations → Messaging → Connect**, enter the SID, the token, sender `+14155238886` and channel WhatsApp, then save.
6. Copy the **Incoming message webhook** URL from LeadGuard. In Twilio's **Sandbox settings**, paste it into **"When a message comes in"**, choose **POST**, and save.
7. **Test it:** send a WhatsApp message from a new phone to the sandbox number. A contact and a lead appear in LeadGuard within seconds.

### Stripe (test mode payments)
1. Sign up at https://dashboard.stripe.com/register. No business verification is needed for test mode. Make sure **Test mode** is on.
2. Go to **Developers → API keys** and copy the **Secret key** (`sk_test_…`). In LeadGuard's **Integrations → Payments → Connect**, paste it and save.
3. Go to **Developers → Webhooks** (sometimes shown as **Event destinations**) and choose **Add endpoint**. Paste LeadGuard's **Webhook endpoint URL** and select these events: `checkout.session.completed`, `checkout.session.expired`, `checkout.session.async_payment_succeeded`, `checkout.session.async_payment_failed`, `payment_intent.payment_failed`, `charge.refunded`.
4. Open the endpoint, reveal the **Signing secret** (`whsec_…`), paste it into LeadGuard, and save again.
5. **Test it:** open an opportunity, choose **Request payment**, then **Open checkout**. Pay with card `4242 4242 4242 4242`, any future date and any CVC. The status turns **Paid** on its own. To test a refund, refund the payment in the Stripe Dashboard: it becomes **Refunded** in LeadGuard.

### Google Calendar (OAuth 2.0)
1. Go to https://console.cloud.google.com, create a project, then open **APIs & Services → Library**, search "Google Calendar API", and click **Enable**.
2. Configure the **OAuth consent screen** (also called **Google Auth Platform**): user type **External**, status **Testing**. Under **Test users**, add every Gmail address that will connect a calendar.
3. Go to **Credentials** (or **Clients**) → **Create credentials → OAuth client ID**, type **Web application**:
   - **Authorized redirect URI:** copy it from LeadGuard's Integrations page, e.g. `https://<your-app>.onrender.com/oauth/google/callback`. Add `http://localhost:3000/oauth/google/callback` as well if you test locally.
4. Copy the **Client ID** and **Client secret** into LeadGuard's **Integrations → Calendar**.
5. Each employee goes to **Profile → Connect Google Calendar** and accepts the consent screen.
6. While the app is in "Testing", Google can expire refresh tokens after 7 days. LeadGuard detects this and shows **Needs reconnection**.

### Telegram (escalation alerts)
1. In Telegram, open **@BotFather**, send `/newbot`, and choose a name and a username ending in `bot`. Copy the **token**.
2. Paste the token into LeadGuard's **Integrations → Notifications** and save.
3. Each employee goes to **Profile → Link Telegram**, opens the bot link, presses **Start**, then clicks **I pressed Start**. **Send test alert** confirms that it works.

---

## 5. Security in short

- Passwords are hashed with salted **scrypt**.
- Sessions are httpOnly cookies that expire (12 h idle, 7 days maximum), and you can end them everywhere.
- After 5 wrong passwords, an account is locked for 5 minutes. Logins are also rate-limited per IP address.
- Every endpoint checks the workspace and the permission **on the server**. IDs from another workspace return "not found".
- Input is validated with zod. All SQL is parameterized. React escapes all output. Requests carry a CSRF header and an Origin check.
- Webhooks are signature-verified (Twilio HMAC-SHA1, Stripe HMAC-SHA256 with a replay window). Forged requests are rejected and logged.
- Integration secrets are AES-256-GCM encrypted per workspace and masked in the UI.
- The audit log and the integration history are append-only, enforced by a database trigger.

---

## 6. Troubleshooting

| Problem | What to do |
|---|---|
| `Missing environment variable DATABASE_URL` | Your `.env` is missing or in the wrong folder. It must sit next to `package.json`. |
| `password authentication failed` / `ENOTFOUND` | Copy the Neon connection string again, and remove `&channel_binding=require` from the end. |
| `EADDRINUSE :3000` | Another program uses port 3000. Set `PORT=3001` in `.env`. |
| Twilio messages never arrive | The phone must have joined the sandbox. The webhook URL must be the Render URL, with POST. Check **Integrations → Synchronization history** for `rejected` rows. |
| "Invalid X-Twilio-Signature" in history | The URL in Twilio must match exactly what LeadGuard shows (https, no extra slash). |
| Stripe status does not change | Check that the webhook endpoint uses the correct URL, has the events listed above, and that its **signing secret** is saved. Stripe → Webhooks → your endpoint shows the delivery attempts. |
| Google: "redirect_uri_mismatch" | The redirect URI in Google Cloud must match LeadGuard's exactly. |
| Google: "access blocked / app not verified" | Add that Gmail address as a **Test user** on the consent screen. |
| "Stored credentials cannot be decrypted" | `ENCRYPTION_KEY` changed. Use the original key, or reconnect the integration. |
| Render site is slow on the first request | The free service was asleep. Wait about 30–60 seconds. |

---

## 7. Honest limitations

- Media messages (images, voice notes) are stored as "[media message — not displayed]".
- Only the employee's **primary** Google calendar is used.
- No email service is included, so invitations are shared as a copyable link.
- The worker runs inside the web process. On Render's free plan it pauses while the service sleeps, then catches up when it wakes.
