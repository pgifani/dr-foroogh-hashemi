# Booking → Telegram (+ SMS) setup

When a patient books, `server.mjs` sends the request to a staff Telegram chat with
**✅ Confirm / ❌ Decline** buttons, and texts the patient (Twilio). Until you add a bot
token the server runs in **mock mode** — bookings work and the messages are printed to the
console instead of being sent, so you can test everything first.

## 1. Run the server (instead of the static one)

```bash
cd website
node server.mjs
```

The site is at http://localhost:3000. The console tells you the current mode.
(`serve.mjs` still exists for static-only preview, but it has no booking backend.)

## 2. Create the Telegram bot

1. In Telegram, open **@BotFather** → `/newbot` → pick a name and username.
2. BotFather gives you a **token** like `123456789:AA...`. Keep it secret.
3. Create the file **`website/.env`** (it is gitignored) and add:

   ```
   TELEGRAM_BOT_TOKEN=123456789:AA-your-token-here
   ```

4. Restart the server. The console now says **Telegram: LIVE**.

## 3. Tell the bot which chat to notify

The bot can only message people who have opened it first.

1. In Telegram, open your new bot and send **`/id`** (or press Start).
2. The bot replies with **`Your chat ID is 123456789`**.
3. Add that to `website/.env` and restart:

   ```
   TELEGRAM_STAFF_CHAT_ID=123456789
   ```

Use the doctor's or assistant's personal chat ID here. To notify a **group** instead, add the
bot to the group, send `/id` in the group, and use that (negative) group ID.

## 4. (Optional) Real SMS to patients — Twilio

Without this, patient texts are printed to the console (mock). To send real SMS:

1. Create a **Twilio** account and get a phone number.
2. Add to `website/.env`:

   ```
   TWILIO_ACCOUNT_SID=ACxxxxxxxx
   TWILIO_AUTH_TOKEN=your-auth-token
   TWILIO_FROM_NUMBER=+15551234567
   TWILIO_DEFAULT_COUNTRY=+1        # prefix for local numbers typed without a country code
   ```

3. Restart. Now patients get a text on booking, and again when staff confirms/declines.

> Note: patients must enter a mobile number. `TWILIO_DEFAULT_COUNTRY` turns a local number like
> `0912...` into `+98912...`. For best results, ask patients for their full number.

## 4b. (Optional) WhatsApp to patients — also Twilio

WhatsApp uses the **same Twilio account** as SMS. You can send SMS, WhatsApp, or both.

**Important WhatsApp rule:** because the patient books on the website (not by messaging you
first), your confirmation is a *business-initiated* message. WhatsApp requires those to use a
**pre-approved message template** — you can't send free-form text like SMS. Two stages:

- **Testing (free sandbox):** in the Twilio console open **Messaging → Try it out → WhatsApp
  sandbox**. It gives you a sandbox number (usually `+1 415 523 8886`) and a join code. On each
  phone that will *receive* test messages, send that join code to the sandbox number once. Then:

  ```
  TWILIO_WHATSAPP_FROM=whatsapp:+14155238886
  ```

  Restart — bookings now send WhatsApp to any number that joined the sandbox.

- **Production:** register a WhatsApp sender (your own number, via Twilio) and submit the
  confirmation wording as a **template** for approval. Once approved, set `TWILIO_WHATSAPP_FROM`
  to your WhatsApp sender. The message text in `server.mjs` (`patientMsg`) becomes your template
  body — keep them matching.

Channel logic: WhatsApp sends whenever `TWILIO_WHATSAPP_FROM` is set; SMS sends whenever
`TWILIO_FROM_NUMBER` is set. Set both to send on both.

## 5. Test the whole loop

1. Book an appointment on the site.
2. The staff chat gets: **🗓 New appointment request** with Confirm / Decline buttons.
3. Tap **✅ Confirm** → the patient gets a confirmation text; the staff message updates to
   *CONFIRMED by <name>*. **❌ Decline** texts the patient to call back.

Bookings are also saved to `website/bookings.json` (gitignored — it holds personal data).

## Going live (later)

`node server.mjs` is a local prototype (uses Telegram long-polling — no public URL needed).
For a public site, the same logic ports to a **Vercel / Netlify function**: move the `/api/book`
handler into a serverless function and switch Telegram from long-polling to a **webhook**
(`setWebhook` to your deployed URL). The message/SMS code stays the same. Ask and I'll do it.

**Never commit `.env` or `bookings.json`, and never paste the bot token or Twilio keys into chat.**
