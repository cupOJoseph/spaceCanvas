import {
  DbConnection,
  STATUS_CONTACTED,
  STATUS_NOT_CONTACTED,
  defaultDatabase,
  defaultHost,
} from './spacetime-client.mjs';

const host = defaultHost;
const database = defaultDatabase;
const timeoutMs = Number(process.env.SMOKE_TIMEOUT_MS ?? 20000);
const resetBeforeRun = process.env.SMOKE_RESET === '1';

let coordinator;
let actor;
let actorIdentityHex = '';

try {
  await runSmoke();
  console.log('PASS: realtime SpacetimeDB smoke test observed voter update');
} catch (error) {
  console.error(
    'FAIL: realtime smoke test failed:',
    error instanceof Error ? error.message : error
  );
  process.exitCode = 1;
} finally {
  actor?.disconnect();
  coordinator?.disconnect();
}

async function runSmoke() {
  coordinator = await connect('coordinator');
  await subscribeAll(coordinator);

  if (resetBeforeRun || coordinator.db.turf.count() === 0n) {
    console.log('Seeding demo data through reset_demo_data');
    await coordinator.reducers.resetDemoData();
    await waitFor(
      () => coordinator.db.turf.count() > 0n && coordinator.db.voter.count() > 0n,
      'seeded turf and voter rows'
    );
  }

  const turf = Array.from(coordinator.db.turf.iter())[0];
  if (!turf) {
    throw new Error('No turf rows are available after subscription');
  }

  actor = await connect('actor');
  actorIdentityHex = actor.identity?.toHexString() ?? '';
  if (!actorIdentityHex) {
    throw new Error('Actor connected without an identity');
  }

  await actor.reducers.claimTurf({
    displayName: 'Realtime Smoke',
    preferredTurfId: turf.id,
  });
  const volunteer = await waitFor(
    () =>
      Array.from(coordinator.db.volunteer.iter()).find(
        row =>
          !row.is_simulated &&
          row.identity.toHexString() === actorIdentityHex &&
          row.current_turf_id === turf.id
      ),
    'claimed volunteer row'
  );

  const voter = Array.from(coordinator.db.voter.iter()).find(
    row => row.turf_id === turf.id && row.status === STATUS_NOT_CONTACTED
  );
  if (!voter) {
    throw new Error(
      'No uncontacted voter is available. Run with SMOKE_RESET=1 on a demo database.'
    );
  }

  const previousSeq = voter.updated_seq;
  await actor.reducers.updateVoterStatus({
    voterId: voter.id,
    status: STATUS_CONTACTED,
    volunteerId: volunteer.id,
    lat: voter.lat,
    lng: voter.lng,
    donationCents: 0,
  });

  await waitFor(() => {
    const updated = coordinator.db.voter.id.find(voter.id);
    return (
      updated &&
      updated.status === STATUS_CONTACTED &&
      updated.updated_seq > previousSeq &&
      updated.last_contacted_at
    );
  }, 'live voter row update');

  await waitFor(
    () =>
      Array.from(coordinator.db.activityEvent.iter()).some(
        row => row.voter_id === voter.id && row.status === STATUS_CONTACTED
      ),
    'activity event for voter update'
  );
}

function connect(label) {
  return new Promise((resolve, reject) => {
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

    if (token && label === 'coordinator') {
      builder.withToken(token);
    }

    builder.build();
  });
}

function subscribeAll(conn) {
  return new Promise((resolve, reject) => {
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
      ]);
  });
}

function waitFor(predicate, label) {
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
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
    }, 80);
  });
}
