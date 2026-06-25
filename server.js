const express = require('express');
const cors = require('cors');
const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*';
const corsOrigin = ALLOWED_ORIGIN === '*'
  ? '*'
  : ALLOWED_ORIGIN.split(',').map(item => item.trim()).filter(Boolean);

app.use(cors({ origin: corsOrigin }));
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Railway persistent volume example: DATA_FILE=/data/prana-data.json
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'prana-data.json');

// Current clinic hours: Monday to Saturday, 5:00 PM to 9:00 PM.
// 30-minute sessions; last session begins at 8:30 PM.
const TIME_SLOTS = [
  { time: '17:00', label: '5:00 PM' },
  { time: '17:30', label: '5:30 PM' },
  { time: '18:00', label: '6:00 PM' },
  { time: '18:30', label: '6:30 PM' },
  { time: '19:00', label: '7:00 PM' },
  { time: '19:30', label: '7:30 PM' },
  { time: '20:00', label: '8:00 PM' },
  { time: '20:30', label: '8:30 PM' }
];

let queue = Promise.resolve();
function withLock(work) {
  const next = queue.then(work, work);
  queue = next.catch(() => {});
  return next;
}

function clean(value) {
  return String(value || '').trim();
}

function cleanLimited(value, maxLength) {
  return clean(value).slice(0, maxLength);
}

function isValidDate(date) {
  return /^\d{4}-\d{2}-\d{2}$/.test(date || '');
}

function getDay(date) {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

function isSunday(date) {
  return getDay(date) === 0;
}

function isValidSlot(time) {
  return TIME_SLOTS.some(slot => slot.time === time);
}

function timeLabel(time) {
  const slot = TIME_SLOTS.find(item => item.time === time);
  return slot ? slot.label : time;
}

function defaultData() {
  return { bookings: [], feedbacks: [] };
}

function normalizeData(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return defaultData();
  }

  if (!Array.isArray(data.bookings)) data.bookings = [];
  if (!Array.isArray(data.feedbacks)) data.feedbacks = [];

  data.bookings = data.bookings.map(item => ({
    id: item.id || crypto.randomUUID(),
    created_at: item.created_at || new Date().toISOString(),
    date: clean(item.date),
    time: clean(item.time),
    name: clean(item.name),
    phone: clean(item.phone),
    concern: clean(item.concern),
    message: clean(item.message),
    status: clean(item.status) || 'booked'
  }));

  data.feedbacks = data.feedbacks.map(item => ({
    id: item.id || crypto.randomUUID(),
    created_at: item.created_at || new Date().toISOString(),
    name: cleanLimited(item.name, 80) || 'Anonymous',
    rating: Number(item.rating) || 5,
    message: cleanLimited(item.message, 800),
    likes: Math.max(0, Number(item.likes) || 0),
    status: clean(item.status) || 'published'
  }));

  return data;
}

async function readData() {
  try {
    const raw = await fs.readFile(DATA_FILE, 'utf8');
    return normalizeData(JSON.parse(raw));
  } catch (err) {
    if (err.code === 'ENOENT') return defaultData();
    throw err;
  }
}

async function writeData(data) {
  await fs.mkdir(path.dirname(DATA_FILE), { recursive: true });
  await fs.writeFile(DATA_FILE, JSON.stringify(normalizeData(data), null, 2));
}

function bookedKey(booking) {
  return `${booking.date}|${booking.time}`;
}

function requireAdmin(req, res, next) {
  const expected = process.env.ADMIN_TOKEN;
  if (!expected) {
    return res.status(500).json({ error: 'ADMIN_TOKEN is not set on the server.' });
  }

  const supplied = clean(req.get('x-admin-token') || req.query.token);
  if (supplied !== expected) {
    return res.status(401).json({ error: 'Unauthorized. Invalid admin password/token.' });
  }

  next();
}

function sortBookings(bookings) {
  return [...bookings].sort((a, b) => {
    const keyA = `${a.date || ''} ${a.time || ''} ${a.created_at || ''}`;
    const keyB = `${b.date || ''} ${b.time || ''} ${b.created_at || ''}`;
    return keyB.localeCompare(keyA);
  });
}

function filterBookings(bookings, date) {
  return bookings.filter(booking => {
    if (booking.status === 'cancelled') return false;
    if (date && booking.date !== date) return false;
    return true;
  });
}

function sortFeedbacks(feedbacks) {
  return [...feedbacks].sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')));
}

function publicFeedback(feedback) {
  return {
    id: feedback.id,
    created_at: feedback.created_at,
    name: feedback.name,
    rating: feedback.rating,
    message: feedback.message,
    likes: feedback.likes || 0
  };
}

function safeCsv(value) {
  let text = clean(value).replace(/\r?\n/g, ' ');
  // CSV-injection safety for Excel-like apps.
  if (/^[=+\-@]/.test(text)) text = "'" + text;
  return '"' + text.replace(/"/g, '""') + '"';
}

app.get('/', (req, res) => {
  res.json({
    ok: true,
    service: 'Prana Homeo Care Booking + Feedback API',
    endpoints: [
      'GET /api/slots?date=YYYY-MM-DD',
      'POST /api/bookings',
      'GET /api/feedbacks',
      'POST /api/feedbacks',
      'POST /api/feedbacks/:id/like',
      'GET /api/admin/bookings',
      'GET /api/admin/feedbacks'
    ]
  });
});

app.get('/api/health', async (req, res) => {
  const data = await readData();
  res.json({ ok: true, bookings: data.bookings.length, feedbacks: data.feedbacks.length });
});

// Public: slots for selected date.
app.get('/api/slots', async (req, res) => {
  const date = clean(req.query.date);

  if (!isValidDate(date)) {
    return res.status(400).json({ error: 'Valid date is required in YYYY-MM-DD format.' });
  }

  if (isSunday(date)) {
    return res.json({
      date,
      closed: true,
      message: 'Sunday appointments are by prior appointment only. Please contact the clinic directly.',
      slots: []
    });
  }

  const data = await readData();
  const booked = new Set(
    data.bookings
      .filter(booking => booking.date === date && booking.status !== 'cancelled')
      .map(bookedKey)
  );

  const slots = TIME_SLOTS.map(slot => ({
    ...slot,
    booked: booked.has(`${date}|${slot.time}`)
  }));

  res.json({ date, closed: false, slots });
});

// Public: create booking. Slot locking happens here.
app.post('/api/bookings', async (req, res) => {
  const booking = {
    id: crypto.randomUUID(),
    created_at: new Date().toISOString(),
    date: clean(req.body.date),
    time: clean(req.body.time),
    name: cleanLimited(req.body.name, 120),
    phone: cleanLimited(req.body.phone, 30),
    concern: cleanLimited(req.body.concern, 180),
    message: cleanLimited(req.body.message, 800),
    status: 'booked'
  };

  if (!booking.name) return res.status(400).json({ error: 'Name is required.' });
  if (!booking.phone || !/^[0-9+\-\s]{7,}$/.test(booking.phone)) {
    return res.status(400).json({ error: 'Valid phone number is required.' });
  }
  if (!isValidDate(booking.date)) return res.status(400).json({ error: 'Valid appointment date is required.' });
  if (isSunday(booking.date)) {
    return res.status(400).json({ error: 'Sunday appointments are by prior appointment only. Please contact the clinic directly.' });
  }
  if (!isValidSlot(booking.time)) return res.status(400).json({ error: 'Please choose a valid session time.' });

  return withLock(async () => {
    const data = await readData();
    const alreadyBooked = data.bookings.some(item =>
      item.date === booking.date && item.time === booking.time && item.status !== 'cancelled'
    );

    if (alreadyBooked) {
      return res.status(409).json({ error: 'This timing is already booked. Please choose another timing.' });
    }

    data.bookings.push(booking);
    await writeData(data);

    return res.status(201).json({
      ok: true,
      booking: {
        id: booking.id,
        date: booking.date,
        time: booking.time,
        time_label: timeLabel(booking.time),
        name: booking.name,
        phone: booking.phone
      }
    });
  }).catch(err => {
    console.error(err);
    return res.status(500).json({ error: 'Server error while booking appointment.' });
  });
});

// Public: latest published feedbacks for website.
app.get('/api/feedbacks', async (req, res) => {
  const limitRaw = Number(req.query.limit || 0);
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 100) : 0;

  const data = await readData();
  const published = sortFeedbacks(data.feedbacks)
    .filter(item => item.status !== 'deleted')
    .map(publicFeedback);

  const feedbacks = limit ? published.slice(0, limit) : published;
  res.json({ ok: true, total: published.length, feedbacks });
});

// Public: submit feedback. Auto-published so latest 3 can show immediately.
app.post('/api/feedbacks', async (req, res) => {
  const rating = Number(req.body.rating);
  const feedback = {
    id: crypto.randomUUID(),
    created_at: new Date().toISOString(),
    name: cleanLimited(req.body.name, 80) || 'Anonymous',
    rating,
    message: cleanLimited(req.body.message || req.body.feedback || req.body.review, 800),
    likes: 0,
    status: 'published'
  };

  if (!Number.isInteger(feedback.rating) || feedback.rating < 1 || feedback.rating > 5) {
    return res.status(400).json({ error: 'Rating must be between 1 and 5.' });
  }

  if (!feedback.message || feedback.message.length < 3) {
    return res.status(400).json({ error: 'Feedback message is required.' });
  }

  return withLock(async () => {
    const data = await readData();
    data.feedbacks.push(feedback);
    await writeData(data);
    return res.status(201).json({ ok: true, feedback: publicFeedback(feedback) });
  }).catch(err => {
    console.error(err);
    return res.status(500).json({ error: 'Server error while saving feedback.' });
  });
});

// Public: like a feedback. Use frontend localStorage to prevent repeated likes per browser.
app.post('/api/feedbacks/:id/like', async (req, res) => {
  const id = clean(req.params.id);

  return withLock(async () => {
    const data = await readData();
    const feedback = data.feedbacks.find(item => item.id === id && item.status !== 'deleted');

    if (!feedback) return res.status(404).json({ error: 'Feedback not found.' });

    feedback.likes = Math.max(0, Number(feedback.likes) || 0) + 1;
    await writeData(data);
    return res.json({ ok: true, id: feedback.id, likes: feedback.likes });
  }).catch(err => {
    console.error(err);
    return res.status(500).json({ error: 'Server error while liking feedback.' });
  });
});

// Admin: stats.
app.get('/api/admin/stats', requireAdmin, async (req, res) => {
  const data = await readData();
  const activeBookings = data.bookings.filter(item => item.status !== 'cancelled');
  const activeFeedbacks = data.feedbacks.filter(item => item.status !== 'deleted');
  res.json({
    ok: true,
    total_bookings: activeBookings.length,
    total_feedbacks: activeFeedbacks.length
  });
});

// Admin: view booked appointments as JSON.
app.get('/api/admin/bookings', requireAdmin, async (req, res) => {
  const date = clean(req.query.date);
  if (date && !isValidDate(date)) return res.status(400).json({ error: 'Date must be in YYYY-MM-DD format.' });

  const data = await readData();
  const bookings = sortBookings(filterBookings(data.bookings, date)).map(booking => ({
    id: booking.id,
    created_at: booking.created_at,
    date: booking.date,
    time: booking.time,
    time_label: timeLabel(booking.time),
    name: booking.name,
    phone: booking.phone,
    concern: booking.concern,
    message: booking.message,
    status: booking.status
  }));

  res.json({ ok: true, date: date || null, total: bookings.length, bookings });
});

// Admin: download booked appointments as CSV.
app.get('/api/admin/bookings.csv', requireAdmin, async (req, res) => {
  const date = clean(req.query.date);
  if (date && !isValidDate(date)) return res.status(400).send('Date must be in YYYY-MM-DD format.');

  const data = await readData();
  const bookings = sortBookings(filterBookings(data.bookings, date));

  const headers = ['Booked At', 'Appointment Date', 'Session Time', 'Name', 'Phone', 'Concern', 'Message', 'Status'];
  const rows = bookings.map(booking => [
    booking.created_at,
    booking.date,
    timeLabel(booking.time),
    booking.name,
    booking.phone,
    booking.concern,
    booking.message,
    booking.status
  ]);

  const csv = [headers, ...rows].map(row => row.map(safeCsv).join(',')).join('\n');
  const suffix = date || 'all';
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="prana-bookings-${suffix}.csv"`);
  res.send('\ufeff' + csv);
});

// Admin: view all feedbacks.
app.get('/api/admin/feedbacks', requireAdmin, async (req, res) => {
  const data = await readData();
  const feedbacks = sortFeedbacks(data.feedbacks)
    .filter(item => item.status !== 'deleted')
    .map(item => ({
      id: item.id,
      created_at: item.created_at,
      name: item.name,
      rating: item.rating,
      message: item.message,
      likes: item.likes || 0,
      status: item.status
    }));

  res.json({ ok: true, total: feedbacks.length, feedbacks });
});

// Admin: delete feedback.
app.delete('/api/admin/feedbacks/:id', requireAdmin, async (req, res) => {
  const id = clean(req.params.id);

  return withLock(async () => {
    const data = await readData();
    const feedback = data.feedbacks.find(item => item.id === id && item.status !== 'deleted');
    if (!feedback) return res.status(404).json({ error: 'Feedback not found.' });

    // Soft delete preserves old data for safety but hides it everywhere.
    feedback.status = 'deleted';
    feedback.deleted_at = new Date().toISOString();
    await writeData(data);
    return res.json({ ok: true, deleted: id });
  }).catch(err => {
    console.error(err);
    return res.status(500).json({ error: 'Server error while deleting feedback.' });
  });
});

// Admin: feedback CSV.
app.get('/api/admin/feedbacks.csv', requireAdmin, async (req, res) => {
  const data = await readData();
  const feedbacks = sortFeedbacks(data.feedbacks).filter(item => item.status !== 'deleted');
  const headers = ['Created At', 'Name', 'Rating', 'Message', 'Likes', 'Status'];
  const rows = feedbacks.map(item => [item.created_at, item.name, item.rating, item.message, item.likes || 0, item.status]);
  const csv = [headers, ...rows].map(row => row.map(safeCsv).join(',')).join('\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="prana-feedbacks-all.csv"');
  res.send('\ufeff' + csv);
});

// Old compatibility route. Prefer /api/admin/bookings.
app.get('/api/bookings', requireAdmin, async (req, res) => {
  const data = await readData();
  res.json(data);
});

app.listen(PORT, () => {
  console.log(`Prana API running on port ${PORT}`);
  console.log(`Data file: ${DATA_FILE}`);
});
