import { existsSync, readFileSync } from 'node:fs';

const root = new URL('..', import.meta.url);

const read = path => readFileSync(new URL(path, root), 'utf8');
const source = read('spacetimedb/src/index.ts');
const app = read('src/App.tsx');
const css = read('src/App.css');
const readme = read('README.md');
const scriptClient = read('scripts/spacetime-client.mjs');
const loadRunner = read('scripts/load-volunteers.mjs');
const probeRunner = read('scripts/probe-realtime.mjs');
const publishReadiness = read('scripts/publish-readiness.mjs');
const publishProd = read('scripts/publish-prod.mjs');
const verifyBindings = read('scripts/verify-bindings.mjs');
const verifySimulation = read('scripts/verify-simulation-model.mjs');
const verifyLiveSimulation = read('scripts/verify-live-simulation.mjs');
const androidDoctor = read('scripts/android-device-doctor.mjs');
const smokeRunner = read('scripts/smoke-realtime.mjs');
const manifest = JSON.parse(read('public/manifest.webmanifest'));
const packageJson = JSON.parse(read('package.json'));
const spacetimeJson = JSON.parse(read('spacetime.json'));
const capacitorConfig = read('capacitor.config.ts');
const androidManifest = read('android/app/src/main/AndroidManifest.xml');
const iosInfoPlist = read('ios/App/App/Info.plist');
const gitignore = read('.gitignore');
const envLocal = existsSync(new URL('.env.local', root))
  ? read('.env.local')
  : '';

const checks = [];
const addCheck = (name, passed, detail) => {
  checks.push({ name, passed, detail });
};

const extractNumber = name => {
  const match = source.match(new RegExp(`const ${name} = ([0-9.]+);`));
  return match ? Number(match[1]) : Number.NaN;
};

const turfCount = (source.match(/\n    id: \d+,\n    name:/g) ?? []).length;
const voterCountMatch = source.match(/const voterCount = (\d+);/);
const votersPerTurf = voterCountMatch ? Number(voterCountMatch[1]) : 0;
const seededVoters = turfCount * votersPerTurf;

const literatureRate = extractNumber('SIM_LITERATURE_RATE');
const contactRate = extractNumber('SIM_CONTACT_RATE');
const refusedRate = extractNumber('SIM_REFUSED_RATE');

addCheck(
  'seeds at least 10,000 fake voters',
  seededVoters >= 10000,
  `${turfCount} turfs x ${votersPerTurf} voters = ${seededVoters}`
);
addCheck(
  'simulator uses requested 80/15/5 outcome split',
  literatureRate === 0.8 &&
    contactRate === 0.15 &&
    refusedRate === 0.05 &&
    loadRunner.includes('SIM_LITERATURE_RATE = 0.8') &&
    loadRunner.includes('SIM_CONTACT_RATE = 0.15') &&
    loadRunner.includes('SIM_REFUSED_RATE = 0.05') &&
    Math.abs(literatureRate + contactRate + refusedRate - 1) < 0.000001,
  `literature=${literatureRate}, contact=${contactRate}, refused=${refusedRate}`
);
addCheck(
  'simulator UI displays live outcome distribution',
  app.includes('function buildOutcomeRows') &&
    app.includes('Outcome distribution') &&
    app.includes("label: 'Literature'") &&
    app.includes("label: 'Contacted'") &&
    app.includes("label: 'Refused'") &&
    app.includes("label: 'Donated'") &&
    css.includes('.outcome-panel') &&
    css.includes('.outcome-row'),
  'simulator panel shows observed literature, contact, refusal, and donation counts'
);
addCheck(
  'Node simulator scripts share one SpacetimeDB client schema',
  scriptClient.includes('export class DbConnection') &&
    scriptClient.includes("reducerSchema('update_voter_status'") &&
    read('scripts/simulate.mjs').includes("from './spacetime-client.mjs'") &&
    loadRunner.includes("from './spacetime-client.mjs'") &&
    probeRunner.includes("from './spacetime-client.mjs'") &&
    smokeRunner.includes("from './spacetime-client.mjs'"),
  'simulate, client-load, probe, and smoke scripts import shared SpacetimeDB schema'
);
addCheck(
  'simulators walk turf routes before knocking doors',
  source.includes('routeWaypointForVolunteer') &&
    source.includes('assignedTurf.walk_route') &&
    source.includes('distanceBetween(routePoint.lat, routePoint.lng') &&
    loadRunner.includes('state.waypoint') &&
    loadRunner.includes('turf?.walk_route') &&
    loadRunner.includes('waypointDistance'),
  'server-batch and client-load simulators select nearby doors from walk_route waypoints'
);
addCheck(
  'simulators move at meter-based walking speed',
  source.includes('WALKING_SPEED_MPS = 1.35') &&
    source.includes('SERVER_SIM_TICK_MS = 420') &&
    source.includes('function walkingStepMeters') &&
    source.includes('function distanceMeters') &&
    source.includes('function moveTowardCoordinate') &&
    !source.includes('const step = 0.00021') &&
    loadRunner.includes('WALKING_SPEED_MPS = 1.35') &&
    loadRunner.includes('function walkingStepMeters') &&
    loadRunner.includes('function distanceMeters') &&
    loadRunner.includes('function moveTowardCoordinate') &&
    !loadRunner.includes('const step = 0.00012'),
  'server-batch and client-load simulators convert tick cadence to walking-distance meters instead of fixed degree jumps'
);
addCheck(
  'all requested voter statuses exist',
  [
    'not_contacted',
    'contacted',
    'literature_dropped',
    'refused',
    'donated',
  ].every(status => source.includes(`'${status}'`) && app.includes(status)),
  'server and client contain Not Contacted, Contacted, Literature Dropped, Refused, Donated'
);
addCheck(
  'right rail shows status labels and last-contact times',
  app.includes('Live household updates') &&
    app.includes('className={`status-badge ${meta.tone}`}') &&
    app.includes('Last contacted {relativeTime(voter.lastContactedAt)}') &&
    app.includes('voter.registeredVoterCount') &&
    app.includes('statusMeta(voter.status).label') &&
    css.includes('.status-badge') &&
    css.includes('.voter-row-meta'),
  'dashboard household stream renders explicit status labels plus relative last-contact time for each updated target'
);
addCheck(
  'backend validates volunteer-owned reducer calls',
  source.includes('volunteerBelongsToSender') &&
    source.includes('function requireOwnedVolunteer') &&
    source.includes('function requireOwnedActiveVolunteer') &&
    source.includes('Volunteer ${volunteerId} does not exist') &&
    source.includes('Volunteer ${volunteerId} is not active') &&
    source.includes('const row = requireOwnedActiveVolunteer(ctx, volunteerId);') &&
    source.includes(': requireOwnedActiveVolunteer(ctx, volunteerId)') &&
    source.includes('const row = requireOwnedVolunteer(ctx, volunteerId);') &&
    source.includes('volunteerRow.current_turf_id !== previousTurfId') &&
    source.includes('belongs to another identity'),
  'GPS, voter status, and turf completion reject missing, inactive, wrong-turf, or non-owned volunteers as appropriate'
);
addCheck(
  'mobile app starts as installable PWA route',
  manifest.start_url === '/#mobile' && manifest.display === 'standalone',
  `start_url=${manifest.start_url}, display=${manifest.display}`
);
addCheck(
  'mobile app reports live GPS through SpacetimeDB reducers',
  app.includes('navigator.geolocation.watchPosition') &&
    app.includes('setGpsEnabled') &&
    app.includes('updateVolunteerLocation({') &&
    app.includes('distanceBetween(origin.lat, origin.lng') &&
    app.includes('Share GPS'),
  'mobile field app can opt into GPS, update volunteer location, and sort doors by current location'
);
addCheck(
  'mobile app can mark a selected house from the turf list',
  app.includes('selectedVoterId') &&
    app.includes('const activeVoter = selectedVoter ?? nextVoter') &&
    app.includes('voterId: activeVoter.id') &&
    app.includes('aria-pressed={selectedVoterId === voter.id}') &&
    app.includes('disabled={voter.status !== STATUS_NOT_CONTACTED}') &&
    css.includes('button.mobile-voter[data-selected="true"]'),
  'mobile field app keeps nearest-door default while allowing a specific uncontacted voter row to drive status reducers'
);
addCheck(
  'mobile app can claim another random turf after completion',
  app.includes('function findCurrentVolunteer') &&
    app.includes('volunteer.active &&') &&
    app.includes('Get random turf') &&
    source.includes('existing.active = true') &&
    source.includes('row.active = false'),
  'completed human volunteer rows are no longer treated as the current mobile assignment, and claim_turf reactivates them'
);
addCheck(
  'native iOS and Android wrapper is configured',
  capacitorConfig.includes("appId: 'com.spacecanvas.fieldops'") &&
    capacitorConfig.includes("webDir: 'dist'") &&
    Boolean(packageJson.scripts?.['mobile:sync']) &&
    Boolean(packageJson.scripts?.['mobile:add:ios']) &&
    Boolean(packageJson.scripts?.['mobile:add:android']) &&
    packageJson.scripts?.['mobile:android:apk']?.includes('./gradlew assembleDebug') &&
    packageJson.scripts?.['mobile:android:install']?.includes('./gradlew installDebug') &&
    packageJson.scripts?.['mobile:android:doctor'] ===
      'node scripts/android-device-doctor.mjs',
  'Capacitor config plus sync/add scripts are present'
);
addCheck(
  'Android APK test workflow is documented',
  readme.includes('### Android APK Testing') &&
    readme.includes('npm run mobile:android:apk') &&
    readme.includes('adb install -r android/app/build/outputs/apk/debug/app-debug.apk') &&
    readme.includes('npm run mobile:android:doctor') &&
    readme.includes('ANDROID_INSTALL=1 npm run mobile:android:doctor') &&
    readme.includes('Before SpacetimeDB publish') &&
    readme.includes('After SpacetimeDB publish') &&
    readme.includes('debug APK for local testing'),
  'README includes build, install, offline, and live-realtime APK test steps'
);
addCheck(
  'Android device doctor checks APK and adb state',
  androidDoctor.includes('android/app/build/outputs/apk/debug/app-debug.apk') &&
    androidDoctor.includes("spawnSync(adb, ['devices']") &&
    androidDoctor.includes('ANDROID_INSTALL') &&
    androidDoctor.includes("['install', '-r', apkPath]") &&
    androidDoctor.includes('USB debugging enabled'),
  'doctor script reports APK, adb, connected devices, and optional install'
);
addCheck(
  'native iOS and Android projects contain synced web assets',
  existsSync(new URL('ios/App/App/public/index.html', root)) &&
    existsSync(new URL('android/app/src/main/assets/public/index.html', root)) &&
    existsSync(new URL('ios/App/App.xcodeproj/project.pbxproj', root)) &&
    existsSync(
      new URL(
        'android/app/src/main/java/com/spacecanvas/fieldops/MainActivity.java',
        root
      )
    ),
  'iOS and Android project files plus copied index.html are present'
);
addCheck(
  'native iOS and Android shells request foreground location permission',
  androidManifest.includes('android.permission.ACCESS_COARSE_LOCATION') &&
    androidManifest.includes('android.permission.ACCESS_FINE_LOCATION') &&
    iosInfoPlist.includes('NSLocationWhenInUseUsageDescription') &&
    iosInfoPlist.includes('live volunteer marker'),
  'Android coarse/fine location and iOS when-in-use usage string are present'
);
addCheck(
  'Mapbox token is configurable',
  app.includes('VITE_MAPBOX_TOKEN') &&
    read('.env.example').includes('VITE_MAPBOX_TOKEN=') &&
    !app.includes('pk.eyJ') &&
    gitignore.includes('.env.local'),
  'VITE_MAPBOX_TOKEN present in env files, source has no embedded token, and local env files are ignored'
);
addCheck(
  'local runtime env targets provided prod database',
  !envLocal ||
    (envLocal.includes('VITE_SPACETIMEDB_DB_NAME=spacecanvas-5rvak') &&
      envLocal.includes(
        'VITE_SPACETIMEDB_DB_ID=c20042aa1c549bd35be19e6cd55e0a32e50107aea30b6a457f6a6316c6317479'
      )),
  envLocal
    ? 'local Vite env points at spacecanvas-5rvak'
    : 'no local env override present'
);
addCheck(
  'dashboard bootstraps empty published databases',
  app.includes('bootstrapAttemptedRef') &&
    app.includes('resetDemoData().catch') &&
    app.includes('turfs.length > 0') &&
    app.includes('voters.length > 0') &&
    app.includes('stats.length > 0'),
  'dashboard calls resetDemoData only when subscribed demo tables are empty'
);
addCheck(
  'dashboard surfaces stalled subscription/schema state',
  app.includes('subscriptionWaitMs') &&
    app.includes('subscriptionStalled') &&
    app.includes('Travis turf subscriptions have not') &&
    app.includes('Publish the module schema to spacecanvas-5rvak'),
  'dashboard distinguishes an active socket from missing or stalled public table subscriptions'
);
addCheck(
  'reducer action failures are visible in the app',
  app.includes('actionError') &&
    app.includes('notice-action') &&
    app.includes('formatError') &&
    app.includes('onActionError') &&
    app.includes("onActionError('Simulate'") &&
    app.includes("onActionError('Mobile voter update'") &&
    app.includes("onActionError('Map voter update'"),
  'dashboard, map, mobile, and simulator reducer calls report failures through a dismissible notice'
);
addCheck(
  'dashboard surfaces live subscription telemetry',
  app.includes('function LiveTelemetry') &&
    app.includes('function buildLiveTelemetry') &&
    app.includes('writesLastMinute') &&
    app.includes('activeGpsRows') &&
    app.includes('subscribedRows') &&
    css.includes('.live-telemetry') &&
    css.includes('@keyframes pulse-dot'),
  'dashboard shows write velocity, GPS row freshness, subscribed row count, and a live pulse animation'
);
addCheck(
  'simulator and SpacetimeDB scripts exist',
  Boolean(packageJson.scripts?.simulate) &&
    Boolean(packageJson.scripts?.['simulate:clients']) &&
    Boolean(packageJson.scripts?.['probe:realtime']) &&
    Boolean(packageJson.scripts?.['smoke:realtime']) &&
    Boolean(packageJson.scripts?.['verify:live-simulation']) &&
    Boolean(packageJson.scripts?.['readiness:publish']) &&
    Boolean(packageJson.scripts?.['publish:prod']) &&
    Boolean(packageJson.scripts?.['demo:verify-prod']) &&
    Boolean(packageJson.scripts?.['verify:bindings']) &&
    Boolean(packageJson.scripts?.['verify:simulation']) &&
    Boolean(packageJson.scripts?.['verify:spacetime']) &&
    Boolean(packageJson.scripts?.['spacetime:publish:local']) &&
    Boolean(packageJson.scripts?.['spacetime:publish']) &&
    Boolean(packageJson.scripts?.['spacetime:dev:local']) &&
    Boolean(packageJson.scripts?.generate),
  'server-batch simulate, client-load simulate, realtime probe, realtime smoke, live simulation verifier, binding drift check, offline simulation check, publish readiness, prod publish, preflight, publish, local dev, local publish, and generate scripts are configured'
);
addCheck(
  'post-publish demo verifier ties live checks together',
  packageJson.scripts?.['demo:verify-prod'] ===
    'npm run readiness:publish && npm run smoke:realtime && npm run verify:live-simulation && npm run mobile:android:doctor' &&
    readme.includes('npm run demo:verify-prod') &&
    readme.includes('live 10,000-volunteer server-side simulation verifier') &&
    readme.includes('ANDROID_INSTALL=1') &&
    readme.includes('simulate:clients'),
  'single command covers readiness, realtime smoke, live sim, and Android device readiness after publish'
);
addCheck(
  'manual TypeScript bindings are checked against module schema',
  verifyBindings.includes('ts.createSourceFile') &&
    verifyBindings.includes('moduleTables') &&
    verifyBindings.includes('moduleReducers') &&
    verifyBindings.includes('compareFieldMaps') &&
    packageJson.scripts?.verify?.includes('npm run verify:bindings'),
  'verify:bindings compares module table/reducer fields against src/module_bindings until CLI generation is available'
);
addCheck(
  '10,000-knocker model is locally verifiable before publish',
  verifySimulation.includes('const volunteerCount = Number(process.env.CLIENTS ?? 10000)') &&
    verifySimulation.includes('TURF_FIXTURES') &&
    verifySimulation.includes('outcome model matches requested 80/15/5 split') &&
    verifySimulation.includes('walkers move along route waypoints before doors') &&
    packageJson.scripts?.verify?.includes('npm run verify:simulation'),
  'verify:simulation recreates seeded voters, assigns 10,000 virtual walkers, checks route-first walking, and validates outcome rates without mutating SpacetimeDB'
);
addCheck(
  'publish readiness combines CLI and remote schema checks',
  publishReadiness.includes('scripts/spacetime-preflight.mjs') &&
    publishReadiness.includes('scripts/probe-realtime.mjs') &&
    publishReadiness.includes('publish readiness summary') &&
    publishReadiness.includes('Ready for mutating verification') &&
    packageJson.scripts?.['readiness:publish'] ===
      'node scripts/publish-readiness.mjs',
  'readiness command runs local CLI/login preflight plus read-only remote subscription probe before smoke/load tests'
);
addCheck(
  'prod publish wrapper avoids destructive data deletion',
  publishProd.includes("'--delete-data=never'") &&
    publishProd.includes('run(cli, [') &&
    publishProd.includes("'publish'") &&
    publishProd.includes("'spacecanvas-5rvak'") &&
    publishProd.includes("run('npm', ['run', 'readiness:publish'])") &&
    publishProd.includes("run('npm', ['run', 'smoke:realtime'])") &&
    publishProd.includes("run('npm', ['run', 'verify:live-simulation'])"),
  'publish:prod generates bindings, publishes to spacecanvas-5rvak without deleting data, then runs readiness, realtime smoke, and live simulation checks'
);
addCheck(
  'post-publish live simulation verifier exercises 10,000 simulated volunteers',
  verifyLiveSimulation.includes('LIVE_SIM_VOLUNTEERS ?? 10000') &&
    verifyLiveSimulation.includes('seedSimulation({ volunteerCount })') &&
    verifyLiveSimulation.includes('simulateTick({ batchSize })') &&
    verifyLiveSimulation.includes('touchedVoters') &&
    verifyLiveSimulation.includes('activity_event') &&
    verifyLiveSimulation.includes('stopSimulation') &&
    packageJson.scripts?.verify?.includes('node --check scripts/verify-live-simulation.mjs'),
  'verify:live-simulation mutates a published demo database, observes subscribed sim rows/events, and stops the simulator'
);
addCheck(
  'non-mutating realtime probe exercises subscriptions',
  probeRunner.includes('SELECT * FROM turf') &&
    probeRunner.includes('SELECT * FROM voter') &&
    probeRunner.includes('SELECT * FROM volunteer') &&
    probeRunner.includes('SELECT * FROM activity_event') &&
    probeRunner.includes('SELECT * FROM turf_stats') &&
    probeRunner.includes('SELECT * FROM sim_state') &&
    probeRunner.includes('SELECT * FROM registered_voter') &&
    probeRunner.includes('registeredVoter.count()') &&
    !probeRunner.includes('.reducers.'),
  'probe connects, subscribes to all public demo tables, validates statuses, and performs no reducer calls'
);
addCheck(
  'realtime smoke test exercises subscriptions and reducers',
  smokeRunner.includes('SELECT * FROM voter') &&
    smokeRunner.includes('claimTurf') &&
    smokeRunner.includes('updateVoterStatus') &&
    smokeRunner.includes('updated.status === STATUS_CONTACTED') &&
    smokeRunner.includes('activityEvent'),
  'smoke script subscribes, claims turf, updates a voter, and waits for live activity'
);
addCheck(
  'client load runner models concurrent canvasser connections',
  loadRunner.includes('CLIENTS') &&
    loadRunner.includes('connectRatePerSecond') &&
    loadRunner.includes('claimTurf') &&
    loadRunner.includes('updateVolunteerLocation') &&
    loadRunner.includes('updateVoterStatus') &&
    loadRunner.includes('SELECT * FROM voter'),
  'load runner creates many clients, subscribes coordinator state, moves GPS, and updates voters'
);
addCheck(
  'spacetime.json targets provided prod database and generated bindings',
  spacetimeJson.server === 'maincloud' &&
    spacetimeJson.database === 'spacecanvas-5rvak' &&
    spacetimeJson['module-path'] === './spacetimedb' &&
    spacetimeJson.generate?.some(
      target =>
        target.language === 'typescript' &&
        target['out-dir'] === './src/module_bindings'
    ),
  `server=${spacetimeJson.server}, database=${spacetimeJson.database}`
);
addCheck(
  'project contains local SpacetimeDB module',
  existsSync(new URL('spacetimedb/src/index.ts', root)) &&
    existsSync(new URL('src/module_bindings/index.ts', root)),
  'module source and TypeScript bindings are present'
);

const failed = checks.filter(check => !check.passed);
for (const check of checks) {
  const prefix = check.passed ? 'PASS' : 'FAIL';
  console.log(`${prefix}: ${check.name} (${check.detail})`);
}

if (failed.length > 0) {
  process.exitCode = 1;
}
