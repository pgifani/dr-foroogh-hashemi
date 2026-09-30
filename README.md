# Ainoor — Pediatric Clinic Website & Booking Backend

A bilingual (English + Persian/RTL) website for a doctor, with an online **appointment
booking system**, an **AI-style care-assistant chatbot**, and a small **Node backend**. New
bookings are pushed to the clinic's messaging apps — **Telegram and Bale (بله)** — with
Confirm/Decline buttons, and the doctor can **manage availability (days off, blocked slots)
straight from the bot** using Persian (Jalali/شمسی) or Gregorian dates. Patient SMS/WhatsApp is
optional (Twilio).

This README is both the documentation for this project **and a step-by-step playbook** so you
can build and deploy the next doctor's site from scratch.

> **Live example:** this project runs at `https://demo.ainoor.io`, self-hosted on a VPS with
> Coolify. It was also deployed as a static-only demo on Vercel.

---

## Table of contents
1. [What this is](#1-what-this-is)
2. [How it works (architecture)](#2-how-it-works-architecture)
3. [Repository structure](#3-repository-structure)
4. [Run it locally](#4-run-it-locally)
5. [Configuration (environment variables)](#5-configuration-environment-variables)
6. [Deploy option A — Vercel (quick static demo)](#6-deploy-option-a--vercel-quick-static-demo)
7. [Deploy option B — Your own VPS with Coolify (production)](#7-deploy-option-b--your-own-vps-with-coolify-production)
8. [Messaging channels & bot commands (Telegram + Bale)](#8-messaging-channels--bot-commands-telegram--bale)
9. [How to add a NEW client site](#9-how-to-add-a-new-client-site)
10. [Troubleshooting (the gotchas we hit)](#10-troubleshooting-the-gotchas-we-hit)
11. [Security notes](#11-security-notes)
12. [Roadmap](#12-roadmap)

---

## 1. What this is

A single, self-contained web project:

- **Two pages:** `index.html` (English) and `fa.html` (Persian, right-to-left) with a language
  switcher. Same design, translated content.
- **Appointment booking:** a weekly calendar showing **real availability** — a slot is open
  unless it's in the past, already booked, or blocked by the doctor. The patient taps a free
  slot, gives just their **name + phone**, and sees an instant on-page confirmation. The Persian
  page shows Jalali (شمسی) dates.
- **AI care assistant:** a floating chatbot answering logistics (hours, location, insurance,
  services, what to bring). It is rule-based and **deliberately never gives medical advice** —
  it routes symptoms to the doctor and emergencies to the local emergency number.
- **Booking → Telegram + Bale:** every booking is pushed to the clinic's **Telegram and Bale**
  chats with **✅ Confirm / ❌ Decline** buttons; confirming on one updates both. The bot also
  lists appointments (`/bookings`, `/pending`, `/today`).
- **Availability managed from the bot:** the doctor closes a day or a single time from the chat
  (`/availability` buttons, `/off فردا`, `/block 1405/07/11 10:00`, …) and the website's calendar
  reflects it immediately. Persian (Jalali) **and** Gregorian dates both work.
- **Backend (`server.mjs`):** serves the site and exposes `POST /api/book` + `GET /api/availability`.
  **Zero npm dependencies.** Runs in a safe **mock mode** (prints messages to the console) until you
  add credentials. Patient **SMS/WhatsApp via Twilio** is optional.

**Design choices:** custom teal + marigold palette (not generic "medical blue"), Fraunces +
Plus Jakarta Sans fonts (English), Vazirmatn (Persian). No frameworks, no build step.

---

## 2. How it works (architecture)

```
  Patient's browser
        │  loads index.html / fa.html  (+ 1.png … 4.png)
        │  GET  /api/availability   → greys out days off / blocked / already-booked slots
        │  POST /api/book  { name, phone, date, time, lang }
        ▼
  server.mjs  (Node 22, zero npm dependencies)
        ├─ serves the static site
        ├─ stores bookings → bookings.json  ·  availability blocks → blocks.json   (DATA_DIR)
        ├─ pushes the booking to Telegram AND Bale staff chats (Confirm / Decline buttons)
        ├─ (optional) Twilio SMS / WhatsApp → patient
        └─ long-polls each channel for: Confirm/Decline taps, and /bookings, /off, /block … commands
```

- **Channel-agnostic bot:** Telegram and Bale share the same bot API, so one code path serves
  both. Adding another (e.g. Eitaa) is one more entry in the `CHANNELS` array in `server.mjs`.
- **No database** — bookings/blocks are small JSON files on the data volume. Enough for a clinic;
  move to SQLite/Postgres later if you want.
- **No dependencies** — uses Node's built-in `http` and `fetch`. That's why it deploys anywhere
  with just `node server.mjs`.

---

## 3. Repository structure

```
website/
├── index.html            English site (structure, styles, and all JS inline)
├── fa.html               Persian (RTL) site
├── 1.png … 4.png         Photos used on the pages
├── server.mjs            Production server: static + /api/book + /api/availability
│                         + Telegram/Bale bot + Twilio ; includes Jalali↔Gregorian conversion
├── serve.mjs             A tiny static-only server (local preview, no backend)
├── Dockerfile            How Coolify/Docker builds and runs the app
├── .dockerignore         Files kept out of the Docker image (secrets, data, docs, serve.mjs…)
├── vercel.json           Config for the Vercel static deploy (framework: null = static)
├── .vercelignore         Files kept out of the Vercel deploy
├── .gitignore            Never commit .env, bookings.json or blocks.json
├── TELEGRAM-SETUP.md      Telegram + Bale + Twilio setup guide
├── CLAUDE.md             Notes for the AI assistant working on this repo
└── README.md             ← this file
```

Runtime data files created on the data volume (never committed): `bookings.json` (patient
requests) and `blocks.json` (the doctor's days off / blocked slots). `.env` holds secrets and is
also never committed.

---

## 4. Run it locally

You need **Node 18+** (built with Node 22).

**Full backend (booking API works, in mock mode):**
```bash
cd website
node server.mjs
```
Open http://localhost:3000. Submit a test booking — the Telegram/SMS messages that *would* be
sent are printed to the terminal.

**Static only (no backend):**
```bash
node serve.mjs
```

Change the port with `PORT=4000 node server.mjs`.

---

## 5. Configuration (environment variables)

All optional — without them the app runs in mock mode. Set them in a local `.env` file (for
local runs) or in your host's environment-variable settings (Vercel / Coolify).

| Variable | What it does |
|---|---|
| `PORT` | Port to listen on (default `3000`). |
| `DATA_DIR` | Folder for `bookings.json` + `blocks.json`. Set to a mounted volume in production (e.g. `/app/data`) so data survives redeploys. |
| `TELEGRAM_BOT_TOKEN` | From **@BotFather** (in Telegram). Enables Telegram. |
| `TELEGRAM_STAFF_CHAT_ID` | The Telegram chat that receives bookings. Message the bot `/id` to learn it. |
| `BALE_BOT_TOKEN` | From **@BotFather** (in the **Bale** app). Enables Bale — the same features as Telegram. |
| `BALE_STAFF_CHAT_ID` | The Bale chat that receives bookings. Message the Bale bot `/id` to learn it. |
| `TWILIO_ACCOUNT_SID` | Twilio account SID (enables real SMS/WhatsApp). |
| `TWILIO_AUTH_TOKEN` | Twilio auth token. |
| `TWILIO_FROM_NUMBER` | Your Twilio SMS number (`+1555…`). Enables **SMS**. |
| `TWILIO_WHATSAPP_FROM` | e.g. `whatsapp:+14155238886`. Enables **WhatsApp**. |
| `TWILIO_DEFAULT_COUNTRY` | Prefix for local numbers, e.g. `+44`. |

> **Never** put secrets in the HTML or commit `.env`. See `TELEGRAM-SETUP.md` for the full walkthrough.

---

## 6. Deploy option A — Vercel (quick static demo)

Best for **quickly sharing the look** with a client. Note: on Vercel's static hosting the
**Telegram/SMS backend does NOT run** — only the site + on-page booking confirmation. Use the VPS
(option B) for the real backend.

1. Install the CLI and log in:
   ```bash
   npm i -g vercel
   vercel login
   ```
2. From the `website` folder, deploy to production:
   ```bash
   vercel --prod
   ```
   - Choose **Create a new project**, give it a **lowercase** name, code directory `./`, and do
     **not** customise settings.
3. `vercel.json` already sets `"framework": null` so Vercel serves it as a **static site**
   (this is what fixes the "No entrypoint found" error — see Troubleshooting).
4. If the live URL shows a Vercel login wall, turn off **Settings → Deployment Protection →
   Vercel Authentication**.
5. Update later by re-running `vercel --prod`.

---

## 7. Deploy option B — Your own VPS with Coolify (production)

This gives you the **full backend** (Telegram/WhatsApp/SMS), your own domain, HTTPS, and room to
host many client sites on one server. [Coolify](https://coolify.io) is a free, self-hosted
dashboard (a Vercel-like experience on your own machine).

### 7.1 Buy a VPS
- Any provider works (Hetzner, Hostinger, DigitalOcean, Vultr…).
- **Recommended size:** 2 vCPU / 4–8 GB RAM / 40–100 GB SSD, **Ubuntu 24.04**.
- Pick a datacenter near your audience.
- *(This project used a Hostinger KVM 2: 2 vCPU / 8 GB / 100 GB, UK, with the one-click Coolify
  template — which pre-installs Coolify for you.)*

### 7.2 Install Coolify (skip if your VPS had a Coolify template)
SSH into the server and run the installer:
```bash
ssh root@<SERVER_IP>
curl -fsSL https://cdn.coollabs.io/coolify/install.sh | bash
```
Then open `http://<SERVER_IP>:8000` in a browser and **register the first account** — whoever
registers first becomes the admin, so do it immediately with a strong password.

### 7.3 Put the code on GitHub
Coolify deploys from a Git repo. From the `website` folder:
```bash
git init
git add .
git commit -m "Initial site"
```
> PowerShell note: run each command on its own line — PowerShell does **not** support `&&`.

Create an **empty repo** on github.com (e.g. `my-clinic-site`), make it **Public** (simplest;
there are no secrets in the code), then push:
```bash
git branch -M main
git remote add origin https://github.com/<username>/my-clinic-site.git
git push -u origin main
```

### 7.4 Create the app in Coolify
1. In Coolify: **Projects → your project → + New Resource → Public Git Repository**.
2. Paste the repo URL, branch `main`.
3. **IMPORTANT — set Build strategy to `Dockerfile`** (not the default "Railpack"/"Nixpacks").
   This app has no `package.json`, so only the Dockerfile knows how to run it.
4. Confirm **Exposed port = `3000`** and **Site type = Dynamic**.
5. **Deploy.** Watch the Deployment Logs — you want "New container is healthy" and "Success".
6. Coolify gives you a temporary `*.sslip.io` URL to test immediately.

### 7.5 Point your domain + get HTTPS
1. In your **domain's DNS** (e.g. Hostinger → Domains → DNS), add an **A record**:
   `Type: A · Name: demo (or clinic name) · Value: <SERVER_IP>`.
2. Verify it resolves (wait a few minutes): `nslookup demo.yourdomain.com`.
3. In Coolify → your app → **Domains → Add Domain** → enter `https://demo.yourdomain.com`
   (with `https://` so Coolify requests an SSL certificate).
4. **Redeploy the app** — the domain/cert only take effect on the next deploy (a fresh deploy
   makes the proxy pick up the new route and issue the Let's Encrypt certificate).
5. Open `https://demo.yourdomain.com` — you should see the padlock 🔒.

### 7.6 Persist booking data (do this once)
By default `bookings.json` lives inside the container and resets on each redeploy. Fix it:
1. Coolify → app → **Persistent Storage → Add** → mount path `/app/data`.
2. Coolify → app → **Environment Variables** → add `DATA_DIR = /app/data`.
3. **Redeploy.**

### 7.7 Add your secrets
Coolify → app → **Environment Variables** → add `TELEGRAM_BOT_TOKEN`, `TELEGRAM_STAFF_CHAT_ID`,
and any `TWILIO_*` values → **Redeploy**. (See section 8.)

---

## 8. Messaging channels & bot commands (Telegram + Bale)

The bot runs on **Telegram and/or Bale (بله)** — identical features on both (they share one bot
API). Any channel whose token is set becomes active; with none set, the app is in mock mode.
Full setup in `TELEGRAM-SETUP.md`.

### Connect a channel
1. **Create the bot** — open **@BotFather** in **Telegram** and/or in the **Bale** app → `/newbot`
   → choose a name + username → copy the token.
2. **Add the token** in Coolify → Environment Variables → **Redeploy**:
   - Telegram → `TELEGRAM_BOT_TOKEN`  ·  Bale → `BALE_BOT_TOKEN`
3. **Get the chat id** — open your bot in that app and send `/id`; it replies with the number.
   Add it as `TELEGRAM_STAFF_CHAT_ID` / `BALE_STAFF_CHAT_ID` → **Redeploy**.

### Bot commands (staff chat only)
**Appointments**
- `/bookings` – list all · `/pending` – awaiting confirmation · `/today` – today's

**Availability** (the website calendar updates immediately)
- `/availability` – next 14 days as buttons (Persian dates); tap to turn a day **⛔ off** / **✅ on**
- `/off <date>` · `/on <date>` – close / reopen a whole day
- `/block <date> <time>` · `/unblock <date> <time>` – block / free one slot
- `/blocked` – list current days off & blocked slots

**Dates** accept `today`/`امروز`, `tomorrow`/`فردا`, a **Jalali** date `1405/07/11` (Persian
digits OK), or a **Gregorian** date `2026-10-08`. A year under 1700 is treated as Jalali and
converted automatically. The grid buttons and confirmations are shown in Persian.

When a booking arrives, staff tap **✅ Confirm / ❌ Decline** — this updates the message on every
channel and (if Twilio is configured) texts the patient.

### Patient SMS / WhatsApp (optional — Twilio)
- **SMS:** create a Twilio account + number, set `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`,
  `TWILIO_FROM_NUMBER`, `TWILIO_DEFAULT_COUNTRY` (e.g. `+44`).
- **WhatsApp:** same account; test with the WhatsApp **sandbox**, then a registered sender +
  approved template for production. Set `TWILIO_WHATSAPP_FROM`.
- **Until Twilio is configured, no patient text is actually sent** (it's logged, not delivered).
  The on-page confirmation still shows and the doctor still gets every booking on Telegram/Bale.
  If you're not using SMS yet, soften the confirmation copy so it doesn't promise a text.

Redeploy after changing any env var.

---

## 9. How to add a NEW client site

The repeatable process for each new doctor:

1. **Copy the `website/` folder** to a new folder (or start a new repo from it).
2. **Edit the content** in `index.html` (and `fa.html` if bilingual):
   - Name, tagline, services, hours, address, phone, email.
   - Replace the photos (`1.png … 4.png`) and the doctor's portrait.
   - Update the colors in the `tailwind.config` block if you want a different palette.
3. **Push to a new GitHub repo** (one repo per client).
4. **In Coolify → + New Resource → Public Git Repository** → Dockerfile build → port 3000 → Deploy.
5. **Add a subdomain** for the client (`clinic-name.ainoor.io` or the client's own domain) and
   redeploy for HTTPS.
6. **Add that client's own** channel env vars (`TELEGRAM_*` and/or `BALE_*`, plus `TWILIO_*` if
   using SMS), and a persistent-storage mount at `/app/data`.

> Tip: register a client's **own domain in the client's name** so they own their brand. Keep the
> bare `ainoor.io` for your agency. One VPS can host many client sites — scale the server up
> (or add another) when it gets busy.

---

## 10. Troubleshooting (the gotchas we hit)

| Symptom | Cause & fix |
|---|---|
| PowerShell: `The token '&&' is not a valid statement separator` | PowerShell doesn't support `&&`. Run each command on its own line. |
| Vercel: **"No entrypoint found"** | Vercel saw the `.mjs` files and treated it as a Node server. Fix: `"framework": null` in `vercel.json` (deploys as static). |
| Vercel: project name rejected | Names must be **lowercase** (letters/numbers/`-`). |
| Vercel link shows a login wall | Turn off **Settings → Deployment Protection → Vercel Authentication**. |
| GitHub push: `unable to access … <you>` / 400 | The remote still had the literal `<you>`. Fix with `git remote set-url origin https://github.com/<real-username>/<repo>.git`. |
| Coolify app status **"Exited"** | Build strategy was **Railpack/Nixpacks**, which can't run an app with no `package.json`. Fix: set Build strategy to **Dockerfile**. |
| Domain shows **404** / SSL cert invalid after adding it in Coolify | The proxy/cert only apply on the next deploy. Fix: **Redeploy** the app. |
| Bookings disappear after a redeploy | `bookings.json` was inside the container. Fix: add **Persistent Storage** at `/app/data` + env `DATA_DIR=/app/data`. |
| Telegram/Bale not sending | Running in mock mode (messages print to the container logs). Add `TELEGRAM_BOT_TOKEN`/`BALE_BOT_TOKEN` + the matching `*_STAFF_CHAT_ID` and redeploy. |
| Booking says "we'll text you" but no SMS arrives | Twilio isn't configured, so patient SMS is mock (logged only). Add `TWILIO_*` env vars, or change the confirmation copy so it doesn't promise a text. |
| Bot doesn't reply to `/id` | Token not active yet — check you added it in Coolify and **redeployed**; look for `telegram: polling started` / `bale: polling started` in the logs. |
| Website calendar / Persian page not updating after a change | Browser cache. Do a **hard refresh** (Ctrl/Cmd+Shift+R) or open in a private window. The server sends `no-store`, but tabs can hold a stale copy. |
| DNS not resolving | Wait a few minutes after adding the A record; verify with `nslookup <subdomain>`. |

---

## 11. Security notes

- **Never commit secrets or patient data.** `.env`, `bookings.json` and `blocks.json` are
  gitignored. Secrets live only in the host's environment variables.
- **Staff-only bot commands.** `/bookings` and all availability commands only respond to the
  configured staff chat id — so if someone else finds the bot, they can't see patient data or
  change availability.
- **Patient data = privacy law** (GDPR/etc.). Collect the minimum (name + phone), add a privacy
  policy + consent before going fully live, and keep the chatbot to **non-medical** logistics.
- **Coolify admin:** register it immediately (first visitor becomes admin) and use a strong
  password.
- **VPS hardening (recommended):** SSH keys instead of passwords, a firewall (allow 22/80/443),
  and keep the server updated.

---

## 12. Roadmap

- **Real LLM chatbot:** replace the rule-based assistant with a Claude-powered agent behind
  `/api/chat` (grounded in the clinic's info, with a "book an appointment" tool and the
  no-medical-advice guardrail).
- **Config-driven template:** move all client-specific text into one config file so a new site is
  "fill in the blanks."
- **Client dashboard:** let each doctor see bookings and edit their hours.
- **Move to a database** (SQLite → Postgres) once you have several clients.
- **Object storage + CDN** when you add heavy media (e.g. the future UGC video product).

---

*Built as the first project of **Ainoor** — AI-powered websites for doctors.*
