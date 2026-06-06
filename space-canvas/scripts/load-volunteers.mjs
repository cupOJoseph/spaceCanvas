import {
  DbConnection,
  STATUS_CONTACTED,
  STATUS_DONATED,
  STATUS_LITERATURE,
  STATUS_NOT_CONTACTED,
  STATUS_REFUSED,
  defaultDatabase,
  defaultHost,
} from './spacetime-client.mjs';

const SIM_LITERATURE_RATE = 0.8;
const SIM_CONTACT_RATE = 0.15;
const SIM_REFUSED_RATE = 0.05;
const SIM_DONATION_WITHIN_CONTACT_RATE = 0.2;
const WALKING_SPEED_MPS = 1.35;
const METERS_PER_DEGREE_LAT = 111320;

const host = defaultHost;
const database = defaultDatabase;
const totalClients = intEnv('CLIENTS', 10000);
const connectRatePerSecond = intEnv('CONNECT_RATE_PER_SEC', 250);
const tickMs = intEnv('CLIENT_TICK_MS', 700);
const logMs = intEnv('LOG_MS', 2500);
const maxReducerInFlight = intEnv('MAX_REDUCER_IN_FLIGHT', 1200);
const resetDemo = process.env.RESET_DEMO === '1';

const coordinatorToken = process.env.SPACETIMEDB_TOKEN;
const turfIds = [1, 2, 3, 4, 5, 6];
const reservedVoters = new Set();
const clients = [];
const cache = {
  builtAt: 0,
  votersByTurf: new Map(),
  volunteersByIdentity: new Map(),
};
const metrics = {
  connected: 0,
  claimed: 0,
  assigned: 0,
  locationUpdates: 0,
  voterUpdates: 0,
  completedTurfs: 0,
  reducerErrors: 0,
  connectErrors: 0,
};

let coordinator;
let coordinatorReady = false;
let createdClients = 0;
let reducerInFlight = 0;
let shuttingDown = false;

const coordinatorBuilder = DbConnection.builder()
  .withUri(host)
  .withDatabaseName(database)
  .onConnect(async conn => {
    coordinator = conn;
    console.log(`Coordinator connected to ${host}/${database}`);
    conn
      .subscriptionBuilder()
      .onApplied(async () => {
        coordinatorReady = true;
        console.log('Coordinator subscription applied');
        if (resetDemo) {
          console.log('Resetting demo data before load run');
          await conn.reducers.resetDemoData();
        }
        startClientRamp();
      })
      .onError((_ctx, error) => {
        console.error('Coordinator subscription failed:', error.message);
      })
      .subscribe([
        'SELECT * FROM turf',
        'SELECT * FROM voter',
        'SELECT * FROM volunteer',
      ]);
  })
  .onConnectError((_ctx, error) => {
    console.error('Coordinator connect failed:', error.message);
    process.exitCode = 1;
  })
  .onDisconnect((_ctx, error) => {
    if (!shuttingDown) {
      console.error('Coordinator disconnected:', error?.message ?? 'closed');
    }
  });

if (coordinatorToken) {
  coordinatorBuilder.withToken(coordinatorToken);
}

coordinatorBuilder.build();

setInterval(() => {
  const voters = coordinatorReady ? Array.from(coordinator.db.voter.iter()) : [];
  const remaining = voters.filter(row => row.status === STATUS_NOT_CONTACTED).length;
  console.log(
    [
      `clients=${clients.length}/${totalClients}`,
      `connected=${metrics.connected}`,
      `claimed=${metrics.claimed}`,
      `assigned=${metrics.assigned}`,
      `updates=${metrics.voterUpdates}`,
      `gps=${metrics.locationUpdates}`,
      `remaining=${remaining}`,
      `inFlight=${reducerInFlight}`,
      `errors=${metrics.reducerErrors + metrics.connectErrors}`,
    ].join(' ')
  );
}, logMs);

function startClientRamp() {
  if (!coordinatorReady || createdClients >= totalClients) {
    return;
  }

  const intervalMs = 250;
  const batchSize = Math.max(
    1,
    Math.ceil((connectRatePerSecond * intervalMs) / 1000)
  );

  const ramp = setInterval(() => {
    if (shuttingDown) {
      clearInterval(ramp);
      return;
    }
    for (let i = 0; i < batchSize && createdClients < totalClients; i += 1) {
      createdClients += 1;
      createClient(createdClients);
    }
    if (createdClients >= totalClients) {
      clearInterval(ramp);
      console.log(`Created ${totalClients.toLocaleString()} client connections`);
    }
  }, intervalMs);
}

function createClient(index) {
  const state = {
    index,
    conn: undefined,
    identityHex: '',
    volunteerId: 0,
    turfId: turfIds[index % turfIds.length],
    lat: 0,
    lng: 0,
    routeIndex: index % 12,
    target: undefined,
    waypoint: undefined,
    lastStepAt: 0,
    inFlight: false,
    completed: false,
  };

  const builder = DbConnection.builder()
    .withUri(host)
    .withDatabaseName(database)
    .withCompression('none')
    .withLightMode(true)
    .onConnect(async (conn, identity) => {
      state.conn = conn;
      state.identityHex = identity.toHexString();
      metrics.connected += 1;
      await queueReducer(() =>
        conn.reducers.claimTurf({
          displayName: `Load ${String(index).padStart(5, '0')}`,
          preferredTurfId: state.turfId,
        })
      );
      metrics.claimed += 1;
    })
    .onConnectError((_ctx, error) => {
      metrics.connectErrors += 1;
      console.error(`client ${index} connect failed: ${error.message}`);
    })
    .onDisconnect((_ctx, error) => {
      if (!shuttingDown) {
        metrics.connectErrors += 1;
        console.error(`client ${index} disconnected: ${error?.message ?? 'closed'}`);
      }
    });

  state.conn = builder.build();
  state.timer = setInterval(() => tickClient(state), tickMs + (index % 9) * 33);
  clients.push(state);
}

async function tickClient(state) {
  if (shuttingDown || state.inFlight || !state.conn || !coordinatorReady) {
    return;
  }

  const volunteer = getVolunteerForClient(state);
  if (!volunteer) {
    return;
  }
  if (!state.volunteerId) {
    state.volunteerId = volunteer.id;
    state.turfId = volunteer.current_turf_id;
    state.lat = volunteer.lat;
    state.lng = volunteer.lng;
    metrics.assigned += 1;
  }

  if (state.completed) {
    return;
  }

  if (!state.target || state.target.status !== STATUS_NOT_CONTACTED) {
    state.target = chooseTarget(state);
    if (!state.target) {
      state.completed = true;
      state.inFlight = true;
      try {
        await queueReducer(() =>
          state.conn.reducers.completeTurf({ volunteerId: state.volunteerId })
        );
        metrics.completedTurfs += 1;
      } catch (error) {
        metrics.reducerErrors += 1;
        console.error(`complete_turf failed for client ${state.index}:`, error.message);
      } finally {
        state.inFlight = false;
      }
      return;
    }
  }

  const next = nextStep(state, state.target);
  state.inFlight = true;
  try {
    if (next.arrived) {
      const status = chooseOutcome();
      await queueReducer(() =>
        state.conn.reducers.updateVoterStatus({
          voterId: state.target.id,
          status,
          volunteerId: state.volunteerId,
          lat: state.target.lat,
          lng: state.target.lng,
          donationCents:
            status === STATUS_DONATED
              ? 2500 + Math.floor(Math.random() * 17500)
              : 0,
        })
      );
      metrics.voterUpdates += 1;
      reservedVoters.delete(state.target.id);
      state.lat = state.target.lat;
      state.lng = state.target.lng;
      state.target = undefined;
      state.waypoint = undefined;
    } else {
      await queueReducer(() =>
        state.conn.reducers.updateVolunteerLocation({
          volunteerId: state.volunteerId,
          lat: next.lat,
          lng: next.lng,
          heading: next.heading,
        })
      );
      metrics.locationUpdates += 1;
      state.lat = next.lat;
      state.lng = next.lng;
    }
  } catch (error) {
    metrics.reducerErrors += 1;
    if (state.target) {
      reservedVoters.delete(state.target.id);
      state.target = undefined;
    }
    console.error(`client ${state.index} reducer failed:`, error.message);
  } finally {
    state.inFlight = false;
  }
}

function getVolunteerForClient(state) {
  const identityHex = state.identityHex;
  if (!identityHex) {
    return undefined;
  }
  refreshCoordinatorCache();
  return cache.volunteersByIdentity.get(identityHex);
}

function chooseTarget(state) {
  refreshCoordinatorCache();
  const turf = coordinator.db.turf.id.find(state.turfId);
  const route = turf?.walk_route ?? [];
  const routePoint = route.length
    ? route[state.routeIndex % route.length]
    : { lat: state.lat, lng: state.lng };
  state.routeIndex += 1;
  state.waypoint = routePoint;

  const candidates = (cache.votersByTurf.get(state.turfId) ?? []).filter(
    row => !reservedVoters.has(row.id)
  );
  if (candidates.length === 0) {
    return undefined;
  }

  candidates.sort(
    (a, b) =>
      distanceBetween(routePoint.lat, routePoint.lng, a.lat, a.lng) -
      distanceBetween(routePoint.lat, routePoint.lng, b.lat, b.lng)
  );
  const target = candidates[Math.floor(Math.random() * Math.min(16, candidates.length))];
  reservedVoters.add(target.id);
  return target;
}

function refreshCoordinatorCache() {
  const now = Date.now();
  if (now - cache.builtAt < 250) {
    return;
  }

  const votersByTurf = new Map();
  for (const row of coordinator.db.voter.iter()) {
    if (row.status !== STATUS_NOT_CONTACTED) {
      continue;
    }
    const rows = votersByTurf.get(row.turf_id) ?? [];
    rows.push(row);
    votersByTurf.set(row.turf_id, rows);
  }

  const volunteersByIdentity = new Map();
  for (const row of coordinator.db.volunteer.iter()) {
    if (!row.is_simulated) {
      volunteersByIdentity.set(identityKey(row.identity), row);
    }
  }

  cache.votersByTurf = votersByTurf;
  cache.volunteersByIdentity = volunteersByIdentity;
  cache.builtAt = now;
}

function nextStep(state, target) {
  const stepMeters = walkingStepMeters(state);
  if (state.waypoint) {
    const waypointDistance = distanceMeters(
      state.lat,
      state.lng,
      state.waypoint.lat,
      state.waypoint.lng
    );
    if (waypointDistance > stepMeters) {
      const heading = Math.atan2(
        state.waypoint.lng - state.lng,
        state.waypoint.lat - state.lat
      );
      const next = moveTowardCoordinate(
        state.lat,
        state.lng,
        state.waypoint.lat,
        state.waypoint.lng,
        stepMeters
      );
      return {
        arrived: false,
        lat: next.lat,
        lng: next.lng,
        heading,
      };
    }
    state.waypoint = undefined;
  }

  const distance = distanceMeters(state.lat, state.lng, target.lat, target.lng);
  const heading = Math.atan2(target.lng - state.lng, target.lat - state.lat);
  if (distance <= stepMeters) {
    return { arrived: true, lat: target.lat, lng: target.lng, heading };
  }
  const next = moveTowardCoordinate(
    state.lat,
    state.lng,
    target.lat,
    target.lng,
    stepMeters
  );
  return {
    arrived: false,
    lat: next.lat,
    lng: next.lng,
    heading,
  };
}

function chooseOutcome() {
  const roll = Math.random();
  if (roll < SIM_LITERATURE_RATE) {
    return STATUS_LITERATURE;
  }
  if (roll < SIM_LITERATURE_RATE + SIM_CONTACT_RATE) {
    return Math.random() < SIM_DONATION_WITHIN_CONTACT_RATE
      ? STATUS_DONATED
      : STATUS_CONTACTED;
  }
  if (roll >= 1 - SIM_REFUSED_RATE) {
    return STATUS_REFUSED;
  }
  return STATUS_REFUSED;
}

async function queueReducer(call) {
  while (reducerInFlight >= maxReducerInFlight && !shuttingDown) {
    await sleep(10);
  }
  reducerInFlight += 1;
  try {
    return await call();
  } finally {
    reducerInFlight -= 1;
  }
}

function identityKey(identity) {
  return identity?.toHexString ? identity.toHexString() : String(identity);
}

function distanceBetween(latA, lngA, latB, lngB) {
  const latDistance = latB - latA;
  const lngDistance = lngB - lngA;
  return Math.sqrt(latDistance * latDistance + lngDistance * lngDistance);
}

function distanceMeters(latA, lngA, latB, lngB) {
  const meanLatRadians = (((latA + latB) / 2) * Math.PI) / 180;
  const latDistance = (latB - latA) * METERS_PER_DEGREE_LAT;
  const lngDistance =
    (lngB - lngA) * METERS_PER_DEGREE_LAT * Math.cos(meanLatRadians);
  return Math.sqrt(latDistance * latDistance + lngDistance * lngDistance);
}

function moveTowardCoordinate(lat, lng, targetLat, targetLng, stepMeters) {
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

function walkingStepMeters(state) {
  const now = Date.now();
  const elapsedMs = state.lastStepAt
    ? Math.max(250, Math.min(5000, now - state.lastStepAt))
    : tickMs;
  state.lastStepAt = now;
  const jitter = 0.85 + Math.random() * 0.3;
  return WALKING_SPEED_MPS * (elapsedMs / 1000) * jitter;
}

function intEnv(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

process.on('SIGINT', () => {
  shuttingDown = true;
  console.log('\nDisconnecting load clients');
  for (const client of clients) {
    clearInterval(client.timer);
    try {
      client.conn?.disconnect();
    } catch {
      // Already disconnected.
    }
  }
  try {
    coordinator?.disconnect();
  } catch {
    // Already disconnected.
  }
  process.exit(0);
});
