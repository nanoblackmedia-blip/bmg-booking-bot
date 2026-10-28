const express    = require('express');
const mysql      = require('mysql2/promise');
const axios      = require('axios');
const { google } = require('googleapis');
const crypto     = require('crypto');
 
const app = express();
app.use(express.json());
app.use('/rates', express.static('public/rates'));
 
const WA_API = `https://graph.facebook.com/v19.0/${process.env.WA_PHONE_NUMBER_ID}/messages`;
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || 'https://bmg-booking-bot-production.up.railway.app';
// Shared secret the desktop app authenticates with (see the /api/inquiries*
// routes below). Deliberately separate from the Google service-account
// credentials — this one is cheap to rotate if it ever leaks, without
// touching Sheets access at all.
const API_SECRET = process.env.API_SECRET;
 
// ── Mobile web access ────────────────────────────────────────────────────────
// A single-password login for the phone-friendly Inquiries page at /mobile.
// The desktop app keeps using x-api-key + API_SECRET (see checkAuth below) —
// this is a second, independent front door for a browser, since a browser
// can't safely hold API_SECRET the way the Electron app does (anyone could
// read it via dev tools). Both MUST be set in Railway before /mobile works;
// there's no fallback default for either, on purpose — a guessable default
// here would defeat the point of having a login at all.
const MOBILE_PASSWORD = process.env.MOBILE_PASSWORD;
const MOBILE_SESSION_SECRET = process.env.MOBILE_SESSION_SECRET;
const MOBILE_COOKIE_NAME = 'bmg_session';
const MOBILE_SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
 
// The session "token" is just an HMAC of a fixed label under a secret only
// this server knows — no per-login randomness, no session store, because
// there's exactly one legitimate user (Nano) and the goal is "don't ship the
// real API_SECRET to a browser", not multi-user session management.
function mobileSessionToken() {
  return crypto.createHmac('sha256', MOBILE_SESSION_SECRET).update('bmg-mobile-session').digest('hex');
}
 
function parseCookies(req) {
  const header = req.headers.cookie;
  const out = {};
  if (!header) return out;
  header.split(';').forEach((pair) => {
    const idx = pair.indexOf('=');
    if (idx === -1) return;
    const k = pair.slice(0, idx).trim();
    const v = pair.slice(idx + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  });
  return out;
}
 
function hasValidMobileSession(req) {
  if (!MOBILE_SESSION_SECRET) return false;
  const cookies = parseCookies(req);
  const token = cookies[MOBILE_COOKIE_NAME];
  if (!token) return false;
  // Constant-time comparison — this guards a real login, so it shouldn't
  // leak timing information about how much of the token matched.
  const expected = mobileSessionToken();
  const a = Buffer.from(token);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
 
const RATE_SHEETS = {
  sub_md: `${PUBLIC_BASE_URL}/rates/Matric%20Dance%20Rates.pdf`,
};
 
const TRAVEL_COSTS_PDF = `${PUBLIC_BASE_URL}/rates/Travel%20Costs.pdf`;
const TRAVEL_DISCLAIMER = '📌 *Travel Disclaimer:* These are Fixed travel rates. Final travel cost will be included in the final Quote.';
 
const PACKAGE_OPTIONS = [
  { id: 'pkg_entry',    title: 'Entry — R2000',     description: '1 hour · 20 edited images · 3-4 days' },
  { id: 'pkg_standard', title: 'Standard — R3000',  description: '2 hours · 30 edited images · 3-4 days' },
  { id: 'pkg_half',     title: 'Half Day — R5000',  description: '4 hours · 50 images · 30s reel · 5-7 days' },
  { id: 'pkg_full',     title: 'Full Day — R8000',  description: '6 hours · 70 images · 1min reel · 7-10 days' },
];
 
const LOCATION_OPTIONS = [
  { id: 'loc_gp',    title: 'Gauteng',          description: 'No travel charge' },
  { id: 'loc_cpt',   title: 'Cape Town' },
  { id: 'loc_dbn',   title: 'Durban' },
  { id: 'loc_pmb',   title: 'Pietermaritzburg' },
  { id: 'loc_nel',   title: 'Nelspruit' },
  { id: 'loc_bfn',   title: 'Bloemfontein' },
  { id: 'loc_other', title: 'Other' },
];
 
const SERVICE_LABEL = '📸 Photography';
const SUBTYPE_ID = 'sub_md';
const SUBTYPE_LABEL = 'Matric Dance';
const BANNER_URL = `${PUBLIC_BASE_URL}/rates/MD%20BANNER.jpg`;
 
const BOOKING_DATE_FLOW_ID = '908090289013623';
const ADMIN_PHONE = '27650767631';
 
// ─── Admin accept/decline ──────────────────────────────────────────────────────
// Both confirmBooking/declineBooking are the single source of truth for what
// "accepting" or "declining" a booking actually does — the WhatsApp admin
// command below and the desktop app's /api/inquiries/:id/confirm|decline
// routes both call these directly rather than each having their own copy.
// That's deliberate: a client-facing message with banking details is exactly
// the kind of thing that must never drift between two code paths.
 
function bookingNotFoundError() {
  const err = new Error('Booking not found');
  err.code = 'NOT_FOUND';
  return err;
}
 
// opts.notifyAdmin controls the "✅ confirmed, client notified" receipt back
// to ADMIN_PHONE — on by default for the WhatsApp path (where that receipt
// IS the confirmation the admin sees), off for the desktop app's API path
// (where the app's own UI already shows the result; a WhatsApp message on
// top of that would just be noise).
async function confirmBooking(bookingId, opts) {
  opts = opts || {};
  const pool = await getDB();
  const [rows] = await pool.query('SELECT * FROM wa_bookings WHERE id = ?', [bookingId]);
  if (!rows.length) throw bookingNotFoundError();
  const booking = rows[0];
  await pool.query('UPDATE wa_bookings SET status = ? WHERE id = ?', ['confirmed', bookingId]);
  const ref = `BMG-${String(bookingId).padStart(4, '0')}`;
  await sendText(booking.phone, `🎉 *Booking Confirmed!*\n\nHi ${booking.client_name}, your *${booking.subtype_label}* booking for *${booking.preferred_date}* is confirmed. ✅\n\n📋 Reference: #${ref}\n\nWe can't wait to work with you! If you have any questions, just reply here.`);
  await sendText(booking.phone, `💰 *Reserve Your Spot*\n\nA *50% deposit* is required to secure your booking.\n\n🏦 *Account name:* Black Meridian Group\n🏦 *Bank:* FNB/RMB\n🔢 *Account no.:* 63202712899\n🏢 *Branch code:* 255355\n📝 *Reference:* ${ref}\n\n⚠️ Please use the reference above so we can match your payment. Once we receive it, your spot is locked in! 🔒\n\n📞 I'll personally give you a call on our business number for a quick care call before your session.`);
  if (opts.notifyAdmin !== false) {
    await sendText(ADMIN_PHONE, `✅ Booking #BMG-${bookingId} confirmed. Client notified.`);
  }
  return booking;
}
 
// Delivery-style pings for accepted bookings — no DB status change, just a
// WhatsApp message per stage. Kept as a lookup table (rather than three
// near-identical functions) so the message copy lives in one place.
const ROUTE_STAGES = {
  en_route: {
    adminLabel: 'On the way',
    clientMessage: (b) => `🚗 *On Our Way!*\n\nHi ${b.client_name}, we're heading to your *${b.subtype_label}* session now. See you soon! 📸`,
  },
  arrived: {
    adminLabel: 'Arrived',
    clientMessage: (b) => `📍 *We've Arrived!*\n\nHi ${b.client_name}, we're here for your *${b.subtype_label}* session. See you in a moment!`,
  },
  session_complete: {
    adminLabel: 'Session complete',
    clientMessage: (b) => `🎬 *Session Complete!*\n\nThanks so much ${b.client_name}! We hope you loved your *${b.subtype_label}* session. We'll be in touch soon with next steps. 🙏`,
  },
};
 
async function sendRouteUpdate(bookingId, stage, opts) {
  opts = opts || {};
  const info = ROUTE_STAGES[stage];
  if (!info) throw new Error('Unknown stage: ' + stage);
  const pool = await getDB();
  const [rows] = await pool.query('SELECT * FROM wa_bookings WHERE id = ?', [bookingId]);
  if (!rows.length) throw bookingNotFoundError();
  const booking = rows[0];
  await sendText(booking.phone, info.clientMessage(booking));
  if (opts.notifyAdmin !== false) {
    await sendText(ADMIN_PHONE, `📣 Booking #BMG-${bookingId}: ${info.adminLabel} — client notified.`);
  }
  return booking;
}
 
// Same shape as confirmBooking/declineBooking — the one place that knows
// what "payment received" means (message the client, stamp the DB), so the
// desktop app's Mark Paid button and any future WhatsApp path both call
// this instead of duplicating the message text.
async function markPaidBooking(bookingId, opts) {
  opts = opts || {};
  const pool = await getDB();
  const [rows] = await pool.query('SELECT * FROM wa_bookings WHERE id = ?', [bookingId]);
  if (!rows.length) throw bookingNotFoundError();
  const booking = rows[0];
  await pool.query('UPDATE wa_bookings SET status = ? WHERE id = ?', ['paid', bookingId]);
  const ref = `BMG-${String(bookingId).padStart(4, '0')}`;
  await sendText(booking.phone, `✅ *Payment Received!*\n\nHi ${booking.client_name}, we've received your payment for *${booking.subtype_label}* — reference #${ref}. Thank you! 🎉\n\nYour booking is fully secured. We can't wait to work with you!`);
  if (opts.notifyAdmin !== false) {
    await sendText(ADMIN_PHONE, `💰 Booking #BMG-${bookingId} marked paid. Client notified.`);
  }
  return booking;
}
 
async function declineBooking(bookingId, opts) {
  opts = opts || {};
  const pool = await getDB();
  const [rows] = await pool.query('SELECT * FROM wa_bookings WHERE id = ?', [bookingId]);
  if (!rows.length) throw bookingNotFoundError();
  const booking = rows[0];
  await pool.query('UPDATE wa_bookings SET status = ? WHERE id = ?', ['declined', bookingId]);
  await sendText(booking.phone, `Hi ${booking.client_name}, unfortunately we're unable to accommodate your *${booking.subtype_label}* request for *${booking.preferred_date}*. 🙏\n\nPlease reply here or type *menu* to pick a different date — we'd still love to work with you!`);
  if (opts.notifyAdmin !== false) {
    await sendText(ADMIN_PHONE, `❌ Booking #BMG-${bookingId} declined. Client notified.`);
  }
  return booking;
}
 
async function handleAdminCommand(adminPhone, action, bookingId) {
  try {
    if (action === 'confirm') {
      await confirmBooking(bookingId);
    } else {
      await declineBooking(bookingId);
    }
  } catch(e) {
    if (e.code === 'NOT_FOUND') {
      await sendText(adminPhone, `⚠️ Booking #BMG-${bookingId} not found.`);
      return;
    }
    console.error('handleAdminCommand error:', e.message);
    await sendText(adminPhone, 'Something went wrong processing that command.');
  }
}
 
// ─── Google Sheets ────────────────────────────────────────────────────────────
 
// The single source of truth for what appendToSheet() writes, in order. Row 1
// of the sheet has to match this exactly — the sheet is read elsewhere (the
// desktop app, anyone opening it directly) by header text, not by position,
// so if this array and row 1 drift apart, data silently lands under the
// wrong label instead of failing loudly. That's exactly what happened when
// Location was added here without row 1 being updated to match.
const SHEET_HEADERS = [
  'ID', 'Date', 'Name', 'Phone', 'Email', 'Location',
  'Service', 'Type', 'Requested Date', 'Notes', 'Status',
];
 
function sheetsClient() {
  const auth = new google.auth.GoogleAuth({
    credentials: {
      client_email: process.env.GOOGLE_CLIENT_EMAIL,
      private_key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
    },
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  return google.sheets({ version: 'v4', auth });
}
 
// Checked once per process lifetime rather than before every single append —
// row 1 doesn't change on its own between bookings, and re-checking on every
// enquiry would just be an extra round trip for no benefit. A fresh check
// happens again after every Railway restart/redeploy, which is exactly when
// a header row is most likely to have drifted (a schema change shipped, or
// someone hand-edited row 1 while the old deploy was still running).
let headerCheckDone = false;
 
async function ensureSheetHeaders(sheets) {
  if (headerCheckDone) return;
  headerCheckDone = true; // set before the check so a slow/failed call can't retry-storm every booking in the meantime
  try {
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: process.env.GOOGLE_SHEET_ID,
      range: 'Sheet1!A1:K1',
    });
    const row = (res.data.values && res.data.values[0]) || [];
    const isBlank = row.every((c) => !c || !String(c).trim());
 
    if (isBlank) {
      // Brand new / empty sheet — write the correct header row ourselves
      // rather than silently appending data under no headers at all.
      await sheets.spreadsheets.values.update({
        spreadsheetId: process.env.GOOGLE_SHEET_ID,
        range: 'Sheet1!A1:K1',
        valueInputOption: 'USER_ENTERED',
        resource: { values: [SHEET_HEADERS] },
      });
      console.log('Sheet was empty — wrote header row.');
      return;
    }
 
    const matches = SHEET_HEADERS.every((h, i) => (row[i] || '').trim().toLowerCase() === h.toLowerCase());
    if (!matches) {
      console.error('Sheet header mismatch. Expected:', SHEET_HEADERS, 'Found:', row);
      await sendText(
        ADMIN_PHONE,
        `⚠️ *Booking sheet headers don't match what the bot writes.*\n\nExpected: ${SHEET_HEADERS.join(' · ')}\n\nFound: ${row.join(' · ') || '(empty row)'}\n\nNew bookings will keep landing under the wrong column labels until row 1 is fixed.`
      ).catch(() => {});
    }
  } catch (e) {
    console.error('Header check failed:', e.message);
    // Don't block bookings on this check failing — worst case here is the
    // same silent-drift risk that already existed before this guard.
  }
}
 
async function appendToSheet(bookingId, data, phone) {
  try {
    const sheets = sheetsClient();
    await ensureSheetHeaders(sheets);
    // notes is always '' now — see the comment in handleConfirm(). Keeping
    // it here preserves the 11-value row shape ensureSheetHeaders() checks
    // against; dropping it would immediately re-trigger the mismatch alert.
    await sheets.spreadsheets.values.append({
      spreadsheetId: process.env.GOOGLE_SHEET_ID,
      range: 'Sheet1!A:K',
      valueInputOption: 'USER_ENTERED',
      resource: {
        values: [[
          `#BMG-${bookingId}`,
          new Date().toLocaleString('en-ZA'),
          data.client_name,
          `+${phone}`,
          data.client_email,
          data.location || '',
          data.service_label,
          data.subtype_label,
          data.preferred_date,
          data.notes || '',
          'Pending',
        ]],
      },
    });
    console.log('Booking appended to Google Sheet');
  } catch(e) {
    console.error('Google Sheets error:', e.message);
  }
}
 
// ─── DB ───────────────────────────────────────────────────────────────────────
let db;
async function getDB() {
  if (!db) {
    const host     = process.env.MYSQLHOST;
    const port     = parseInt(process.env.MYSQLPORT || '3306');
    const database = process.env.MYSQLDATABASE || process.env.MYSQL_DATABASE;
    const user     = process.env.MYSQLUSER;
    const password = process.env.MYSQLPASSWORD;
    console.log(`DB: ${user}@${host}:${port}/${database}`);
    db = await mysql.createPool({ host, port, database, user, password, waitForConnections: true, connectionLimit: 5 });
  }
  return db;
}
 
// ─── WhatsApp API ─────────────────────────────────────────────────────────────
const WA_TIMEOUT_MS = 10000;
const sleep = ms => new Promise(r => setTimeout(r, ms));
 
async function sendText(to, text) {
  try {
    console.log(`Sending text to ${to}`);
    await axios.post(WA_API, {
      messaging_product: 'whatsapp', to, type: 'text', text: { body: text },
    }, { headers: { Authorization: `Bearer ${process.env.WA_ACCESS_TOKEN}` }, timeout: WA_TIMEOUT_MS });
    console.log(`sendText OK to ${to}`);
  } catch(e) {
    console.error('sendText error:', e.response?.data || e.message);
  }
}
 
async function sendButtons(to, body, buttons, header = '') {
  try {
    const payload = {
      messaging_product: 'whatsapp', to, type: 'interactive',
      interactive: {
        type: 'button',
        body: { text: body },
        action: { buttons: buttons.slice(0, 3).map(b => ({ type: 'reply', reply: { id: b.id, title: b.title.substring(0, 20) } })) },
      },
    };
    if (header) {
      if (/^https?:\/\//.test(header)) {
        payload.interactive.header = { type: 'image', image: { link: header } };
      } else {
        payload.interactive.header = { type: 'text', text: header };
      }
    }
    console.log(`Sending buttons to ${to}`);
    await axios.post(WA_API, payload, { headers: { Authorization: `Bearer ${process.env.WA_ACCESS_TOKEN}` }, timeout: WA_TIMEOUT_MS });
    console.log(`sendButtons OK to ${to}`);
  } catch(e) {
    console.error('sendButtons error:', e.response?.data || e.message);
  }
}
 
async function sendList(to, body, buttonLabel, sections) {
  try {
    console.log(`Sending list to ${to}`);
    await axios.post(WA_API, {
      messaging_product: 'whatsapp', to, type: 'interactive',
      interactive: { type: 'list', body: { text: body }, action: { button: buttonLabel.substring(0, 20), sections } },
    }, { headers: { Authorization: `Bearer ${process.env.WA_ACCESS_TOKEN}` }, timeout: WA_TIMEOUT_MS });
    console.log(`sendList OK to ${to}`);
  } catch(e) {
    console.error('sendList error:', e.response?.data || e.message);
  }
}
 
async function sendDocument(to, link, filename, caption = '') {
  try {
    console.log(`Sending document to ${to}`);
    await axios.post(WA_API, {
      messaging_product: 'whatsapp', to, type: 'document',
      document: { link, filename, caption },
    }, { headers: { Authorization: `Bearer ${process.env.WA_ACCESS_TOKEN}` }, timeout: WA_TIMEOUT_MS });
    console.log(`sendDocument OK to ${to}`);
  } catch(e) {
    console.error('sendDocument error:', e.response?.data || e.message);
  }
}
 
async function sendDatePickerFlow(to) {
  try {
    console.log(`Sending date picker flow to ${to}`);
    await axios.post(WA_API, {
      messaging_product: 'whatsapp', to, type: 'interactive',
      interactive: {
        type: 'flow',
        body: { text: 'Tap below to pick your date and time from the calendar. 📅\n\nNot sure yet, or prefer to type it? Just send it as a message instead — e.g. _15 July 2026, 14:00_ or _"anytime in August"_.' },
        action: {
          name: 'flow',
          parameters: {
            flow_message_version: '3',
            flow_token: 'unused',
            flow_id: BOOKING_DATE_FLOW_ID,
            flow_cta: 'Pick a Date',
            flow_action: 'navigate',
            flow_action_payload: { screen: 'BOOKING_DATE_TIME' },
          },
        },
      },
    }, { headers: { Authorization: `Bearer ${process.env.WA_ACCESS_TOKEN}` }, timeout: WA_TIMEOUT_MS });
    console.log(`sendDatePickerFlow OK to ${to}`);
  } catch(e) {
    console.error('sendDatePickerFlow error:', e.response?.data || e.message);
  }
}
 
// ─── Session ──────────────────────────────────────────────────────────────────
async function getSession(phone) {
  try {
    const pool = await getDB();
    const [rows] = await pool.query('SELECT * FROM wa_sessions WHERE phone = ?', [phone]);
    if (!rows.length) {
      await saveSession(phone, 'START', {});
      return { phone, state: 'START', data: {} };
    }
    const raw = rows[0];
    let data = {};
    if (raw.data) {
      data = typeof raw.data === 'object' ? raw.data : JSON.parse(raw.data);
    }
    return { phone: raw.phone, state: raw.state, data };
  } catch(e) {
    console.error('getSession error:', e.message);
    return { phone, state: 'START', data: {} };
  }
}
 
async function saveSession(phone, state, data = {}) {
  try {
    const pool = await getDB();
    await pool.query(
      `INSERT INTO wa_sessions (phone, state, data, updated_at) VALUES (?, ?, ?, NOW())
       ON DUPLICATE KEY UPDATE state=VALUES(state), data=VALUES(data), updated_at=NOW()`,
      [phone, state, JSON.stringify(data)]
    );
  } catch(e) { console.error('saveSession error:', e.message); }
}
 
async function resetSession(phone) { await saveSession(phone, 'START', {}); }
 
// ─── Flow ─────────────────────────────────────────────────────────────────────
async function handle(phone, displayName, input, msgType) {
  const sess  = await getSession(phone);
  const state = sess.state;
  const data  = sess.data;
 
  if (['menu','hi','hey','hello','start','restart','hallo','good morning','good afternoon'].includes(input.toLowerCase())) {
    await resetSession(phone);
    await sendMainMenu(phone, displayName);
    await saveSession(phone, 'MAIN_MENU', { name: displayName });
    return;
  }
 
  switch (state) {
    case 'START':          await sendMainMenu(phone, displayName); await saveSession(phone, 'MAIN_MENU', { name: displayName }); break;
    case 'MAIN_MENU':      await handleMainMenu(phone, displayName, input, data); break;
    case 'ENTER_PACKAGE':  await handleEnterPackage(phone, input, data); break;
    case 'CHOOSE_PACKAGE': await handleChoosePackage(phone, input, data); break;
    case 'POST_RATES':     await handlePostRates(phone, displayName, input, data); break;
    case 'ENTER_DATE':     await handleDate(phone, input, data); break;
    case 'ENTER_NAME':     await handleName(phone, input, data); break;
    case 'ENTER_EMAIL':    await handleEmail(phone, input, data); break;
    case 'CHOOSE_LOCATION':      await handleLocation(phone, input, data); break;
    case 'ENTER_LOCATION_OTHER': await handleLocationOther(phone, input, data); break;
    case 'CONFIRM':        await handleConfirm(phone, input, data); break;
    case 'CONFIRM_DUPLICATE': await handleConfirmDuplicate(phone, input, data); break;
    default: await resetSession(phone); await sendMainMenu(phone, displayName); await saveSession(phone, 'MAIN_MENU', { name: displayName });
  }
}
 
async function sendMainMenu(phone, name) {
  await sendButtons(phone,
    `👋 Hi ${name}! Welcome to *Nanoblack Photo | Video* by *BMG Systems* 🎓📸\n\nHair, makeup, dress, jewellery — stunning. But who's capturing it? That's where we come in! 📸✨\n\nTap below to see our packages or reserve your date! 👇`,
    [{ id: 'menu_rates', title: '📦 View Rates' }, { id: 'menu_book', title: '📅 Make an Enquiry' }],
    BANNER_URL
  );
}
 
async function handleMainMenu(phone, displayName, input, data) {
  if (input === 'menu_rates') {
    await sendDocument(phone, RATE_SHEETS.sub_md, 'Matric Dance Rates.pdf', `Here's our ${SUBTYPE_LABEL} rate card 📄`);
    await sleep(4000);
    await sendText(phone, '📖 Take your time and browse through our packages.\n\nFound one you love? We\'d love to hear from you — sending an enquiry takes less than a minute! ✨');
    await sleep(3000);
    await sendPackageList(phone);
    await saveSession(phone, 'CHOOSE_PACKAGE', { ...data, service: 'svc_photo', service_label: SERVICE_LABEL, subtype: SUBTYPE_ID, subtype_label: SUBTYPE_LABEL });
  } else if (input === 'menu_book') {
    await sendText(phone, `Great! Let's get your *${SUBTYPE_LABEL}* enquiry started. 🎉`);
    await sendPackageList(phone);
    await saveSession(phone, 'CHOOSE_PACKAGE', { name: displayName, skip_browse_prompt: true, service: 'svc_photo', service_label: SERVICE_LABEL, subtype: SUBTYPE_ID, subtype_label: SUBTYPE_LABEL });
  } else {
    await sendText(phone, 'Please tap one of the buttons above, or type *menu* to start over.');
  }
}
 
async function handleEnterPackage(phone, input, data) {
  if (input.trim().length < 2) { await sendText(phone, "Please let us know which package you're interested in."); return; }
  data.rate_package = input;
  await sendPostRatesPrompt(phone);
  await saveSession(phone, 'POST_RATES', data);
}
 
async function sendPackageList(phone) {
  await sendList(phone, 'Which package catches your eye? 👀', 'View Packages', [{ title: 'Choose a Package', rows: PACKAGE_OPTIONS }]);
}
 
async function handleChoosePackage(phone, input, data) {
  const pkg = PACKAGE_OPTIONS.find(p => p.id === input);
  if (!pkg) { await sendText(phone, 'Please select a package from the list, or type *menu* to restart.'); return; }
  data.rate_package = pkg.title;
  await sendText(phone, `Lovely choice — *${pkg.title}*. ✨`);
  if (data.skip_browse_prompt) {
    await sendDatePickerFlow(phone);
    await saveSession(phone, 'ENTER_DATE', data);
    return;
  }
  await sendPostRatesPrompt(phone);
  await saveSession(phone, 'POST_RATES', data);
}
 
async function sendPostRatesPrompt(phone) {
  await sendButtons(phone,
    'Would you like to make an enquiry, or are you just browsing for now? 😊',
    [{ id: 'post_rates_book', title: '📅 Make an Enquiry' }, { id: 'post_rates_browse', title: '👀 Just Looking' }]
  );
}
 
async function handlePostRates(phone, displayName, input, data) {
  if (input === 'post_rates_book') {
    await sendText(phone, `Great! Let's get your *${data.subtype_label || SUBTYPE_LABEL}* enquiry started. 🎉`);
    await sendDatePickerFlow(phone);
    await saveSession(phone, 'ENTER_DATE', { ...data, service: data.service || 'svc_photo', service_label: data.service_label || SERVICE_LABEL, subtype: data.subtype || SUBTYPE_ID, subtype_label: data.subtype_label || SUBTYPE_LABEL });
  } else if (input === 'post_rates_browse') {
    await resetSession(phone);
    await sendText(phone, `Thanks for stopping by! 🙏 We'd love to capture your next big moment.\n\n✨ When you're ready, just type *menu* and we'll get your enquiry sent in seconds. See you soon! 👋`);
  } else {
    await sendPostRatesPrompt(phone);
  }
}
 
async function handleDate(phone, input, data) {
  if (input.startsWith('flow_reply:')) {
    try {
      const { booking_date, start_time, end_time } = JSON.parse(input.slice('flow_reply:'.length));
      data.preferred_date = `${booking_date}, ${start_time} - ${end_time}`;
    } catch(e) {
      await sendText(phone, "Sorry, we couldn't read that. Please pick a date from the calendar above, or type it instead.");
      return;
    }
    await sendText(phone, `Got it — *${data.preferred_date}*. 📅\n\nWhat's your full name?`);
    await saveSession(phone, 'ENTER_NAME', data);
    return;
  }
  if (input.trim().length < 3) { await sendText(phone, 'Please pick a date from the calendar above, or type a date and time.'); return; }
  data.preferred_date = input;
  await sendText(phone, `Got it — *${input}*. 📅\n\nWhat's your full name?`);
  await saveSession(phone, 'ENTER_NAME', data);
}
 
async function handleName(phone, input, data) {
  if (input.trim().length < 2) { await sendText(phone, 'Please enter your full name.'); return; }
  data.client_name = input;
  await sendText(phone, `Thanks *${input}*! 😊\n\nWhat's your email address?`);
  await saveSession(phone, 'ENTER_EMAIL', data);
}
 
async function handleEmail(phone, input, data) {
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input)) { await sendText(phone, "That doesn't look valid. Try again — e.g. _name@gmail.com_"); return; }
  data.client_email = input;
  await sendList(phone, '📍 Where are you based?', 'Select Location', [{ title: 'Choose a Location', rows: LOCATION_OPTIONS }]);
  await saveSession(phone, 'CHOOSE_LOCATION', data);
}
 
async function handleLocation(phone, input, data) {
  const loc = LOCATION_OPTIONS.find(l => l.id === input);
  if (!loc) { await sendText(phone, 'Please select a location from the list, or type *menu* to restart.'); return; }
  if (loc.id === 'loc_other') {
    await sendText(phone, 'No problem! Please type your location.');
    await saveSession(phone, 'ENTER_LOCATION_OTHER', data);
    return;
  }
  data.location = loc.title;
  await sendDocument(phone, TRAVEL_COSTS_PDF, 'Travel Costs.pdf', `Here's our travel cost guide for ${loc.title} 📄`);
  await sendText(phone, TRAVEL_DISCLAIMER);
  await sendConfirmSummary(phone, data);
  await saveSession(phone, 'CONFIRM', data);
}
 
async function handleLocationOther(phone, input, data) {
  if (input.trim().length < 2) { await sendText(phone, 'Please enter your location.'); return; }
  data.location = input;
  await sendConfirmSummary(phone, data);
  await saveSession(phone, 'CONFIRM', data);
}
 
async function sendConfirmSummary(phone, data) {
  await sendButtons(phone,
    `✅ *Enquiry/Booking Summary*\n\n👤 *Name:* ${data.client_name}\n📧 *Email:* ${data.client_email}\n📍 *Location:* ${data.location || 'N/A'}\n🎯 *Service:* ${data.service_label}\n📋 *Type:* ${data.subtype_label}${data.rate_package ? `\n💰 *Package:* ${data.rate_package}` : ''}\n📅 *Date:* ${data.preferred_date}\n\n👉 Please make sure these details are correct, then tap *✅ Confirm* to send your request.`,
    [{ id: 'confirm_yes', title: '✅ Confirm' }, { id: 'confirm_edit', title: '✏️ Start Over' }, { id: 'confirm_cancel', title: '❌ Cancel' }]
  );
}
 
// A client resubmitting (double-tapping Confirm, or genuinely re-enquiring
// while their first request is still sitting untouched) used to just create
// a second row silently. This catches the common case — same phone, another
// pending booking within the last month — without blocking a client who
// genuinely wants a second, separate booking; it just makes them confirm
// that's what they meant.
const DUPLICATE_WINDOW_DAYS = 30;
 
async function findRecentPendingBooking(phone) {
  try {
    const pool = await getDB();
    const [rows] = await pool.query(
      `SELECT id, created_at FROM wa_bookings
       WHERE phone = ? AND status = 'pending' AND created_at > (NOW() - INTERVAL ? DAY)
       ORDER BY created_at DESC LIMIT 1`,
      [phone, DUPLICATE_WINDOW_DAYS]
    );
    return rows[0] || null;
  } catch (e) {
    console.error('findRecentPendingBooking error:', e.message);
    return null; // fail open — a broken dedupe check shouldn't block a real booking
  }
}
 
// Shared by the normal confirm path and the "yes, send it anyway" duplicate
// path below, so there's exactly one place that inserts a booking.
async function finalizeBooking(phone, data) {
  const pool = await getDB();
  // notes is no longer collected from the client (see handleLocation /
  // handleLocationOther — they go straight to the confirm summary now),
  // but the column stays in this INSERT and data.notes stays in
  // appendToSheet()'s payload deliberately. Dropping it would shrink the
  // row from 11 values back to 10 and reopen the exact column-shift bug
  // that misaligned the Google Sheet before — this just always inserts ''.
  const [result] = await pool.query(
    `INSERT INTO wa_bookings (phone, client_name, client_email, location, service, service_label, subtype, subtype_label, preferred_date, notes, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', NOW())`,
    [phone, data.client_name, data.client_email, data.location || '', data.service, data.service_label, data.subtype, data.subtype_label, data.preferred_date, data.notes || '']
  );
  await sendText(phone, `🎉 *Request Sent!*\n\nWe'll be in touch in regards to the availability of your request. 📅\n\nThanks *${data.client_name}* — we'll be in touch within 24 hours.\n\n📋 *Reference:* #BMG-${result.insertId}\n\nType *menu* to make another enquiry. 🙏`);
  await saveSession(phone, 'DONE', data);
  // Send admin notification via approved template
  try {
    await axios.post(WA_API, {
      messaging_product: 'whatsapp',
      to: '27650767631',
      type: 'template',
      template: {
        name: 'new_booking_notification',
        language: { code: 'en' },
        components: [{
          type: 'body',
          parameters: [
            { type: 'text', text: `#BMG-${result.insertId}` },
            { type: 'text', text: data.client_name },
            { type: 'text', text: `+${phone}` },
            { type: 'text', text: data.client_email },
            { type: 'text', text: `${data.service_label} → ${data.subtype_label}` },
            { type: 'text', text: data.preferred_date },
            { type: 'text', text: data.rate_package ? `Package: ${data.rate_package}` : 'None' },
          ],
        }],
      },
    }, { headers: { Authorization: `Bearer ${process.env.WA_ACCESS_TOKEN}` }, timeout: WA_TIMEOUT_MS });
    console.log('Admin notification sent');
  } catch(e) {
    console.error('Admin notification error:', e.response?.data || e.message);
  }
  await appendToSheet(result.insertId, data, phone);
}
 
async function handleConfirm(phone, input, data) {
  if (input === 'confirm_yes') {
    try {
      const dup = await findRecentPendingBooking(phone);
      if (dup) {
        await sendButtons(phone,
          `You already have a pending enquiry — *#BMG-${dup.id}* (submitted ${new Date(dup.created_at).toLocaleDateString('en-ZA')}) that we haven't gotten back to you on yet. 🙏\n\nWant to send this as a separate, new enquiry too, or hold off since the first one's still in progress?`,
          [{ id: 'dup_proceed', title: '📨 Send as new' }, { id: 'dup_cancel', title: '⏳ Hold off' }]
        );
        await saveSession(phone, 'CONFIRM_DUPLICATE', data);
        return;
      }
      await finalizeBooking(phone, data);
    } catch(e) {
      console.error('Save booking error:', e.message);
      await sendText(phone, 'Sorry, something went wrong. Please try again.');
    }
  } else if (input === 'confirm_edit') {
    await resetSession(phone); await sendText(phone, "No problem! Type *hi* to start over. 😊");
  } else if (input === 'confirm_cancel') {
    await resetSession(phone); await sendText(phone, "Cancelled. Type *hi* anytime to enquire with us! 👋");
  } else {
    await sendText(phone, "I can't reply to typed messages at this step — please tap *✅ Confirm* below to send your request through (or *✏️ Start Over* / *❌ Cancel*).");
    await sendConfirmSummary(phone, data);
  }
}
 
async function handleConfirmDuplicate(phone, input, data) {
  if (input === 'dup_proceed') {
    try {
      await finalizeBooking(phone, data);
    } catch(e) {
      console.error('Save booking error:', e.message);
      await sendText(phone, 'Sorry, something went wrong. Please try again.');
    }
  } else if (input === 'dup_cancel') {
    await resetSession(phone);
    await sendText(phone, "No problem — we've still got your first enquiry on file and will be in touch soon! 🙏");
  } else {
    await sendText(phone, "Please tap one of the buttons above to let us know how you'd like to proceed.");
  }
}
 
// ─── Routes ───────────────────────────────────────────────────────────────────
app.get('/webhook', (req, res) => {
  const { hub_mode, hub_verify_token, hub_challenge } = req.query;
  if (hub_mode === 'subscribe' && hub_verify_token === process.env.WEBHOOK_VERIFY_TOKEN) {
    console.log('Webhook verified'); return res.status(200).send(hub_challenge);
  }
  res.sendStatus(403);
});
 
app.post('/webhook', async (req, res) => {
  res.sendStatus(200);
  try {
    const value   = req.body?.entry?.[0]?.changes?.[0]?.value;
    const message = value?.messages?.[0];
    if (!message) return;
    const phone       = message.from;
    const displayName = value?.contacts?.[0]?.profile?.name || 'there';
    const msgType     = message.type;
    let input = '';
    if (msgType === 'text') input = message.text?.body?.trim() || '';
    else if (msgType === 'interactive') {
      const iType = message.interactive?.type;
      if (iType === 'button_reply') input = message.interactive.button_reply?.id || '';
      if (iType === 'list_reply')   input = message.interactive.list_reply?.id || '';
      if (iType === 'nfm_reply')    input = `flow_reply:${message.interactive.nfm_reply?.response_json || '{}'}`;
    }
    console.log(`MSG from ${phone}: "${input}" (${msgType})`);
    if (phone === ADMIN_PHONE) {
      const m = input.match(/^(confirm|decline)\s+#?(?:BMG-)?(\d+)$/i);
      if (m) { await handleAdminCommand(phone, m[1].toLowerCase(), m[2]); return; }
    }
    await handle(phone, displayName, input, msgType);
  } catch(e) { console.error('Webhook error:', e.message); }
});
 
app.get('/', (req, res) => res.send('BMG Booking Bot ✅'));
 
// ─── Desktop app bridge ─────────────────────────────────────────────────────
// The desktop app used to read the sheet straight off its public "anyone
// with the link" CSV export — that's the exposure this closes. This process
// already holds the Sheets service-account credentials (see sheetsClient()
// above); the desktop app now authenticates to *this* endpoint instead, with
// its own separate, revocable secret, and never touches the Google
// credentials or the sheet's own sharing settings at all. Once this is wired
// up, the sheet itself can go back to fully private.
// Two ways in: the desktop app sends x-api-key: API_SECRET directly; the
// mobile page (which never holds that secret — see the /mobile section
// above) sends its signed session cookie instead. Either is sufficient.
function checkApiSecret(req, res, next) {
  if (!API_SECRET) {
    res.status(500).json({ error: 'API_SECRET is not configured on the server' });
    return;
  }
  if (req.get('x-api-key') === API_SECRET) { next(); return; }
  if (hasValidMobileSession(req)) { next(); return; }
  res.status(401).json({ error: 'Unauthorized' });
}
 
// Accepts "45", "BMG-45", or "#BMG-45" — the desktop app addresses bookings
// by the sheet's ID column text, the WhatsApp admin command by the raw
// MySQL integer id. This normalizes either into both forms so a single
// route can talk to the DB and the sheet without the caller worrying about
// which spelling either side expects.
function parseBookingRef(raw) {
  const digits = String(raw || '').replace(/[^0-9]/g, '');
  if (!digits) return null;
  return { dbId: digits, sheetId: '#BMG-' + digits };
}
 
// Shared by /status, /confirm, and /decline below — one place that knows
// how to find a booking's row and overwrite its Status cell, rather than
// three copies of the same lookup-by-ID logic drifting apart over time.
// Returns false (not an error) when the row simply isn't in the sheet yet —
// callers decide whether that's worth surfacing.
async function writeSheetStatus(sheets, sheetId, status) {
  const idColumn = await sheets.spreadsheets.values.get({
    spreadsheetId: process.env.GOOGLE_SHEET_ID,
    range: 'Sheet1!A:A',
  });
  const idRows = idColumn.data.values || [];
  const rowIndex = idRows.findIndex((r) => (r[0] || '').trim() === sheetId);
  if (rowIndex < 1) return false; // row 0 is the header row
  const statusColIdx = SHEET_HEADERS.findIndex((h) => h.toLowerCase() === 'status');
  const colLetter = String.fromCharCode('A'.charCodeAt(0) + statusColIdx);
  await sheets.spreadsheets.values.update({
    spreadsheetId: process.env.GOOGLE_SHEET_ID,
    range: `Sheet1!${colLetter}${rowIndex + 1}`,
    valueInputOption: 'USER_ENTERED',
    resource: { values: [[status]] },
  });
  return true;
}
 
// The Sheets API needs the tab's internal numeric grid ID for row deletion
// (a completely different number from anything in the booking data — don't
// confuse it with the booking's own "#BMG-45" sheetId string used
// everywhere else in this file). Cached for the life of the process since a
// tab's grid ID never changes; refetching it on every delete would be a
// wasted round trip.
let cachedSheetGridId = null;
async function getSheetGridId(sheets) {
  if (cachedSheetGridId !== null) return cachedSheetGridId;
  const meta = await sheets.spreadsheets.get({ spreadsheetId: process.env.GOOGLE_SHEET_ID });
  const tab = (meta.data.sheets || []).find((s) => s.properties && s.properties.title === 'Sheet1');
  cachedSheetGridId = tab ? tab.properties.sheetId : 0;
  return cachedSheetGridId;
}
 
// Actually deletes the row from the sheet — unlike writeSheetStatus, there's
// no undo once this runs. Row indices aren't cached anywhere between calls
// (this always re-looks-up the current row by ID first), so this is safe to
// call even if other rows have shifted since the sheet was last read.
async function deleteSheetRow(sheets, sheetId) {
  const idColumn = await sheets.spreadsheets.values.get({
    spreadsheetId: process.env.GOOGLE_SHEET_ID,
    range: 'Sheet1!A:A',
  });
  const idRows = idColumn.data.values || [];
  const rowIndex = idRows.findIndex((r) => (r[0] || '').trim() === sheetId);
  if (rowIndex < 1) return false; // not found, or it's the header row
  const gridId = await getSheetGridId(sheets);
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: process.env.GOOGLE_SHEET_ID,
    resource: {
      requests: [{
        deleteDimension: {
          range: { sheetId: gridId, dimension: 'ROWS', startIndex: rowIndex, endIndex: rowIndex + 1 },
        },
      }],
    },
  });
  return true;
}
 
app.get('/api/inquiries', checkApiSecret, async (req, res) => {
  try {
    const sheets = sheetsClient();
    await ensureSheetHeaders(sheets);
    const result = await sheets.spreadsheets.values.get({
      spreadsheetId: process.env.GOOGLE_SHEET_ID,
      range: 'Sheet1!A:K',
    });
    const rows = result.data.values || [];
    if (!rows.length) { res.json({ headers: [], records: [] }); return; }
    // Same shape main.js's own parseSheet() used to build from the CSV, so
    // the desktop app's header-driven column detection needs no changes.
    const headers = rows[0].map((h, i) => (h && String(h).trim()) || ('Column ' + (i + 1)));
    const records = rows.slice(1)
      .filter((r) => r.some((cell) => cell !== undefined && cell !== ''))
      .map((r) => {
        const obj = {};
        headers.forEach((h, i) => { obj[h] = r[i] !== undefined ? r[i] : ''; });
        return obj;
      });
    res.json({ headers, records });
  } catch (e) {
    console.error('GET /api/inquiries error:', e.message);
    res.status(500).json({ error: 'Failed to read sheet' });
  }
});
 
// Plain label mirror — no client-facing side effects. Used for Responded/
// un-Responded/un-Accepted, none of which have a WhatsApp-side equivalent
// message to send. Accept itself no longer uses this route; see /confirm.
app.post('/api/inquiries/:id/status', checkApiSecret, async (req, res) => {
  const bookingId = String(req.params.id || '').trim();
  const status = String((req.body && req.body.status) || '').trim();
  if (!bookingId || !status) { res.status(400).json({ error: 'id and status are required' }); return; }
  try {
    const found = await writeSheetStatus(sheetsClient(), bookingId, status);
    if (!found) { res.status(404).json({ error: 'Booking ID not found' }); return; }
    res.json({ ok: true });
  } catch (e) {
    console.error('POST /api/inquiries/:id/status error:', e.message);
    res.status(500).json({ error: 'Failed to update status' });
  }
});
 
// Full parity with the WhatsApp admin "confirm #BMG-X" command — this is
// what the desktop app's Accept button calls. Updates wa_bookings, messages
// the client with their confirmation and deposit/banking details via
// confirmBooking() (the exact same function the WhatsApp path uses), and
// mirrors the sheet's Status cell. notifyAdmin is off since the desktop
// app's own UI is the confirmation the person clicking Accept sees.
app.post('/api/inquiries/:id/confirm', checkApiSecret, async (req, res) => {
  const ref = parseBookingRef(req.params.id);
  if (!ref) { res.status(400).json({ error: 'Invalid booking id' }); return; }
  try {
    const booking = await confirmBooking(ref.dbId, { notifyAdmin: false });
    try {
      await writeSheetStatus(sheetsClient(), ref.sheetId, 'Accepted');
    } catch (e) {
      // The client has already been messaged and the DB already updated —
      // don't fail the whole request over the sheet mirror specifically.
      console.error('Sheet status write after confirm failed:', e.message);
    }
    res.json({ ok: true, booking: { id: booking.id, client_name: booking.client_name } });
  } catch (e) {
    if (e.code === 'NOT_FOUND') { res.status(404).json({ error: 'Booking not found' }); return; }
    console.error('POST /api/inquiries/:id/confirm error:', e.message);
    res.status(500).json({ error: 'Failed to confirm booking' });
  }
});
 
// Same shape as /confirm, for symmetry — not called from the desktop app
// yet (there's no Decline button in inquiries.html today), but the shared
// declineBooking() function is right here if that's ever added.
app.post('/api/inquiries/:id/decline', checkApiSecret, async (req, res) => {
  const ref = parseBookingRef(req.params.id);
  if (!ref) { res.status(400).json({ error: 'Invalid booking id' }); return; }
  try {
    const booking = await declineBooking(ref.dbId, { notifyAdmin: false });
    try {
      await writeSheetStatus(sheetsClient(), ref.sheetId, 'Declined');
    } catch (e) {
      console.error('Sheet status write after decline failed:', e.message);
    }
    res.json({ ok: true, booking: { id: booking.id, client_name: booking.client_name } });
  } catch (e) {
    if (e.code === 'NOT_FOUND') { res.status(404).json({ error: 'Booking not found' }); return; }
    console.error('POST /api/inquiries/:id/decline error:', e.message);
    res.status(500).json({ error: 'Failed to decline booking' });
  }
});
 
// Same shape as /confirm — this is what the desktop app's "Mark Paid"
// button calls. Updates wa_bookings, messages the client via
// markPaidBooking() above, and mirrors the sheet's Status cell.
app.post('/api/inquiries/:id/paid', checkApiSecret, async (req, res) => {
  const ref = parseBookingRef(req.params.id);
  if (!ref) { res.status(400).json({ error: 'Invalid booking id' }); return; }
  try {
    const booking = await markPaidBooking(ref.dbId, { notifyAdmin: false });
    try {
      await writeSheetStatus(sheetsClient(), ref.sheetId, 'Paid');
    } catch (e) {
      console.error('Sheet status write after paid failed:', e.message);
    }
    res.json({ ok: true, booking: { id: booking.id, client_name: booking.client_name } });
  } catch (e) {
    if (e.code === 'NOT_FOUND') { res.status(404).json({ error: 'Booking not found' }); return; }
    console.error('POST /api/inquiries/:id/paid error:', e.message);
    res.status(500).json({ error: 'Failed to mark booking as paid' });
  }
});
 
// Delivery-style pings — what the desktop app's On the way / Arrived /
// Session complete buttons call. No status stored anywhere; just tells
// sendRouteUpdate() which message to send.
app.post('/api/inquiries/:id/route-update', checkApiSecret, async (req, res) => {
  const ref = parseBookingRef(req.params.id);
  if (!ref) { res.status(400).json({ error: 'Invalid booking id' }); return; }
  const stage = String((req.body && req.body.stage) || '').trim();
  if (!ROUTE_STAGES[stage]) { res.status(400).json({ error: 'stage must be one of: ' + Object.keys(ROUTE_STAGES).join(', ') }); return; }
  try {
    const booking = await sendRouteUpdate(ref.dbId, stage, { notifyAdmin: false });
    res.json({ ok: true, booking: { id: booking.id, client_name: booking.client_name } });
  } catch (e) {
    if (e.code === 'NOT_FOUND') { res.status(404).json({ error: 'Booking not found' }); return; }
    console.error('POST /api/inquiries/:id/route-update error:', e.message);
    res.status(500).json({ error: 'Failed to send update' });
  }
});
 
// Permanently deletes the row from the sheet — no client message, no DB
// change, just the sheet. Both the desktop app's Remove button and the
// mobile page's Remove button call this directly; there's no local-only
// "hide" version of Remove anymore now that this is the real thing.
app.post('/api/inquiries/:id/remove', checkApiSecret, async (req, res) => {
  const ref = parseBookingRef(req.params.id);
  if (!ref) { res.status(400).json({ error: 'Invalid booking id' }); return; }
  try {
    const found = await deleteSheetRow(sheetsClient(), ref.sheetId);
    if (!found) { res.status(404).json({ error: 'Booking not found in the sheet' }); return; }
    res.json({ ok: true });
  } catch (e) {
    console.error('POST /api/inquiries/:id/remove error:', e.message);
    res.status(500).json({ error: 'Failed to remove the row from the sheet' });
  }
});
 
// ── Mobile web page ──────────────────────────────────────────────────────────
// A phone-friendly Inquiries view served straight from the bot, so Nano can
// check and act on bookings without the desktop app. It talks to the exact
// same /api/inquiries* routes above (via the session cookie checkApiSecret
// now accepts) rather than duplicating any booking logic here — this is
// presentation only.
//
// New/Accepted/Declined is read straight from the sheet's own Status column
// (written by /confirm, /decline, /paid above) rather than the desktop app's
// local accepted/declined/paid JSON files, which this page has no access to
// and doesn't need — the sheet is already the shared source of truth.
 
function requireMobileSession(req, res, next) {
  if (hasValidMobileSession(req)) { next(); return; }
  res.redirect('/mobile/login');
}
 
function mobileNotConfiguredMessage() {
  const missing = [];
  if (!MOBILE_PASSWORD) missing.push('MOBILE_PASSWORD');
  if (!MOBILE_SESSION_SECRET) missing.push('MOBILE_SESSION_SECRET');
  return `Set ${missing.join(' and ')} in Railway's environment variables for this service, then redeploy.`;
}
 
app.get('/mobile/login', (req, res) => {
  if (!MOBILE_PASSWORD || !MOBILE_SESSION_SECRET) {
    res.status(500).send(mobileNotConfiguredMessage());
    return;
  }
  res.type('html').send(`<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Black Meridian — Sign in</title>
<style>
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
    background: #16150f; color: #f4f1e8; font-family: 'Segoe UI', system-ui, sans-serif; padding: 24px; }
  form { width: 100%; max-width: 320px; }
  h1 { font-size: 20px; font-weight: 600; margin: 0 0 4px; }
  p.sub { color: #9a9484; font-size: 13px; margin: 0 0 24px; }
  input { width: 100%; padding: 12px 14px; border-radius: 8px; border: 1px solid #3d3a2d;
    background: #201f16; color: #f4f1e8; font-size: 15px; margin-bottom: 12px; }
  input:focus { outline: none; border-color: #9a7a3c; }
  button { width: 100%; padding: 12px; border-radius: 8px; border: 0; background: #9a7a3c;
    color: #16150f; font-weight: 600; font-size: 14px; cursor: pointer; }
  button:disabled { opacity: .6; }
  #err { color: #d1543f; font-size: 13px; margin-top: 10px; min-height: 16px; }
</style></head>
<body>
  <form id="f">
    <h1>Black Meridian Suite</h1>
    <p class="sub">Sign in to view inquiries on your phone.</p>
    <input type="password" id="pw" placeholder="Password" autofocus autocomplete="current-password">
    <button type="submit" id="go">Sign in</button>
    <div id="err"></div>
  </form>
  <script>
    document.getElementById('f').addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = document.getElementById('go');
      const err = document.getElementById('err');
      btn.disabled = true; err.textContent = '';
      try {
        const res = await fetch('/mobile/login', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ password: document.getElementById('pw').value }),
        });
        if (res.ok) { location.href = '/mobile'; return; }
        const data = await res.json().catch(() => ({}));
        err.textContent = data.error || 'Wrong password.';
      } catch (e) {
        err.textContent = 'Could not reach the server.';
      }
      btn.disabled = false;
    });
  </script>
</body></html>`);
});
 
app.post('/mobile/login', (req, res) => {
  if (!MOBILE_PASSWORD || !MOBILE_SESSION_SECRET) {
    res.status(500).json({ error: mobileNotConfiguredMessage() });
    return;
  }
  const supplied = String((req.body && req.body.password) || '');
  const expected = Buffer.from(MOBILE_PASSWORD);
  const given = Buffer.from(supplied);
  const match = given.length === expected.length && crypto.timingSafeEqual(given, expected);
  if (!match) { res.status(401).json({ error: 'Wrong password.' }); return; }
  const cookie = `${MOBILE_COOKIE_NAME}=${mobileSessionToken()}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${Math.floor(MOBILE_SESSION_MAX_AGE_MS / 1000)}`;
  res.setHeader('Set-Cookie', cookie);
  res.json({ ok: true });
});
 
app.get('/mobile/logout', (req, res) => {
  res.setHeader('Set-Cookie', `${MOBILE_COOKIE_NAME}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`);
  res.redirect('/mobile/login');
});
 
app.get('/mobile', requireMobileSession, (req, res) => {
  res.type('html').send(`<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Inquiries — Black Meridian</title>
<style>
  * { box-sizing: border-box; -webkit-tap-highlight-color: transparent; }
  body { margin: 0; background: #16150f; color: #f4f1e8; font-family: 'Segoe UI', system-ui, sans-serif;
    padding-bottom: 40px; }
  header { position: sticky; top: 0; background: #100f0a; padding: 14px 16px; display: flex;
    align-items: center; justify-content: space-between; border-bottom: 1px solid #2e2c22; z-index: 10; }
  header h1 { font-size: 16px; margin: 0; font-weight: 600; }
  header button { background: none; border: 1px solid #3d3a2d; color: #cfc8b8; border-radius: 6px;
    padding: 6px 10px; font-size: 12px; }
  header .header-actions { display: flex; align-items: center; gap: 8px; }
  #refresh-btn { display: flex; align-items: center; gap: 6px; }
  #refresh-btn svg { width: 13px; height: 13px; transition: transform .5s ease; }
  #refresh-btn.spinning svg { animation: spin .6s linear infinite; }
  @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
  .tabs { display: flex; gap: 6px; padding: 12px 16px 0; }
  .tab { flex: 1; text-align: center; padding: 9px 0; border-radius: 8px; font-size: 13px; font-weight: 600;
    background: #201f16; color: #9a9484; border: 1px solid #2e2c22; }
  .tab.active { background: #9a7a3c; color: #16150f; border-color: #9a7a3c; }
  #status { padding: 10px 16px; font-size: 12px; color: #7d7864; }
  #list { padding: 8px 16px; display: flex; flex-direction: column; gap: 10px; }
  .card { background: #1e1c14; border: 1px solid #2e2c22; border-radius: 12px; padding: 14px; }
  .card .name { font-weight: 600; font-size: 15px; margin-bottom: 2px; }
  .card .meta { font-size: 12px; color: #9a9484; margin-bottom: 10px; }
  .card .id { display: inline-block; font-size: 10.5px; color: #9a7a3c; border: 1px solid #3d3a2d;
    border-radius: 5px; padding: 1px 6px; margin-bottom: 8px; }
  .row { display: flex; flex-wrap: wrap; gap: 8px; }
  .btn { flex: 1; min-width: 90px; padding: 10px 8px; border-radius: 8px; border: 1px solid #3d3a2d;
    background: none; color: #cfc8b8; font-size: 12.5px; font-weight: 600; text-align: center; }
  .btn:active { transform: scale(.95); }
  .btn.accept { color: #6b8a5f; border-color: #4a6a3f; }
  .btn.decline { color: #a35a4f; border-color: #6a3f37; }
  .btn.paid { color: #6b8a5f; border-color: #4a6a3f; }
  .btn.remove { color: #a35a4f; border-color: #6a3f37; }
  .btn.sent { color: #4a7a3f; background: #21301c; border-color: #4a6a3f; }
  .badge { display: inline-block; font-size: 11px; font-weight: 700; border-radius: 999px; padding: 3px 10px; }
  .badge.declined { color: #d19a90; background: #3a1f1c; }
  .badge.accepted { color: #a9c99c; background: #223018; }
  .badge.paid { color: #a9c99c; background: #223018; margin-left: 6px; }
  .empty { text-align: center; color: #7d7864; font-size: 13px; padding: 40px 20px; }
</style></head>
<body>
  <header>
    <h1>Inquiries</h1>
    <div class="header-actions">
      <button id="refresh-btn" onclick="manualRefresh()" title="Refresh from the desktop app / sheet">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3v6h-6"/></svg>
        Refresh
      </button>
      <button onclick="location.href='/mobile/logout'">Sign out</button>
    </div>
  </header>
  <div class="tabs">
    <div class="tab active" data-tab="new" onclick="switchTab('new')">New</div>
    <div class="tab" data-tab="accepted" onclick="switchTab('accepted')">Accepted</div>
    <div class="tab" data-tab="declined" onclick="switchTab('declined')">Declined</div>
  </div>
  <div id="status">Loading…</div>
  <div id="list"></div>
 
<script>
let records = [];
let headers = [];
let currentTab = 'new';
 
function col(name) {
  return headers.find(h => h.toLowerCase() === name.toLowerCase());
}
 
async function api(path, opts) {
  const res = await fetch(path, Object.assign({ credentials: 'include' }, opts || {}));
  if (res.status === 401) { location.href = '/mobile/login'; throw new Error('Not signed in'); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
}
 
async function load() {
  const btn = document.getElementById('refresh-btn');
  if (btn) btn.classList.add('spinning');
  document.getElementById('status').textContent = 'Loading…';
  try {
    const data = await api('/api/inquiries');
    headers = data.headers || [];
    records = data.records || [];
    const now = new Date();
    const timeStr = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    document.getElementById('status').textContent = records.length + ' inquiries · updated ' + timeStr;
    render();
  } catch (e) {
    document.getElementById('status').textContent = 'Could not load: ' + e.message;
  } finally {
    if (btn) btn.classList.remove('spinning');
  }
}
 
// Manual pull — same load(), just exposed as its own name so the button's
// intent is clear and it's easy to attach analytics/haptics later without
// touching the auto-load-on-open call at the bottom of this script.
function manualRefresh() {
  load();
}
 
function switchTab(tab) {
  currentTab = tab;
  document.querySelectorAll('.tab').forEach(el => el.classList.toggle('active', el.dataset.tab === tab));
  render();
}
 
function render() {
  const statusCol = col('Status');
  const nameCol = col('Name');
  const idCol = col('ID');
  const dateCol = col('Requested Date') || col('Date');
  const svcCol = col('Type') || col('Service');
 
  const grouped = { new: [], accepted: [], declined: [] };
  records.forEach(r => {
    const status = (statusCol && r[statusCol] || '').trim().toLowerCase();
    if (status === 'declined') grouped.declined.push(r);
    else if (status === 'accepted' || status === 'paid') grouped.accepted.push(r);
    else grouped.new.push(r);
  });
 
  const list = document.getElementById('list');
  const items = grouped[currentTab];
  if (!items.length) {
    list.innerHTML = '<div class="empty">Nothing here yet.</div>';
    return;
  }
 
  list.innerHTML = items.map((r, i) => {
    const realIdx = records.indexOf(r);
    const name = nameCol ? r[nameCol] : 'Unnamed';
    const id = idCol ? r[idCol] : '';
    const date = dateCol ? r[dateCol] : '';
    const svc = svcCol ? r[svcCol] : '';
    const status = (statusCol && r[statusCol] || '').trim().toLowerCase();
    const isPaid = status === 'paid';
 
    let actions = '';
    if (currentTab === 'new') {
      actions = '<div class="row">'
        + '<button class="btn accept" onclick="doAction(' + realIdx + ',\\'confirm\\',this)">Accept</button>'
        + '<button class="btn decline" onclick="doAction(' + realIdx + ',\\'decline\\',this)">Decline</button>'
        + '</div>';
    } else if (currentTab === 'accepted') {
      actions = '<div class="row">'
        + (isPaid ? '<span class="badge paid">💰 Paid</span>' : '<button class="btn paid" onclick="doAction(' + realIdx + ',\\'paid\\',this)">💰 Mark Paid</button>')
        + '</div><div class="row" style="margin-top:8px;">'
        + '<button class="btn" onclick="doRoute(' + realIdx + ',\\'en_route\\',this)">🚗 On the way</button>'
        + '<button class="btn" onclick="doRoute(' + realIdx + ',\\'arrived\\',this)">📍 Arrived</button>'
        + '<button class="btn" onclick="doRoute(' + realIdx + ',\\'session_complete\\',this)">🎬 Complete</button>'
        + '</div>';
    } else {
      actions = '<span class="badge declined">✕ Declined</span>';
    }
    actions += '<div class="row" style="margin-top:8px;">'
      + '<button class="btn remove" onclick="doRemove(' + realIdx + ',this)">🗑 Remove</button>'
      + '</div>';
 
    return '<div class="card">'
      + (id ? '<div class="id">' + esc(id) + '</div>' : '')
      + '<div class="name">' + esc(name || 'Unnamed inquiry') + '</div>'
      + '<div class="meta">' + esc(svc) + (date ? ' · ' + esc(date) : '') + '</div>'
      + actions
      + '</div>';
  }).join('');
}
 
function esc(s) {
  return String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}
 
async function doRemove(idx, btn) {
  const idCol = col('ID');
  const nameCol = col('Name');
  const id = idCol ? records[idx][idCol] : '';
  const name = nameCol ? records[idx][nameCol] : 'this inquiry';
  if (!confirm('Permanently delete ' + (name || 'this inquiry') + ' from the sheet? This cannot be undone.')) return;
  btn.disabled = true;
  const original = btn.textContent;
  btn.textContent = 'Removing…';
  try {
    await api('/api/inquiries/' + encodeURIComponent(id) + '/remove', { method: 'POST' });
    await load();
  } catch (e) {
    alert('Failed: ' + e.message);
    btn.disabled = false;
    btn.textContent = original;
  }
}
 
async function doAction(idx, action, btn) {
  const idCol = col('ID');
  const id = idCol ? records[idx][idCol] : '';
  btn.disabled = true;
  const original = btn.textContent;
  btn.textContent = '…';
  try {
    await api('/api/inquiries/' + encodeURIComponent(id) + '/' + action, { method: 'POST' });
    await load();
  } catch (e) {
    alert('Failed: ' + e.message);
    btn.disabled = false;
    btn.textContent = original;
  }
}
 
async function doRoute(idx, stage, btn) {
  const idCol = col('ID');
  const id = idCol ? records[idx][idCol] : '';
  btn.disabled = true;
  const original = btn.textContent;
  btn.textContent = 'Sending…';
  try {
    await api('/api/inquiries/' + encodeURIComponent(id) + '/route-update', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ stage }),
    });
    btn.textContent = '✓ Sent';
    btn.classList.add('sent');
    setTimeout(() => { btn.disabled = false; btn.classList.remove('sent'); btn.textContent = original; }, 2000);
  } catch (e) {
    alert('Failed: ' + e.message);
    btn.disabled = false;
    btn.textContent = original;
  }
}
 
load();
</script>
</body></html>`);
});
 
app.listen(process.env.PORT || 3000, () => console.log(`Server running on port ${process.env.PORT || 3000}`));
 
