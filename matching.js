'use strict';

// Estimated road distances (km) for demo pricing — not turn-by-turn routing.
// Swap DISTANCE_TABLE / routeDistanceKm() for a real routing API (Google
// Routes/Directions, Mapbox, OSRM) before production, same as the frontend.
const CITIES = ['Accra', 'Kumasi', 'Tema', 'Takoradi', 'Tamale', 'Ho', 'Cape Coast', 'Sunyani'];

const DISTANCE_TABLE = {
  'Accra|Kumasi': 250, 'Accra|Tema': 30, 'Accra|Takoradi': 230, 'Accra|Tamale': 600,
  'Accra|Ho': 165, 'Accra|Cape Coast': 145, 'Accra|Sunyani': 380,
  'Kumasi|Tema': 270, 'Kumasi|Takoradi': 210, 'Kumasi|Tamale': 380, 'Kumasi|Ho': 330,
  'Kumasi|Cape Coast': 215, 'Kumasi|Sunyani': 130,
  'Tema|Takoradi': 250, 'Tema|Tamale': 620, 'Tema|Ho': 150, 'Tema|Cape Coast': 165, 'Tema|Sunyani': 400,
  'Takoradi|Tamale': 700, 'Takoradi|Ho': 370, 'Takoradi|Cape Coast': 70, 'Takoradi|Sunyani': 300,
  'Tamale|Ho': 560, 'Tamale|Cape Coast': 650, 'Tamale|Sunyani': 260,
  'Ho|Cape Coast': 300, 'Ho|Sunyani': 430,
  'Cape Coast|Sunyani': 330,
};

function routeDistanceKm(cityA, cityB) {
  if (cityA === cityB) return 0;
  const key1 = `${cityA}|${cityB}`;
  const key2 = `${cityB}|${cityA}`;
  const km = DISTANCE_TABLE[key1] ?? DISTANCE_TABLE[key2];
  if (km == null) {
    throw new Error(`No distance entry for ${cityA} <-> ${cityB}. Known cities: ${CITIES.join(', ')}`);
  }
  return km;
}

/**
 * Prices a route from three inputs, as described in the frontend README:
 *  - mileage: distance x carrier's rate per km
 *  - unit: cargo weight/volume scale price up for bigger loads
 *  - quality: verified carriers carry a small trust premium; unverified are discounted
 */
function estimateRoutePrice({ distanceKm, ratePerKmGhs, weightKg, volumeM3, verified }) {
  const mileage = distanceKm * ratePerKmGhs;
  const weightFactor = 1 + Math.min(weightKg / 10000, 1) * 0.25;
  const volumeFactor = 1 + Math.min(volumeM3 / 40, 1) * 0.15;
  const qualityFactor = verified ? 1.05 : 0.9;
  return Math.round(mileage * weightFactor * volumeFactor * qualityFactor * 100) / 100;
}

function datesOverlap(aStart, aEnd, bStart, bEnd) {
  return new Date(aStart) <= new Date(bEnd) && new Date(bStart) <= new Date(aEnd);
}

/**
 * Scores one truck against one load. Returns null if the pair is not viable
 * at all (capacity too small or date windows don't overlap). Otherwise
 * returns { score, distanceKm, estimatedPriceGhs, reason }.
 *
 * Scoring (mirrors the frontend matching engine described in the README):
 *  - exact reverse route (truck goes B->A, load needs A->B): 100 base points
 *  - same-direction route (truck and load both A->B): 60 base points
 *  - anything else: not a viable match for this engine, returns null
 *  - +10 if the truck is verified, -15 if still pending
 *  - +15 if the load's budget covers the estimated price, -10 if it falls short
 */
function scoreMatch(truck, load) {
  if (load.weight_kg > truck.capacity_kg || load.volume_m3 > truck.volume_m3) return null;
  if (!datesOverlap(truck.available_from, truck.available_to, load.pickup_date, load.delivery_date)) return null;

  let base;
  let reason;
  const isReverse = truck.from_city === load.to_city && truck.to_city === load.from_city;
  const isSameDirection = truck.from_city === load.from_city && truck.to_city === load.to_city;

  if (isReverse) {
    base = 100;
    reason = 'exact reverse route';
  } else if (isSameDirection) {
    base = 60;
    reason = 'same-direction route';
  } else {
    return null;
  }

  const distanceKm = routeDistanceKm(truck.from_city, truck.to_city);
  const verified = truck.status === 'verified';
  const estimatedPriceGhs = estimateRoutePrice({
    distanceKm,
    ratePerKmGhs: truck.rate_per_km_ghs,
    weightKg: load.weight_kg,
    volumeM3: load.volume_m3,
    verified,
  });

  let score = base;
  score += verified ? 10 : (truck.status === 'pending' ? -15 : -100);
  score += load.budget_ghs >= estimatedPriceGhs ? 15 : -10;

  return { score, distanceKm, estimatedPriceGhs, reason, verified };
}

/**
 * Scores every open load against every truck available for matching and
 * returns viable pairs sorted best-first.
 */
function findMatches(trucks, loads) {
  const results = [];
  for (const truck of trucks) {
    for (const load of loads) {
      const scored = scoreMatch(truck, load);
      if (scored) {
        results.push({ truck, load, ...scored });
      }
    }
  }
  results.sort((a, b) => b.score - a.score);
  return results;
}

module.exports = { CITIES, routeDistanceKm, estimateRoutePrice, scoreMatch, findMatches, datesOverlap };
