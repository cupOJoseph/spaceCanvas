import {
  DbConnection,
  defaultDatabase,
  defaultHost,
} from './spacetime-client.mjs';

const host = defaultHost;
const database = defaultDatabase;
const volunteers = Number(process.env.VOLUNTEERS ?? 10000);
const batchSize = Number(process.env.BATCH_SIZE ?? 800);
const tickMs = Number(process.env.TICK_MS ?? 420);
const token = process.env.SPACETIMEDB_TOKEN;

let tick = 0;
let inFlight = false;

const builder = DbConnection.builder()
  .withUri(host)
  .withDatabaseName(database)
  .onConnect(async conn => {
    console.log(`Connected to ${host}/${database}`);
    console.log(`Seeding ${volunteers.toLocaleString()} simulated volunteers`);
    await conn.reducers.seedSimulation({ volunteerCount: volunteers });
    console.log(`Running simulation: batch=${batchSize}, interval=${tickMs}ms`);
    setInterval(() => {
      if (inFlight) {
        return;
      }
      inFlight = true;
      conn.reducers
        .simulateTick({ batchSize })
        .then(() => {
          tick += 1;
          if (tick % 10 === 0) {
            console.log(`simulate_tick x${tick}`);
          }
        })
        .catch(error => {
          console.error('simulate_tick failed:', error);
        })
        .finally(() => {
          inFlight = false;
        });
    }, tickMs);
  })
  .onDisconnect((_ctx, error) => {
    console.log('Disconnected from SpacetimeDB', error?.message ?? '');
  })
  .onConnectError((_ctx, error) => {
    console.error('Could not connect to SpacetimeDB:', error.message);
  });

if (token) {
  builder.withToken(token);
}

const connection = builder.build();

process.on('SIGINT', async () => {
  console.log('\nStopping simulation');
  try {
    await connection.reducers.stopSimulation();
  } finally {
    connection.disconnect();
    process.exit(0);
  }
});
