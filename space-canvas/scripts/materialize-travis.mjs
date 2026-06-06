import * as turf from '@turf/turf';
import { DbConnection, defaultDatabase, defaultHost } from './spacetime-client.mjs';

const TARGET_VOTERS_PER_TURF = intEnv('TARGET_VOTERS_PER_TURF', 200);
const TURF_BATCH_SIZE = intEnv('TURF_BATCH_SIZE', 20);
const VOTER_BATCH_SIZE = intEnv('VOTER_BATCH_SIZE', 1200);
const MATERIALIZE_LIMIT = intEnv('MATERIALIZE_LIMIT', 0);
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

const builder = DbConnection.builder()
  .withUri(defaultHost)
  .withDatabaseName(defaultDatabase)
  .onConnect(conn => {
    connection = conn;
    console.log(`Connected to ${defaultHost}/${defaultDatabase}`);
    conn
      .subscriptionBuilder()
      .onApplied(() => {
        void materialize().catch(error => {
          console.error(error);
          process.exitCode = 1;
          disconnect();
        });
      })
      .onError((_ctx, error) => {
        console.error('registered_voter subscription failed:', error.message);
        process.exitCode = 1;
        disconnect();
      })
      .subscribe('SELECT * FROM registered_voter');
  })
  .onConnectError((_ctx, error) => {
    console.error('Connection failed:', error.message);
    process.exitCode = 1;
  });

if (token) {
  builder.withToken(token);
}

builder.build();

async function materialize() {
  const rows = Array.from(connection.db.registeredVoter.iter());
  const sourceRows = MATERIALIZE_LIMIT > 0 ? rows.slice(0, MATERIALIZE_LIMIT) : rows;
  console.log(
    `Loaded ${rows.length.toLocaleString()} registered voters; materializing ${sourceRows.length.toLocaleString()}`
  );

  const households = groupHouseholds(sourceRows);
  console.log(`Grouped ${households.length.toLocaleString()} household targets`);

  const turfs = buildTurfs(households);
  console.log(`Built ${turfs.length.toLocaleString()} ${TARGET_VOTERS_PER_TURF}-voter turfs`);

  console.log('Clearing derived realtime tables');
  await connection.reducers.clearDerivedData();

  let turfIndex = 0;
  let voterIndex = 0;
  while (turfIndex < turfs.length || voterIndex < households.length) {
    const turfBatch = turfs.slice(turfIndex, turfIndex + TURF_BATCH_SIZE);
    const voterBatch = households.slice(voterIndex, voterIndex + VOTER_BATCH_SIZE);
    turfIndex += turfBatch.length;
    voterIndex += voterBatch.length;
    const finalBatch = turfIndex >= turfs.length && voterIndex >= households.length;
    await connection.reducers.importDerivedDataBatch({
      finalBatch,
      turfs: turfBatch,
      voters: voterBatch,
    });
    console.log(
      `Imported turfs=${turfIndex.toLocaleString()}/${turfs.length.toLocaleString()} households=${voterIndex.toLocaleString()}/${households.length.toLocaleString()}`
    );
  }

  console.log('Travis materialization complete');
  disconnect();
}

function groupHouseholds(rows) {
  const households = new Map();
  for (const row of rows) {
    const parsed = parsePayload(row.payload);
    const key = householdKey(row, parsed);
    if (!key) {
      continue;
    }
    const existing = households.get(key);
    if (existing) {
      existing.registered_voter_count += 1;
      addName(existing, row.name || parsed.NAME || '');
      continue;
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

  const sorted = [...households.values()].sort(compareHouseholds);
  let id = 1;
  let turfId = 1;
  let votersInTurf = 0;
  for (const household of sorted) {
    if (
      votersInTurf > 0 &&
      votersInTurf + household.registered_voter_count > TARGET_VOTERS_PER_TURF
    ) {
      turfId += 1;
      votersInTurf = 0;
    }
    household.id = id;
    household.turf_id = turfId;
    household.household_name = householdName(household);
    delete household.names;
    delete household.city;
    votersInTurf += household.registered_voter_count;
    id += 1;
  }
  return sorted;
}

function buildTurfs(households) {
  const byTurf = new Map();
  for (const household of households) {
    const rows = byTurf.get(household.turf_id) ?? [];
    rows.push(household);
    byTurf.set(household.turf_id, rows);
  }

  return [...byTurf.entries()].map(([id, rows]) => {
    const featureCollection = turf.featureCollection(
      rows.map(row => turf.point([row.lng, row.lat]))
    );
    const center = turf.center(featureCollection).geometry.coordinates;
    const bbox = turf.bbox(featureCollection);
    const expanded = expandBbox(bbox);
    const boundary = [
      { lat: expanded[1], lng: expanded[0] },
      { lat: expanded[3], lng: expanded[0] },
      { lat: expanded[3], lng: expanded[2] },
      { lat: expanded[1], lng: expanded[2] },
    ];
    const walkRoute = rows
      .slice()
      .sort((a, b) => a.lat - b.lat || a.lng - b.lng)
      .filter((_row, index) => index % Math.max(1, Math.floor(rows.length / 10)) === 0)
      .slice(0, 12)
      .map(row => ({ lat: row.lat, lng: row.lng }));
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

function parsePayload(payload) {
  try {
    return JSON.parse(payload);
  } catch {
    return {};
  }
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
    return { lat, lng };
  }
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
  const padLng = Math.max(0.0025, (bbox[2] - bbox[0]) * 0.22);
  const padLat = Math.max(0.0025, (bbox[3] - bbox[1]) * 0.22);
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

function disconnect() {
  try {
    connection?.disconnect();
  } catch {
    // Already disconnected.
  }
}
