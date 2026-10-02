// All-in-one dev server for the pediatrics site:
//   1. Serves the static site (same as serve.mjs).
//   2. POST /api/book  -> notifies staff on Telegram/Bale with Confirm/Decline buttons,
//                          emails the patient a "request received" note (Resend).
//   3. Long-polls the bot: when staff taps Confirm/Decline, emails the patient the result.
//
// Runs on Node 18+ (uses built-in fetch). No npm install needed.
//
// Configuration (put these in website/.env or the workspace ../.env — NEVER in the page):
//   TELEGRAM_BOT_TOKEN=123456:ABC...        (from @BotFather)
//   TELEGRAM_STAFF_CHAT_ID=123456789         (message the bot "/id" to learn this)
//   RESEND_API_KEY=re_...                    (enables patient email — resend.com)
//   MAIL_FROM=Dr. Hashemi <booking@ainoor.io> (verified Resend sender)
//   MAIL_REPLY_TO=clinic@ainoor.io            (optional — where patient replies go)
//   PUBLIC_BASE_URL=https://demo.ainoor.io    (used to build the patient's cancel link)
//   CLINIC_WHATSAPP=+989120000000             (doctor's WhatsApp — sent to patients for online visits)
//   TWILIO_ACCOUNT_SID=AC...                 (optional — enables patient SMS)
//   TWILIO_AUTH_TOKEN=...
//   TWILIO_FROM_NUMBER=+1555...
//   TWILIO_WHATSAPP_FROM=whatsapp:+1555...   (optional — enables patient WhatsApp)
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
import { randomUUID } from "node:crypto";

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
const newToken = () => randomUUID().replace(/-/g, "");
// Iranian national ID (کد ملی): 10 digits with a checksum; Persian digits accepted.
const toAsciiDigits = (s) => String(s).replace(/[۰-۹]/g, (d) => "۰۱۲۳۴۵۶۷۸۹".indexOf(d)).replace(/\D/g, "");
function validCodeMelli(v) {
  if (!/^\d{10}$/.test(v) || /^(\d)\1{9}$/.test(v)) return false;
  let s = 0; for (let i = 0; i < 9; i++) s += (+v[i]) * (10 - i);
  const r = s % 11, c = +v[9];
  return r < 2 ? c === r : c === 11 - r;
}
const PUBLIC_BASE = (ENV.PUBLIC_BASE_URL || "").trim().replace(/\/$/, "");
// Absolute link the patient taps to cancel. Falls back to the base captured at booking time.
const cancelUrl = (b) => {
  const base = (b.base || PUBLIC_BASE || "").replace(/\/$/, "");
  return base && b.cancelToken ? `${base}/cancel?id=${encodeURIComponent(b.id)}&t=${encodeURIComponent(b.cancelToken)}` : "";
};

// Visit types: in-person, or online over WhatsApp (video / text).
const VISIT_TYPES = new Set(["in-person", "video", "text"]);
const isOnline = (t) => t === "video" || t === "text";
const CLINIC_WHATSAPP = (ENV.CLINIC_WHATSAPP || "").trim();           // e.g. +98912…
const waDigits = CLINIC_WHATSAPP.replace(/[^\d]/g, "");
const waLink = waDigits ? `https://wa.me/${waDigits}` : "";
function visitLabel(type, lang) {
  const fa = lang === "fa";
  if (type === "video") return fa ? "ویزیت آنلاین تصویری (واتس‌اپ)" : "Online video visit (WhatsApp)";
  if (type === "text")  return fa ? "ویزیت آنلاین متنی (واتس‌اپ)"   : "Online text visit (WhatsApp)";
  return fa ? "ویزیت حضوری" : "In-person visit";
}

/* ---------- availability blocks (days off + blocked slots), set from the bot ---------- */
const BLOCKS_DB = join(DATA_DIR, "blocks.json");
let blocks = { days: [], slots: [] };   // days: ["YYYY-MM-DD"], slots: ["YYYY-MM-DD HH:MM"]
try { if (existsSync(BLOCKS_DB)) blocks = { days: [], slots: [], ...JSON.parse(readFileSync(BLOCKS_DB, "utf8")) }; } catch {}
const saveBlocks = () => { try { writeFileSync(BLOCKS_DB, JSON.stringify(blocks, null, 2)); } catch (e) { console.error("saveBlocks failed:", e.message); } };
const isoAdd = (days) => { const d = new Date(); d.setUTCHours(0, 0, 0, 0); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().split("T")[0]; };
/* ---------- Jalali (Persian) <-> Gregorian, for Persian date input & display ---------- */
const _div = (a, b) => Math.trunc(a / b);
const FA_MONTHS = ["فروردین","اردیبهشت","خرداد","تیر","مرداد","شهریور","مهر","آبان","آذر","دی","بهمن","اسفند"];
const FA_WEEK = ["یکشنبه","دوشنبه","سه‌شنبه","چهارشنبه","پنجشنبه","جمعه","شنبه"]; // index = JS getUTCDay (0=Sun)
const toFa = (s) => String(s).replace(/\d/g, (d) => "۰۱۲۳۴۵۶۷۸۹"[d]);
function g2j(gy, gm, gd) {
  const gdm = [0,31,59,90,120,151,181,212,243,273,304,334];
  let jy; if (gy > 1600) { jy = 979; gy -= 1600; } else { jy = 0; gy -= 621; }
  const gy2 = gm > 2 ? gy + 1 : gy;
  let days = 365*gy + _div(gy2+3,4) - _div(gy2+99,100) + _div(gy2+399,400) - 80 + gd + gdm[gm-1];
  jy += 33*_div(days,12053); days %= 12053;
  jy += 4*_div(days,1461); days %= 1461;
  if (days > 365) { jy += _div(days-1,365); days = (days-1)%365; }
  let jm, jd;
  if (days < 186) { jm = 1 + _div(days,31); jd = 1 + (days % 31); }
  else { jm = 7 + _div(days-186,30); jd = 1 + ((days-186) % 30); }
  return [jy, jm, jd];
}
function j2g(jy, jm, jd) {
  let gy; if (jy > 979) { gy = 1600; jy -= 979; } else { gy = 621; }
  let days = 365*jy + _div(jy,33)*8 + _div((jy%33)+3,4) + 78 + jd + (jm < 7 ? (jm-1)*31 : (jm-7)*30 + 186);
  gy += 400*_div(days,146097); days %= 146097;
  if (days > 36524) { days--; gy += 100*_div(days,36524); days %= 36524; if (days >= 365) days++; }
  gy += 4*_div(days,1461); days %= 1461;
  if (days > 365) { gy += _div(days-1,365); days = (days-1)%365; }
  let gd = days + 1;
  const sal = [0,31,((gy%4===0&&gy%100!==0)||(gy%400===0))?29:28,31,30,31,30,31,31,30,31,30,31];
  let gm; for (gm = 0; gm < 13; gm++) { const v = sal[gm]; if (gd <= v) break; gd -= v; }
  return [gy, gm, gd];
}
// ISO Gregorian "YYYY-MM-DD" -> Persian label, e.g. "پنجشنبه ۹ مهر ۱۴۰۵"
function faDate(iso, withYear = true) {
  const [gy, gm, gd] = iso.split("-").map(Number);
  const [jy, jm, jd] = g2j(gy, gm, gd);
  const wd = new Date(iso + "T00:00:00Z").getUTCDay();
  return `${FA_WEEK[wd]} ${toFa(jd)} ${FA_MONTHS[jm - 1]}${withYear ? " " + toFa(jy) : ""}`;
}

// Accepts: today/امروز, tomorrow/فردا, a Jalali date (e.g. 1405/07/11), or a Gregorian date (2026-10-08).
// Persian digits are accepted. Returns an ISO Gregorian "YYYY-MM-DD".
function parseDate(s) {
  s = (s || "").trim().toLowerCase().replace(/[۰-۹]/g, (d) => "۰۱۲۳۴۵۶۷۸۹".indexOf(d));
  if (s === "today" || s === "امروز") return isoAdd(0);
  if (s === "tomorrow" || s === "فردا") return isoAdd(1);
  const m = s.match(/^(\d{3,4})[-/](\d{1,2})[-/](\d{1,2})$/);
  if (!m) return null;
  let y = +m[1], mo = +m[2], d = +m[3];
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  if (y < 1700) { const g = j2g(y, mo, d); y = g[0]; mo = g[1]; d = g[2]; }  // a Jalali year → convert
  return `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

// Inline keyboard: next 14 days shown as Persian dates; tap to toggle a whole day off/on.
function dayGridMarkup() {
  const rows = [];
  for (let i = 0; i < 14; i++) {
    const iso = isoAdd(i);
    const off = blocks.days.includes(iso);
    const label = `${off ? "⛔" : "✅"} ${faDate(iso, false)}`;
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
  return `🗓 New appointment request\n\n👤 ${b.name}${b.nationalId ? `\n🆔 ${b.nationalId}` : ""}\n📞 ${b.phone}${b.email ? `\n📧 ${b.email}` : ""}\n🩺 ${visitLabel(b.type || "in-person", "en")}\n🕒 ${b.when}\n🌐 ${site}\n\nStatus: ⏳ pending`;
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
/* ---------- patient email (Resend via REST, optional) ---------- */
const MAIL = {
  key: (ENV.RESEND_API_KEY || "").trim(),
  from: (ENV.MAIL_FROM || "").trim(),        // e.g. "Dr. Hashemi <booking@ainoor.io>"
  replyTo: (ENV.MAIL_REPLY_TO || "").trim(), // optional
};
const MAIL_ON = !!(MAIL.key && MAIL.from);
async function sendEmail(to, subject, html, text) {
  if (!MAIL_ON) { console.log(`[MOCK email -> ${to}] ${subject}`); return; }
  try {
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${MAIL.key}`, "content-type": "application/json" },
      body: JSON.stringify({ from: MAIL.from, to: [to], subject, html, text, ...(MAIL.replyTo ? { reply_to: MAIL.replyTo } : {}) }),
    });
    if (!r.ok) console.error("email error:", ((await r.json().catch(() => ({}))).message) || r.status);
  } catch (e) { console.error("email failed:", e.message); }
}

// Notify the patient on every configured channel: email (primary) + optional SMS/WhatsApp.
async function notifyPatient(b, kind) {
  const msg = patientMsg(b, kind);
  const jobs = [];
  if (MAIL_ON && b.email) { const em = emailContent(b, kind); jobs.push(sendEmail(b.email, em.subject, em.html, msg)); }
  if (WA_FROM) jobs.push(sendWhatsApp(b.phone, msg));
  if (SMS.from) jobs.push(sendSms(b.phone, msg));
  if (!jobs.length) console.log(`[MOCK notify -> ${b.email || b.phone}] ${msg}`); // nothing configured yet
  await Promise.allSettled(jobs);
}

const patientMsg = (b, kind) => {
  const fa = b.lang === "fa";
  const name = b.name.split(" ")[0];
  if (kind === "received") return fa
    ? `سلام ${name}، درخواست نوبت شما با دکتر هاشمی برای ${b.when} دریافت شد. به‌زودی تأیید می‌کنیم.`
    : `Hi ${name}, your appointment request with Dr. Hashemi for ${b.when} was received. We'll confirm shortly.`;
  if (kind === "confirmed") {
    if (isOnline(b.type)) {
      const act = b.type === "video" ? (fa ? "تماس تصویری بگیرید" : "video-call us") : (fa ? "پیام دهید" : "message us");
      return fa
        ? `ویزیت آنلاین شما تأیید شد ✅ ${b.when}. در زمان نوبت، در واتس‌اپ ${act}: ${CLINIC_WHATSAPP}`
        : `Your online visit is confirmed ✅ ${b.when}. At your appointment time, ${act} on WhatsApp: ${CLINIC_WHATSAPP}`;
    }
    return fa
      ? `نوبت شما تأیید شد ✅ ${b.when}. منتظر دیدن‌تان هستیم! دکتر هاشمی`
      : `You're confirmed ✅ ${b.when}. See you then! — Dr. Hashemi's office`;
  }
  if (kind === "cancelled") return fa
    ? `نوبت شما برای ${b.when} لغو شد. ممنون که اطلاع دادید — هر زمان خواستید دوباره نوبت بگیرید. دکتر هاشمی`
    : `Your appointment for ${b.when} has been cancelled. Thanks for letting us know — you can book again anytime. — Dr. Hashemi's office`;
  return fa
    ? `متأسفیم، ${b.when} در دسترس نیست. لطفاً برای زمان دیگری تماس بگیرید. دکتر هاشمی`
    : `Sorry, ${b.when} isn't available. Please call us to pick another time. — Dr. Hashemi's office`;
};

// Branded HTML email for the patient. Returns { subject, html }.
function emailContent(b, kind) {
  const fa = b.lang === "fa";
  const name = esc(b.name.split(" ")[0]);
  const when = esc(b.when);
  const dir = fa ? "rtl" : "ltr";
  const font = fa
    ? "Vazirmatn, 'Segoe UI', Tahoma, sans-serif"
    : "'Segoe UI', Helvetica, Arial, sans-serif";
  const t = {
    received: {
      subject: fa ? "درخواست نوبت شما دریافت شد" : "We received your appointment request",
      badge: fa ? "در انتظار تأیید" : "Pending confirmation",
      bg: "#0d6e66", accent: "#0d6e66",
      head: fa ? `سلام ${name}،` : `Hi ${name},`,
      body: fa
        ? `درخواست نوبت شما نزد <strong>دکتر فروغ هاشمی</strong> ثبت شد. به‌محض بررسی، ایمیل تأیید برایتان ارسال می‌شود.`
        : `Your appointment request with <strong>Dr. Foroogh Hashemi</strong> has been received. We'll email you a confirmation as soon as we review it.`,
    },
    confirmed: {
      subject: fa ? "نوبت شما تأیید شد ✅" : "Your appointment is confirmed ✅",
      badge: fa ? "تأیید شد" : "Confirmed",
      bg: "#0d6e66", accent: "#15803d",
      head: fa ? `${name} عزیز،` : `Dear ${name},`,
      body: fa
        ? `نوبت شما <strong>تأیید شد</strong>. منتظر دیدن شما هستیم. اگر لازم شد تغییری بدهید، کافی است به همین ایمیل پاسخ دهید یا تماس بگیرید.`
        : `Your appointment is <strong>confirmed</strong>. We look forward to seeing you. If you need to change anything, just reply to this email or call us.`,
    },
    declined: {
      subject: fa ? "درباره‌ی درخواست نوبت شما" : "About your appointment request",
      badge: fa ? "در دسترس نیست" : "Not available",
      bg: "#0d6e66", accent: "#b45309",
      head: fa ? `${name} عزیز،` : `Dear ${name},`,
      body: fa
        ? `متأسفیم، این زمان دیگر در دسترس نیست. لطفاً برای انتخاب زمان دیگری به این ایمیل پاسخ دهید یا با ما تماس بگیرید؛ خوشحال می‌شویم کمک کنیم.`
        : `We're sorry — this time is no longer available. Please reply to this email or call us to pick another time; we'd be happy to help.`,
    },
    cancelled: {
      subject: fa ? "نوبت شما لغو شد" : "Your appointment has been cancelled",
      badge: fa ? "لغو شد" : "Cancelled",
      bg: "#0d6e66", accent: "#9ca3af",
      head: fa ? `${name} عزیز،` : `Dear ${name},`,
      body: fa
        ? `نوبت شما طبق درخواست <strong>لغو شد</strong>. ممنون که اطلاع دادید — هر زمان خواستید می‌توانید دوباره از سایت نوبت بگیرید.`
        : `Your appointment has been <strong>cancelled</strong> as requested. Thanks for letting us know — you're welcome to book again from the site anytime.`,
    },
  }[kind] || t_received_fallback();
  function t_received_fallback() { return { subject: "Appointment", badge: "", bg: "#0d6e66", accent: "#0d6e66", head: "", body: "" }; }

  const online = isOnline(b.type);
  const typeText = visitLabel(b.type || "in-person", b.lang);
  if (online && kind === "received") t.body += fa
    ? " این ویزیت به‌صورت آنلاین و از طریق واتس‌اپ انجام می‌شود؛ پس از تأیید، شماره‌ی واتس‌اپ و زمان دقیق برایتان ارسال می‌شود."
    : " This is an online visit over WhatsApp; once we confirm it, we'll send you the WhatsApp number and the exact time.";
  if (online && kind === "confirmed") t.body = fa
    ? `ویزیت آنلاین شما <strong>تأیید شد</strong>. در زمان نوبت، از طریق واتس‌اپ با شما در ارتباط خواهیم بود.`
    : `Your online visit is <strong>confirmed</strong>. We'll connect with you over WhatsApp at your appointment time.`;

  const whenLabel = fa ? "زمان" : "Time";
  const cancelHref = (kind === "received" || kind === "confirmed") ? cancelUrl(b) : "";
  const cancelBlock = cancelHref
    ? `<tr><td style="padding:18px 28px 0;">
        <p style="font-size:13.5px;line-height:1.7;color:#5a736e;margin:0;">
          ${fa ? "برنامه‌تان عوض شد؟ " : "Plans changed? "}
          <a href="${esc(cancelHref)}" style="color:#b45309;font-weight:600;text-decoration:underline;">${fa ? "لغو این نوبت" : "Cancel this appointment"}</a>
        </p>
      </td></tr>`
    : "";
  const onlineBlock = (kind === "confirmed" && online && waLink)
    ? `<tr><td style="padding:18px 28px 0;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#e9f8ef;border:1px solid #bfe6cd;border-radius:12px;">
          <tr><td style="padding:16px 18px;">
            <div style="font-size:12px;color:#157a3a;text-transform:uppercase;letter-spacing:.04em;">${fa ? "واتس‌اپ" : "WhatsApp"}</div>
            <a href="${esc(waLink)}" style="display:inline-block;font-size:17px;color:#157a3a;font-weight:700;text-decoration:none;margin-top:4px;direction:ltr;">${esc(CLINIC_WHATSAPP)}</a>
            <p style="font-size:13.5px;line-height:1.7;color:#3c4b47;margin:8px 0 0;">${
              b.type === "video"
                ? (fa ? "در زمان نوبت، روی شماره بزنید و در واتس‌اپ <strong>تماس تصویری</strong> بگیرید." : "At your appointment time, tap the number and start a <strong>WhatsApp video call</strong>.")
                : (fa ? "در زمان نوبت، روی شماره بزنید و در واتس‌اپ <strong>پیام</strong> دهید." : "At your appointment time, tap the number and <strong>message us</strong> on WhatsApp.")
            }</p>
          </td></tr>
        </table>
      </td></tr>`
    : "";
  const footer = fa
    ? "این ایمیل برای هماهنگی نوبت ارسال شده و توصیه‌ی پزشکی نیست. در موارد اورژانسی با ۱۱۵ تماس بگیرید."
    : "This email is about your appointment and is not medical advice. In an emergency, call your local emergency number.";
  const office = fa ? "مطب دکتر فروغ هاشمی" : "Dr. Foroogh Hashemi's office";

  const html = `<!doctype html><html lang="${fa ? "fa" : "en"}" dir="${dir}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">${fa ? '<link href="https://fonts.googleapis.com/css2?family=Vazirmatn:wght@400;600;700&display=swap" rel="stylesheet">' : ""}</head>
<body style="margin:0;padding:0;background:#f1f5f4;">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;">${esc(t.subject)}</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f1f5f4;padding:28px 12px;">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#ffffff;border-radius:18px;overflow:hidden;font-family:${font};direction:${dir};box-shadow:0 10px 30px rgba(13,110,102,.12);">
        <tr><td style="background:${t.bg};padding:22px 28px;">
          <div style="color:#ffffff;font-size:18px;font-weight:700;">${office}</div>
          <div style="color:rgba(255,255,255,.82);font-size:13px;margin-top:3px;">${fa ? "پزشک متخصص کودکان" : "Pediatrician"}</div>
        </td></tr>
        <tr><td style="padding:28px;">
          ${t.badge ? `<span style="display:inline-block;background:${t.accent}1a;color:${t.accent};font-size:12.5px;font-weight:600;padding:5px 12px;border-radius:999px;">${esc(t.badge)}</span>` : ""}
          <p style="font-size:16px;color:#14201d;margin:16px 0 6px;font-weight:600;">${esc(t.head)}</p>
          <p style="font-size:15px;line-height:1.75;color:#3c4b47;margin:0 0 20px;">${t.body}</p>
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f3faf8;border:1px solid #d8ebe7;border-radius:12px;">
            <tr><td style="padding:14px 18px;">
              <div style="font-size:12px;color:#5a736e;text-transform:uppercase;letter-spacing:.04em;">${fa ? "نوع ویزیت" : "Visit type"}</div>
              <div style="font-size:15px;color:#14201d;font-weight:600;margin-top:3px;">${esc(typeText)}</div>
            </td></tr>
            <tr><td style="padding:14px 18px;border-top:1px solid #e2efec;">
              <div style="font-size:12px;color:#5a736e;text-transform:uppercase;letter-spacing:.04em;">${esc(whenLabel)}</div>
              <div style="font-size:16px;color:#0d6e66;font-weight:700;margin-top:3px;">${when}</div>
            </td></tr>
          </table>
        </td></tr>
        ${onlineBlock}
        ${cancelBlock}
        <tr><td style="padding:18px 28px 26px;">
          <p style="font-size:12.5px;line-height:1.7;color:#8a9a96;margin:0;border-top:1px solid #eef2f1;padding-top:16px;">${footer}</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;
  return { subject: t.subject, html };
}
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

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
    return void api(ch, "answerCallbackQuery", { callback_query_id: cq.id, text: `${faDate(id, false)} ${wasOff ? "باز شد ✅" : "بسته شد ⛔"}` });
  }

  // Staff cancels a booking (works on pending or confirmed). Frees the slot + notifies the patient.
  if (action === "scancel") {
    if (ch.staff && String(cq.from && cq.from.id) !== String(ch.staff) && String(cq.message && cq.message.chat && cq.message.chat.id) !== String(ch.staff))
      return void api(ch, "answerCallbackQuery", { callback_query_id: cq.id, text: "Staff only." });
    const bk = bookings.find((x) => x.id === id);
    if (!bk) return void api(ch, "answerCallbackQuery", { callback_query_id: cq.id, text: "Not found." });
    if (bk.status === "cancelled") return void api(ch, "answerCallbackQuery", { callback_query_id: cq.id, text: "Already cancelled." });
    bk.status = "cancelled"; bk.cancelledAt = new Date().toISOString(); bk.cancelledBy = "clinic"; save();
    const who2 = (cq.from && (cq.from.first_name || cq.from.username)) || "staff";
    const text2 = staffText(bk).replace("Status: ⏳ pending", `Status: 🚫 CANCELLED by ${who2}`);
    for (const c of CHANNELS) {
      const rec = bk.staffMsgs && bk.staffMsgs[c.name];
      if (rec) await api(c, "editMessageText", { chat_id: rec.chatId, message_id: rec.msgId, text: text2 });
    }
    await api(ch, "answerCallbackQuery", { callback_query_id: cq.id, text: "Cancelled — patient notified." });
    await notifyPatient(bk, "declined"); // "sorry, please contact us to reschedule"
    return;
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
  // Confirmed bookings keep a Cancel button so staff can cancel later; declined ones lose all buttons.
  const keep = b.status === "confirmed" ? { inline_keyboard: [[{ text: "🚫 Cancel appointment", callback_data: "scancel:" + b.id }]] } : undefined;
  for (const c of CHANNELS) {
    const rec = b.staffMsgs && b.staffMsgs[c.name];
    if (rec) await api(c, "editMessageText", { chat_id: rec.chatId, message_id: rec.msgId, text: finalText, ...(keep ? { reply_markup: keep } : {}) });
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
      `AVAILABILITY (staff)\n/availability – tap days to turn off/on (Persian dates)\n/off <date> – close a day (e.g. /off فردا  ·  /off 1405/07/11  ·  /off 2026-10-08)\n/on <date> – reopen a day\n/block <date> <time> – block one slot (e.g. /block 1405/07/11 10:00)\n/unblock <date> <time> – unblock a slot\n/blocked – show current blocks`);

  // ----- availability management (staff only) -----
  if (["/availability", "/dayoff", "/off", "/on", "/block", "/unblock", "/blocked"].includes(t)) {
    if (!isStaff) return void say("This command is only available to the clinic staff chat.");

    if (t === "/availability" || t === "/dayoff")
      return void say("Tap a day to turn it OFF (⛔) or back ON (✅) for bookings:", { reply_markup: dayGridMarkup() });

    if (t === "/blocked") {
      const days = blocks.days.slice().sort(), slots = blocks.slots.slice().sort();
      if (!days.length && !slots.length) return void say("موردی بسته نشده — همه‌ی ساعات کاری باز است.");
      let txt = "⛔ موارد بسته‌شده:";
      if (days.length) txt += "\n\nروزهای تعطیل:\n" + days.map((d) => "• " + faDate(d)).join("\n");
      if (slots.length) txt += "\n\nساعت‌های بسته:\n" + slots.map((s) => { const [sd, st] = s.split(" "); return "• " + faDate(sd) + " ساعت " + toFa(st); }).join("\n");
      return void say(txt);
    }

    if (t === "/off" || t === "/on") {
      const d = parseDate(parts[1]);
      if (!d) return void say("یک تاریخ بدهید، مثلاً:  /off فردا  ·  /off 1405/07/11  ·  /off 2026-10-08");
      if (t === "/off") { if (!blocks.days.includes(d)) blocks.days.push(d); }
      else blocks.days = blocks.days.filter((x) => x !== d);
      saveBlocks();
      return void say(t === "/off" ? `⛔ ${faDate(d)} برای نوبت‌دهی بسته شد.` : `✅ ${faDate(d)} دوباره باز شد.`);
    }

    if (t === "/block" || t === "/unblock") {
      const d = parseDate(parts[1]);
      const mt = (parts[2] || "").trim().match(/^(\d{1,2}):(\d{2})$/);
      if (!d || !mt) return void say("به این شکل بنویسید:  /block 1405/07/11 10:00");
      const time = `${mt[1].padStart(2, "0")}:${mt[2]}`;
      const key = `${d} ${time}`;
      if (t === "/block") { if (!blocks.slots.includes(key)) blocks.slots.push(key); }
      else blocks.slots = blocks.slots.filter((x) => x !== key);
      saveBlocks();
      return void say(t === "/block" ? `⛔ ${faDate(d)} ساعت ${toFa(time)} بسته شد.` : `✅ ${faDate(d)} ساعت ${toFa(time)} باز شد.`);
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

    const icon = s => (s === "confirmed" ? "✅" : s === "declined" ? "❌" : s === "cancelled" ? "🚫" : "⏳");
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
  const email = String(b.email || "").trim();
  const nationalId = toAsciiDigits(b.nationalId || "");
  const emailOk = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
  const type = VISIT_TYPES.has(b.type) ? b.type : "in-person";
  if (!name || phone.replace(/[^\d۰-۹]/g, "").length < 7 || !emailOk || !validCodeMelli(nationalId))
    return json(res, 400, { ok: false, error: "name, valid national ID, mobile and email are required" });

  const proto = String(req.headers["x-forwarded-proto"] || "https").split(",")[0].trim();
  const host = String(req.headers["x-forwarded-host"] || req.headers.host || "").split(",")[0].trim();
  const reqBase = host ? `${proto}://${host}` : "";

  const rec = {
    id: newId(), name, nationalId, phone, email, type,
    date: String(b.date || ""), time: String(b.time || ""),
    when: String(b.when || `${b.date} ${b.time}`).slice(0, 120),
    lang: b.lang === "fa" ? "fa" : "en",
    status: "pending", createdAt: new Date().toISOString(),
    cancelToken: newToken(), base: PUBLIC_BASE || reqBase,
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

/* ---------- patient self-cancellation (secure link in their email) ---------- */
// Branded page shown when the patient taps the Cancel link. `state` drives the copy.
function cancelPage({ lang = "en", state, when = "", id = "", token = "" }) {
  const fa = lang === "fa";
  const dir = fa ? "rtl" : "ltr";
  const font = fa ? "Vazirmatn, 'Segoe UI', Tahoma, sans-serif" : "'Segoe UI', Helvetica, Arial, sans-serif";
  const T = {
    confirm:  fa ? { h: "لغو نوبت", p: "آیا می‌خواهید این نوبت را لغو کنید؟", btn: "بله، لغو کن", keep: "نه، نگه‌دار" }
                 : { h: "Cancel appointment", p: "Do you want to cancel this appointment?", btn: "Yes, cancel it", keep: "No, keep it" },
    done:     fa ? { h: "نوبت لغو شد", p: "نوبت شما لغو شد. ایمیل تأیید برایتان ارسال شد. هر زمان خواستید دوباره نوبت بگیرید." }
                 : { h: "Appointment cancelled", p: "Your appointment has been cancelled. We've emailed you a confirmation. You can book again anytime." },
    already:  fa ? { h: "قبلاً لغو شده", p: "این نوبت پیش‌تر لغو شده است." }
                 : { h: "Already cancelled", p: "This appointment has already been cancelled." },
    inactive: fa ? { h: "نوبت فعال نیست", p: "این نوبت دیگر فعال نیست. برای هماهنگی لطفاً با مطب تماس بگیرید." }
                 : { h: "Appointment not active", p: "This appointment is no longer active. Please contact the office if you need help." },
    invalid:  fa ? { h: "لینک نامعتبر", p: "این لینک لغو معتبر نیست یا منقضی شده است." }
                 : { h: "Invalid link", p: "This cancellation link is invalid or has expired." },
  }[state];
  const office = fa ? "مطب دکتر فروغ هاشمی" : "Dr. Foroogh Hashemi's office";
  const whenRow = when ? `<div style="background:#f3faf8;border:1px solid #d8ebe7;border-radius:12px;padding:14px 16px;margin:18px 0;"><div style="font-size:16px;color:#0d6e66;font-weight:700;">${esc(when)}</div></div>` : "";
  const actions = state === "confirm"
    ? `<div id="act" style="margin-top:20px;">
         <button id="go" style="width:100%;padding:13px;border:0;border-radius:12px;background:#b45309;color:#fff;font-size:15px;font-weight:700;cursor:pointer;font-family:inherit;">${T.btn}</button>
         <a href="/" style="display:inline-block;margin-top:14px;color:#5a736e;font-size:14px;text-decoration:none;">${T.keep}</a>
       </div>
       <div id="err" style="display:none;margin-top:14px;color:#c0492f;font-size:14px;"></div>`
    : `<a href="/" style="display:inline-block;margin-top:18px;color:#0d6e66;font-weight:600;text-decoration:none;font-size:14px;">${fa ? "بازگشت به سایت" : "Back to the site"}</a>`;
  const script = state === "confirm" ? `<script>
    document.getElementById('go').addEventListener('click', async function(){
      this.disabled = true; this.textContent = ${JSON.stringify(fa ? "در حال لغو…" : "Cancelling…")};
      try {
        const r = await fetch('/api/cancel', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ id:${JSON.stringify(id)}, t:${JSON.stringify(token)} }) });
        const j = await r.json();
        if (j.ok) {
          document.getElementById('title').textContent = ${JSON.stringify(T.done ? (fa ? "نوبت لغو شد" : "Appointment cancelled") : "")};
          document.getElementById('msg').textContent = ${JSON.stringify(fa ? "نوبت شما لغو شد. ایمیل تأیید برایتان ارسال شد." : "Your appointment has been cancelled. We've emailed you a confirmation.")};
          document.getElementById('act').style.display='none';
          document.getElementById('badge').textContent = ${JSON.stringify(fa ? "لغو شد" : "Cancelled")};
        } else { throw new Error(j.error||'failed'); }
      } catch(e){
        this.disabled=false; this.textContent=${JSON.stringify(T.btn)};
        var el=document.getElementById('err'); el.style.display='block';
        el.textContent=${JSON.stringify(fa ? "لغو انجام نشد. لطفاً دوباره تلاش کنید یا تماس بگیرید." : "Could not cancel. Please try again or call us.")};
      }
    });
  </script>` : "";
  const badge = state === "confirm" ? (fa ? "لغو نوبت" : "Cancel") : T.h;
  return `<!doctype html><html lang="${fa ? "fa" : "en"}" dir="${dir}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(T.h)}</title>${fa ? '<link href="https://fonts.googleapis.com/css2?family=Vazirmatn:wght@400;600;700&display=swap" rel="stylesheet">' : ""}</head>
<body style="margin:0;background:#f1f5f4;font-family:${font};direction:${dir};">
  <div style="max-width:460px;margin:0 auto;padding:40px 16px;">
    <div style="background:#fff;border-radius:18px;overflow:hidden;box-shadow:0 10px 30px rgba(13,110,102,.12);">
      <div style="background:#0d6e66;padding:20px 26px;color:#fff;font-weight:700;font-size:17px;">${office}</div>
      <div style="padding:28px 26px;text-align:center;">
        <span id="badge" style="display:inline-block;background:#b453091a;color:#b45309;font-size:12.5px;font-weight:600;padding:5px 12px;border-radius:999px;">${esc(badge)}</span>
        <h1 id="title" style="font-size:20px;color:#14201d;margin:16px 0 8px;">${esc(T.h)}</h1>
        <p id="msg" style="font-size:15px;line-height:1.7;color:#3c4b47;margin:0;">${esc(T.p)}</p>
        ${whenRow}
        ${actions}
      </div>
    </div>
  </div>
  ${script}
</body></html>`;
}

function sendHtml(res, code, html) { res.writeHead(code, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }); res.end(html); }

function handleCancelPage(req, res) {
  const u = new URL(req.url, "http://x");
  const id = u.searchParams.get("id") || "", token = u.searchParams.get("t") || "";
  const b = bookings.find((x) => x.id === id);
  if (!b || !b.cancelToken || b.cancelToken !== token) return sendHtml(res, 404, cancelPage({ state: "invalid" }));
  if (b.status === "cancelled") return sendHtml(res, 200, cancelPage({ lang: b.lang, state: "already", when: b.when }));
  if (b.status === "declined") return sendHtml(res, 200, cancelPage({ lang: b.lang, state: "inactive", when: b.when }));
  return sendHtml(res, 200, cancelPage({ lang: b.lang, state: "confirm", when: b.when, id: b.id, token: b.cancelToken }));
}

async function handleCancel(req, res) {
  let body;
  try { body = JSON.parse(await readBody(req)); } catch { return json(res, 400, { ok: false, error: "bad json" }); }
  const id = String(body.id || ""), token = String(body.t || "");
  const b = bookings.find((x) => x.id === id);
  if (!b || !b.cancelToken || b.cancelToken !== token) return json(res, 400, { ok: false, error: "invalid" });
  if (b.status === "cancelled") return json(res, 200, { ok: true, already: true });
  if (b.status === "declined") return json(res, 409, { ok: false, error: "inactive" });

  b.status = "cancelled";
  b.cancelledAt = new Date().toISOString();
  save();

  // Reflect on every staff channel: mark the original message and send a fresh alert.
  const finalText = staffText(b).replace("Status: ⏳ pending", "Status: 🚫 CANCELLED by patient");
  for (const c of CHANNELS) {
    const rec = b.staffMsgs && b.staffMsgs[c.name];
    if (rec) await api(c, "editMessageText", { chat_id: rec.chatId, message_id: rec.msgId, text: finalText });
    if (c.staff) await api(c, "sendMessage", { chat_id: c.staff, text: `🚫 Patient cancelled\n\n👤 ${b.name}\n🕒 ${b.when}\n\nThe slot is now open again.` });
  }
  await notifyPatient(b, "cancelled");
  json(res, 200, { ok: true });
}

createServer(async (req, res) => {
  const path = (req.url || "/").split("?")[0];
  if (req.method === "POST" && path === "/api/book") return handleBook(req, res);
  if (req.method === "POST" && path === "/api/cancel") return handleCancel(req, res);
  if (req.method === "GET" && path === "/cancel") return handleCancelPage(req, res);
  if (req.method === "GET" && path === "/api/bookings") return json(res, 200, bookings); // local convenience view
  if (req.method === "GET" && path === "/api/availability") {
    // The website reads this to grey out days off, blocked slots, and already-taken slots.
    const bookedSlots = bookings.filter((b) => b.status !== "declined" && b.status !== "cancelled").map((b) => `${b.date} ${b.time}`);
    return json(res, 200, { blockedDays: blocks.days, blockedSlots: blocks.slots, bookedSlots });
  }
  if (req.method === "GET") return serveStatic(req, res);
  res.writeHead(405); res.end("405");
}).listen(PORT, () => {
  console.log(`Serving ${ROOT} at http://localhost:${PORT}`);
  console.log(MOCK
    ? "Staff channels: MOCK mode (no TELEGRAM_BOT_TOKEN / BALE_BOT_TOKEN). Messages print to the console."
    : `Staff channels: ${CHANNELS.map(c => `${c.name}${c.staff ? "" : " (chat id NOT set — message the bot /id)"}`).join(", ")}`);
  console.log(MAIL_ON ? `Patient email: Resend configured (from ${MAIL.from}).` : "Patient email: MOCK (set RESEND_API_KEY + MAIL_FROM to send real emails).");
  console.log(CLINIC_WHATSAPP ? `Online visits: WhatsApp ${CLINIC_WHATSAPP}.` : "Online visits: set CLINIC_WHATSAPP so confirmation emails include the number.");
  console.log(SMS.from ? "Patient SMS: Twilio configured." : "Patient SMS: off (set TWILIO_FROM_NUMBER to enable).");
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
