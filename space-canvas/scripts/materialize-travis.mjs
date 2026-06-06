import * as turf from '@turf/turf';
import { createReadStream, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { dirname } from 'node:path';
import { DbConnection, defaultDatabase, defaultHost } from './spacetime-client.mjs';

const TARGET_VOTERS_PER_TURF = intEnv('TARGET_VOTERS_PER_TURF', 100);
const TURF_BATCH_SIZE = intEnv('TURF_BATCH_SIZE', 20);
const VOTER_BATCH_SIZE = intEnv('VOTER_BATCH_SIZE', 1200);
const MATERIALIZE_LIMIT = intEnv('MATERIALIZE_LIMIT', 0);
const MAX_WALK_ROUTE_POINTS = intEnv('MAX_WALK_ROUTE_POINTS', 16);
const MIN_BOUNDARY_PAD_DEGREES = numberEnv('MIN_BOUNDARY_PAD_DEGREES', 0.0007);
const SKIP_DERIVED_CLEAR = process.env.SKIP_DERIVED_CLEAR === '1';
const ARTIFACT_PATH =
  process.env.DERIVED_ARTIFACT_PATH ?? 'data/travis-derived-turfs.json';
const GEOCODE_CACHE_PATH =
  process.env.TRAVIS_GEOCODE_CACHE ?? 'data/travis-geocodes.jsonl';
const CSV_PATH =
  process.env.TRAVIS_VOTER_CSV ??
  new URL('../../data/travis-county-Registered_Voter_List.csv', import.meta.url)
    .pathname;
const args = new Set(process.argv.slice(2));
const mode = args.has('--export')
  ? args.has('--import')
    ? 'export-import'
    : 'export'
  : args.has('--import')
    ? 'import'
    : process.env.MATERIALIZE_MODE ?? 'export-import';
const geocodeCache = mode === 'import' ? new Map() : loadGeocodeCache(GEOCODE_CACHE_PATH);
const coordinateStats = {
  explicit: 0,
  geocoded: 0,
  synthetic: 0,
};
const TRAVIS_CENTER = { lat: 30.2672, lng: -97.7431 };
const TRAVIS_BOUNDS = {
  maxLat: 30.628,
  maxLng: -97.37,
  minLat: 30.024,
  minLng: -98.173,
};
const CITY_CENTERS = {
  AUSTIN: { lat: 30.2672, lng: -97.7431 },
  BEE_CAVE: { lat: 30.3085, lng: -97.945 },
  CEDAR_PARK: { lat: 30.5052, lng: -97.8203 },
  DEL_VALLE: { lat: 30.2124, lng: -97.6567 },
  ELGIN: { lat: 30.3497, lng: -97.3703 },
  JONESTOWN: { lat: 30.4955, lng: -97.9236 },
  LAGO_VISTA: { lat: 30.4602, lng: -97.9884 },
  LAKEWAY: { lat: 30.3638, lng: -97.9796 },
  LEANDER: { lat: 30.5788, lng: -97.8531 },
  MANOR: { lat: 30.3408, lng: -97.5569 },
  PFLUGERVILLE: { lat: 30.4394, lng: -97.62 },
  ROLLINGWOOD: { lat: 30.2769, lng: -97.7911 },
  SUNSET_VALLEY: { lat: 30.2258, lng: -97.8164 },
  THE_HILLS: { lat: 30.3477, lng: -97.985 },
  VOLENTE: { lat: 30.4424, lng: -97.9103 },
  WEBBERVILLE: { lat: 30.2316, lng: -97.4972 },
  WEST_LAKE_HILLS: { lat: 30.2977, lng: -97.8014 },
};

const token = process.env.SPACETIMEDB_TOKEN;
let connection;

if (mode === 'export') {
  void exportArtifactFromCsv().catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
} else {
  connect();
}

function connect() {
const builder = DbConnection.builder()
  .withUri(defaultHost)
  .withDatabaseName(defaultDatabase)
  .onConnect(conn => {
    connection = conn;
    console.log(`Connected to ${defaultHost}/${defaultDatabase}`);
    if (mode === 'import') {
      void importArtifact().catch(error => {
        console.error(error);
        process.exitCode = 1;
        disconnect();
      });
      return;
    }
    void exportArtifactFromCsv()
      .then(importArtifact)
      .catch(error => {
        console.error(error);
        process.exitCode = 1;
        disconnect();
      });
  })
  .onConnectError((_ctx, error) => {
    console.error('Connection failed:', error.message);
    process.exitCode = 1;
  });

if (token) {
  builder.withToken(token);
}

builder.build();
}

async function exportArtifactFromCsv() {
  const households = await groupHouseholdsFromCsv(CSV_PATH);
  console.log(
    `Grouped ${households.length.toLocaleString()} household targets from ${CSV_PATH}`
  );

  const turfs = buildTurfs(households);
  console.log(`Built ${turfs.length.toLocaleString()} ${TARGET_VOTERS_PER_TURF}-voter turfs`);

  writeArtifact({
    meta: {
      createdAt: new Date().toISOString(),
      coordinateSources: coordinateStats,
      sourceRows: households.reduce(
        (sum, row) => sum + row.registered_voter_count,
        0
      ),
      targetVotersPerTurf: TARGET_VOTERS_PER_TURF,
      turfCount: turfs.length,
      voterCount: households.length,
    },
    turfs,
    voters: households,
  });
}

async function importArtifact() {
  const artifact = JSON.parse(readFileSync(ARTIFACT_PATH, 'utf8'));
  console.log(
    `Loaded static artifact ${ARTIFACT_PATH}: ${artifact.turfs.length.toLocaleString()} turfs, ${artifact.voters.length.toLocaleString()} households`
  );
  await importRows(artifact);
  disconnect();
}

async function importRows({ turfs, voters }) {
  if (SKIP_DERIVED_CLEAR) {
    console.log('Skipping derived table clear');
  } else {
    console.log('Clearing derived realtime tables');
    await connection.reducers.clearDerivedData();
  }

  let turfIndex = 0;
  let voterIndex = 0;
  while (turfIndex < turfs.length || voterIndex < voters.length) {
    const turfBatch = turfs.slice(turfIndex, turfIndex + TURF_BATCH_SIZE);
    const voterBatch = voters.slice(voterIndex, voterIndex + VOTER_BATCH_SIZE);
    turfIndex += turfBatch.length;
    voterIndex += voterBatch.length;
    const finalBatch = turfIndex >= turfs.length && voterIndex >= voters.length;
    await connection.reducers.importDerivedDataJsonBatch({
      finalBatch,
      payloadJson: JSON.stringify({
        turfs: turfBatch,
        voters: voterBatch,
      }),
    });
    console.log(
      `Imported turfs=${turfIndex.toLocaleString()}/${turfs.length.toLocaleString()} households=${voterIndex.toLocaleString()}/${voters.length.toLocaleString()}`
    );
  }

  console.log('Travis materialization complete');
}

function writeArtifact(artifact) {
  mkdirSync(dirname(ARTIFACT_PATH), { recursive: true });
  writeFileSync(ARTIFACT_PATH, `${JSON.stringify(artifact)}\n`);
  console.log(
    `Wrote static Travis turf artifact ${ARTIFACT_PATH} (${artifact.turfs.length.toLocaleString()} turfs, ${artifact.voters.length.toLocaleString()} households)`
  );
}

function groupHouseholds(rows) {
  const households = new Map();
  for (const row of rows) {
    const parsed = parsePayload(row.payload);
    addRegisteredRowToHouseholds(households, row, parsed);
  }
  return finalizeHouseholds(households);
}

async function groupHouseholdsFromCsv(filePath) {
  const households = new Map();
  const input = createReadStream(filePath, { encoding: 'utf8' });
  const reader = createInterface({ crlfDelay: Infinity, input });
  let headers;
  let sourceRows = 0;

  for await (const line of reader) {
    if (!headers) {
      headers = parseCsvLine(stripBom(line));
      continue;
    }
    if (!line.trim()) {
      continue;
    }
    if (MATERIALIZE_LIMIT > 0 && sourceRows >= MATERIALIZE_LIMIT) {
      break;
    }
    sourceRows += 1;
    const parsed = csvObject(headers, parseCsvLine(line));
    const row = {
      city: cleanUpper(parsed.City),
      name: clean(parsed.NAME),
      precinct: clean(parsed.Precinct),
      zip5: clean(parsed['Zip Code 5']),
    };
    addRegisteredRowToHouseholds(households, row, parsed);
    if (sourceRows % 100000 === 0) {
      console.log(`Read ${sourceRows.toLocaleString()} CSV voter rows`);
    }
  }

  console.log(`Read ${sourceRows.toLocaleString()} CSV voter rows`);
  return finalizeHouseholds(households);
}

function addRegisteredRowToHouseholds(households, row, parsed) {
  const key = householdKey(row, parsed);
  if (!key) {
    return;
  }
  const existing = households.get(key);
  if (existing) {
    existing.registered_voter_count += 1;
    addName(existing, row.name || parsed.NAME || '');
    return;
  }
  const city = cleanUpper(row.city || parsed.City || 'AUSTIN');
  const zip5 = clean(row.zip5 || parsed['Zip Code 5']);
  const precinct = clean(row.precinct || parsed.Precinct || 'Unassigned');
  const point = coordinateFor(row, parsed, key);
  const household = {
    address: displayAddress(parsed),
    city,
    household_key: key,
    id: 0,
    lat: point.lat,
    lng: point.lng,
    names: [],
    precinct,
    registered_voter_count: 1,
    source_city: city,
    source_zip5: zip5,
    turf_id: 0,
  };
  addName(household, row.name || parsed.NAME || '');
  households.set(key, household);
}

function finalizeHouseholds(households) {
  const sorted = [...households.values()].sort(compareHouseholds);
  let id = 1;
  for (const household of sorted) {
    household.id = id;
    household.turf_id = 0;
    household.household_name = householdName(household);
    delete household.names;
    delete household.city;
    id += 1;
  }
  return sorted;
}

function buildTurfs(households) {
  const groups = spatiallyPartitionHouseholds(households);
  return groups.map((rows, index) => {
    const id = index + 1;
    for (const row of rows) {
      row.turf_id = id;
    }
    const featureCollection = turf.featureCollection(
      rows.map(row =>
        turf.point([row.lng, row.lat], {
          weight: row.registered_voter_count,
        })
      )
    );
    const center = turf.centerMean(featureCollection, {
      weight: 'weight',
    }).geometry.coordinates;
    const boundary = turfBoundary(featureCollection, rows);
    const walkRoute = walkingRoute(rows);
    const precincts = [...new Set(rows.map(row => row.precinct).filter(Boolean))].sort();
    return {
      boundary,
      center_lat: center[1],
      center_lng: center[0],
      id,
      name: `Travis ${String(id).padStart(4, '0')}`,
      neighborhood:
        precincts.length > 0
          ? `${precincts.slice(0, 3).join(', ')}${precincts.length > 3 ? ' +' : ''}`
          : 'Travis County',
      walk_route: walkRoute.length > 0 ? walkRoute : [{ lat: center[1], lng: center[0] }],
    };
  });
}

function spatiallyPartitionHouseholds(households) {
  return splitSpatialGroup(households).sort(compareTurfGroups);
}

function splitSpatialGroup(rows) {
  const voterCount = totalRegisteredVoters(rows);
  const desiredPieces = Math.ceil(voterCount / TARGET_VOTERS_PER_TURF);
  if (rows.length <= 1 || desiredPieces <= 1) {
    return [rows];
  }

  const axis = widerAxis(rows);
  const sorted = rows.slice().sort((a, b) => compareByAxis(a, b, axis));
  const leftPieces = Math.max(1, Math.floor(desiredPieces / 2));
  const leftTarget = (voterCount * leftPieces) / desiredPieces;
  const splitIndex = weightedSplitIndex(sorted, leftTarget);
  const left = sorted.slice(0, splitIndex);
  const right = sorted.slice(splitIndex);
  if (left.length === 0 || right.length === 0) {
    return [sorted];
  }
  return [...splitSpatialGroup(left), ...splitSpatialGroup(right)];
}

function totalRegisteredVoters(rows) {
  return rows.reduce((sum, row) => sum + row.registered_voter_count, 0);
}

function widerAxis(rows) {
  const bbox = bboxForRows(rows);
  const westEastKm = turf.distance([bbox.minLng, bbox.minLat], [bbox.maxLng, bbox.minLat], {
    units: 'kilometers',
  });
  const southNorthKm = turf.distance([bbox.minLng, bbox.minLat], [bbox.minLng, bbox.maxLat], {
    units: 'kilometers',
  });
  return westEastKm >= southNorthKm ? 'lng' : 'lat';
}

function bboxForRows(rows) {
  let maxLat = -Infinity;
  let maxLng = -Infinity;
  let minLat = Infinity;
  let minLng = Infinity;
  for (const row of rows) {
    maxLat = Math.max(maxLat, row.lat);
    maxLng = Math.max(maxLng, row.lng);
    minLat = Math.min(minLat, row.lat);
    minLng = Math.min(minLng, row.lng);
  }
  return { maxLat, maxLng, minLat, minLng };
}

function compareByAxis(a, b, axis) {
  if (axis === 'lng') {
    return (
      a.lng - b.lng ||
      a.lat - b.lat ||
      a.precinct.localeCompare(b.precinct) ||
      a.household_key.localeCompare(b.household_key)
    );
  }
  return (
    a.lat - b.lat ||
    a.lng - b.lng ||
    a.precinct.localeCompare(b.precinct) ||
    a.household_key.localeCompare(b.household_key)
  );
}

function weightedSplitIndex(rows, target) {
  let running = 0;
  for (let index = 0; index < rows.length - 1; index += 1) {
    const before = running;
    running += rows[index].registered_voter_count;
    if (running >= target) {
      const splitBefore = Math.max(1, index);
      const splitAfter = Math.min(rows.length - 1, index + 1);
      return Math.abs(before - target) < Math.abs(running - target)
        ? splitBefore
        : splitAfter;
    }
  }
  return Math.max(1, Math.min(rows.length - 1, Math.floor(rows.length / 2)));
}

function compareTurfGroups(a, b) {
  const centerA = weightedCenter(a);
  const centerB = weightedCenter(b);
  return centerA.lat - centerB.lat || centerA.lng - centerB.lng;
}

function weightedCenter(rows) {
  const total = totalRegisteredVoters(rows);
  if (total <= 0) {
    return rows[0] ?? TRAVIS_CENTER;
  }
  return rows.reduce(
    (center, row) => ({
      lat: center.lat + (row.lat * row.registered_voter_count) / total,
      lng: center.lng + (row.lng * row.registered_voter_count) / total,
    }),
    { lat: 0, lng: 0 }
  );
}

function turfBoundary(featureCollection, rows) {
  const uniquePoints = new Set(rows.map(row => `${row.lat.toFixed(7)},${row.lng.toFixed(7)}`));
  if (uniquePoints.size >= 3) {
    const hull = turf.convex(featureCollection);
    const boundary = polygonBoundary(hull);
    if (boundary.length >= 3) {
      return boundary;
    }
  }
  return bboxBoundary(turf.bbox(featureCollection));
}

function polygonBoundary(feature) {
  const ring = feature?.geometry?.coordinates?.[0];
  if (!Array.isArray(ring)) {
    return [];
  }
  const openRing = ring.length > 1 ? ring.slice(0, -1) : ring;
  return openRing.map(([lng, lat]) => ({
    lat: clamp(lat, TRAVIS_BOUNDS.minLat, TRAVIS_BOUNDS.maxLat),
    lng: clamp(lng, TRAVIS_BOUNDS.minLng, TRAVIS_BOUNDS.maxLng),
  }));
}

function bboxBoundary(bbox) {
  const expanded = expandBbox(bbox);
  return [
    { lat: expanded[1], lng: expanded[0] },
    { lat: expanded[3], lng: expanded[0] },
    { lat: expanded[3], lng: expanded[2] },
    { lat: expanded[1], lng: expanded[2] },
  ];
}

function walkingRoute(rows) {
  const remaining = rows.slice();
  const route = [];
  let current =
    remaining.find(row => row.lng === Math.min(...remaining.map(item => item.lng))) ??
    remaining[0];
  while (current && route.length < MAX_WALK_ROUTE_POINTS) {
    route.push({ lat: current.lat, lng: current.lng });
    remaining.splice(remaining.indexOf(current), 1);
    current = nearestRow(current, remaining);
  }
  return route;
}

function nearestRow(origin, rows) {
  let nearest;
  let bestDistance = Infinity;
  for (const row of rows) {
    const distance = approximateDistanceSquared(origin, row);
    if (distance < bestDistance) {
      nearest = row;
      bestDistance = distance;
    }
  }
  return nearest;
}

function approximateDistanceSquared(a, b) {
  const latDelta = b.lat - a.lat;
  const lngDelta = (b.lng - a.lng) * Math.cos(((a.lat + b.lat) / 2) * (Math.PI / 180));
  return latDelta * latDelta + lngDelta * lngDelta;
}

function parsePayload(payload) {
  try {
    return JSON.parse(payload);
  } catch {
    return {};
  }
}

function parseCsvLine(line) {
  const values = [];
  let value = '';
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === '"') {
      if (quoted && line[index + 1] === '"') {
        value += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
      continue;
    }
    if (char === ',' && !quoted) {
      values.push(value);
      value = '';
      continue;
    }
    value += char;
  }
  values.push(value);
  return values;
}

function csvObject(headers, values) {
  const row = {};
  for (let index = 0; index < headers.length; index += 1) {
    if (row[headers[index]] === undefined) {
      row[headers[index]] = values[index] ?? '';
    }
  }
  return row;
}

function stripBom(value) {
  return value.charCodeAt(0) === 0xfeff ? value.slice(1) : value;
}

function householdKey(row, parsed) {
  const streetNumber = clean(parsed['Street Number 1']);
  const streetName = clean(parsed['Street Name 1']);
  const unit = clean(parsed.Unit);
  const city = cleanUpper(row.city || parsed.City || '');
  const zip5 = clean(row.zip5 || parsed['Zip Code 5']);
  if (!streetNumber && !streetName) {
    const residential = clean(parsed['Residential Address']);
    return residential ? cleanUpper(`${residential}|${unit}|${city}|${zip5}`) : '';
  }
  return cleanUpper(`${streetNumber}|${streetName}|${unit}|${city}|${zip5}`);
}

function displayAddress(parsed) {
  const base =
    clean(`${clean(parsed['Street Number 1'])} ${clean(parsed['Street Name 1'])}`) ||
    clean(parsed['Residential Address']);
  const unit = clean(parsed.Unit);
  const unitText = unit ? ` #${unit}` : '';
  return `${base}${unitText}, ${clean(parsed.City || 'Austin')} ${clean(parsed.State || 'TX')} ${clean(parsed['Zip Code 5'])}`.trim();
}

function coordinateFor(row, parsed, key) {
  const lat = numberValue(parsed.Latitude ?? parsed.latitude ?? parsed.lat ?? parsed.Y);
  const lng = numberValue(
    parsed.Longitude ?? parsed.longitude ?? parsed.lng ?? parsed.LNG ?? parsed.X
  );
  if (lat && lng && insideBounds({ lat, lng })) {
    coordinateStats.explicit += 1;
    return { lat, lng };
  }
  const cached = geocodeCache.get(key);
  if (isAcceptedCachedGeocode(cached)) {
    coordinateStats.geocoded += 1;
    return { lat: cached.lat, lng: cached.lng };
  }
  coordinateStats.synthetic += 1;
  const cityKey = cleanUpper(row.city || parsed.City || 'AUSTIN').replaceAll(' ', '_');
  const center = CITY_CENTERS[cityKey] ?? zipCenter(row.zip5 || parsed['Zip Code 5']);
  const hash = hashString(key);
  const angle = ((hash % 360) * Math.PI) / 180;
  const radius = 0.004 + (((hash >>> 9) % 1600) / 1600) * 0.072;
  return {
    lat: clamp(center.lat + Math.sin(angle) * radius, TRAVIS_BOUNDS.minLat, TRAVIS_BOUNDS.maxLat),
    lng: clamp(
      center.lng + Math.cos(angle) * radius * 1.15,
      TRAVIS_BOUNDS.minLng,
      TRAVIS_BOUNDS.maxLng
    ),
  };
}

function zipCenter(zip5) {
  const value = Number(clean(zip5).replace(/\D/g, '').slice(-3));
  if (!Number.isFinite(value)) {
    return TRAVIS_CENTER;
  }
  return {
    lat: TRAVIS_BOUNDS.minLat + ((value % 29) / 28) * (TRAVIS_BOUNDS.maxLat - TRAVIS_BOUNDS.minLat),
    lng:
      TRAVIS_BOUNDS.minLng +
      ((Math.floor(value / 7) % 31) / 30) *
        (TRAVIS_BOUNDS.maxLng - TRAVIS_BOUNDS.minLng),
  };
}

function expandBbox(bbox) {
  const padLng = Math.max(MIN_BOUNDARY_PAD_DEGREES, (bbox[2] - bbox[0]) * 0.22);
  const padLat = Math.max(MIN_BOUNDARY_PAD_DEGREES, (bbox[3] - bbox[1]) * 0.22);
  return [
    clamp(bbox[0] - padLng, TRAVIS_BOUNDS.minLng, TRAVIS_BOUNDS.maxLng),
    clamp(bbox[1] - padLat, TRAVIS_BOUNDS.minLat, TRAVIS_BOUNDS.maxLat),
    clamp(bbox[2] + padLng, TRAVIS_BOUNDS.minLng, TRAVIS_BOUNDS.maxLng),
    clamp(bbox[3] + padLat, TRAVIS_BOUNDS.minLat, TRAVIS_BOUNDS.maxLat),
  ];
}

function compareHouseholds(a, b) {
  return (
    a.source_zip5.localeCompare(b.source_zip5) ||
    a.precinct.localeCompare(b.precinct) ||
    a.lat - b.lat ||
    a.lng - b.lng ||
    a.household_key.localeCompare(b.household_key)
  );
}

function householdName(household) {
  const label = household.names[0]
    ? `${household.names[0]} household`
    : 'Registered voter household';
  return household.registered_voter_count > 1
    ? `${label} (${household.registered_voter_count} voters)`
    : label;
}

function addName(household, name) {
  const value = clean(name);
  if (value && !household.names.includes(value) && household.names.length < 3) {
    household.names.push(value);
  }
}

function clean(value) {
  return String(value ?? '').trim().replace(/\s+/g, ' ');
}

function cleanUpper(value) {
  return clean(value).toUpperCase();
}

function loadGeocodeCache(filePath) {
  const cache = new Map();
  if (!existsSync(filePath)) {
    return cache;
  }
  for (const line of readFileSync(filePath, 'utf8').split('\n')) {
    if (!line.trim()) {
      continue;
    }
    try {
      const record = JSON.parse(line);
      if (record.household_key) {
        cache.set(record.household_key, record);
      }
    } catch {
      // Ignore partial cache lines so interrupted geocoding runs can resume.
    }
  }
  console.log(`Loaded ${cache.size.toLocaleString()} cached Travis geocodes from ${filePath}`);
  return cache;
}

function isAcceptedCachedGeocode(record) {
  if (!record || !insideBounds(record)) {
    return false;
  }
  if (record.accepted === true) {
    return true;
  }
  return (
    ['parcel', 'point', 'rooftop', 'interpolated'].includes(String(record.accuracy)) &&
    ['exact', 'high', 'medium'].includes(String(record.confidence))
  );
}

function numberValue(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function insideBounds(point) {
  return (
    point.lat >= TRAVIS_BOUNDS.minLat &&
    point.lat <= TRAVIS_BOUNDS.maxLat &&
    point.lng >= TRAVIS_BOUNDS.minLng &&
    point.lng <= TRAVIS_BOUNDS.maxLng
  );
}

function hashString(value) {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function intEnv(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function numberEnv(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function disconnect() {
  try {
    connection?.disconnect();
  } catch {
    // Already disconnected.
  }
}
