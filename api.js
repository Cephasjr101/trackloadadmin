'use strict';

const db = require('./db');
const { Router, HttpError } = require('./router');
const { hashPassword, verifyPassword, createSession, getUserFromToken, generateOtp, hashOtp, verifyOtp } = require('./auth');
const { CITIES, routeDistanceKm, estimateRoutePrice, scoreMatch, findMatches } = require('./matching');

const COMMISSION_MIN = 3;
const COMMISSION_MAX = 10;
const COMMISSION_DEFAULT = 5;

const router = new Router();

// ---------- small helpers ----------

function require_(value, field) {
  if (value === undefined || value === null || value === '') {
    throw new HttpError(400, `Missing required field: ${field}`);
  }
  return value;
}

function requireCity(value, field) {
  require_(value, field);
  if (!CITIES.includes(value)) {
    throw new HttpError(400, `${field} must be one of: ${CITIES.join(', ')}`);
  }
  return value;
}

function requireAuth(ctx) {
  const auth = ctx.req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  const user = getUserFromToken(token);
  if (!user) throw new HttpError(401, 'Not authenticated. Send Authorization: Bearer <token>.');
  return user;
}

function requireRole(user, ...roles) {
  if (!roles.includes(user.role)) {
    throw new HttpError(403, `This action requires role: ${roles.join(' or ')}`);
  }
}

function getTruckOr404(id) {
  const truck = db.prepare('SELECT * FROM trucks WHERE id = ?').get(id);
  if (!truck) throw new HttpError(404, 'Truck not found');
  return truck;
}

function getLoadOr404(id) {
  const load = db.prepare('SELECT * FROM loads WHERE id = ?').get(id);
  if (!load) throw new HttpError(404, 'Load not found');
  return load;
}

function getMatchOr404(id) {
  const match = db.prepare('SELECT * FROM matches WHERE id = ?').get(id);
  if (!match) throw new HttpError(404, 'Match not found');
  return match;
}

function matchParties(match) {
  const truck = getTruckOr404(match.truck_id);
  const load = getLoadOr404(match.load_id);
  return { truck, load };
}

function assertMatchParty(user, match) {
  const { truck, load } = matchParties(match);
  if (user.role === 'admin') return { truck, load };
  if (truck.user_id !== user.id && load.user_id !== user.id) {
    throw new HttpError(403, 'You are not a party to this match');
  }
  return { truck, load };
}

// ---------- auth ----------

router.post('/api/auth/register', async (ctx) => {
  const b = ctx.body;
  const role = require_(b.role, 'role');
  if (!['carrier', 'shipper'].includes(role)) throw new HttpError(400, "role must be 'carrier' or 'shipper'");
  require_(b.ownerName, 'ownerName');
  require_(b.email, 'email');
  require_(b.phone, 'phone');
  require_(b.password, 'password');
  if (String(b.password).length < 8) throw new HttpError(400, 'password must be at least 8 characters');
  if (!/^\S+@\S+\.\S+$/.test(b.email)) throw new HttpError(400, 'invalid email');

  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(b.email);
  if (existing) throw new HttpError(409, 'An account with that email already exists');

  const { salt, hash } = hashPassword(b.password);
  const now = Date.now();
  const info = db
    .prepare(
      'INSERT INTO users (role, owner_name, company, email, phone, password_hash, password_salt, created_at) VALUES (?,?,?,?,?,?,?,?)'
    )
    .run(role, b.ownerName, b.company || null, b.email, b.phone, hash, salt, now);

  const token = createSession(info.lastInsertRowid);
  const user = db.prepare('SELECT id, role, owner_name, company, email, phone, created_at FROM users WHERE id = ?').get(info.lastInsertRowid);
  return { status: 201, body: { token, user } };
});

router.post('/api/auth/login', async (ctx) => {
  const b = ctx.body;
  require_(b.email, 'email');
  require_(b.password, 'password');
  const row = db.prepare('SELECT * FROM users WHERE email = ?').get(b.email);
  if (!row || !verifyPassword(b.password, row.password_salt, row.password_hash)) {
    throw new HttpError(401, 'Invalid email or password');
  }
  const token = createSession(row.id);
  const { password_hash, password_salt, ...user } = row;
  return { status: 200, body: { token, user } };
});

router.get('/api/me', async (ctx) => {
  const user = requireAuth(ctx);
  return { status: 200, body: { user } };
});

// ---------- trucks ----------

router.post('/api/trucks', async (ctx) => {
  const user = requireAuth(ctx);
  requireRole(user, 'carrier');
  const b = ctx.body;
  requireCity(b.fromCity, 'fromCity');
  requireCity(b.toCity, 'toCity');
  require_(b.plateNo, 'plateNo');
  require_(b.truckType, 'truckType');
  require_(b.availableFrom, 'availableFrom');
  require_(b.availableTo, 'availableTo');
  const capacityKg = Number(b.capacityKg);
  const volumeM3 = Number(b.volumeM3);
  const ratePerKm = Number(b.ratePerKmGhs);
  if (!(capacityKg > 0)) throw new HttpError(400, 'capacityKg must be a positive number');
  if (!(volumeM3 > 0)) throw new HttpError(400, 'volumeM3 must be a positive number');
  if (!(ratePerKm > 0)) throw new HttpError(400, 'ratePerKmGhs must be a positive number');

  const now = Date.now();
  const info = db
    .prepare(
      `INSERT INTO trucks (user_id, plate_no, truck_type, from_city, to_city, capacity_kg, volume_m3, rate_per_km_ghs, available_from, available_to, status, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?, 'pending', ?)`
    )
    .run(user.id, b.plateNo, b.truckType, b.fromCity, b.toCity, capacityKg, volumeM3, ratePerKm, b.availableFrom, b.availableTo, now);

  const truck = getTruckOr404(info.lastInsertRowid);
  return { status: 201, body: { truck, note: 'Submitted for verification — typical turnaround 24h.' } };
});

router.get('/api/trucks', async (ctx) => {
  const { from, to, status } = ctx.query;
  let sql = 'SELECT * FROM trucks WHERE 1=1';
  const args = [];
  if (from) { sql += ' AND from_city = ?'; args.push(from); }
  if (to) { sql += ' AND to_city = ?'; args.push(to); }
  if (status) { sql += ' AND status = ?'; args.push(status); }
  sql += ' ORDER BY created_at DESC';
  const trucks = db.prepare(sql).all(...args);
  return { status: 200, body: { trucks } };
});

router.get('/api/trucks/:id', async (ctx) => {
  return { status: 200, body: { truck: getTruckOr404(ctx.params.id) } };
});

// Admin-only verification step (in production, gate this behind real admin auth/roles + document review)
router.post('/api/trucks/:id/verify', async (ctx) => {
  const user = requireAuth(ctx);
  requireRole(user, 'admin');
  const decision = require_(ctx.body.decision, 'decision'); // 'verified' | 'rejected'
  if (!['verified', 'rejected'].includes(decision)) throw new HttpError(400, "decision must be 'verified' or 'rejected'");
  getTruckOr404(ctx.params.id);
  db.prepare('UPDATE trucks SET status = ? WHERE id = ?').run(decision, ctx.params.id);
  return { status: 200, body: { truck: getTruckOr404(ctx.params.id) } };
});

// ---------- loads ----------

router.post('/api/loads', async (ctx) => {
  const user = requireAuth(ctx);
  requireRole(user, 'shipper');
  const b = ctx.body;
  requireCity(b.fromCity, 'fromCity');
  requireCity(b.toCity, 'toCity');
  require_(b.description, 'description');
  require_(b.pickupDate, 'pickupDate');
  require_(b.deliveryDate, 'deliveryDate');
  const weightKg = Number(b.weightKg);
  const volumeM3 = Number(b.volumeM3);
  const budgetGhs = Number(b.budgetGhs);
  if (!(weightKg > 0)) throw new HttpError(400, 'weightKg must be a positive number');
  if (!(volumeM3 > 0)) throw new HttpError(400, 'volumeM3 must be a positive number');
  if (!(budgetGhs > 0)) throw new HttpError(400, 'budgetGhs must be a positive number');

  const now = Date.now();
  const info = db
    .prepare(
      `INSERT INTO loads (user_id, description, from_city, to_city, weight_kg, volume_m3, budget_ghs, pickup_date, delivery_date, status, created_at)
       VALUES (?,?,?,?,?,?,?,?,?, 'open', ?)`
    )
    .run(user.id, b.description, b.fromCity, b.toCity, weightKg, volumeM3, budgetGhs, b.pickupDate, b.deliveryDate, now);

  return { status: 201, body: { load: getLoadOr404(info.lastInsertRowid) } };
});

router.get('/api/loads', async (ctx) => {
  const { from, to, status } = ctx.query;
  let sql = 'SELECT * FROM loads WHERE 1=1';
  const args = [];
  if (from) { sql += ' AND from_city = ?'; args.push(from); }
  if (to) { sql += ' AND to_city = ?'; args.push(to); }
  if (status) { sql += ' AND status = ?'; args.push(status); }
  sql += ' ORDER BY created_at DESC';
  const loads = db.prepare(sql).all(...args);
  return { status: 200, body: { loads } };
});

router.get('/api/loads/:id', async (ctx) => {
  return { status: 200, body: { load: getLoadOr404(ctx.params.id) } };
});

// ---------- pricing (standalone estimate, e.g. for a form preview) ----------

router.get('/api/pricing/estimate', async (ctx) => {
  const { from, to, ratePerKmGhs, weightKg, volumeM3, verified } = ctx.query;
  requireCity(from, 'from');
  requireCity(to, 'to');
  const distanceKm = routeDistanceKm(from, to);
  const price = estimateRoutePrice({
    distanceKm,
    ratePerKmGhs: Number(ratePerKmGhs) || 0,
    weightKg: Number(weightKg) || 0,
    volumeM3: Number(volumeM3) || 0,
    verified: verified === 'true',
  });
  return { status: 200, body: { distanceKm, estimatedPriceGhs: price } };
});

// ---------- matching ----------

// Preview matches without persisting anything.
router.get('/api/matches/run', async (ctx) => {
  const trucks = db.prepare("SELECT * FROM trucks WHERE status != 'rejected'").all();
  const loads = db.prepare("SELECT * FROM loads WHERE status = 'open'").all();
  const results = findMatches(trucks, loads).map((r) => ({
    truckId: r.truck.id,
    loadId: r.load.id,
    score: r.score,
    distanceKm: r.distanceKm,
    estimatedPriceGhs: r.estimatedPriceGhs,
    reason: r.reason,
    truckVerified: r.verified,
  }));
  return { status: 200, body: { candidates: results } };
});

// Persist a chosen truck/load pair as a real match.
router.post('/api/matches', async (ctx) => {
  const user = requireAuth(ctx);
  const b = ctx.body;
  const truckId = require_(b.truckId, 'truckId');
  const loadId = require_(b.loadId, 'loadId');
  const truck = getTruckOr404(truckId);
  const load = getLoadOr404(loadId);

  if (user.role !== 'admin' && truck.user_id !== user.id && load.user_id !== user.id) {
    throw new HttpError(403, 'You must own the truck or the load to propose this match');
  }
  if (load.status !== 'open') throw new HttpError(409, 'Load is no longer open');

  const scored = scoreMatch(truck, load);
  if (!scored) throw new HttpError(422, 'This truck/load pair does not satisfy the matching engine (route, capacity, or date window)');

  const now = Date.now();
  let info;
  try {
    info = db
      .prepare(
        `INSERT INTO matches (truck_id, load_id, score, distance_km, estimated_price_ghs, commission_pct, status, created_at)
         VALUES (?,?,?,?,?,?, 'proposed', ?)`
      )
      .run(truck.id, load.id, scored.score, scored.distanceKm, scored.estimatedPriceGhs, COMMISSION_DEFAULT, now);
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) throw new HttpError(409, 'A match already exists for this truck/load pair');
    throw e;
  }

  db.prepare("UPDATE loads SET status = 'matched' WHERE id = ?").run(load.id);
  return { status: 201, body: { match: getMatchOr404(info.lastInsertRowid) } };
});

router.get('/api/matches', async (ctx) => {
  const user = requireAuth(ctx);
  let matches;
  if (user.role === 'admin') {
    matches = db.prepare('SELECT * FROM matches ORDER BY created_at DESC').all();
  } else {
    matches = db
      .prepare(
        `SELECT m.* FROM matches m
         JOIN trucks t ON t.id = m.truck_id
         JOIN loads l ON l.id = m.load_id
         WHERE t.user_id = ? OR l.user_id = ?
         ORDER BY m.created_at DESC`
      )
      .all(user.id, user.id);
  }
  return { status: 200, body: { matches } };
});

router.get('/api/matches/:id', async (ctx) => {
  const user = requireAuth(ctx);
  const match = getMatchOr404(ctx.params.id);
  const { truck, load } = assertMatchParty(user, match);
  return { status: 200, body: { match, truck, load } };
});

router.post('/api/matches/:id/accept', async (ctx) => {
  const user = requireAuth(ctx);
  const match = getMatchOr404(ctx.params.id);
  assertMatchParty(user, match);
  if (match.status !== 'proposed') throw new HttpError(409, `Match is '${match.status}', cannot accept`);
  db.prepare("UPDATE matches SET status = 'accepted' WHERE id = ?").run(match.id);
  return { status: 200, body: { match: getMatchOr404(match.id) } };
});

router.patch('/api/matches/:id/commission', async (ctx) => {
  const user = requireAuth(ctx);
  const match = getMatchOr404(ctx.params.id);
  requireRole(user, 'admin');
  const pct = Number(ctx.body.commissionPct);
  if (!(pct >= COMMISSION_MIN && pct <= COMMISSION_MAX)) {
    throw new HttpError(400, `commissionPct must be between ${COMMISSION_MIN} and ${COMMISSION_MAX}`);
  }
  db.prepare('UPDATE matches SET commission_pct = ? WHERE id = ?').run(pct, match.id);
  return { status: 200, body: { match: getMatchOr404(match.id) } };
});

// ---------- digital contracts ----------

function buildContractText(truck, load, match) {
  return [
    `LOADMATCH DIGITAL CONTRACT — Match #${match.id}`,
    `Route: ${truck.from_city} -> ${truck.to_city}`,
    `Cargo: ${load.description} (${load.weight_kg}kg, ${load.volume_m3}m3)`,
    `Agreed price: GHS ${match.estimated_price_ghs.toFixed(2)}`,
    `Platform commission: ${match.commission_pct}%`,
    `Carrier collects cargo at ${truck.from_city} and delivers to ${truck.to_city}.`,
    `Shipper cargo declaration: accurate weight, volume and nature of goods as posted.`,
    `Funds are held in escrow and released to the carrier upon OTP-verified proof of delivery.`,
    `Disputes: handled via LoadMatch support within 14 days of delivery using contract, GPS and POD records.`,
  ].join('\n');
}

router.post('/api/matches/:id/contract', async (ctx) => {
  const user = requireAuth(ctx);
  const match = getMatchOr404(ctx.params.id);
  const { truck, load } = assertMatchParty(user, match);
  if (!['accepted', 'contracted'].includes(match.status)) {
    throw new HttpError(409, "Match must be 'accepted' before generating a contract");
  }
  const existing = db.prepare('SELECT * FROM contracts WHERE match_id = ?').get(match.id);
  if (existing) return { status: 200, body: { contract: existing } };

  const termsText = buildContractText(truck, load, match);
  const now = Date.now();
  const info = db
    .prepare('INSERT INTO contracts (match_id, terms_text, created_at) VALUES (?,?,?)')
    .run(match.id, termsText, now);
  const contract = db.prepare('SELECT * FROM contracts WHERE id = ?').get(info.lastInsertRowid);
  return { status: 201, body: { contract } };
});

router.post('/api/matches/:id/contract/sign', async (ctx) => {
  const user = requireAuth(ctx);
  const match = getMatchOr404(ctx.params.id);
  const { truck, load } = assertMatchParty(user, match);
  const signatureName = require_(ctx.body.signatureName, 'signatureName');

  const contract = db.prepare('SELECT * FROM contracts WHERE match_id = ?').get(match.id);
  if (!contract) throw new HttpError(409, 'Generate the contract before signing it');

  const now = Date.now();
  if (user.id === truck.user_id) {
    db.prepare('UPDATE contracts SET carrier_signature = ?, carrier_signed_at = ? WHERE id = ?').run(signatureName, now, contract.id);
  } else if (user.id === load.user_id) {
    db.prepare('UPDATE contracts SET shipper_signature = ?, shipper_signed_at = ? WHERE id = ?').run(signatureName, now, contract.id);
  } else {
    throw new HttpError(403, 'Only the carrier or shipper on this match may sign');
  }

  const updated = db.prepare('SELECT * FROM contracts WHERE id = ?').get(contract.id);
  if (updated.carrier_signature && updated.shipper_signature) {
    db.prepare("UPDATE matches SET status = 'contracted' WHERE id = ?").run(match.id);
  }
  return { status: 200, body: { contract: updated, match: getMatchOr404(match.id) } };
});

// ---------- escrow payments ----------

router.post('/api/matches/:id/escrow/fund', async (ctx) => {
  const user = requireAuth(ctx);
  const match = getMatchOr404(ctx.params.id);
  const { load } = assertMatchParty(user, match);
  if (user.id !== load.user_id && user.role !== 'admin') throw new HttpError(403, 'Only the shipper funds escrow');
  if (match.status !== 'contracted') throw new HttpError(409, "Match must be 'contracted' (both signatures) before funding escrow");

  const existing = db.prepare('SELECT * FROM payments WHERE match_id = ?').get(match.id);
  if (existing && existing.status !== 'pending') return { status: 200, body: { payment: existing } };

  const amount = match.estimated_price_ghs;
  const commission = Math.round(amount * (match.commission_pct / 100) * 100) / 100;
  const payout = Math.round((amount - commission) * 100) / 100;
  const now = Date.now();

  let payment;
  if (existing) {
    db.prepare("UPDATE payments SET status = 'escrowed', escrowed_at = ? WHERE id = ?").run(now, existing.id);
    payment = db.prepare('SELECT * FROM payments WHERE id = ?').get(existing.id);
  } else {
    const info = db
      .prepare(
        `INSERT INTO payments (match_id, amount_ghs, commission_ghs, payout_ghs, status, escrowed_at, created_at)
         VALUES (?,?,?,?, 'escrowed', ?, ?)`
      )
      .run(match.id, amount, commission, payout, now, now);
    payment = db.prepare('SELECT * FROM payments WHERE id = ?').get(info.lastInsertRowid);
  }

  db.prepare("UPDATE matches SET status = 'in_transit' WHERE id = ? AND status = 'contracted'").run(match.id);
  return { status: 200, body: { payment, match: getMatchOr404(match.id), note: 'Escrow simulation — wire a real processor (e.g. Paystack/Flutterwave) before production.' } };
});

router.get('/api/matches/:id/payment', async (ctx) => {
  const user = requireAuth(ctx);
  const match = getMatchOr404(ctx.params.id);
  assertMatchParty(user, match);
  const payment = db.prepare('SELECT * FROM payments WHERE match_id = ?').get(match.id);
  if (!payment) throw new HttpError(404, 'No payment record for this match yet');
  return { status: 200, body: { payment } };
});

// ---------- GPS tracking (breadcrumbs) ----------

router.post('/api/matches/:id/tracking', async (ctx) => {
  const user = requireAuth(ctx);
  const match = getMatchOr404(ctx.params.id);
  const { truck } = assertMatchParty(user, match);
  if (user.id !== truck.user_id && user.role !== 'admin') throw new HttpError(403, 'Only the carrier posts tracking updates');
  const lat = Number(ctx.body.lat);
  const lng = Number(ctx.body.lng);
  if (Number.isNaN(lat) || Number.isNaN(lng)) throw new HttpError(400, 'lat and lng must be numbers');

  const now = Date.now();
  db.prepare('INSERT INTO tracking_events (match_id, lat, lng, note, created_at) VALUES (?,?,?,?,?)')
    .run(match.id, lat, lng, ctx.body.note || null, now);

  return { status: 201, body: { ok: true } };
});

router.get('/api/matches/:id/tracking', async (ctx) => {
  const user = requireAuth(ctx);
  const match = getMatchOr404(ctx.params.id);
  assertMatchParty(user, match);
  const events = db.prepare('SELECT * FROM tracking_events WHERE match_id = ? ORDER BY created_at ASC').all(match.id);
  return { status: 200, body: { events } };
});

// ---------- proof of delivery (OTP) ----------

router.post('/api/matches/:id/pod/request-otp', async (ctx) => {
  const user = requireAuth(ctx);
  const match = getMatchOr404(ctx.params.id);
  const { truck } = assertMatchParty(user, match);
  if (user.id !== truck.user_id && user.role !== 'admin') throw new HttpError(403, 'Only the carrier requests the delivery OTP');
  if (match.status !== 'in_transit') throw new HttpError(409, "Match must be 'in_transit' (escrow funded) before requesting a POD OTP");

  const otp = generateOtp();
  const { salt, hash } = hashOtp(otp);
  const now = Date.now();
  const existing = db.prepare('SELECT * FROM pods WHERE match_id = ?').get(match.id);
  if (existing) {
    db.prepare('UPDATE pods SET otp_hash = ?, otp_salt = ?, requested_at = ?, verified_at = NULL, attempts = 0 WHERE id = ?')
      .run(hash, salt, now, existing.id);
  } else {
    db.prepare('INSERT INTO pods (match_id, otp_hash, otp_salt, requested_at) VALUES (?,?,?,?)').run(match.id, hash, salt, now);
  }

  // No SMS gateway wired up — logged server-side and returned in the response
  // for this MVP. Replace with a real SMS provider before production; do not
  // return the OTP in the API response once that's in place.
  console.log(`[POD] OTP for match ${match.id}: ${otp} (send this via SMS in production)`);
  return { status: 200, body: { ok: true, devOnlyOtp: otp, note: 'devOnlyOtp is only returned because no SMS gateway is wired up yet — remove this field once one is.' } };
});

router.post('/api/matches/:id/pod/verify', async (ctx) => {
  const user = requireAuth(ctx);
  const match = getMatchOr404(ctx.params.id);
  assertMatchParty(user, match);
  const otp = require_(ctx.body.otp, 'otp');

  const pod = db.prepare('SELECT * FROM pods WHERE match_id = ?').get(match.id);
  if (!pod) throw new HttpError(409, 'No OTP has been requested for this match yet');
  if (pod.verified_at) return { status: 200, body: { ok: true, alreadyVerified: true } };
  if (pod.attempts >= 5) throw new HttpError(429, 'Too many failed attempts — request a new OTP');

  if (!verifyOtp(otp, pod.otp_salt, pod.otp_hash)) {
    db.prepare('UPDATE pods SET attempts = attempts + 1 WHERE id = ?').run(pod.id);
    throw new HttpError(401, 'Incorrect OTP');
  }

  const now = Date.now();
  db.prepare('UPDATE pods SET verified_at = ? WHERE id = ?').run(now, pod.id);
  db.prepare("UPDATE matches SET status = 'delivered' WHERE id = ?").run(match.id);

  const payment = db.prepare('SELECT * FROM payments WHERE match_id = ?').get(match.id);
  if (payment && payment.status === 'escrowed') {
    db.prepare("UPDATE payments SET status = 'released', released_at = ? WHERE id = ?").run(now, payment.id);
    db.prepare("UPDATE matches SET status = 'paid' WHERE id = ?").run(match.id);
  }

  return { status: 200, body: { ok: true, match: getMatchOr404(match.id) } };
});

// ---------- health ----------

router.get('/api/health', async () => ({ status: 200, body: { ok: true, time: new Date().toISOString() } }));

module.exports = router;
