'use strict';

const db = require('./db');
const { hashPassword } = require('./auth');
const { scoreMatch } = require('./matching');

function upsertUser({ role, ownerName, company, email, phone, password }) {
  const existing = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (existing) return existing;
  const { salt, hash } = hashPassword(password);
  const info = db
    .prepare('INSERT INTO users (role, owner_name, company, email, phone, password_hash, password_salt, created_at) VALUES (?,?,?,?,?,?,?,?)')
    .run(role, ownerName, company, email, phone, hash, salt, Date.now());
  return db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid);
}

function seed() {
  const carrier1 = upsertUser({ role: 'carrier', ownerName: 'Kwame Asante', company: 'Asante Haulage', email: 'kwame@asantehaulage.example', phone: '+233240000001', password: 'demo1234' });
  const carrier2 = upsertUser({ role: 'carrier', ownerName: 'Abena Boateng', company: 'Boateng Logistics', email: 'abena@boatenglogistics.example', phone: '+233240000002', password: 'demo1234' });
  const carrier3 = upsertUser({ role: 'carrier', ownerName: 'Yaw Mensah', company: 'Mensah Freight', email: 'yaw@mensahfreight.example', phone: '+233240000003', password: 'demo1234' });
  const shipper1 = upsertUser({ role: 'shipper', ownerName: 'Ama Owusu', company: 'Owusu Furniture', email: 'ama@owusufurniture.example', phone: '+233240000011', password: 'demo1234' });
  const shipper2 = upsertUser({ role: 'shipper', ownerName: 'Kofi Darko', company: 'Darko Cocoa Traders', email: 'kofi@darkococoa.example', phone: '+233240000012', password: 'demo1234' });
  const shipper3 = upsertUser({ role: 'shipper', ownerName: 'Efua Sarpong', company: 'Sarpong Textiles', email: 'efua@sarpongtextiles.example', phone: '+233240000013', password: 'demo1234' });

  const truckCount = db.prepare('SELECT COUNT(*) c FROM trucks').get().c;
  if (truckCount > 0) {
    console.log('Demo data already present — skipping seed. Delete data/loadmatch.db to reseed.');
    return;
  }

  const now = Date.now();
  const insertTruck = db.prepare(
    `INSERT INTO trucks (user_id, plate_no, truck_type, from_city, to_city, capacity_kg, volume_m3, rate_per_km_ghs, available_from, available_to, status, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
  );
  const t1 = insertTruck.run(carrier1.id, 'GR 1234-24', 'Box truck', 'Accra', 'Kumasi', 8000, 30, 4.5, '2026-09-12', '2026-09-14', 'verified', now);
  const t2 = insertTruck.run(carrier2.id, 'GT 5678-23', 'Flatbed', 'Tema', 'Takoradi', 12000, 40, 5.2, '2026-09-13', '2026-09-16', 'verified', now);
  const t3 = insertTruck.run(carrier3.id, 'GW 9012-22', 'Tautliner', 'Kumasi', 'Accra', 9000, 32, 4.2, '2026-09-12', '2026-09-15', 'pending', now);

  const insertLoad = db.prepare(
    `INSERT INTO loads (user_id, description, from_city, to_city, weight_kg, volume_m3, budget_ghs, pickup_date, delivery_date, status, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`
  );
  const l1 = insertLoad.run(shipper1.id, '40 furniture items', 'Kumasi', 'Accra', 4500, 22, 1400, '2026-09-13', '2026-09-14', 'open', now);
  const l2 = insertLoad.run(shipper2.id, '300 bags of cocoa', 'Takoradi', 'Tema', 9000, 18, 1600, '2026-09-14', '2026-09-16', 'open', now);
  const l3 = insertLoad.run(shipper3.id, 'Textile rolls, palletized', 'Accra', 'Tamale', 3000, 15, 2200, '2026-09-15', '2026-09-18', 'open', now);

  console.log('Seeded users, trucks, loads.');

  // Pre-match the obvious reverse-route pair (truck 1: Accra->Kumasi, load 1: Kumasi->Accra)
  const truck1 = db.prepare('SELECT * FROM trucks WHERE id = ?').get(t1.lastInsertRowid);
  const load1 = db.prepare('SELECT * FROM loads WHERE id = ?').get(l1.lastInsertRowid);
  const scored = scoreMatch(truck1, load1);
  if (scored) {
    const info = db
      .prepare(
        `INSERT INTO matches (truck_id, load_id, score, distance_km, estimated_price_ghs, commission_pct, status, created_at)
         VALUES (?,?,?,?,?,5,'accepted',?)`
      )
      .run(truck1.id, load1.id, scored.score, scored.distanceKm, scored.estimatedPriceGhs, now);
    db.prepare("UPDATE loads SET status = 'matched' WHERE id = ?").run(load1.id);
    console.log(`Pre-matched deal created: match #${info.lastInsertRowid} (score ${scored.score}, est. GHS ${scored.estimatedPriceGhs})`);
  } else {
    console.log('Note: pre-match candidate did not score as viable — check matching.js constraints.');
  }

  console.log('\nDemo logins (all use password: demo1234):');
  console.log('  carrier: kwame@asantehaulage.example');
  console.log('  shipper: ama@owusufurniture.example');
}

seed();
