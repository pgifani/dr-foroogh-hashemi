# CLAUDE.md — Frontend Website Rules

A separate project inside this workspace for building websites/landing pages. The workspace-level `../CLAUDE.md` covers general tool setup (Tavily first for research, the gws CLI). This file governs frontend design work.

## Always Do First
- **Invoke the `frontend-design` skill** before writing any frontend code, every session, no exceptions. (Official Anthropic plugin, installed 2026-09-29 from the `claude-plugins-official` marketplace. Full name: `frontend-design:frontend-design`.)
- Check the `brand_assets/` folder (see Brand Assets) before designing.

## Reference Images
- If a reference image is provided: match layout, spacing, typography, and color exactly. Swap in placeholder content (images via `https://placehold.co/`, generic copy). Do not improve or add to the design.
- If no reference image: design from scratch with high craft (see guardrails below).
- Screenshot your output, compare against reference, fix mismatches, re-screenshot. Do at least 2 comparison rounds. Stop only when no visible differences remain or the user says so.

## Local Server
- **Always serve on localhost** — never screenshot a `file:///` URL.
- `server.mjs` (project root) is the all-in-one zero-dependency server: it serves the static site **and** exposes the booking backend `/api/book` (Telegram + SMS). It's the `.claude/launch.json` config named **`website`**. `serve.mjs` (config `website-static`) is a static-only fallback with no backend.
- Start it via the built-in browser: `preview_start` with `name: "website"`. Or from a terminal: `node server.mjs` (set `PORT=4000` to change the port).
- If the server is already running, do not start a second instance — reuse it.

## Booking backend (Telegram + SMS)
- The appointment picker (weekly slot grid, minimal name + phone) POSTs to `/api/book` in `server.mjs`.
- On a booking: the server messages a staff Telegram chat with **Confirm/Decline** buttons and texts the patient (Twilio). Staff tapping a button texts the patient the result. Long-polling, so no public URL needed locally.
- Patient notifications go to every configured channel: **SMS** (`TWILIO_FROM_NUMBER`) and/or **WhatsApp** (`TWILIO_WHATSAPP_FROM`, same Twilio account). WhatsApp business-initiated messages need an approved template in production; use the Twilio WhatsApp sandbox for testing.
- **Runs in mock mode** (prints messages to console) until `TELEGRAM_BOT_TOKEN` is set. Config lives in `website/.env` (gitignored): `TELEGRAM_BOT_TOKEN`, `TELEGRAM_STAFF_CHAT_ID`, and optional `TWILIO_*` (`TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_NUMBER`, `TWILIO_WHATSAPP_FROM`, `TWILIO_DEFAULT_COUNTRY`). Full steps in `TELEGRAM-SETUP.md`.
- Bookings persist to `website/bookings.json` (gitignored — contains patient PII). **Never read/print `.env`, the bot token, Twilio keys, or `bookings.json` contents.**
- The front-end sends the booking as fire-and-forget, so the on-page confirmation always shows even if the backend is down.

## Screenshot Workflow (built-in browser pane)
- This app has a **built-in browser** (`mcp__Claude_Browser__*` tools). Use it for previews and screenshots — **no Puppeteer, no external Chrome, no `screenshot.mjs`.**
- Flow:
  1. `preview_start` with `name: "website"` (starts `serve.mjs` and opens the pane at `http://localhost:3000`). If already open, use `navigate` to the page instead.
  2. `mcp__Claude_Browser__computer` with `action: "screenshot"` to capture the current view. For a specific element, use `action: "zoom"` with a region.
  3. For text/structure checks prefer `read_page` or `get_page_text` over a screenshot — cheaper and exact.
  4. Test responsive breakpoints with `resize_window` (preset `mobile` 375×812, `tablet`, or `desktop`), reloading after switching.
- Screenshots render directly to Claude — no need to save PNGs to disk. If you do want a saved copy for side-by-side comparison, write it under the scratchpad, not the project.
- When comparing, be specific: "heading is 32px but reference shows ~24px", "card gap is 16px but should be 24px".
- Check: spacing/padding, font size/weight/line-height, colors (exact hex), alignment, border-radius, shadows, image sizing.

## Output Defaults
- Single `index.html` file, all styles inline, unless the user says otherwise.
- Tailwind CSS via CDN: `<script src="https://cdn.tailwindcss.com"></script>`.
- Placeholder images: `https://placehold.co/WIDTHxHEIGHT`.
- Mobile-first responsive.

## Brand Assets
- Always check the `brand_assets/` folder before designing. It may contain logos, color guides, style guides, or images.
- If assets exist there, use them. Do not use placeholders where real assets are available.
- If a logo is present, use it. If a color palette is defined, use those exact values — do not invent brand colors.

## Anti-Generic Guardrails
- **Colors:** Never use the default Tailwind palette (indigo-500, blue-600, etc.). Pick a custom brand color and derive from it.
- **Shadows:** Never use flat `shadow-md`. Use layered, color-tinted shadows with low opacity.
- **Typography:** Never use the same font for headings and body. Pair a display/serif with a clean sans. Apply tight tracking (`-0.03em`) on large headings, generous line-height (`1.7`) on body.
- **Gradients:** Layer multiple radial gradients. Add grain/texture via an SVG noise filter for depth.
- **Animations:** Only animate `transform` and `opacity`. Never `transition-all`. Use spring-style easing.
- **Interactive states:** Every clickable element needs hover, focus-visible, and active states. No exceptions.
- **Images:** Add a gradient overlay (`bg-gradient-to-t from-black/60`) and a color treatment layer with `mix-blend-multiply`.
- **Spacing:** Use intentional, consistent spacing tokens — not random Tailwind steps.
- **Depth:** Surfaces should have a layering system (base → elevated → floating), not all sit at the same z-plane.

## Hard Rules
- Do not add sections, features, or content not in the reference.
- Do not "improve" a reference design — match it.
- Do not stop after one screenshot pass.
- Do not use `transition-all`.
- Do not use the default Tailwind blue/indigo as the primary color.
