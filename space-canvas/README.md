# Travis County Turf Live Ops

A mini SpacetimeDB project that shows live voter-contact updates across a desktop dashboard, mobile canvassing surface, and high-volume volunteer simulator.

## Completed Status And How It Works

Completed:

- Published the TypeScript SpacetimeDB module to production database `spacecanvas-5rvak` without deleting the existing `registered_voter` source table.
- Verified `registered_voter` contains 929,802 Travis County source voter rows in production.
- Added live derived canvassing tables for `turf`, household-level `voter` knock targets, `volunteer` GPS rows, `activity_event`, `turf_stats`, and `sim_state`.
- Added contact-state columns on household targets: `status`, `last_contacted_at`, `last_contacted_by`, `attempt_count`, `donation_cents`, and `updated_seq`.
- Updated the web dashboard to Travis County, TX, with Mapbox rendering, live selected-turf household updates, active volunteer locations, aggregate turf stats, activity stream, and a neobrutalist blue UI.
- Updated the app to subscribe to selected-turf household targets instead of all voter rows, so the UI can scale beyond demo-size data.
- Built a mobile canvassing route at `/#mobile`, plus Capacitor iOS and Android shells. The mobile view claims a random turf, shares GPS, selects the nearest uncontacted household, and writes voter status through SpacetimeDB reducers.
- Built a one-button simulator UI. Pressing `Simulate` seeds 10,000 server-side simulated canvassers and runs reducer ticks that move GPS locations and mark households with the requested outcome mix: 80% literature dropped, 15% contacted/donated, and 5% refused.
- Added verification scripts for local schema/binding drift, static feature coverage, realtime smoke checks, live simulation checks, Android APK readiness, and production publish readiness.

How the production data model works:

- `registered_voter` is the immutable-ish Travis County source table. It stores voter registration metadata and raw JSON payloads.
- `voter` is now a derived household knock-target table. Multiple registered voters at the same household can collapse into one row with `registered_voter_count`, so the canvasser knocks once while stats still count all voters behind that door.
- `reset_demo_data` currently clears derived realtime tables and attempts to rebuild household targets/turfs from `registered_voter`.
- `claim_turf`, `update_volunteer_location`, `update_voter_status`, `complete_turf`, `seed_simulation`, `simulate_tick`, and `stop_simulation` are the realtime reducer surface for dashboard/mobile/simulator.
- `turf_stats` stores aggregate registered-voter counts by status so the dashboard and simulator can show county-scale progress without subscribing to every source voter.

Known incomplete work:

- Full Travis County turf materialization needs to be chunked. The first single-reducer attempt to process all 929,802 source voters hit a hosted instance fatal 530, so this must become a chunked reducer/import pipeline or an external batch job.
- The current coordinate derivation uses real payload coordinates if present, but the sampled source payloads did not include lat/lng. Until a geocoded source is added, fallback coordinates are deterministic Travis County placements based on city/zip/household.
- The README still keeps older Arlington/demo language in some lower sections for historical local fallback behavior; those docs should be cleaned up after the chunked Travis pipeline lands.
- Final end-to-end prod demo verification is not complete until derived Travis turfs are populated and the one-button simulator is run against those rows.

### Local Static Travis Turf Cut

The Travis voter CSV is intentionally local-only and ignored by git:

```text
../data/travis-county-Registered_Voter_List.csv
```

Cut turfs locally once and write the static derived artifact:

```bash
npm run materialize:travis:export
```

The local cut completed with:

```text
929,802 registered voters
493,558 household knock targets
4,664 roughly 200-voter turfs
```

The generated artifact is also ignored by git because it is large:

```text
data/travis-derived-turfs.json
```

Import that static artifact into SpacetimeDB in bounded reducer batches:

```bash
npm run materialize:travis:import
```

Or export and import in one run:

```bash
npm run materialize:travis
```

## What It Demonstrates

- SpacetimeDB as the database and backend: tables hold turf, voter, volunteer GPS, event, aggregate, and simulator state.
- Reducer-only writes: mobile and simulator clients mutate state through reducers.
- Backend reducer validation: voter updates require an active volunteer assigned to the same turf and owned by the caller identity.
- Realtime subscriptions: the React dashboard subscribes to public tables and updates the map, right-side voter stream, event log, metrics, and simulator counters as rows change.
- Installable mobile field app: open `/#mobile` on iOS or Android and install it as a PWA.
- 10,000 virtual knockers: use the simulator view or `npm run simulate` to seed and tick virtual volunteers through Arlington turfs.

## Docs Used

This was built against the current SpacetimeDB 2.0 docs:

- TypeScript quickstart: <https://spacetimedb.com/docs/quickstarts/typescript/>
- Tables and public subscriptions: <https://spacetimedb.com/docs/tables/>
- Reducers and reducer table access: <https://spacetimedb.com/docs/functions/reducers/>
- Subscriptions: <https://spacetimedb.com/docs/clients/subscriptions/>
- TypeScript SDK and React hooks: <https://spacetimedb.com/docs/clients/typescript/>
- Binding generation: <https://spacetimedb.com/docs/sdks/codegen/>

## Project Structure

```text
spacetimedb/src/index.ts       SpacetimeDB schema, seed data, reducers, simulator
src/App.tsx                    Dashboard, mobile app, simulator UI
src/module_bindings/           TypeScript client bindings mirrored from the module
scripts/simulate.mjs           Standalone high-volume simulator runner
scripts/load-volunteers.mjs    Multi-client volunteer load runner
scripts/probe-realtime.mjs     Non-mutating realtime subscription probe
scripts/spacetime-client.mjs   Shared SpacetimeDB Node client schema
public/manifest.webmanifest    Mobile PWA manifest
capacitor.config.ts            Native iOS/Android wrapper config
```

## Run Locally

Install the SpacetimeDB CLI first. The current official macOS/Linux installer is documented at <https://spacetimedb.com/install>:

```bash
curl -sSf https://install.spacetimedb.com | sh
spacetime login
cp .env.example .env.local
spacetime start
npm run spacetime:publish:local
npm run dev
```

The web app defaults its SpacetimeDB target to:

```text
VITE_SPACETIMEDB_HOST=https://maincloud.spacetimedb.com
VITE_SPACETIMEDB_DB_NAME=spacecanvas-5rvak
VITE_SPACETIMEDB_DB_ID=c20042aa1c549bd35be19e6cd55e0a32e50107aea30b6a457f6a6316c6317479
VITE_MAPBOX_TOKEN=<public Mapbox token>
```

The dashboard uses Mapbox GL for the Arlington base map and draws realtime SpacetimeDB turf, voter, and volunteer overlays above it. `VITE_MAPBOX_TOKEN` is intentionally env-only; if it is missing the app still renders the SVG turf overlay with a Mapbox-unavailable notice. Override these values when targeting maincloud, another local database, or a different Mapbox token.

Local env files such as `.env.local` are gitignored because they may contain `SPACETIMEDB_TOKEN` for the simulator or a deploy-specific Mapbox token.

When the dashboard connects to a freshly published empty database, it automatically calls the `reset_demo_data` reducer once to seed the Arlington turf/voter fixtures. Existing demos are left alone because the bootstrap only runs when turf, voter, and turf-stat subscriptions are all empty.

## Refresh Bindings

`spacetime.json` contains the current 2.0 config for the prod database, module path, and TypeScript binding output:

```json
{
  "server": "maincloud",
  "database": "spacecanvas-5rvak",
  "module-path": "./spacetimedb",
  "generate": [{ "language": "typescript", "out-dir": "./src/module_bindings" }]
}
```

The CLI was not installed in this workspace when the project was first scaffolded, so `src/module_bindings` is manually mirrored from `spacetimedb/src/index.ts`. Once the CLI is available, refresh generated bindings with:

```bash
npm run generate
```

Then rebuild:

```bash
npm run build
```

Until generated bindings can be refreshed, the local verifier compares the manual binding files against the module table and reducer schema:

```bash
npm run verify:bindings
```

Prod publish uses `spacetime.json`. The publish path follows the current CLI reference at <https://spacetimedb.com/docs/cli-reference/> and keeps `--delete-data never` on production publishes:

```bash
spacetime login
npm run verify:spacetime
npm run spacetime:publish
npm run readiness:publish
```

After the CLI is installed and logged in, the guarded one-command prod path is:

```bash
npm run publish:prod
```

That command validates `spacetime.json`, refreshes TypeScript bindings, runs local verification, publishes to `spacecanvas-5rvak` with `--delete-data never`, checks live subscriptions, runs the mutating realtime smoke test, and runs the live simulation verifier. Use `SKIP_SMOKE=1 npm run publish:prod` to skip the voter-update smoke test, or `SKIP_LIVE_SIM=1 npm run publish:prod` to skip the 10,000-volunteer live simulation check.

After the module is published, run the consolidated production demo verifier:

```bash
npm run demo:verify-prod
```

That command runs the non-mutating publish readiness probe, the mutating realtime smoke test, the live 10,000-volunteer server-side simulation verifier, and the Android device doctor. It does not install the APK unless `ANDROID_INSTALL=1` is set.

Local development uses an explicit local database and ignores the prod config:

```bash
spacetime start
npm run spacetime:dev:local
```

`npm run verify:spacetime` does not publish or mutate data. It checks whether the CLI is installed, whether Maincloud is reachable, whether the user is logged in, and whether local config still targets `spacecanvas-5rvak`. `npm run readiness:publish` is also non-mutating; it runs the CLI/login preflight plus the remote subscription probe so you can see whether `spacecanvas-5rvak` exposes the expected public tables before running the mutating smoke and load tests.

## Demo Flow

1. Open `http://localhost:5173/#dashboard`.
2. Open `http://localhost:5173/#mobile` in another browser or phone.
3. Claim a random turf in the mobile view and mark voters as Contacted, Literature Dropped, Refused, or Donated.
4. Watch the dashboard map, right rail, stats, and event log update live.
5. Open `http://localhost:5173/#simulator`, seed 10,000 simulated volunteers, and run ticks.

For the full production demo after publishing:

1. Run `npm run demo:verify-prod`.
2. Open `http://localhost:5173/#dashboard`.
3. Install the debug APK with `adb install -r android/app/build/outputs/apk/debug/app-debug.apk` or `ANDROID_INSTALL=1 npm run mobile:android:doctor`.
4. Open the Android app, claim a random turf, enable GPS, and mark a voter.
5. Confirm the dashboard map, right rail, stats, and activity log update live.
6. Optionally run `CLIENTS=10000 CONNECT_RATE_PER_SEC=250 CLIENT_TICK_MS=700 npm run simulate:clients` for the multi-client connection-pressure demo.

## Mobile App

The field app is available three ways:

- Browser/PWA: open `http://localhost:5173/#mobile` on iOS or Android and install it from the browser.
- Native iOS shell: run `npm run mobile:add:ios`, then `npm run mobile:open:ios`.
- Native Android shell: run `npm run mobile:add:android`, then `npm run mobile:open:android`.

After web changes, refresh native web assets with:

```bash
npm run mobile:sync
```

The native projects use the same built React app and SpacetimeDB reducers as the dashboard, so mobile status updates flow into the dashboard subscriptions in realtime.

The mobile field app also has an opt-in GPS control. When enabled, it sends throttled `update_volunteer_location` reducer calls so the dashboard human-volunteer marker moves live, and it uses the latest device or volunteer location to choose the nearest next door in the turf.

The nearest uncontacted door is selected by default, but the visible turf list is also actionable: tapping an uncontacted voter row makes that house the active target for the Contacted, Literature Dropped, Refused, or Donated reducer buttons.

When a volunteer finishes a turf, `complete_turf` marks that assignment inactive. The mobile app then returns to the random-turf claim flow; calling `claim_turf` again reuses and reactivates the same human volunteer row with a fresh turf assignment.

The native shells declare foreground location permissions: Android requests coarse/fine location, and iOS includes `NSLocationWhenInUseUsageDescription`.

### Android APK Testing

Build a debug APK:

```bash
npm run mobile:android:apk
```

The APK is written to:

```text
android/app/build/outputs/apk/debug/app-debug.apk
```

Install it on a connected Android device with USB debugging enabled:

```bash
adb install -r android/app/build/outputs/apk/debug/app-debug.apk
```

Or let Gradle build and install in one command:

```bash
npm run mobile:android:install
```

Check local Android readiness without installing:

```bash
npm run mobile:android:doctor
```

The doctor verifies the debug APK path, finds `adb`, reports connected devices, and prints the install command. To install through the doctor script, run:

```bash
ANDROID_INSTALL=1 npm run mobile:android:doctor
```

Before SpacetimeDB publish, the APK should launch, show the mobile canvass screen, request location permission when GPS is enabled, and display the configured-database waiting state. After SpacetimeDB publish, test the full realtime flow: open the dashboard on desktop, open the APK on Android, claim a random turf, enable GPS, mark a voter Contacted or Literature Dropped, then confirm the dashboard map, right rail, stats, and activity stream update live.

This is a debug APK for local testing, not a release-signed Play Store artifact.

Native verification commands:

```bash
cd android && ./gradlew testDebugUnitTest
plutil -lint ios/App/App/Info.plist
```

Opening or building the iOS project requires full Xcode, not only Apple's Command Line Tools.

## Simulator Modes

There are two simulator modes:

- `npm run simulate`: one coordinator client asks SpacetimeDB reducers to run server-side batch simulation. This is the fastest way to make the dashboard light up.
- `npm run simulate:clients`: one coordinator subscription watches turf/voter/volunteer state while many lightweight canvasser clients connect independently, claim turf, send GPS updates, and mark voters. This is the connection-pressure load test for the "10,000 users concurrently" demo.

The browser simulator panel shows the live observed outcome distribution beside the requested target mix: 80% literature, 15% contact/donation, and 5% refused. Donations are displayed separately as a contact subcase while still contributing to the 15% contact pool.

Run the server-batch simulator without the browser:

```bash
VOLUNTEERS=10000 BATCH_SIZE=800 TICK_MS=420 npm run simulate
```

Run the multi-client load runner:

```bash
CLIENTS=10000 CONNECT_RATE_PER_SEC=250 CLIENT_TICK_MS=700 npm run simulate:clients
```

After publishing, run the non-mutating realtime probe first. It connects to the configured SpacetimeDB database, subscribes to every public demo table, validates known voter statuses if rows exist, prints row counts, and exits without reducer calls:

```bash
npm run probe:realtime
```

Then run the mutating realtime smoke test against the live database:

```bash
npm run smoke:realtime
```

The smoke test is intentionally mutating: it subscribes to the live tables, claims a turf as a test volunteer, updates one uncontacted voter to Contacted, and waits until the subscribed voter row and activity event arrive through SpacetimeDB. Use `SMOKE_RESET=1 npm run smoke:realtime` only on a demo database when you want it to reset fixtures first.

Run the post-publish live simulation verifier:

```bash
npm run verify:live-simulation
```

This is also intentionally mutating. By default it resets demo fixtures, seeds 10,000 simulated volunteers, runs server-side `simulate_tick` reducers until subscribed voter rows and activity events change, then stops the simulation. Tune it with `LIVE_SIM_VOLUNTEERS`, `LIVE_SIM_BATCH_SIZE`, `LIVE_SIM_MAX_TICKS`, `LIVE_SIM_MIN_VOTER_UPDATES`, and `LIVE_SIM_RESET=0`.

Optional environment variables for the standalone simulator:

```text
SPACETIMEDB_HOST=https://maincloud.spacetimedb.com
SPACETIMEDB_DB_NAME=spacecanvas-5rvak
SPACETIMEDB_DB_ID=c20042aa1c549bd35be19e6cd55e0a32e50107aea30b6a457f6a6316c6317479
SPACETIMEDB_TOKEN=...
VOLUNTEERS=10000
BATCH_SIZE=800
TICK_MS=420
CLIENTS=10000
CONNECT_RATE_PER_SEC=250
CLIENT_TICK_MS=700
MAX_REDUCER_IN_FLIGHT=1200
PROBE_TIMEOUT_MS=15000
RESET_DEMO=1
SMOKE_TIMEOUT_MS=20000
SMOKE_RESET=0
```

The module seeds about 10,800 fake Arlington voter households for demos and stress runs. Both simulator modes walk volunteers through each turf's `walk_route` waypoints, choose nearby uncontacted doors around the current waypoint, and then approach the voter coordinate before submitting an outcome. Movement is meter-based at about 1.35 m/s with small jitter, so simulated GPS markers drift like walking canvassers instead of jumping fixed coordinate deltas. Outcomes are 80% literature dropped, 15% in-person contact, and 5% refused access. Donated is modeled as a subcase of successful in-person contact so the dashboard still exercises every requested voter status.

Before the module is published, verify the 10,000-knocker model locally without mutating SpacetimeDB:

```bash
npm run verify:simulation
```

Run all local checks that do not require the SpacetimeDB CLI:

```bash
npm run verify
```
