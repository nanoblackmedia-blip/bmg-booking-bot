const express = require('express');
const mysql   = require('mysql2/promise');
const axios   = require('axios');

const app = express();
app.use(express.json());

const WA_API = `https://graph.facebook.com/v19.0/${process.env.WA_PHONE_NUMBER_ID}/messages`;

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

// ─── Services ─────────────────────────────────────────────────────────────────
const SERVICES = {
  svc_photo: '📸 Photography',
  svc_video: '🎬 Videography',
  svc_web:   '💻 Web Design',
};

const SUB_TYPES = {
  svc_photo: [
    { id: 'sub_portrait',  title: 'Portrait / Headshots',    description: 'Personal or corporate' },
    { id: 'sub_event',     title: 'Event Coverage',           description: 'Conferences, parties, launches' },
    { id: 'sub_product',   title: 'Product / Commercial',     description: 'E-commerce, advertising' },
    { id: 'sub_property',  title: 'Property / Architecture',  description: 'Real estate, interior' },
  ],
  svc_video: [
    { id: 'sub_promo',     title: 'Promo / Ad Video',         description: 'Social media, TV spots' },
    { id: 'sub_corporate', title: 'Corporate Video',          description: 'Internal comms, training' },
    { id: 'sub_event_vid', title: 'Event Filming',            description: 'Full event coverage' },
    { id: 'sub_music',     title: 'Music Video',              description: 'Artists & labels' },
  ],
  svc_web: [
    { id: 'sub_newsite',   title: 'New Website',              description: 'Design & build from scratch' },
    { id: 'sub_redesign',  title: 'Redesign / Revamp',        description: 'Refresh an existing site' },
    { id: 'sub_ecom',      title: 'E-commerce Store',         description: 'WooCommerce / Shopify' },
    { id: 'sub_landing',   title: 'Landing Page',             description: 'Single conversion page' },
  ],
};

// ─── WhatsApp API ─────────────────────────────────────────────────────────────
async function sendText(to, text) {
  try {
    await axios.post(WA_API, {
      messaging_product: 'whatsapp', to, type: 'text', text: { body: text },
    }, { headers: { Authorization: `Bearer ${process.env.WA_ACCESS_TOKEN}` } });
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
    if (header) payload.interactive.header = { type: 'text', text: header };
    await axios.post(WA_API, payload, { headers: { Authorization: `Bearer ${process.env.WA_ACCESS_TOKEN}` } });
  } catch(e) {
    console.error('sendButtons error:', e.response?.data || e.message);
  }
}

async function sendList(to, body, buttonLabel, sections) {
  try {
    await axios.post(WA_API, {
      messaging_product: 'whatsapp', to, type: 'interactive',
      interactive: { type: 'list', body: { text: body }, action: { button: buttonLabel.substring(0, 20), sections } },
    }, { headers: { Authorization: `Bearer ${process.env.WA_ACCESS_TOKEN}` } });
  } catch(e) {
    console.error('sendList error:', e.response?.data || e.message);
  }
}

// ─── Session ──────────────────────────────────────────────────────────────────
async function getSession(phone) {
  try {
    const pool = await getDB();
    const [rows] = await pool.query(
      'SELECT * FROM wa_sessions WHERE phone = ?', [phone]
    );
    if (!rows.length) { await saveSession(phone, 'START', {}); return { phone, state: 'START', data: {} }; }
    try { rows[0].data = JSON.parse(rows[0].data || '{}'); } catch(je) { rows[0].data = {}; }
    return rows[0];
  } catch(e) {
    console.error('getSession error:', JSON.stringify(e), e.message, e.code, e.sqlMessage);
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

  if (['menu','hi','hello','start','restart','hallo'].includes(input.toLowerCase())) {
    await resetSession(phone);
    await sendWelcome(phone, displayName);
    await saveSession(phone, 'CHOOSE_SERVICE', { name: displayName });
    return;
  }

  switch (state) {
    case 'START':          await sendWelcome(phone, displayName); await saveSession(phone, 'CHOOSE_SERVICE', { name: displayName }); break;
    case 'CHOOSE_SERVICE': await handleService(phone, input, data); break;
    case 'CHOOSE_SUBTYPE': await handleSubType(phone, input, data); break;
    case 'ENTER_DATE':     await handleDate(phone, input, data); break;
    case 'ENTER_NAME':     await handleName(phone, input, data); break;
    case 'ENTER_EMAIL':    await handleEmail(phone, input, data); break;
    case 'ENTER_NOTES':    await handleNotes(phone, input, data); break;
    case 'CONFIRM':        await handleConfirm(phone, input, data); break;
    default: await resetSession(phone); await sendWelcome(phone, displayName); await saveSession(phone, 'CHOOSE_SERVICE', { name: displayName });
  }
}

async function sendWelcome(phone, name) {
  await sendButtons(phone,
    `👋 Hey ${name}! Welcome to *Black Meridian Group*.\n\nWhat can we help you with today?`,
    [{ id: 'svc_photo', title: '📸 Photography' }, { id: 'svc_video', title: '🎬 Videography' }, { id: 'svc_web', title: '💻 Web Design' }],
    'Black Meridian Group'
  );
}

async function handleService(phone, input, data) {
  if (!SERVICES[input]) { await sendText(phone, 'Please tap one of the buttons above, or type *menu* to start over.'); return; }
  data.service = input; data.service_label = SERVICES[input];
  await sendList(phone, `Great choice! 🙌\n\nWhat type of ${data.service_label} are you looking for?`, 'View Options', [{ title: 'Choose a Type', rows: SUB_TYPES[input] }]);
  await saveSession(phone, 'CHOOSE_SUBTYPE', data);
}

async function handleSubType(phone, input, data) {
  const sub = (SUB_TYPES[data.service] || []).find(s => s.id === input);
  if (!sub) { await sendText(phone, 'Please select an option from the list, or type *menu* to restart.'); return; }
  data.subtype = input; data.subtype_label = sub.title;
  await sendText(phone, `Perfect! *${sub.title}* — noted. 📝\n\nWhat date(s) are you thinking?\n\n_Example: 15 July 2026 or "anytime in August"_`);
  await saveSession(phone, 'ENTER_DATE', data);
}

async function handleDate(phone, input, data) {
  if (input.trim().length < 3) { await sendText(phone, 'Please enter a date or timeframe.'); return; }
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
  await sendText(phone, 'Almost done! Any extra details or requirements?\n\n_Type *skip* if none._');
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
    `✅ *Booking Summary*\n\n👤 *Name:* ${data.client_name}\n📧 *Email:* ${data.client_email}\n🎯 *Service:* ${data.service_label}\n📋 *Type:* ${data.subtype_label}\n📅 *Date:* ${data.preferred_date}${notes}\n\nShall we confirm?`,
    [{ id: 'confirm_yes', title: '✅ Confirm' }, { id: 'confirm_edit', title: '✏️ Start Over' }, { id: 'confirm_cancel', title: '❌ Cancel' }]
  );
}

async function handleConfirm(phone, input, data) {
  if (input === 'confirm_yes') {
    try {
      const pool = await getDB();
      const [result] = await pool.query(
        `INSERT INTO wa_bookings (phone, client_name, client_email, service, service_label, subtype, subtype_label, preferred_date, notes, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', NOW())`,
        [phone, data.client_name, data.client_email, data.service, data.service_label, data.subtype, data.subtype_label, data.preferred_date, data.notes || '']
      );
      await sendText(phone, `🎉 *Booking Confirmed!*\n\nThanks *${data.client_name}* — we'll be in touch within 24 hours.\n\n📋 *Reference:* #BMG-${result.insertId}\n\nType *menu* to make another booking. 🙏`);
      await saveSession(phone, 'DONE', data);
    } catch(e) { console.error('Save booking error:', e.message); await sendText(phone, 'Sorry, something went wrong saving your booking. Please try again.'); }
  } else if (input === 'confirm_edit') {
    await resetSession(phone); await sendText(phone, "No problem! Type *hi* to start over. 😊");
  } else if (input === 'confirm_cancel') {
    await resetSession(phone); await sendText(phone, "Cancelled. Type *hi* anytime to book with us! 👋");
  } else { await sendConfirmSummary(phone, data); }
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
    }
    console.log(`MSG from ${phone}: "${input}" (${msgType})`);
    await handle(phone, displayName, input, msgType);
  } catch(e) { console.error('Webhook error:', e.message); }
});

app.get('/', (req, res) => res.send('BMG Booking Bot ✅'));

app.listen(process.env.PORT || 3000, () => console.log(`Server running on port ${process.env.PORT || 3000}`));
