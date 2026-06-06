import { schema, table, t } from 'spacetimedb/server';

const coordinate = t.object('Coordinate', {
  lat: t.f64(),
  lng: t.f64(),
});

const turf = table(
  { name: 'turf', public: true },
  {
    id: t.u32().primaryKey(),
    name: t.string(),
    neighborhood: t.string(),
    center_lat: t.f64(),
    center_lng: t.f64(),
    boundary: t.array(coordinate),
    walk_route: t.array(coordinate),
  }
);

const voter = table(
  {
    name: 'voter',
    public: true,
    indexes: [
      { accessor: 'by_turf', algorithm: 'btree', columns: ['turf_id'] },
      { accessor: 'by_status', algorithm: 'btree', columns: ['status'] },
    ],
  },
  {
    id: t.u32().primaryKey(),
    turf_id: t.u32(),
    household_key: t.option(t.string()),
    registered_voter_count: t.option(t.u32()),
    household_name: t.string(),
    address: t.string(),
    precinct: t.option(t.string()),
    source_city: t.option(t.string()),
    source_zip5: t.option(t.string()),
    lat: t.f64(),
    lng: t.f64(),
    status: t.string(),
    last_contacted_at: t.option(t.timestamp()),
    last_contacted_by: t.option(t.u32()),
    attempt_count: t.u16(),
    donation_cents: t.u32(),
    updated_seq: t.u32(),
  }
);

const volunteer = table(
  {
    name: 'volunteer',
    public: true,
    indexes: [
      { accessor: 'by_identity', algorithm: 'btree', columns: ['identity'] },
      { accessor: 'by_turf', algorithm: 'btree', columns: ['current_turf_id'] },
      { accessor: 'by_simulated', algorithm: 'btree', columns: ['is_simulated'] },
    ],
  },
  {
    id: t.u32().primaryKey(),
    identity: t.identity(),
    display_name: t.string(),
    current_turf_id: t.u32(),
    lat: t.f64(),
    lng: t.f64(),
    heading: t.f64(),
    active: t.bool(),
    is_simulated: t.bool(),
    target_voter_id: t.u32(),
    completed_count: t.u32(),
    updated_at: t.timestamp(),
  }
);

const activityEvent = table(
  {
    name: 'activity_event',
    public: true,
    indexes: [
      { accessor: 'by_turf', algorithm: 'btree', columns: ['turf_id'] },
      { accessor: 'by_created_at', algorithm: 'btree', columns: ['created_at'] },
    ],
  },
  {
    id: t.u32().primaryKey(),
    turf_id: t.u32(),
    voter_id: t.option(t.u32()),
    volunteer_id: t.option(t.u32()),
    event_type: t.string(),
    status: t.string(),
    message: t.string(),
    lat: t.f64(),
    lng: t.f64(),
    created_at: t.timestamp(),
  }
);

const turfStats = table(
  { name: 'turf_stats', public: true },
  {
    turf_id: t.u32().primaryKey(),
    total_voters: t.u32(),
    not_contacted_count: t.u32(),
    contacted_count: t.u32(),
    literature_dropped_count: t.u32(),
    refused_count: t.u32(),
    donated_count: t.u32(),
    active_volunteer_count: t.u32(),
    update_count: t.u32(),
    last_event_at: t.option(t.timestamp()),
  }
);

const simState = table(
  { name: 'sim_state', public: true },
  {
    id: t.u32().primaryKey(),
    enabled: t.bool(),
    virtual_volunteers: t.u32(),
    cursor: t.u32(),
    ticks: t.u32(),
    events_emitted: t.u32(),
    updated_at: t.timestamp(),
  }
);

const registeredVoterImportRow = t.object('RegisteredVoterImportRow', {
  vuid: t.string(),
  payload: t.string(),
});

const registeredVoter = table(
  {
    name: 'registered_voter',
    public: true,
    indexes: [
      { accessor: 'by_status', algorithm: 'btree', columns: ['status'] },
      { accessor: 'by_city', algorithm: 'btree', columns: ['city'] },
    ],
  },
  {
    vuid: t.string().primaryKey(),
    name: t.string(),
    status: t.string(),
    city: t.string(),
    zip5: t.string(),
    precinct: t.string(),
    payload: t.string(),
  }
);

const spacetimedb = schema({
  turf,
  voter,
  volunteer,
  activityEvent,
  turfStats,
  simState,
  registeredVoter,
});

export default spacetimedb;

const STATUS_NOT_CONTACTED = 'not_contacted';
const STATUS_CONTACTED = 'contacted';
const STATUS_LITERATURE = 'literature_dropped';
const STATUS_REFUSED = 'refused';
const STATUS_DONATED = 'donated';
const SYSTEM_VOLUNTEER_ID = 0;
const SIM_LITERATURE_RATE = 0.8;
const SIM_CONTACT_RATE = 0.15;
const SIM_REFUSED_RATE = 0.05;
const SIM_DONATION_WITHIN_CONTACT_RATE = 0.2;
const WALKING_SPEED_MPS = 1.35;
const SERVER_SIM_TICK_MS = 420;
const METERS_PER_DEGREE_LAT = 111320;
const TARGET_VOTERS_PER_TURF = 200;
const MAX_ACTIVITY_EVENTS = 5000;
const TRAVIS_CENTER = { lat: 30.2672, lng: -97.7431 };
const TRAVIS_BOUNDS = {
  maxLat: 30.628,
  maxLng: -97.37,
  minLat: 30.024,
  minLng: -98.173,
};
const TRAVIS_CITY_CENTERS: Record<string, { lat: number; lng: number }> = {
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

type CoordinateSeed = { lat: number; lng: number };
type HouseholdSeed = {
  address: string;
  city: string;
  count: number;
  householdKey: string;
  lat: number;
  lng: number;
  names: string[];
  precinct: string;
  zip5: string;
};

const TURF_FIXTURES = [
  {
    id: 1,
    name: 'Clarendon North',
    neighborhood: 'Clarendon',
    center_lat: 38.8898,
    center_lng: -77.0951,
    boundary: [
      { lat: 38.8942, lng: -77.1018 },
      { lat: 38.8945, lng: -77.0899 },
      { lat: 38.8859, lng: -77.0884 },
      { lat: 38.8849, lng: -77.1005 },
    ],
    walk_route: [
      { lat: 38.8932, lng: -77.1001 },
      { lat: 38.8921, lng: -77.0948 },
      { lat: 38.8901, lng: -77.0905 },
      { lat: 38.8872, lng: -77.0925 },
      { lat: 38.8864, lng: -77.0985 },
      { lat: 38.8891, lng: -77.1011 },
    ],
  },
  {
    id: 2,
    name: 'Ballston Grid',
    neighborhood: 'Ballston',
    center_lat: 38.8816,
    center_lng: -77.1117,
    boundary: [
      { lat: 38.8867, lng: -77.1185 },
      { lat: 38.8875, lng: -77.1051 },
      { lat: 38.8775, lng: -77.1039 },
      { lat: 38.8761, lng: -77.1169 },
    ],
    walk_route: [
      { lat: 38.8856, lng: -77.1167 },
      { lat: 38.8844, lng: -77.1102 },
      { lat: 38.8821, lng: -77.1058 },
      { lat: 38.8794, lng: -77.1078 },
      { lat: 38.8782, lng: -77.1148 },
      { lat: 38.8816, lng: -77.1176 },
    ],
  },
  {
    id: 3,
    name: 'Columbia Pike West',
    neighborhood: 'Columbia Pike',
    center_lat: 38.8616,
    center_lng: -77.0893,
    boundary: [
      { lat: 38.8664, lng: -77.0973 },
      { lat: 38.8675, lng: -77.0836 },
      { lat: 38.8576, lng: -77.0812 },
      { lat: 38.8555, lng: -77.0946 },
    ],
    walk_route: [
      { lat: 38.8649, lng: -77.0952 },
      { lat: 38.8641, lng: -77.0892 },
      { lat: 38.8622, lng: -77.0838 },
      { lat: 38.8596, lng: -77.0848 },
      { lat: 38.8582, lng: -77.0926 },
      { lat: 38.8614, lng: -77.0961 },
    ],
  },
  {
    id: 4,
    name: 'Shirlington South',
    neighborhood: 'Shirlington',
    center_lat: 38.8404,
    center_lng: -77.0862,
    boundary: [
      { lat: 38.8462, lng: -77.0938 },
      { lat: 38.8461, lng: -77.0795 },
      { lat: 38.8358, lng: -77.0781 },
      { lat: 38.8349, lng: -77.0917 },
    ],
    walk_route: [
      { lat: 38.8448, lng: -77.0915 },
      { lat: 38.8432, lng: -77.0842 },
      { lat: 38.8402, lng: -77.0799 },
      { lat: 38.8374, lng: -77.0832 },
      { lat: 38.8366, lng: -77.0899 },
      { lat: 38.8401, lng: -77.0925 },
    ],
  },
  {
    id: 5,
    name: 'Rosslyn Ridge',
    neighborhood: 'Rosslyn',
    center_lat: 38.8967,
    center_lng: -77.0715,
    boundary: [
      { lat: 38.9027, lng: -77.0797 },
      { lat: 38.9023, lng: -77.0641 },
      { lat: 38.8911, lng: -77.0635 },
      { lat: 38.8902, lng: -77.0778 },
    ],
    walk_route: [
      { lat: 38.9012, lng: -77.0777 },
      { lat: 38.8994, lng: -77.0711 },
      { lat: 38.8961, lng: -77.0648 },
      { lat: 38.8927, lng: -77.0681 },
      { lat: 38.8925, lng: -77.0756 },
      { lat: 38.8966, lng: -77.0786 },
    ],
  },
  {
    id: 6,
    name: 'Crystal City Loop',
    neighborhood: 'Crystal City',
    center_lat: 38.8562,
    center_lng: -77.0508,
    boundary: [
      { lat: 38.8624, lng: -77.0594 },
      { lat: 38.8622, lng: -77.0438 },
      { lat: 38.8499, lng: -77.0429 },
      { lat: 38.8492, lng: -77.0576 },
    ],
    walk_route: [
      { lat: 38.8608, lng: -77.0578 },
      { lat: 38.8593, lng: -77.0516 },
      { lat: 38.8564, lng: -77.0449 },
      { lat: 38.8528, lng: -77.0472 },
      { lat: 38.8514, lng: -77.0555 },
      { lat: 38.8559, lng: -77.0583 },
    ],
  },
];

const HOUSEHOLD_NAMES = [
  'Nguyen',
  'Patel',
  'Johnson',
  'Garcia',
  'Lee',
  'Smith',
  'Williams',
  'Brown',
  'Martinez',
  'Davis',
  'Miller',
  'Wilson',
  'Anderson',
  'Taylor',
  'Thomas',
  'Moore',
  'Jackson',
  'White',
  'Harris',
  'Clark',
];

const STREET_NAMES = [
  'N Highland St',
  'Wilson Blvd',
  'N Barton St',
  'N Vermont St',
  'Columbia Pike',
  'S Walter Reed Dr',
  'S Four Mile Run Dr',
  'N Lynn St',
  'Crystal Dr',
  'S Eads St',
];

export const init = spacetimedb.init(ctx => {
  seedIfEmpty(ctx);
});

export const onConnect = spacetimedb.clientConnected(ctx => {
  seedIfEmpty(ctx);
});

export const onDisconnect = spacetimedb.clientDisconnected(_ctx => {
  // Connection lifecycle is tracked from explicit claim/update reducers.
});

export const importRegisteredVoters = spacetimedb.reducer(
  { rows: t.array(registeredVoterImportRow) },
  (ctx, { rows }) => {
    for (const row of rows) {
      let parsed: Record<string, string> = {};
      try {
        parsed = JSON.parse(row.payload) as Record<string, string>;
      } catch {
        parsed = {};
      }

      const record = {
        vuid: row.vuid,
        name: (parsed.NAME ?? '').trim(),
        status: (parsed.Status ?? '').trim().toUpperCase(),
        city: (parsed.City ?? '').trim().toUpperCase(),
        zip5: (parsed['Zip Code 5'] ?? '').trim(),
        precinct: (parsed.Precinct ?? '').trim(),
        payload: row.payload,
      };
      const existing = ctx.db.registeredVoter.vuid.find(row.vuid);
      if (existing) {
        Object.assign(existing, record);
        ctx.db.registeredVoter.vuid.update(existing);
      } else {
        ctx.db.registeredVoter.insert(record);
      }
    }
  }
);

export const resetDemoData = spacetimedb.reducer({}, ctx => {
  clearTable(ctx, 'activityEvent');
  clearTable(ctx, 'volunteer');
  clearTable(ctx, 'voter');
  clearTable(ctx, 'turfStats');
  clearTable(ctx, 'turf');
  clearTable(ctx, 'simState');
  seedData(ctx);
});

export const claimTurf = spacetimedb.reducer(
  { displayName: t.string(), preferredTurfId: t.u32() },
  (ctx, { displayName, preferredTurfId }) => {
    seedIfEmpty(ctx);
    const assignedTurf = chooseTurf(ctx, preferredTurfId);
    const routePoint = assignedTurf.walk_route[0] ?? {
      lat: assignedTurf.center_lat,
      lng: assignedTurf.center_lng,
    };
    const existing = findHumanVolunteerForSender(ctx);
    let volunteerId: number;
    if (existing) {
      existing.display_name = displayName || existing.display_name;
      existing.current_turf_id = assignedTurf.id;
      existing.lat = routePoint.lat;
      existing.lng = routePoint.lng;
      existing.heading = 0;
      existing.active = true;
      existing.is_simulated = false;
      existing.target_voter_id = 0;
      existing.updated_at = ctx.timestamp;
      ctx.db.volunteer.id.update(existing);
      volunteerId = existing.id;
    } else {
      volunteerId = nextVolunteerId(ctx);
      ctx.db.volunteer.insert({
        id: volunteerId,
        identity: ctx.sender,
        display_name: displayName || 'Field volunteer',
        current_turf_id: assignedTurf.id,
        lat: routePoint.lat,
        lng: routePoint.lng,
        heading: 0,
        active: true,
        is_simulated: false,
        target_voter_id: 0,
        completed_count: 0,
        updated_at: ctx.timestamp,
      });
    }
    recomputeTurfStats(ctx, assignedTurf.id);
    logActivity(ctx, {
      turfId: assignedTurf.id,
      voterId: undefined,
      volunteerId,
      eventType: 'assignment',
      status: 'active',
      message: `${displayName || 'A volunteer'} claimed ${assignedTurf.name}`,
      lat: routePoint.lat,
      lng: routePoint.lng,
    });
  }
);

export const updateVolunteerLocation = spacetimedb.reducer(
  {
    volunteerId: t.u32(),
    lat: t.f64(),
    lng: t.f64(),
    heading: t.f64(),
  },
  (ctx, { volunteerId, lat, lng, heading }) => {
    const row = requireOwnedActiveVolunteer(ctx, volunteerId);
    row.lat = lat;
    row.lng = lng;
    row.heading = heading;
    row.active = true;
    row.updated_at = ctx.timestamp;
    ctx.db.volunteer.id.update(row);
  }
);

export const updateVoterStatus = spacetimedb.reducer(
  {
    voterId: t.u32(),
    status: t.string(),
    volunteerId: t.u32(),
    lat: t.f64(),
    lng: t.f64(),
    donationCents: t.u32(),
  },
  (ctx, { voterId, status, volunteerId, lat, lng, donationCents }) => {
    const cleanStatus = normalizeStatus(status);
    if (cleanStatus === STATUS_NOT_CONTACTED) {
      throw new Error('Use resetDemoData to clear a contacted voter');
    }

    const row = ctx.db.voter.id.find(voterId);
    if (!row) {
      throw new Error(`Voter ${voterId} does not exist`);
    }

    const previousTurfId = row.turf_id;
    const volunteerRow =
      volunteerId === SYSTEM_VOLUNTEER_ID
        ? undefined
        : requireOwnedActiveVolunteer(ctx, volunteerId);
    if (volunteerId !== SYSTEM_VOLUNTEER_ID) {
      if (volunteerRow.current_turf_id !== previousTurfId) {
        throw new Error(
          `Volunteer ${volunteerId} is not assigned to turf ${previousTurfId}`
        );
      }
    }

    row.status = cleanStatus;
    row.last_contacted_at = ctx.timestamp;
    row.last_contacted_by =
      volunteerId === SYSTEM_VOLUNTEER_ID ? undefined : volunteerId;
    row.attempt_count += 1;
    row.donation_cents =
      cleanStatus === STATUS_DONATED ? Math.max(donationCents, 2500) : 0;
    row.updated_seq += 1;
    ctx.db.voter.id.update(row);

    if (volunteerRow) {
      volunteerRow.lat = lat;
      volunteerRow.lng = lng;
      volunteerRow.completed_count += 1;
      volunteerRow.active = true;
      volunteerRow.target_voter_id = 0;
      volunteerRow.updated_at = ctx.timestamp;
      ctx.db.volunteer.id.update(volunteerRow);
    }

    recomputeTurfStats(ctx, previousTurfId);
    const registeredVoterCount = row.registered_voter_count ?? 1;
    const voterCountLabel =
      registeredVoterCount > 1
        ? `${registeredVoterCount} voters`
        : '1 voter';
    logActivity(ctx, {
      turfId: previousTurfId,
      voterId,
      volunteerId:
        volunteerId === SYSTEM_VOLUNTEER_ID ? undefined : volunteerId,
      eventType: 'voter_status',
      status: cleanStatus,
      message: `${row.household_name} at ${row.address} marked ${humanStatus(cleanStatus)} for ${voterCountLabel}`,
      lat,
      lng,
    });
  }
);

export const completeTurf = spacetimedb.reducer(
  { volunteerId: t.u32() },
  (ctx, { volunteerId }) => {
    const row = requireOwnedVolunteer(ctx, volunteerId);
    row.active = false;
    row.target_voter_id = 0;
    row.updated_at = ctx.timestamp;
    ctx.db.volunteer.id.update(row);
    recomputeTurfStats(ctx, row.current_turf_id);
    logActivity(ctx, {
      turfId: row.current_turf_id,
      voterId: undefined,
      volunteerId,
      eventType: 'complete_turf',
      status: 'inactive',
      message: `${row.display_name} completed ${row.completed_count} doors`,
      lat: row.lat,
      lng: row.lng,
    });
  }
);

export const seedSimulation = spacetimedb.reducer(
  { volunteerCount: t.u32() },
  (ctx, { volunteerCount }) => {
    seedIfEmpty(ctx);
    const desiredCount = clampU32(volunteerCount, 1, 10000);
    for (const row of ctx.db.volunteer.by_simulated.filter(true)) {
      ctx.db.volunteer.id.delete(row.id);
    }

    const turfs = Array.from(ctx.db.turf.iter());
    if (turfs.length === 0) {
      throw new Error('No turfs are available');
    }

    let id = nextVolunteerId(ctx);
    for (let i = 0; i < desiredCount; i += 1) {
      const assignedTurf = turfs[i % turfs.length];
      const routePoint =
        assignedTurf.walk_route[i % assignedTurf.walk_route.length] ?? {
          lat: assignedTurf.center_lat,
          lng: assignedTurf.center_lng,
        };
      ctx.db.volunteer.insert({
        id,
        identity: ctx.sender,
        display_name: `Sim ${String(i + 1).padStart(5, '0')}`,
        current_turf_id: assignedTurf.id,
        lat: routePoint.lat,
        lng: routePoint.lng,
        heading: randomHeading(),
        active: true,
        is_simulated: true,
        target_voter_id: 0,
        completed_count: 0,
        updated_at: ctx.timestamp,
      });
      id += 1;
    }

    upsertSimState(ctx, desiredCount, true, 0, 0);
    for (const row of ctx.db.turf.iter()) {
      recomputeTurfStats(ctx, row.id);
    }
    logActivity(ctx, {
      turfId: 1,
      voterId: undefined,
      volunteerId: undefined,
      eventType: 'simulation_seeded',
      status: 'active',
      message: `Seeded ${desiredCount} simulated knockers`,
      lat: TRAVIS_CENTER.lat,
      lng: TRAVIS_CENTER.lng,
    });
  }
);

export const stopSimulation = spacetimedb.reducer({}, ctx => {
  const state = ctx.db.simState.id.find(1);
  if (state) {
    state.enabled = false;
    state.updated_at = ctx.timestamp;
    ctx.db.simState.id.update(state);
  }
});

export const simulateTick = spacetimedb.reducer(
  { batchSize: t.u32() },
  (ctx, { batchSize }) => {
    seedIfEmpty(ctx);
    const state = ctx.db.simState.id.find(1);
    if (!state || !state.enabled) {
      return;
    }

    const batchLimit = clampU32(batchSize, 1, 10000);
    const simulated = Array.from(
      ctx.db.volunteer.by_simulated.filter(true)
    ) as any[];
    if (simulated.length === 0) {
      state.enabled = false;
      state.updated_at = ctx.timestamp;
      ctx.db.simState.id.update(state);
      return;
    }

    simulated.sort((a, b) => a.id - b.id);
    const startIndex = simulated.findIndex(row => row.id >= state.cursor);
    let index = startIndex === -1 ? 0 : startIndex;
    let processed = 0;
    let events = 0;
    const touchedTurfs: number[] = [];

    while (processed < batchLimit && processed < simulated.length) {
      const row = simulated[index];
      const effectiveTickMs =
        SERVER_SIM_TICK_MS *
        Math.max(1, Math.ceil(simulated.length / batchLimit));
      events += simulateVolunteerStep(ctx, row, effectiveTickMs);
      touchedTurfs.push(row.current_turf_id);
      processed += 1;
      index = (index + 1) % simulated.length;
    }

    const nextRow = simulated[index];
    state.cursor = nextRow ? nextRow.id : 0;
    state.ticks += 1;
    state.events_emitted += events;
    state.updated_at = ctx.timestamp;
    ctx.db.simState.id.update(state);
    recomputeTouchedTurfs(ctx, touchedTurfs);
  }
);

function seedIfEmpty(ctx: any) {
  if (ctx.db.turf.count() === 0) {
    seedData(ctx);
  }
}

function seedData(ctx: any) {
  if (ctx.db.registeredVoter.count() > 0) {
    seedRegisteredVoterHouseholds(ctx);
    return;
  }

  seedFallbackTurfVoters(ctx);
}

function seedRegisteredVoterHouseholds(ctx: any) {
  const households: Record<string, HouseholdSeed> = {};

  for (const row of ctx.db.registeredVoter.iter()) {
    const parsed = parsePayload(row.payload);
    const householdKey = householdKeyForRegisteredVoter(row, parsed);
    if (!householdKey) {
      continue;
    }

    const existing = households[householdKey];
    if (existing) {
      existing.count += 1;
      addHouseholdName(existing, row.name || parsed.NAME || '');
      continue;
    }

    const city = cleanUpper(row.city || parsed.City || 'AUSTIN');
    const zip5 = (row.zip5 || parsed['Zip Code 5'] || '').trim();
    const precinct = (row.precinct || parsed.Precinct || 'Unassigned').trim();
    const address = displayAddressForRegisteredVoter(parsed);
    const point = coordinateForRegisteredVoter(row, parsed, householdKey);
    households[householdKey] = {
      address,
      city,
      count: 1,
      householdKey,
      lat: point.lat,
      lng: point.lng,
      names: [],
      precinct,
      zip5,
    };
    addHouseholdName(households[householdKey], row.name || parsed.NAME || '');
  }

  const householdRows = Object.values(households).sort(compareHouseholds);
  let turfId = 1;
  let voterId = 1;
  let current: HouseholdSeed[] = [];
  let currentVoterTotal = 0;

  const flushTurf = () => {
    if (current.length === 0) {
      return;
    }

    const geometry = geometryForHouseholds(current);
    const precincts = uniqueSorted(current.map(row => row.precinct).filter(Boolean));
    const zipCodes = uniqueSorted(current.map(row => row.zip5).filter(Boolean));
    const neighborhood =
      precincts.length > 0
        ? `${precincts.slice(0, 3).join(', ')}${precincts.length > 3 ? ' +' : ''}`
        : zipCodes.length > 0
          ? `ZIP ${zipCodes.slice(0, 3).join(', ')}${zipCodes.length > 3 ? ' +' : ''}`
        : 'Travis County';
    ctx.db.turf.insert({
      id: turfId,
      name: `Travis ${String(turfId).padStart(4, '0')}`,
      neighborhood,
      center_lat: geometry.center.lat,
      center_lng: geometry.center.lng,
      boundary: geometry.boundary,
      walk_route: geometry.walkRoute,
    });
    ctx.db.turfStats.insert({
      turf_id: turfId,
      total_voters: 0,
      not_contacted_count: 0,
      contacted_count: 0,
      literature_dropped_count: 0,
      refused_count: 0,
      donated_count: 0,
      active_volunteer_count: 0,
      update_count: 0,
      last_event_at: undefined,
    });

    for (const household of current) {
      ctx.db.voter.insert({
        id: voterId,
        turf_id: turfId,
        household_key: household.householdKey,
        registered_voter_count: household.count,
        household_name: householdName(household),
        address: household.address,
        precinct: household.precinct,
        source_city: household.city,
        source_zip5: household.zip5,
        lat: household.lat,
        lng: household.lng,
        status: STATUS_NOT_CONTACTED,
        last_contacted_at: undefined,
        last_contacted_by: undefined,
        attempt_count: 0,
        donation_cents: 0,
        updated_seq: 0,
      });
      voterId += 1;
    }

    recomputeTurfStats(ctx, turfId);
    turfId += 1;
    current = [];
    currentVoterTotal = 0;
  };

  for (const household of householdRows) {
    if (
      current.length > 0 &&
      currentVoterTotal + household.count > TARGET_VOTERS_PER_TURF
    ) {
      flushTurf();
    }
    current.push(household);
    currentVoterTotal += household.count;
  }
  flushTurf();
  upsertSimState(ctx, 0, false, 0, 0);
}

function seedFallbackTurfVoters(ctx: any) {
  for (const turfFixture of TURF_FIXTURES) {
    ctx.db.turf.insert(turfFixture);
    ctx.db.turfStats.insert({
      turf_id: turfFixture.id,
      total_voters: 0,
      not_contacted_count: 0,
      contacted_count: 0,
      literature_dropped_count: 0,
      refused_count: 0,
      donated_count: 0,
      active_volunteer_count: 0,
      update_count: 0,
      last_event_at: undefined,
    });
    seedTurfVoters(ctx, turfFixture);
  }
  upsertSimState(ctx, 0, false, 0, 0);
  for (const row of ctx.db.turf.iter()) {
    recomputeTurfStats(ctx, row.id);
  }
}

function seedTurfVoters(ctx: any, turfFixture: (typeof TURF_FIXTURES)[number]) {
  const boundary = turfFixture.boundary;
  const route = turfFixture.walk_route;
  const voterCount = 1800;
  for (let i = 0; i < voterCount; i += 1) {
    const routePoint = route[i % route.length];
    const jitterLat = (((i * 17) % 101) - 50) * 0.000055;
    const jitterLng = (((i * 29) % 113) - 56) * 0.000057;
    const lat = clamp(
      routePoint.lat + jitterLat,
      Math.min(...boundary.map(p => p.lat)) + 0.0004,
      Math.max(...boundary.map(p => p.lat)) - 0.0004
    );
    const lng = clamp(
      routePoint.lng + jitterLng,
      Math.min(...boundary.map(p => p.lng)) + 0.0004,
      Math.max(...boundary.map(p => p.lng)) - 0.0004
    );
    const household = HOUSEHOLD_NAMES[(i + turfFixture.id) % HOUSEHOLD_NAMES.length];
    const street = STREET_NAMES[(i + turfFixture.id * 2) % STREET_NAMES.length];
    ctx.db.voter.insert({
      id: turfFixture.id * 100000 + i + 1,
      turf_id: turfFixture.id,
      household_key: `fallback:${turfFixture.id}:${i}`,
      registered_voter_count: 1,
      household_name: `${household} household`,
      address: `${1200 + turfFixture.id * 100 + i} ${street}`,
      precinct: `P ${String(100 + turfFixture.id).padStart(3, '0')}`,
      source_city: 'AUSTIN',
      source_zip5: '78701',
      lat,
      lng,
      status: STATUS_NOT_CONTACTED,
      last_contacted_at: undefined,
      last_contacted_by: undefined,
      attempt_count: 0,
      donation_cents: 0,
      updated_seq: 0,
    });
  }
}

function parsePayload(payload: string) {
  try {
    return JSON.parse(payload) as Record<string, string>;
  } catch {
    return {};
  }
}

function cleanUpper(value: string) {
  return value.trim().replace(/\s+/g, ' ').toUpperCase();
}

function cleanAddressPart(value: string | undefined) {
  return (value ?? '').trim().replace(/\s+/g, ' ');
}

function householdKeyForRegisteredVoter(
  row: any,
  parsed: Record<string, string>
) {
  const streetNumber = cleanAddressPart(parsed['Street Number 1']);
  const streetName = cleanAddressPart(parsed['Street Name 1']);
  const unit = cleanAddressPart(parsed.Unit);
  const city = cleanUpper(row.city || parsed.City || '');
  const zip5 = cleanAddressPart(row.zip5 || parsed['Zip Code 5']);

  if (!streetNumber && !streetName) {
    const residentialAddress = cleanAddressPart(parsed['Residential Address']);
    if (!residentialAddress) {
      return '';
    }
    return cleanUpper(`${residentialAddress}|${unit}|${city}|${zip5}`);
  }

  return cleanUpper(`${streetNumber}|${streetName}|${unit}|${city}|${zip5}`);
}

function displayAddressForRegisteredVoter(parsed: Record<string, string>) {
  const streetNumber = cleanAddressPart(parsed['Street Number 1']);
  const streetName = cleanAddressPart(parsed['Street Name 1']);
  const unit = cleanAddressPart(parsed.Unit);
  const city = cleanAddressPart(parsed.City || 'Austin');
  const state = cleanAddressPart(parsed.State || 'TX');
  const zip5 = cleanAddressPart(parsed['Zip Code 5']);
  const base =
    streetNumber || streetName
      ? `${streetNumber} ${streetName}`.trim()
      : cleanAddressPart(parsed['Residential Address']);
  const unitText = unit ? ` #${unit}` : '';
  return `${base}${unitText}, ${city} ${state} ${zip5}`.trim();
}

function coordinateForRegisteredVoter(
  row: any,
  parsed: Record<string, string>,
  householdKey: string
) {
  const explicit = explicitCoordinate(parsed);
  if (explicit && insideTravisBounds(explicit)) {
    return explicit;
  }

  const cityKey = cleanUpper(row.city || parsed.City || 'AUSTIN').replaceAll(
    ' ',
    '_'
  );
  const cityCenter = TRAVIS_CITY_CENTERS[cityKey] ?? zipCenter(row.zip5 || parsed['Zip Code 5']);
  const hash = hashString(householdKey);
  const angle = ((hash % 360) * Math.PI) / 180;
  const radius = 0.004 + (((hash >>> 9) % 1600) / 1600) * 0.072;
  const latJitter = Math.sin(angle) * radius;
  const lngJitter = Math.cos(angle) * radius * 1.15;
  return {
    lat: clamp(cityCenter.lat + latJitter, TRAVIS_BOUNDS.minLat, TRAVIS_BOUNDS.maxLat),
    lng: clamp(cityCenter.lng + lngJitter, TRAVIS_BOUNDS.minLng, TRAVIS_BOUNDS.maxLng),
  };
}

function explicitCoordinate(parsed: Record<string, string>) {
  const lat = parseCoordinate(
    parsed.Latitude ??
      parsed.latitude ??
      parsed.LAT ??
      parsed.lat ??
      parsed.Y ??
      parsed.y
  );
  const lng = parseCoordinate(
    parsed.Longitude ??
      parsed.longitude ??
      parsed.LON ??
      parsed.lng ??
      parsed.LNG ??
      parsed.X ??
      parsed.x
  );
  if (lat === undefined || lng === undefined) {
    return undefined;
  }
  return { lat, lng };
}

function parseCoordinate(value: string | undefined) {
  if (!value) {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function insideTravisBounds(point: CoordinateSeed) {
  return (
    point.lat >= TRAVIS_BOUNDS.minLat &&
    point.lat <= TRAVIS_BOUNDS.maxLat &&
    point.lng >= TRAVIS_BOUNDS.minLng &&
    point.lng <= TRAVIS_BOUNDS.maxLng
  );
}

function zipCenter(zip5: string | undefined) {
  const zipValue = Number((zip5 ?? '').replace(/\D/g, '').slice(-3));
  if (!Number.isFinite(zipValue)) {
    return TRAVIS_CENTER;
  }
  const latBucket = zipValue % 29;
  const lngBucket = Math.floor(zipValue / 7) % 31;
  return {
    lat: TRAVIS_BOUNDS.minLat + (latBucket / 28) * (TRAVIS_BOUNDS.maxLat - TRAVIS_BOUNDS.minLat),
    lng: TRAVIS_BOUNDS.minLng + (lngBucket / 30) * (TRAVIS_BOUNDS.maxLng - TRAVIS_BOUNDS.minLng),
  };
}

function addHouseholdName(household: HouseholdSeed, name: string) {
  const cleanName = cleanAddressPart(name);
  if (!cleanName || household.names.includes(cleanName) || household.names.length >= 3) {
    return;
  }
  household.names.push(cleanName);
}

function compareHouseholds(a: HouseholdSeed, b: HouseholdSeed) {
  return (
    a.zip5.localeCompare(b.zip5) ||
    a.precinct.localeCompare(b.precinct) ||
    a.city.localeCompare(b.city) ||
    a.lat - b.lat ||
    a.lng - b.lng ||
    a.householdKey.localeCompare(b.householdKey)
  );
}

function householdName(household: HouseholdSeed) {
  const label = household.names[0]
    ? `${household.names[0]} household`
    : 'Registered voter household';
  return household.count > 1
    ? `${label} (${household.count} voters)`
    : label;
}

function geometryForHouseholds(households: HouseholdSeed[]) {
  const latValues = households.map(row => row.lat);
  const lngValues = households.map(row => row.lng);
  const minLat = Math.min(...latValues);
  const maxLat = Math.max(...latValues);
  const minLng = Math.min(...lngValues);
  const maxLng = Math.max(...lngValues);
  const latPad = Math.max(0.0025, (maxLat - minLat) * 0.22);
  const lngPad = Math.max(0.0025, (maxLng - minLng) * 0.22);
  const boundary = [
    {
      lat: clamp(minLat - latPad, TRAVIS_BOUNDS.minLat, TRAVIS_BOUNDS.maxLat),
      lng: clamp(minLng - lngPad, TRAVIS_BOUNDS.minLng, TRAVIS_BOUNDS.maxLng),
    },
    {
      lat: clamp(maxLat + latPad, TRAVIS_BOUNDS.minLat, TRAVIS_BOUNDS.maxLat),
      lng: clamp(minLng - lngPad, TRAVIS_BOUNDS.minLng, TRAVIS_BOUNDS.maxLng),
    },
    {
      lat: clamp(maxLat + latPad, TRAVIS_BOUNDS.minLat, TRAVIS_BOUNDS.maxLat),
      lng: clamp(maxLng + lngPad, TRAVIS_BOUNDS.minLng, TRAVIS_BOUNDS.maxLng),
    },
    {
      lat: clamp(minLat - latPad, TRAVIS_BOUNDS.minLat, TRAVIS_BOUNDS.maxLat),
      lng: clamp(maxLng + lngPad, TRAVIS_BOUNDS.minLng, TRAVIS_BOUNDS.maxLng),
    },
  ];
  const center = {
    lat: households.reduce((sum, row) => sum + row.lat, 0) / households.length,
    lng: households.reduce((sum, row) => sum + row.lng, 0) / households.length,
  };
  const sorted = [...households].sort((a, b) => a.lat - b.lat || a.lng - b.lng);
  const stride = Math.max(1, Math.floor(sorted.length / 10));
  const walkRoute = sorted
    .filter((_row, index) => index % stride === 0)
    .slice(0, 12)
    .map(row => ({ lat: row.lat, lng: row.lng }));

  return {
    boundary,
    center,
    walkRoute: walkRoute.length > 0 ? walkRoute : [center],
  };
}

function uniqueSorted(values: string[]) {
  return [...new Set(values)].sort();
}

function hashString(value: string) {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function clearTable(ctx: any, accessorName: string) {
  const ids = Array.from(ctx.db[accessorName].iter()).map((row: any) => row.id ?? row.turf_id);
  for (const id of ids) {
    if (accessorName === 'turfStats') {
      ctx.db[accessorName].turfId.delete(id);
    } else {
      ctx.db[accessorName].id.delete(id);
    }
  }
}

function chooseTurf(ctx: any, preferredTurfId: number) {
  const preferred = preferredTurfId === 0 ? undefined : ctx.db.turf.id.find(preferredTurfId);
  if (preferred) {
    return preferred;
  }
  const turfs = Array.from(ctx.db.turf.iter());
  if (turfs.length === 0) {
    throw new Error('No turfs are available');
  }
  return turfs[Math.floor(Math.random() * turfs.length)];
}

function findHumanVolunteerForSender(ctx: any) {
  for (const row of ctx.db.volunteer.by_identity.filter(ctx.sender)) {
    if (!row.is_simulated) {
      return row;
    }
  }
  return undefined;
}

function volunteerBelongsToSender(ctx: any, volunteerRow: any) {
  for (const row of ctx.db.volunteer.by_identity.filter(ctx.sender)) {
    if (row.id === volunteerRow.id) {
      return true;
    }
  }
  return false;
}

function requireOwnedVolunteer(ctx: any, volunteerId: number) {
  const row = ctx.db.volunteer.id.find(volunteerId);
  if (!row) {
    throw new Error(`Volunteer ${volunteerId} does not exist`);
  }
  if (!volunteerBelongsToSender(ctx, row)) {
    throw new Error(`Volunteer ${volunteerId} belongs to another identity`);
  }
  return row;
}

function requireOwnedActiveVolunteer(ctx: any, volunteerId: number) {
  const row = requireOwnedVolunteer(ctx, volunteerId);
  if (!row.active) {
    throw new Error(`Volunteer ${volunteerId} is not active`);
  }
  return row;
}

function normalizeStatus(status: string) {
  const value = status.trim().toLowerCase();
  if (
    value === STATUS_NOT_CONTACTED ||
    value === STATUS_CONTACTED ||
    value === STATUS_LITERATURE ||
    value === STATUS_REFUSED ||
    value === STATUS_DONATED
  ) {
    return value;
  }
  throw new Error(`Unsupported voter status: ${status}`);
}

function humanStatus(status: string) {
  if (status === STATUS_CONTACTED) return 'Contacted';
  if (status === STATUS_LITERATURE) return 'Literature Dropped';
  if (status === STATUS_REFUSED) return 'Refused';
  if (status === STATUS_DONATED) return 'Donated';
  return 'Not Contacted';
}

function nextVolunteerId(ctx: any) {
  let maxId = 0;
  for (const row of ctx.db.volunteer.iter()) {
    maxId = Math.max(maxId, row.id);
  }
  return maxId + 1;
}

function nextActivityEventId(ctx: any) {
  let maxId = 0;
  for (const row of ctx.db.activityEvent.iter()) {
    maxId = Math.max(maxId, row.id);
  }
  return maxId + 1;
}

function recomputeTouchedTurfs(ctx: any, turfIds: number[]) {
  const seen: Record<number, boolean> = {};
  for (const turfId of turfIds) {
    if (!seen[turfId]) {
      recomputeTurfStats(ctx, turfId);
      seen[turfId] = true;
    }
  }
}

function recomputeTurfStats(ctx: any, turfId: number) {
  let total = 0;
  let notContacted = 0;
  let contacted = 0;
  let literature = 0;
  let refused = 0;
  let donated = 0;
  for (const row of ctx.db.voter.by_turf.filter(turfId)) {
    const weight = row.registered_voter_count || 1;
    total += weight;
    if (row.status === STATUS_CONTACTED) contacted += weight;
    else if (row.status === STATUS_LITERATURE) literature += weight;
    else if (row.status === STATUS_REFUSED) refused += weight;
    else if (row.status === STATUS_DONATED) donated += weight;
    else notContacted += weight;
  }
  let activeVolunteers = 0;
  for (const row of ctx.db.volunteer.by_turf.filter(turfId)) {
    if (row.active) {
      activeVolunteers += 1;
    }
  }

  const existing = ctx.db.turfStats.turfId.find(turfId);
  if (existing) {
    existing.total_voters = total;
    existing.not_contacted_count = notContacted;
    existing.contacted_count = contacted;
    existing.literature_dropped_count = literature;
    existing.refused_count = refused;
    existing.donated_count = donated;
    existing.active_volunteer_count = activeVolunteers;
    existing.update_count += 1;
    ctx.db.turfStats.turfId.update(existing);
  } else {
    ctx.db.turfStats.insert({
      turf_id: turfId,
      total_voters: total,
      not_contacted_count: notContacted,
      contacted_count: contacted,
      literature_dropped_count: literature,
      refused_count: refused,
      donated_count: donated,
      active_volunteer_count: activeVolunteers,
      update_count: 1,
      last_event_at: undefined,
    });
  }
}

function logActivity(
  ctx: any,
  event: {
    turfId: number;
    voterId: number | undefined;
    volunteerId: number | undefined;
    eventType: string;
    status: string;
    message: string;
    lat: number;
    lng: number;
  }
) {
  ctx.db.activityEvent.insert({
    id: nextActivityEventId(ctx),
    turf_id: event.turfId,
    voter_id: event.voterId,
    volunteer_id: event.volunteerId,
    event_type: event.eventType,
    status: event.status,
    message: event.message,
    lat: event.lat,
    lng: event.lng,
    created_at: ctx.timestamp,
  });

  const stats = ctx.db.turfStats.turfId.find(event.turfId);
  if (stats) {
    stats.last_event_at = ctx.timestamp;
    stats.update_count += 1;
    ctx.db.turfStats.turfId.update(stats);
  }
  pruneActivityEvents(ctx);
}

function pruneActivityEvents(ctx: any) {
  if (ctx.db.activityEvent.count() <= MAX_ACTIVITY_EVENTS) {
    return;
  }
  const rows = Array.from(ctx.db.activityEvent.iter()) as any[];
  rows.sort((a, b) => a.id - b.id);
  const removeCount = rows.length - MAX_ACTIVITY_EVENTS;
  for (let i = 0; i < removeCount; i += 1) {
    ctx.db.activityEvent.id.delete(rows[i].id);
  }
}

function upsertSimState(
  ctx: any,
  virtualVolunteers: number,
  enabled: boolean,
  cursor: number,
  eventsEmitted: number
) {
  const row = ctx.db.simState.id.find(1);
  if (row) {
    row.enabled = enabled;
    row.virtual_volunteers = virtualVolunteers;
    row.cursor = cursor;
    row.events_emitted = eventsEmitted;
    row.updated_at = ctx.timestamp;
    ctx.db.simState.id.update(row);
  } else {
    ctx.db.simState.insert({
      id: 1,
      enabled,
      virtual_volunteers: virtualVolunteers,
      cursor,
      ticks: 0,
      events_emitted: eventsEmitted,
      updated_at: ctx.timestamp,
    });
  }
}

function simulateVolunteerStep(ctx: any, row: any, effectiveTickMs: number) {
  const target = ensureTargetVoter(ctx, row);
  if (!target) {
    row.active = false;
    row.updated_at = ctx.timestamp;
    ctx.db.volunteer.id.update(row);
    return 0;
  }

  const stepMeters = walkingStepMeters(effectiveTickMs);
  const waypoint = routeWaypointForVolunteer(ctx, row);
  if (waypoint) {
    const routeDistance = distanceMeters(row.lat, row.lng, waypoint.lat, waypoint.lng);
    if (routeDistance > stepMeters) {
      const routeHeading = Math.atan2(waypoint.lng - row.lng, waypoint.lat - row.lat);
      const next = moveTowardCoordinate(
        row.lat,
        row.lng,
        waypoint.lat,
        waypoint.lng,
        stepMeters
      );
      row.lat = next.lat;
      row.lng = next.lng;
      row.heading = routeHeading;
      row.active = true;
      row.updated_at = ctx.timestamp;
      ctx.db.volunteer.id.update(row);
      return 0;
    }
  }

  const distance = distanceMeters(row.lat, row.lng, target.lat, target.lng);
  const heading = Math.atan2(target.lng - row.lng, target.lat - row.lat);
  if (distance <= stepMeters) {
    row.lat = target.lat;
    row.lng = target.lng;
    row.heading = heading;
    row.target_voter_id = 0;
    row.completed_count += 1;
    row.updated_at = ctx.timestamp;
    ctx.db.volunteer.id.update(row);
    applySimulatedContact(ctx, row, target);
    return 1;
  }

  const next = moveTowardCoordinate(row.lat, row.lng, target.lat, target.lng, stepMeters);
  row.lat = next.lat;
  row.lng = next.lng;
  row.heading = heading;
  row.active = true;
  row.updated_at = ctx.timestamp;
  ctx.db.volunteer.id.update(row);
  return 0;
}

function ensureTargetVoter(ctx: any, row: any) {
  if (row.target_voter_id !== 0) {
    const existing = ctx.db.voter.id.find(row.target_voter_id);
    if (existing && existing.status === STATUS_NOT_CONTACTED) {
      return existing;
    }
  }

  const candidates = [];
  for (const voterRow of ctx.db.voter.by_turf.filter(row.current_turf_id)) {
    if (voterRow.status === STATUS_NOT_CONTACTED) {
      candidates.push(voterRow);
    }
  }
  if (candidates.length === 0) {
    return undefined;
  }

  const routePoint = routeWaypointForVolunteer(ctx, row);
  if (routePoint) {
    candidates.sort(
      (a, b) =>
        distanceBetween(routePoint.lat, routePoint.lng, a.lat, a.lng) -
        distanceBetween(routePoint.lat, routePoint.lng, b.lat, b.lng)
    );
  }
  const next =
    candidates[Math.floor(Math.random() * Math.min(12, candidates.length))];
  row.target_voter_id = next.id;
  ctx.db.volunteer.id.update(row);
  return next;
}

function routeWaypointForVolunteer(ctx: any, row: any) {
  const turf = ctx.db.turf.id.find(row.current_turf_id);
  const route = turf?.walk_route ?? [];
  if (route.length === 0) {
    return undefined;
  }
  return route[(row.completed_count + row.id) % route.length];
}

function applySimulatedContact(ctx: any, row: any, target: any) {
  const roll = Math.random();
  let status = STATUS_REFUSED;
  if (roll < SIM_LITERATURE_RATE) {
    status = STATUS_LITERATURE;
  } else if (roll < SIM_LITERATURE_RATE + SIM_CONTACT_RATE) {
    status =
      Math.random() < SIM_DONATION_WITHIN_CONTACT_RATE
        ? STATUS_DONATED
        : STATUS_CONTACTED;
  } else if (roll >= 1 - SIM_REFUSED_RATE) {
    status = STATUS_REFUSED;
  }
  target.status = status;
  target.last_contacted_at = ctx.timestamp;
  target.last_contacted_by = row.id;
  target.attempt_count += 1;
  target.donation_cents =
    status === STATUS_DONATED ? 2500 + Math.floor(Math.random() * 17500) : 0;
  target.updated_seq += 1;
  ctx.db.voter.id.update(target);

  logActivity(ctx, {
    turfId: target.turf_id,
    voterId: target.id,
    volunteerId: row.id,
    eventType: 'simulated_knock',
    status,
    message: `${row.display_name} marked ${target.household_name} ${humanStatus(status)}`,
    lat: target.lat,
    lng: target.lng,
  });
}

function distanceBetween(latA: number, lngA: number, latB: number, lngB: number) {
  const latDistance = latB - latA;
  const lngDistance = lngB - lngA;
  return Math.sqrt(latDistance * latDistance + lngDistance * lngDistance);
}

function distanceMeters(latA: number, lngA: number, latB: number, lngB: number) {
  const meanLatRadians = (((latA + latB) / 2) * Math.PI) / 180;
  const latDistance = (latB - latA) * METERS_PER_DEGREE_LAT;
  const lngDistance =
    (lngB - lngA) * METERS_PER_DEGREE_LAT * Math.cos(meanLatRadians);
  return Math.sqrt(latDistance * latDistance + lngDistance * lngDistance);
}

function moveTowardCoordinate(
  lat: number,
  lng: number,
  targetLat: number,
  targetLng: number,
  stepMeters: number
) {
  const distance = distanceMeters(lat, lng, targetLat, targetLng);
  if (distance === 0 || distance <= stepMeters) {
    return { lat: targetLat, lng: targetLng };
  }
  const ratio = stepMeters / distance;
  return {
    lat: lat + (targetLat - lat) * ratio,
    lng: lng + (targetLng - lng) * ratio,
  };
}

function walkingStepMeters(effectiveTickMs: number) {
  const jitter = 0.85 + Math.random() * 0.3;
  return WALKING_SPEED_MPS * (effectiveTickMs / 1000) * jitter;
}

function randomHeading() {
  return Math.random() * Math.PI * 2;
}

function clampU32(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, Math.floor(value)));
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}
