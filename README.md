# Ainoor — Pediatric Clinic Website & Booking Backend

A bilingual (English + Persian/RTL) website for a doctor, with an online **appointment
booking system**, an **AI-style care-assistant chatbot**, and a small **Node backend** that
sends new bookings to the clinic's **Telegram** (and optionally **WhatsApp/SMS**).

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
8. [Turn on Telegram / WhatsApp / SMS](#8-turn-on-telegram--whatsapp--sms)
9. [How to add a NEW client site](#9-how-to-add-a-new-client-site)
10. [Troubleshooting (the gotchas we hit)](#10-troubleshooting-the-gotchas-we-hit)
11. [Security notes](#11-security-notes)
12. [Roadmap](#12-roadmap)

---

## 1. What this is

A single, self-contained web project:

- **Two pages:** `index.html` (English) and `fa.html` (Persian, right-to-left) with a language
  switcher. Same design, translated content.
- **Appointment booking:** a weekly calendar of time slots. The patient taps a free slot, then
  gives just their **name + phone**. Shows an instant on-page confirmation.
- **AI care assistant:** a floating chatbot answering logistics (hours, location, insurance,
  services, what to bring). It is rule-based and **deliberately never gives medical advice** —
  it routes symptoms to the doctor and emergencies to the local emergency number.
- **Backend (`server.mjs`):** serves the site **and** exposes `POST /api/book`. On a booking it
  messages a **Telegram** staff chat (with Confirm/Decline buttons) and can text the patient via
  **Twilio SMS/WhatsApp**. Runs in a safe **mock mode** (prints messages to the console) until you
  add credentials.

**Design choices:** custom teal + marigold palette (not generic "medical blue"), Fraunces +
Plus Jakarta Sans fonts (English), Vazirmatn (Persian). No frameworks, no build step.

---

## 2. How it works (architecture)

```
  Patient's browser
        │  loads index.html / fa.html  (+ 1.png … 4.png)
        │  POST /api/book  { name, phone, date, time, lang }
        ▼
  server.mjs  (Node 22, zero npm dependencies)
        ├─ serves the static site
        ├─ stores the booking → bookings.json   (DATA_DIR)
        ├─ Telegram sendMessage → staff chat  (Confirm / Decline buttons)
        ├─ Twilio SMS / WhatsApp → patient
        └─ long-polls Telegram for the staff's Confirm/Decline tap → texts the patient the result
```

- **No database** — bookings are appended to a `bookings.json` file. Simple and enough for one
  clinic. (Move to SQLite/Postgres later if you want.)
- **No dependencies** — uses Node's built-in `http` and `fetch`. That's why it deploys anywhere
  with just `node server.mjs`.

---

## 3. Repository structure

```
website/
├── index.html            English site (structure, styles, and all JS inline)
├── fa.html               Persian (RTL) site
├── 1.png … 4.png         Photos used on the pages
├── server.mjs            The production server: static + /api/book + Telegram + Twilio
├── serve.mjs             A tiny static-only server (local preview, no backend)
├── Dockerfile            How Coolify/Docker builds and runs the app
├── .dockerignore         Files kept out of the Docker image (secrets, docs, serve.mjs…)
├── vercel.json           Config for the Vercel static deploy (framework: null = static)
├── .vercelignore         Files kept out of the Vercel deploy
├── .gitignore            Never commit .env or bookings.json
├── TELEGRAM-SETUP.md      Full Telegram + Twilio setup guide
├── CLAUDE.md             Notes for the AI assistant working on this repo
└── README.md             ← this file
```

Files that are **never committed** (in `.gitignore`): `.env` (secrets) and `bookings.json`
(patient data).

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
| `DATA_DIR` | Folder for `bookings.json`. Set to a mounted volume in production (e.g. `/app/data`) so data survives redeploys. |
| `TELEGRAM_BOT_TOKEN` | From **@BotFather**. Enables Telegram. Without it → mock mode. |
| `TELEGRAM_STAFF_CHAT_ID` | The chat that receives bookings. Message the bot `/id` to learn it. |
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

## 8. Turn on Telegram / WhatsApp / SMS

Full details in `TELEGRAM-SETUP.md`. In short:

1. **Telegram bot:** open **@BotFather** → `/newbot` → copy the token → set
   `TELEGRAM_BOT_TOKEN`.
2. **Staff chat id:** message your new bot `/id`; it replies with the number → set
   `TELEGRAM_STAFF_CHAT_ID`.
3. **SMS (optional):** create a Twilio account, get a number, set `TWILIO_ACCOUNT_SID`,
   `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_NUMBER`, `TWILIO_DEFAULT_COUNTRY`.
4. **WhatsApp (optional):** same Twilio account; use the WhatsApp **sandbox** for testing, then a
   registered sender + approved template for production. Set `TWILIO_WHATSAPP_FROM`.

Redeploy after changing env vars. Test a booking → the staff chat gets it with Confirm/Decline
buttons; tapping notifies the patient.

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
6. **Add that client's own** Telegram/Twilio env vars.

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
| Telegram/SMS not sending | Running in mock mode (messages print to the container logs). Add the `TELEGRAM_*` / `TWILIO_*` env vars and redeploy. |
| DNS not resolving | Wait a few minutes after adding the A record; verify with `nslookup <subdomain>`. |

---

## 11. Security notes

- **Never commit secrets.** `.env` and `bookings.json` are gitignored. Secrets live only in the
  host's environment variables.
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
