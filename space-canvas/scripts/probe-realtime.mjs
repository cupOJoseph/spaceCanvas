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
const timeoutMs = Number(process.env.PROBE_TIMEOUT_MS ?? 15000);
const token = process.env.SPACETIMEDB_TOKEN;
const expectedStatuses = new Set([
  STATUS_NOT_CONTACTED,
  STATUS_CONTACTED,
  STATUS_LITERATURE,
  STATUS_REFUSED,
  STATUS_DONATED,
]);

let connection;

try {
  connection = await connect();
  await subscribeAll(connection);
  reportCounts(connection);
  validateSubscribedState(connection);
  console.log('PASS: realtime subscription probe completed without mutations');
} catch (error) {
  console.error(
    'FAIL: realtime subscription probe failed:',
    error instanceof Error ? error.message : error
  );
  process.exitCode = 1;
} finally {
  connection?.disconnect();
}

function connect() {
  return withTimeout(
    new Promise((resolve, reject) => {
      const builder = DbConnection.builder()
        .withUri(host)
        .withDatabaseName(database)
        .onConnect(conn => {
          console.log(`Connected to ${host}/${database}`);
          resolve(conn);
        })
        .onConnectError((_ctx, error) => {
          reject(error);
        })
        .onDisconnect((_ctx, error) => {
          if (error) {
            reject(error);
          }
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
          'SELECT * FROM registered_voter',
        ]);
    }),
    'subscription hydration'
  );
}

function reportCounts(conn) {
  const counts = {
    activityEvents: conn.db.activityEvent.count(),
    simStates: conn.db.simState.count(),
    turfStats: conn.db.turfStats.count(),
    turfs: conn.db.turf.count(),
    voters: conn.db.voter.count(),
    volunteers: conn.db.volunteer.count(),
    registeredVoters: conn.db.registeredVoter.count(),
  };

  console.log(
    [
      `turfs=${counts.turfs}`,
      `voters=${counts.voters}`,
      `volunteers=${counts.volunteers}`,
      `events=${counts.activityEvents}`,
      `stats=${counts.turfStats}`,
      `sim_state=${counts.simStates}`,
      `registered_voters=${counts.registeredVoters}`,
    ].join(' ')
  );
}

function validateSubscribedState(conn) {
  const statusCounts = new Map();
  for (const voter of conn.db.voter.iter()) {
    if (!expectedStatuses.has(voter.status)) {
      throw new Error(`Unexpected voter status from subscription: ${voter.status}`);
    }
    statusCounts.set(voter.status, (statusCounts.get(voter.status) ?? 0) + 1);
  }

  const turfs = Number(conn.db.turf.count());
  const voters = Number(conn.db.voter.count());
  if (turfs === 0 || voters === 0) {
    console.log(
      'WARN: subscribed database is empty; open the dashboard or run smoke reset to seed demo rows'
    );
    return;
  }

  const notContacted = statusCounts.get(STATUS_NOT_CONTACTED) ?? 0;
  console.log(
    `status_counts not_contacted=${notContacted} contacted=${
      statusCounts.get(STATUS_CONTACTED) ?? 0
    } literature=${statusCounts.get(STATUS_LITERATURE) ?? 0} refused=${
      statusCounts.get(STATUS_REFUSED) ?? 0
    } donated=${statusCounts.get(STATUS_DONATED) ?? 0}`
  );
}

function withTimeout(promise, label) {
  let timer;
  const timeout = new Promise((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`Timed out waiting for ${label}`));
    }, timeoutMs);
  });

  return Promise.race([promise, timeout]).finally(() => {
    clearTimeout(timer);
  });
}
