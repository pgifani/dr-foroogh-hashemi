// All-in-one dev server for the pediatrics site:
//   1. Serves the static site (same as serve.mjs).
//   2. POST /api/book  -> notifies staff on Telegram with Confirm/Decline buttons,
//                          texts the patient a "request received" SMS (Twilio).
//   3. Long-polls Telegram: when staff taps Confirm/Decline, texts the patient the result.
//
// Runs on Node 18+ (uses built-in fetch). No npm install needed.
//
// Configuration (put these in website/.env or the workspace ../.env — NEVER in the page):
//   TELEGRAM_BOT_TOKEN=123456:ABC...        (from @BotFather)
//   TELEGRAM_STAFF_CHAT_ID=123456789         (message the bot "/id" to learn this)
//   TWILIO_ACCOUNT_SID=AC...                 (optional — enables patient SMS)
//   TWILIO_AUTH_TOKEN=...
//   TWILIO_FROM_NUMBER=+1555...
//   TWILIO_DEFAULT_COUNTRY=+1                 (prefixed to local numbers without a +)
//   PORT=3000
//
// Without TELEGRAM_BOT_TOKEN the server runs in MOCK mode: bookings still work and the
// message that WOULD be sent is printed to the console, so the front-end can be tested now.

import { createServer } from "node:http";
import { readFile, stat, readFile as rf } from "node:fs/promises";
import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { extname, join, normalize, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL(".", import.meta.url));

/* ---------- env (loaded from files; values are never logged) ---------- */
function loadEnv() {
  const env = { ...process.env };
  for (const p of [join(ROOT, ".env"), join(ROOT, "..", ".env")]) {
    if (!existsSync(p)) continue;
    for (const line of readFileSync(p, "utf8").split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
      if (m && env[m[1]] === undefined) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  }
  return env;
}
const ENV = loadEnv();
const PORT = Number(ENV.PORT) || 3000;

// Staff messaging channels. Telegram and Bale share the same bot API, so one code path serves both.
// A channel is "active" when its bot token is set.
const CHANNELS = [
  { name: "telegram", base: "https://api.telegram.org/bot", token: (ENV.TELEGRAM_BOT_TOKEN || "").trim(), staff: (ENV.TELEGRAM_STAFF_CHAT_ID || "").trim() },
  { name: "bale",     base: "https://tapi.bale.ai/bot",     token: (ENV.BALE_BOT_TOKEN || "").trim(),     staff: (ENV.BALE_STAFF_CHAT_ID || "").trim() },
].filter((c) => c.token);
const MOCK = CHANNELS.length === 0;

/* ---------- booking store (persisted to bookings.json) ---------- */
const DATA_DIR = process.env.DATA_DIR || ROOT;   // mount a volume here in prod (Coolify)
const DB = join(DATA_DIR, "bookings.json");
let bookings = [];
try { if (existsSync(DB)) bookings = JSON.parse(readFileSync(DB, "utf8")); } catch { bookings = []; }
const save = () => { try { writeFileSync(DB, JSON.stringify(bookings, null, 2)); } catch (e) { console.error("save failed:", e.message); } };
const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

/* ---------- availability blocks (days off + blocked slots), set from the bot ---------- */
const BLOCKS_DB = join(DATA_DIR, "blocks.json");
let blocks = { days: [], slots: [] };   // days: ["YYYY-MM-DD"], slots: ["YYYY-MM-DD HH:MM"]
try { if (existsSync(BLOCKS_DB)) blocks = { days: [], slots: [], ...JSON.parse(readFileSync(BLOCKS_DB, "utf8")) }; } catch {}
const saveBlocks = () => { try { writeFileSync(BLOCKS_DB, JSON.stringify(blocks, null, 2)); } catch (e) { console.error("saveBlocks failed:", e.message); } };
const isoAdd = (days) => { const d = new Date(); d.setUTCHours(0, 0, 0, 0); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().split("T")[0]; };
function parseDate(s) {
  s = (s || "").trim().toLowerCase();
  if (s === "today") return isoAdd(0);
  if (s === "tomorrow") return isoAdd(1);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}
// Inline keyboard: next 14 days, tap to toggle a whole day off/on.
function dayGridMarkup() {
  const rows = [];
  for (let i = 0; i < 14; i++) {
    const iso = isoAdd(i);
    const off = blocks.days.includes(iso);
    const label = `${off ? "⛔" : "✅"} ${new Date(iso + "T00:00:00Z").toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" })}`;
    if (i % 2 === 0) rows.push([]);
    rows[rows.length - 1].push({ text: label, callback_data: `dayoff:${iso}` });
  }
  return { inline_keyboard: rows };
}

/* ---------- messaging helpers (Telegram + Bale use the same bot API) ---------- */
async function api(ch, method, payload) {
  try {
    const r = await fetch(`${ch.base}${ch.token}/${method}`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload),
    });
    const j = await r.json();
    if (!j.ok) console.error(`${ch.name}.${method} error:`, j.description || JSON.stringify(j).slice(0, 200));
    return j;
  } catch (e) { console.error(`${ch.name}.${method} failed:`, e.message); return { ok: false }; }
}

function staffText(b) {   // plain text so it renders identically on Telegram and Bale
  const site = b.lang === "fa" ? "Persian site" : "English site";
  return `🗓 New appointment request\n\n👤 ${b.name}\n📞 ${b.phone}\n🕒 ${b.when}\n🌐 ${site}\n\nStatus: ⏳ pending`;
}
const bookingMarkup = (b) => ({ inline_keyboard: [[
  { text: "✅ Confirm", callback_data: `confirm:${b.id}` },
  { text: "❌ Decline", callback_data: `decline:${b.id}` },
]] });

// Send the booking to every active channel's staff chat.
async function notifyStaff(b) {
  const text = staffText(b);
  b.staffMsgs = b.staffMsgs || {};
  if (MOCK) { console.log(`[MOCK staff message]\n${text}`); return; }
  for (const ch of CHANNELS) {
    if (!ch.staff) continue;
    const res = await api(ch, "sendMessage", { chat_id: ch.staff, text, reply_markup: bookingMarkup(b) });
    if (res.result) b.staffMsgs[ch.name] = { chatId: res.result.chat.id, msgId: res.result.message_id };
  }
  save();
}

/* ---------- patient SMS (Twilio via REST, optional) ---------- */
const SMS = {
  sid: (ENV.TWILIO_ACCOUNT_SID || "").trim(),
  auth: (ENV.TWILIO_AUTH_TOKEN || "").trim(),
  from: (ENV.TWILIO_FROM_NUMBER || "").trim(),
  cc: (ENV.TWILIO_DEFAULT_COUNTRY || "").trim(),
};
const WA_FROM = (ENV.TWILIO_WHATSAPP_FROM || "").trim(); // e.g. whatsapp:+14155238886 (sandbox) or your WA sender
function toE164(phone) {
  let p = String(phone).replace(/[۰-۹]/g, (d) => "۰۱۲۳۴۵۶۷۸۹".indexOf(d)); // Persian digits -> ASCII
  p = p.replace(/[^\d+]/g, "");
  if (p.startsWith("+")) return p;
  if (p.startsWith("00")) return "+" + p.slice(2);
  if (p.startsWith("0") && SMS.cc) return SMS.cc + p.slice(1);
  return SMS.cc ? SMS.cc + p : p;
}
async function twilioSend(params, label, to, body) {
  if (!SMS.sid || !SMS.auth) { console.log(`[MOCK ${label} -> ${to}] ${body}`); return; }
  try {
    const creds = Buffer.from(`${SMS.sid}:${SMS.auth}`).toString("base64");
    const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${SMS.sid}/Messages.json`, {
      method: "POST", headers: { Authorization: `Basic ${creds}`, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(params),
    });
    if (!r.ok) console.error(`${label} error:`, (await r.json()).message);
  } catch (e) { console.error(`${label} failed:`, e.message); }
}
async function sendSms(to, body) {
  if (!SMS.from) { console.log(`[MOCK sms -> ${to}] ${body}`); return; }
  return twilioSend({ To: toE164(to), From: SMS.from, Body: body }, "sms", to, body);
}
async function sendWhatsApp(to, body) {
  if (!WA_FROM) { console.log(`[MOCK whatsapp -> ${to}] ${body}`); return; }
  const from = WA_FROM.startsWith("whatsapp:") ? WA_FROM : `whatsapp:${WA_FROM}`;
  return twilioSend({ To: `whatsapp:${toE164(to)}`, From: from, Body: body }, "whatsapp", to, body);
}
// Notify the patient on every configured channel (SMS and/or WhatsApp).
async function notifyPatient(b, kind) {
  const msg = patientMsg(b, kind);
  const jobs = [];
  if (WA_FROM) jobs.push(sendWhatsApp(b.phone, msg));
  if (SMS.from || !WA_FROM) jobs.push(sendSms(b.phone, msg)); // SMS on if configured, or as the mock fallback
  await Promise.allSettled(jobs);
}

const patientMsg = (b, kind) => {
  const fa = b.lang === "fa";
  const name = b.name.split(" ")[0];
  if (kind === "received") return fa
    ? `سلام ${name}، درخواست نوبت شما با دکتر هاشمی برای ${b.when} دریافت شد. به‌زودی تأیید می‌کنیم.`
    : `Hi ${name}, your appointment request with Dr. Hashemi for ${b.when} was received. We'll confirm shortly.`;
  if (kind === "confirmed") return fa
    ? `نوبت شما تأیید شد ✅ ${b.when}. منتظر دیدن‌تان هستیم! دکتر هاشمی`
    : `You're confirmed ✅ ${b.when}. See you then! — Dr. Hashemi's office`;
  return fa
    ? `متأسفیم، ${b.when} در دسترس نیست. لطفاً برای زمان دیگری تماس بگیرید. دکتر هاشمی`
    : `Sorry, ${b.when} isn't available. Please call us to pick another time. — Dr. Hashemi's office`;
};

/* ---------- bot updates: Confirm/Decline + commands (Telegram + Bale) ---------- */
async function handleCallback(ch, cq) {
  const data = cq.data || "";
  const ci = data.indexOf(":");
  const action = ci < 0 ? data : data.slice(0, ci);
  const id = ci < 0 ? "" : data.slice(ci + 1);

  // Day on/off toggle from the /availability grid (staff only).
  if (action === "dayoff") {
    if (ch.staff && String(cq.from && cq.from.id) !== String(ch.staff) && String(cq.message && cq.message.chat && cq.message.chat.id) !== String(ch.staff)) {
      return void api(ch, "answerCallbackQuery", { callback_query_id: cq.id, text: "Staff only." });
    }
    const wasOff = blocks.days.includes(id);
    blocks.days = wasOff ? blocks.days.filter((x) => x !== id) : [...blocks.days, id];
    saveBlocks();
    await api(ch, "editMessageReplyMarkup", { chat_id: cq.message.chat.id, message_id: cq.message.message_id, reply_markup: dayGridMarkup() });
    return void api(ch, "answerCallbackQuery", { callback_query_id: cq.id, text: wasOff ? `${id} reopened` : `${id} closed` });
  }

  const b = bookings.find((x) => x.id === id);
  if (!b) { await api(ch, "answerCallbackQuery", { callback_query_id: cq.id, text: "This booking is no longer available." }); return; }
  if (b.status !== "pending") { await api(ch, "answerCallbackQuery", { callback_query_id: cq.id, text: `Already ${b.status}.` }); return; }

  b.status = action === "confirm" ? "confirmed" : "declined";
  b.decidedAt = new Date().toISOString();
  save();

  const mark = b.status === "confirmed" ? "✅ CONFIRMED" : "❌ DECLINED";
  const who = (cq.from && (cq.from.first_name || cq.from.username)) || "staff";
  const finalText = staffText(b).replace("Status: ⏳ pending", `Status: ${mark} by ${who}`);
  // Reflect the decision on every channel that received this booking (and remove the buttons).
  for (const c of CHANNELS) {
    const rec = b.staffMsgs && b.staffMsgs[c.name];
    if (rec) await api(c, "editMessageText", { chat_id: rec.chatId, message_id: rec.msgId, text: finalText });
  }
  await api(ch, "answerCallbackQuery", { callback_query_id: cq.id, text: b.status === "confirmed" ? "Confirmed — patient notified." : "Declined — patient notified." });
  await notifyPatient(b, b.status);
}

async function handleMessage(ch, m) {
  const chat = m.chat.id;
  const raw = (m.text || "").trim();
  const parts = raw.split(/\s+/);
  const t = (parts[0] || "").toLowerCase();       // the command word
  const envName = ch.name === "bale" ? "BALE_STAFF_CHAT_ID" : "TELEGRAM_STAFF_CHAT_ID";
  const isStaff = !ch.staff || String(chat) === String(ch.staff);
  const say = (text, extra = {}) => api(ch, "sendMessage", { chat_id: chat, text, ...extra });

  if (t === "/id" || t === "/start" || t === "/help")
    return void say(
      `Your chat ID is ${chat}\nPut it in ${envName} to receive booking requests here.\n\n` +
      `APPOINTMENTS\n/bookings – list all\n/pending – pending only\n/today – today's\n\n` +
      `AVAILABILITY (staff)\n/availability – tap days to turn off/on\n/off <date> – close a day (e.g. /off tomorrow  ·  /off 2026-10-08)\n/on <date> – reopen a day\n/block <date> <time> – block one slot (e.g. /block 2026-10-08 10:00)\n/unblock <date> <time> – unblock a slot\n/blocked – show current blocks`);

  // ----- availability management (staff only) -----
  if (["/availability", "/dayoff", "/off", "/on", "/block", "/unblock", "/blocked"].includes(t)) {
    if (!isStaff) return void say("This command is only available to the clinic staff chat.");

    if (t === "/availability" || t === "/dayoff")
      return void say("Tap a day to turn it OFF (⛔) or back ON (✅) for bookings:", { reply_markup: dayGridMarkup() });

    if (t === "/blocked") {
      const days = blocks.days.slice().sort(), slots = blocks.slots.slice().sort();
      if (!days.length && !slots.length) return void say("No blocks — all business hours are open.");
      let txt = "⛔ Current blocks:";
      if (days.length) txt += "\n\nDays off:\n" + days.map((d) => "• " + d).join("\n");
      if (slots.length) txt += "\n\nBlocked slots:\n" + slots.map((s) => "• " + s).join("\n");
      return void say(txt);
    }

    if (t === "/off" || t === "/on") {
      const d = parseDate(parts[1]);
      if (!d) return void say("Give a date, e.g.  /off tomorrow  or  /off 2026-10-08");
      if (t === "/off") { if (!blocks.days.includes(d)) blocks.days.push(d); }
      else blocks.days = blocks.days.filter((x) => x !== d);
      saveBlocks();
      return void say(t === "/off" ? `⛔ ${d} is now closed for bookings.` : `✅ ${d} is open again.`);
    }

    if (t === "/block" || t === "/unblock") {
      const d = parseDate(parts[1]);
      const mt = (parts[2] || "").trim().match(/^(\d{1,2}):(\d{2})$/);
      if (!d || !mt) return void say("Use:  /block 2026-10-08 10:00");
      const key = `${d} ${mt[1].padStart(2, "0")}:${mt[2]}`;
      if (t === "/block") { if (!blocks.slots.includes(key)) blocks.slots.push(key); }
      else blocks.slots = blocks.slots.filter((x) => x !== key);
      saveBlocks();
      return void say(t === "/block" ? `⛔ Slot ${key} is blocked.` : `✅ Slot ${key} is unblocked.`);
    }
  }

  if (["/bookings", "/list", "/appointments", "/pending", "/today"].includes(t)) {
    // Patient data: only the configured staff chat may list bookings.
    if (!isStaff)
      return void say("This command is only available to the clinic staff chat.");

    let list = bookings.slice().sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
    let title = "All appointments";
    if (t === "/pending") { list = list.filter(b => b.status === "pending"); title = "Pending appointments"; }
    if (t === "/today") { const today = new Date().toISOString().split("T")[0]; list = list.filter(b => b.date === today); title = "Today's appointments"; }

    if (!list.length)
      return void api(ch, "sendMessage", { chat_id: chat, text: `📋 ${title}: none yet.` });

    const icon = s => (s === "confirmed" ? "✅" : s === "declined" ? "❌" : "⏳");
    const MAX = 30;
    const lines = list.slice(0, MAX).map(b =>
      `${icon(b.status)} ${b.name}\n   📞 ${b.phone} · 🕒 ${b.when}${b.lang === "fa" ? " · 🌐 FA" : ""}`);
    let text = `📋 ${title} (${list.length})\n\n` + lines.join("\n\n");
    if (list.length > MAX) text += `\n\n… and ${list.length - MAX} more.`;
    return void api(ch, "sendMessage", { chat_id: chat, text });
  }
}

async function pollChannel(ch) {
  let offset = 0;
  try { const r = await api(ch, "getUpdates", { timeout: 0 }); if (r.result?.length) offset = r.result[r.result.length - 1].update_id + 1; } catch {}
  console.log(`${ch.name}: polling started.`);
  for (;;) {
    try {
      const r = await api(ch, "getUpdates", { offset, timeout: 30 });
      for (const u of r.result || []) {
        offset = u.update_id + 1;
        if (u.callback_query) await handleCallback(ch, u.callback_query);
        else if (u.message) await handleMessage(ch, u.message);
      }
    } catch (e) { console.error(`${ch.name} poll error:`, e.message); await new Promise((r) => setTimeout(r, 3000)); }
  }
}

/* ---------- HTTP: /api/book + static ---------- */
function readBody(req) {
  return new Promise((resolve) => {
    let data = ""; req.on("data", (c) => { data += c; if (data.length > 1e5) req.destroy(); });
    req.on("end", () => resolve(data));
  });
}

async function handleBook(req, res) {
  let b;
  try { b = JSON.parse(await readBody(req)); } catch { return json(res, 400, { ok: false, error: "bad json" }); }
  const name = String(b.name || "").trim(), phone = String(b.phone || "").trim();
  if (!name || phone.replace(/[^\d۰-۹]/g, "").length < 7) return json(res, 400, { ok: false, error: "name and phone required" });

  const rec = {
    id: newId(), name, phone,
    date: String(b.date || ""), time: String(b.time || ""),
    when: String(b.when || `${b.date} ${b.time}`).slice(0, 120),
    lang: b.lang === "fa" ? "fa" : "en",
    status: "pending", createdAt: new Date().toISOString(),
  };
  bookings.push(rec); save();

  // fire notifications without blocking the response
  notifyStaff(rec);
  notifyPatient(rec, "received");

  json(res, 200, { ok: true, id: rec.id, status: "pending", mock: MOCK });
}

const TYPES = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8", ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".ico": "image/x-icon",
  ".woff": "font/woff", ".woff2": "font/woff2" };

const json = (res, code, obj) => { res.writeHead(code, { "content-type": "application/json; charset=utf-8" }); res.end(JSON.stringify(obj)); };

async function serveStatic(req, res) {
  let rel = decodeURIComponent((req.url || "/").split("?")[0]);
  if (rel.endsWith("/")) rel += "index.html";
  const full = normalize(join(ROOT, rel));
  if (!full.startsWith(ROOT.replace(/[\\/]$/, ""))) { res.writeHead(403); return res.end("403"); }
  try {
    const s = await stat(full);
    const file = s.isDirectory() ? join(full, "index.html") : full;
    const body = await readFile(file);
    res.writeHead(200, { "content-type": TYPES[extname(file).toLowerCase()] || "application/octet-stream", "cache-control": "no-store" });
    res.end(body);
  } catch { res.writeHead(404, { "content-type": "text/plain; charset=utf-8" }); res.end("404 Not Found"); }
}

createServer(async (req, res) => {
  const path = (req.url || "/").split("?")[0];
  if (req.method === "POST" && path === "/api/book") return handleBook(req, res);
  if (req.method === "GET" && path === "/api/bookings") return json(res, 200, bookings); // local convenience view
  if (req.method === "GET" && path === "/api/availability") {
    // The website reads this to grey out days off, blocked slots, and already-taken slots.
    const bookedSlots = bookings.filter((b) => b.status !== "declined").map((b) => `${b.date} ${b.time}`);
    return json(res, 200, { blockedDays: blocks.days, blockedSlots: blocks.slots, bookedSlots });
  }
  if (req.method === "GET") return serveStatic(req, res);
  res.writeHead(405); res.end("405");
}).listen(PORT, () => {
  console.log(`Serving ${ROOT} at http://localhost:${PORT}`);
  console.log(MOCK
    ? "Staff channels: MOCK mode (no TELEGRAM_BOT_TOKEN / BALE_BOT_TOKEN). Messages print to the console."
    : `Staff channels: ${CHANNELS.map(c => `${c.name}${c.staff ? "" : " (chat id NOT set — message the bot /id)"}`).join(", ")}`);
  console.log(SMS.from ? "Patient SMS: Twilio configured." : "Patient SMS: MOCK (set TWILIO_* to send real texts).");
  console.log(WA_FROM ? "Patient WhatsApp: Twilio configured." : "Patient WhatsApp: off (set TWILIO_WHATSAPP_FROM to enable).");
});

const BOT_COMMANDS = [
  { command: "bookings", description: "List all appointments" },
  { command: "pending", description: "Show pending appointments" },
  { command: "today", description: "Today's appointments" },
  { command: "availability", description: "Turn days off/on (buttons)" },
  { command: "off", description: "Close a day — /off tomorrow" },
  { command: "on", description: "Reopen a day — /on 2026-10-08" },
  { command: "blocked", description: "Show current blocks" },
  { command: "id", description: "Show this chat's ID" },
];
for (const ch of CHANNELS) {
  api(ch, "setMyCommands", { commands: BOT_COMMANDS });   // best-effort; ignored if unsupported
  pollChannel(ch);
}
