const express    = require('express');
const mysql      = require('mysql2/promise');
const axios      = require('axios');
const { google } = require('googleapis');

const app = express();
app.use(express.json());
app.use('/rates', express.static('public/rates'));

const WA_API = `https://graph.facebook.com/v19.0/${process.env.WA_PHONE_NUMBER_ID}/messages`;
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || 'https://bmg-booking-bot-production.up.railway.app';

const RATE_SHEETS = {
  sub_md: `${PUBLIC_BASE_URL}/rates/matric-dance-rates.pdf`,
};

const TRAVEL_COSTS_PDF = `${PUBLIC_BASE_URL}/rates/travel-costs.pdf`;
const TRAVEL_DISCLAIMER = '📌 *Travel Disclaimer:* These are estimated travel rates. Final travel cost will be confirmed once we know your exact address.';

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
async function handleAdminCommand(adminPhone, action, bookingId) {
  try {
    const pool = await getDB();
    const [rows] = await pool.query('SELECT * FROM wa_bookings WHERE id = ?', [bookingId]);
    if (!rows.length) { await sendText(adminPhone, `\u26A0\uFE0F Booking #BMG-${bookingId} not found.`); return; }
    const booking = rows[0];
    if (action === 'confirm') {
      await pool.query('UPDATE wa_bookings SET status = ? WHERE id = ?', ['confirmed', bookingId]);
      const ref = `BMG-${String(bookingId).padStart(4, '0')}`;
      await sendText(booking.phone, `\u{1F389} *Booking Confirmed!*\n\nHi ${booking.client_name}, your *${booking.subtype_label}* booking for *${booking.preferred_date}* is confirmed. \u2705\n\n\u{1F4CB} Reference: #${ref}\n\nWe can't wait to work with you! If you have any questions, just reply here.`);
      await sendText(booking.phone, `\u{1F4B0} *Reserve Your Spot*\n\nA *50% deposit* is required to secure your booking.\n\n\u{1F3E6} *Account name:* Black Meridian Group\n\u{1F3E6} *Bank:* FNB/RMB\n\u{1F522} *Account no.:* 63202712899\n\u{1F3E2} *Branch code:* 255355\n\u{1F4DD} *Reference:* ${ref}\n\n\u26A0\uFE0F Please use the reference above so we can match your payment. Once we receive it, your spot is locked in! \u{1F512}\n\n\u{1F4DE} I'll personally give you a call on our business number for a quick care call before your session.`);
      await sendText(adminPhone, `\u2705 Booking #BMG-${bookingId} confirmed. Client notified.`);
    } else {
      await pool.query('UPDATE wa_bookings SET status = ? WHERE id = ?', ['declined', bookingId]);
      await sendText(booking.phone, `Hi ${booking.client_name}, unfortunately we're unable to accommodate your *${booking.subtype_label}* request for *${booking.preferred_date}*. \u{1F64F}\n\nPlease reply here or type *menu* to pick a different date \u2014 we'd still love to work with you!`);
      await sendText(adminPhone, `\u274C Booking #BMG-${bookingId} declined. Client notified.`);
    }
  } catch(e) {
    console.error('handleAdminCommand error:', e.message);
    await sendText(adminPhone, 'Something went wrong processing that command.');
  }
}

// ─── Google Sheets ────────────────────────────────────────────────────────────
async function appendToSheet(bookingId, data, phone) {
  try {
    const auth = new google.auth.GoogleAuth({
      credentials: {
        client_email: process.env.GOOGLE_CLIENT_EMAIL,
        private_key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
      },
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });
    const sheets = google.sheets({ version: 'v4', auth });
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
    case 'POST_RATES':     await handlePostRates(phone, displayName, input, data); break;
    case 'ENTER_DATE':     await handleDate(phone, input, data); break;
    case 'ENTER_NAME':     await handleName(phone, input, data); break;
    case 'ENTER_EMAIL':    await handleEmail(phone, input, data); break;
    case 'CHOOSE_LOCATION':      await handleLocation(phone, input, data); break;
    case 'ENTER_LOCATION_OTHER': await handleLocationOther(phone, input, data); break;
    case 'ENTER_NOTES':    await handleNotes(phone, input, data); break;
    case 'CONFIRM':        await handleConfirm(phone, input, data); break;
    default: await resetSession(phone); await sendMainMenu(phone, displayName); await saveSession(phone, 'MAIN_MENU', { name: displayName });
  }
}

async function sendMainMenu(phone, name) {
  await sendButtons(phone,
    `👋 Hi ${name}! Welcome to *Nanoblack Photo | Video* by *BMG Systems* 🎓📸\n\nHair, makeup, dress, jewellery — stunning. But who's capturing it? That's where we come in! 📸✨\n\nTap below to see our packages or reserve your date! 👇`,
    [{ id: 'menu_rates', title: '📦 View Packages' }, { id: 'menu_book', title: '📅 Make an Enquiry' }],
    BANNER_URL
  );
}

async function handleMainMenu(phone, displayName, input, data) {
  if (input === 'menu_rates') {
    await sendDocument(phone, RATE_SHEETS.sub_md, 'Matric Dance Rates.pdf', `Here's our ${SUBTYPE_LABEL} rate card 📄`);
    await sendText(phone, 'Which package are you interested in? (e.g. Entry, Standard, Half-Day, Full Day)');
    await saveSession(phone, 'ENTER_PACKAGE', { ...data, service: 'svc_photo', service_label: SERVICE_LABEL, subtype: SUBTYPE_ID, subtype_label: SUBTYPE_LABEL });
  } else if (input === 'menu_book') {
    await sendText(phone, `Great! Let's get your *${SUBTYPE_LABEL}* enquiry started. 🎉`);
    await sendDatePickerFlow(phone);
    await saveSession(phone, 'ENTER_DATE', { name: displayName, service: 'svc_photo', service_label: SERVICE_LABEL, subtype: SUBTYPE_ID, subtype_label: SUBTYPE_LABEL });
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
  await sendList(phone, '📍 Where will you be travelling from?', 'Select Location', [{ title: 'Choose a Location', rows: LOCATION_OPTIONS }]);
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
  await sendText(phone, 'Almost done! Anything else we should know?\n\n_Type *skip* if none._');
  await saveSession(phone, 'ENTER_NOTES', data);
}

async function handleLocationOther(phone, input, data) {
  if (input.trim().length < 2) { await sendText(phone, 'Please enter your location.'); return; }
  data.location = input;
  await sendText(phone, 'Almost done! Anything else we should know?\n\n_Type *skip* if none._');
  await saveSession(phone, 'ENTER_NOTES', data);
}

async function handleNotes(phone, input, data) {
  data.notes = input.toLowerCase().trim() === 'skip' ? '' : input;
  await sendConfirmSummary(phone, data);
  await saveSession(phone, 'CONFIRM', data);
}

async function sendConfirmSummary(phone, data) {
  const notes = data.notes ? `\n📌 *Notes:* ${data.notes}` : '';
  await sendButtons(phone,
    `✅ *Enquiry/Booking Summary*\n\n👤 *Name:* ${data.client_name}\n📧 *Email:* ${data.client_email}\n📍 *Location:* ${data.location || 'N/A'}\n🎯 *Service:* ${data.service_label}\n📋 *Type:* ${data.subtype_label}\n📅 *Date:* ${data.preferred_date}${notes}\n\n👉 Please make sure these details are correct, then tap *✅ Confirm* to send your request.`,
    [{ id: 'confirm_yes', title: '✅ Confirm' }, { id: 'confirm_edit', title: '✏️ Start Over' }, { id: 'confirm_cancel', title: '❌ Cancel' }]
  );
}

async function handleConfirm(phone, input, data) {
  if (input === 'confirm_yes') {
    try {
      const pool = await getDB();
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
          { type: 'text', text: data.notes || 'None' },
        ],
      }],
    },
  }, { headers: { Authorization: `Bearer ${process.env.WA_ACCESS_TOKEN}` }, timeout: WA_TIMEOUT_MS });
  console.log('Admin notification sent');
} catch(e) {
  console.error('Admin notification error:', e.response?.data || e.message);
}
      await appendToSheet(result.insertId, data, phone);
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

app.listen(process.env.PORT || 3000, () => console.log(`Server running on port ${process.env.PORT || 3000}`));
