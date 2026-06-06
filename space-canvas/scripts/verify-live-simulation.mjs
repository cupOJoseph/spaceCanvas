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

const host = defaultHost;
const database = defaultDatabase;
const timeoutMs = Number(process.env.LIVE_SIM_TIMEOUT_MS ?? 120000);
const volunteerCount = Number(process.env.LIVE_SIM_VOLUNTEERS ?? 10000);
const batchSize = Number(process.env.LIVE_SIM_BATCH_SIZE ?? 500);
const maxTicks = Number(process.env.LIVE_SIM_MAX_TICKS ?? 160);
const minVoterUpdates = Number(process.env.LIVE_SIM_MIN_VOTER_UPDATES ?? 10);
const resetBeforeRun = process.env.LIVE_SIM_RESET !== '0';

const expectedStatuses = new Set([
  STATUS_NOT_CONTACTED,
  STATUS_CONTACTED,
  STATUS_LITERATURE,
  STATUS_REFUSED,
  STATUS_DONATED,
]);

let coordinator;

try {
  await runLiveSimulation();
  console.log('PASS: live simulation verifier observed realtime sim updates');
} catch (error) {
  console.error(
    'FAIL: live simulation verifier failed:',
    error instanceof Error ? error.message : error
  );
  process.exitCode = 1;
} finally {
  try {
    await coordinator?.reducers.stopSimulation();
  } catch {
    // The database may be unavailable or the reducer may already be stopped.
  }
  coordinator?.disconnect();
}

async function runLiveSimulation() {
  coordinator = await connect('live-sim');
  await subscribeAll(coordinator);

  if (resetBeforeRun || coordinator.db.turf.count() === 0n) {
    console.log('Resetting demo data before live simulation verification');
    await coordinator.reducers.resetDemoData();
    await waitFor(
      () => coordinator.db.turf.count() > 0n && coordinator.db.voter.count() > 0n,
      'seeded turf and voter rows'
    );
  }

  const initialTouched = touchedVoters(coordinator);
  const initialEvents = Number(coordinator.db.activityEvent.count());

  console.log(
    `Seeding ${volunteerCount.toLocaleString()} simulated volunteers for live verification`
  );
  await coordinator.reducers.seedSimulation({ volunteerCount });
  await waitFor(
    () => simulatedVolunteers(coordinator) === volunteerCount,
    `${volunteerCount.toLocaleString()} simulated volunteer rows`
  );

  const stateAfterSeed = coordinator.db.simState.id.find(1);
  const initialTicks = Number(stateAfterSeed?.ticks ?? 0);
  let executedTicks = 0;
  let touched = initialTouched;

  for (let i = 0; i < maxTicks; i += 1) {
    await coordinator.reducers.simulateTick({ batchSize });
    executedTicks += 1;
    touched = touchedVoters(coordinator);

    if (i % 10 === 0) {
      console.log(
        `live_sim ticks=${executedTicks} touched_delta=${touched - initialTouched}`
      );
    }

    if (touched - initialTouched >= minVoterUpdates) {
      break;
    }
  }

  await waitFor(
    () => Number(coordinator.db.simState.id.find(1)?.ticks ?? 0) >= initialTicks + executedTicks,
    'sim_state tick updates'
  );

  const finalTouched = touchedVoters(coordinator);
  const finalEvents = Number(coordinator.db.activityEvent.count());
  const statusCounts = countStatuses(coordinator);
  validateStatuses(statusCounts);

  if (finalTouched - initialTouched < minVoterUpdates) {
    throw new Error(
      `Expected at least ${minVoterUpdates} simulated voter updates, saw ${
        finalTouched - initialTouched
      } after ${executedTicks} ticks`
    );
  }
  if (finalEvents <= initialEvents) {
    throw new Error('Expected simulated reducer activity events to arrive');
  }

  console.log(
    [
      `simulated=${simulatedVolunteers(coordinator).toLocaleString()}`,
      `ticks=${executedTicks}`,
      `voter_updates=${finalTouched - initialTouched}`,
      `events_delta=${finalEvents - initialEvents}`,
      `literature=${statusCounts.get(STATUS_LITERATURE) ?? 0}`,
      `contacted=${statusCounts.get(STATUS_CONTACTED) ?? 0}`,
      `refused=${statusCounts.get(STATUS_REFUSED) ?? 0}`,
      `donated=${statusCounts.get(STATUS_DONATED) ?? 0}`,
    ].join(' ')
  );
}

function connect(label) {
  return withTimeout(
    new Promise((resolve, reject) => {
      const token = process.env.SPACETIMEDB_TOKEN;
      const builder = DbConnection.builder()
        .withUri(host)
        .withDatabaseName(database)
        .onConnect(conn => {
          console.log(`${label} connected to ${host}/${database}`);
          resolve(conn);
        })
        .onConnectError((_ctx, error) => {
          reject(error);
        });

      if (token) {
        builder.withToken(token);
      }

      builder.build();
    }),
    'database connection'
  );
}

function subscribeAll(conn) {
  return withTimeout(
    new Promise((resolve, reject) => {
      conn
        .subscriptionBuilder()
        .onApplied(() => {
          resolve();
        })
        .onError((_ctx, error) => {
          reject(error);
        })
        .subscribe([
          'SELECT * FROM turf',
          'SELECT * FROM voter',
          'SELECT * FROM volunteer',
          'SELECT * FROM activity_event',
          'SELECT * FROM turf_stats',
          'SELECT * FROM sim_state',
        ]);
    }),
    'subscription hydration'
  );
}

function simulatedVolunteers(conn) {
  return Array.from(conn.db.volunteer.iter()).filter(row => row.is_simulated)
    .length;
}

function touchedVoters(conn) {
  return Array.from(conn.db.voter.iter()).filter(
    row => row.status !== STATUS_NOT_CONTACTED
  ).length;
}

function countStatuses(conn) {
  const statusCounts = new Map();
  for (const voter of conn.db.voter.iter()) {
    statusCounts.set(voter.status, (statusCounts.get(voter.status) ?? 0) + 1);
  }
  return statusCounts;
}

function validateStatuses(statusCounts) {
  for (const status of statusCounts.keys()) {
    if (!expectedStatuses.has(status)) {
      throw new Error(`Unexpected voter status from live simulation: ${status}`);
    }
  }
}

function waitFor(predicate, label) {
  const startedAt = Date.now();
  return withTimeout(
    new Promise((resolve, reject) => {
      const timer = setInterval(() => {
        const result = predicate();
        if (result) {
          clearInterval(timer);
          resolve(result);
          return;
        }

        if (Date.now() - startedAt > timeoutMs) {
          clearInterval(timer);
          reject(new Error(`Timed out waiting for ${label}`));
        }
      }, 100);
    }),
    label
  );
}

function withTimeout(promise, label) {
  let timer;
  const timeout = new Promise((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`Timed out waiting for ${label}`));
    }, timeoutMs);
  });

  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
