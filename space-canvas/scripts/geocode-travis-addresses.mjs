import { appendFileSync, createReadStream, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { createInterface } from 'node:readline';

const CSV_PATH =
  process.env.TRAVIS_VOTER_CSV ??
  new URL('../../data/travis-county-Registered_Voter_List.csv', import.meta.url)
    .pathname;
const CACHE_PATH = process.env.TRAVIS_GEOCODE_CACHE ?? 'data/travis-geocodes.jsonl';
const MAPBOX_TOKEN =
  process.env.MAPBOX_GEOCODING_TOKEN ??
  process.env.MAPBOX_TOKEN ??
  process.env.VITE_MAPBOX_TOKEN;
const DRY_RUN = process.env.GEOCODE_DRY_RUN === '1';
const INCLUDE_UNITS = process.env.GEOCODE_INCLUDE_UNITS === '1';
const LIMIT = intEnv('GEOCODE_LIMIT', 0);
const BATCH_SIZE = Math.min(1000, intEnv('GEOCODE_BATCH_SIZE', 1000));
const BATCH_DELAY_MS = intEnv('GEOCODE_BATCH_DELAY_MS', 250);
const TRAVIS_BBOX = [-98.173, 30.024, -97.37, 30.628];
const ACCEPTED_ACCURACY = new Set(['parcel', 'point']);
const ACCEPTED_CONFIDENCE = new Set(['exact', 'high', 'medium']);

if (!MAPBOX_TOKEN && !DRY_RUN) {
  console.error(
    'Missing MAPBOX_GEOCODING_TOKEN, MAPBOX_TOKEN, or VITE_MAPBOX_TOKEN for Mapbox geocoding.'
  );
  process.exitCode = 1;
} else {
  void main().catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
}

async function main() {
  const cached = loadCache(CACHE_PATH);
  const queries = await loadGeocodeQueries(CSV_PATH, cached);
  const queue = LIMIT > 0 ? queries.slice(0, LIMIT) : queries;
  const householdCount = queue.reduce((sum, row) => sum + row.householdKeys.length, 0);
  console.log(
    `Geocoding ${queue.length.toLocaleString()} missing Travis address queries for ${householdCount.toLocaleString()} households; ${cached.size.toLocaleString()} households already cached`
  );
  if (DRY_RUN) {
    console.log('Dry run only; no Mapbox requests sent.');
    return;
  }
  mkdirSync(dirname(CACHE_PATH), { recursive: true });

  let processed = 0;
  let accepted = 0;
  for (let index = 0; index < queue.length; index += BATCH_SIZE) {
    const batch = queue.slice(index, index + BATCH_SIZE);
    const results = await geocodeBatch(batch);
    for (let offset = 0; offset < batch.length; offset += 1) {
      const records = cacheRecords(batch[offset], results[offset]);
      if (records.some(record => record.accepted)) {
        accepted += 1;
      }
      appendFileSync(CACHE_PATH, records.map(record => JSON.stringify(record)).join('\n') + '\n');
    }
    processed += batch.length;
    console.log(
      `Geocoded ${processed.toLocaleString()}/${queue.length.toLocaleString()} missing address queries; accepted=${accepted.toLocaleString()}`
    );
    if (index + BATCH_SIZE < queue.length && BATCH_DELAY_MS > 0) {
      await sleep(BATCH_DELAY_MS);
    }
  }
}

async function geocodeBatch(batch) {
  const url = new URL('https://api.mapbox.com/search/geocode/v6/batch');
  url.searchParams.set('access_token', MAPBOX_TOKEN);
  url.searchParams.set('permanent', 'true');
  const response = await fetch(url, {
    body: JSON.stringify(
      batch.map(row => ({
        address_line1: row.addressLine1,
        bbox: TRAVIS_BBOX,
        country: 'us',
        limit: 1,
        place: row.city,
        postcode: row.zip5,
        region: 'TX',
        types: ['address'],
      }))
    ),
    headers: { 'Content-Type': 'application/json' },
    method: 'POST',
  });

  if (!response.ok) {
    throw new Error(`Mapbox geocoding failed: ${response.status} ${await response.text()}`);
  }
  return response.json();
}

function cacheRecords(row, result) {
  const feature = firstFeature(result);
  const coordinates = feature?.geometry?.coordinates;
  const lng = Number(coordinates?.[0]);
  const lat = Number(coordinates?.[1]);
  const properties = feature?.properties ?? {};
  const accuracy = properties.coordinates?.accuracy ?? properties.accuracy ?? '';
  const confidence = properties.match_code?.confidence ?? '';
  const accepted =
    Number.isFinite(lat) &&
    Number.isFinite(lng) &&
    insideTravisBounds({ lat, lng }) &&
    ACCEPTED_ACCURACY.has(String(accuracy)) &&
    ACCEPTED_CONFIDENCE.has(String(confidence));

  return row.householdKeys.map(householdKey => ({
    accepted,
    accuracy,
    address: row.address,
    confidence,
    household_key: householdKey,
    lat: Number.isFinite(lat) ? lat : undefined,
    lng: Number.isFinite(lng) ? lng : undefined,
    mapbox_id: properties.mapbox_id,
    provider: 'mapbox-v6',
    query_key: row.queryKey,
    updated_at: new Date().toISOString(),
  }));
}

function firstFeature(result) {
  if (Array.isArray(result?.features)) {
    return result.features[0];
  }
  if (Array.isArray(result) && Array.isArray(result[0]?.features)) {
    return result[0].features[0];
  }
  return undefined;
}

async function loadGeocodeQueries(filePath, cached) {
  const queries = new Map();
  const queuedHouseholds = new Set();
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
    sourceRows += 1;
    const parsed = csvObject(headers, parseCsvLine(line));
    const householdKey = buildHouseholdKey(parsed);
    if (!householdKey || cached.has(householdKey) || queuedHouseholds.has(householdKey)) {
      continue;
    }
    const addressLine1 = queryAddressLine(parsed);
    if (!addressLine1) {
      continue;
    }
    const city = clean(parsed.City || 'Austin');
    const zip5 = clean(parsed['Zip Code 5']);
    const queryKey = cleanUpper(`${addressLine1}|${city}|TX|${zip5}`);
    const existing = queries.get(queryKey);
    if (existing) {
      existing.householdKeys.push(householdKey);
      queuedHouseholds.add(householdKey);
      continue;
    }
    queries.set(queryKey, {
      address: `${addressLine1}, ${city} ${clean(parsed.State || 'TX')} ${zip5}`.trim(),
      addressLine1,
      city,
      householdKeys: [householdKey],
      queryKey,
      zip5,
    });
    queuedHouseholds.add(householdKey);
    if (sourceRows % 100000 === 0) {
      console.log(`Read ${sourceRows.toLocaleString()} CSV voter rows`);
    }
  }

  console.log(`Read ${sourceRows.toLocaleString()} CSV voter rows`);
  return [...queries.values()].sort((a, b) =>
    a.zip5.localeCompare(b.zip5) || a.address.localeCompare(b.address)
  );
}

function loadCache(filePath) {
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
      // Ignore partial cache lines from interrupted runs.
    }
  }
  return cache;
}

function buildHouseholdKey(parsed) {
  const streetNumber = clean(parsed['Street Number 1']);
  const streetName = clean(parsed['Street Name 1']);
  const unit = clean(parsed.Unit);
  const city = cleanUpper(parsed.City);
  const zip5 = clean(parsed['Zip Code 5']);
  if (!streetNumber && !streetName) {
    const residential = clean(parsed['Residential Address']);
    return residential ? cleanUpper(`${residential}|${unit}|${city}|${zip5}`) : '';
  }
  return cleanUpper(`${streetNumber}|${streetName}|${unit}|${city}|${zip5}`);
}

function addressLine(parsed) {
  const base =
    clean(`${clean(parsed['Street Number 1'])} ${clean(parsed['Street Name 1'])}`) ||
    clean(parsed['Residential Address']);
  const unit = clean(parsed.Unit);
  return unit ? `${base} #${unit}` : base;
}

function displayAddress(parsed) {
  return `${addressLine(parsed)}, ${clean(parsed.City || 'Austin')} ${clean(
    parsed.State || 'TX'
  )} ${clean(parsed['Zip Code 5'])}`.trim();
}

function queryAddressLine(parsed) {
  const base =
    clean(`${clean(parsed['Street Number 1'])} ${clean(parsed['Street Name 1'])}`) ||
    clean(parsed['Residential Address']);
  if (INCLUDE_UNITS) {
    const unit = clean(parsed.Unit);
    return unit ? `${base} #${unit}` : base;
  }
  return base;
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

function clean(value) {
  return String(value ?? '').trim().replace(/\s+/g, ' ');
}

function cleanUpper(value) {
  return clean(value).toUpperCase();
}

function insideTravisBounds(point) {
  return (
    point.lat >= TRAVIS_BBOX[1] &&
    point.lat <= TRAVIS_BBOX[3] &&
    point.lng >= TRAVIS_BBOX[0] &&
    point.lng <= TRAVIS_BBOX[2]
  );
}

function intEnv(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function sleep(ms) {
  return new Promise(resolve => {
    setTimeout(resolve, ms);
  });
}
