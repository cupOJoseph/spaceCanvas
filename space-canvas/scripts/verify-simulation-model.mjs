import { readFileSync } from 'node:fs';
import ts from 'typescript';

const root = new URL('..', import.meta.url);
const modulePath = new URL('spacetimedb/src/index.ts', root);
const source = readFileSync(modulePath, 'utf8');
const ast = ts.createSourceFile(
  modulePath.pathname,
  source,
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TS
);

const checks = [];
const add = (name, passed, detail) => checks.push({ name, passed, detail });

const turfFixtures = evaluateConst('TURF_FIXTURES');
const householdNames = evaluateConst('HOUSEHOLD_NAMES');
const streetNames = evaluateConst('STREET_NAMES');
const literatureRate = numberConst('SIM_LITERATURE_RATE');
const contactRate = numberConst('SIM_CONTACT_RATE');
const refusedRate = numberConst('SIM_REFUSED_RATE');
const donationWithinContactRate = numberConst('SIM_DONATION_WITHIN_CONTACT_RATE');
const walkingSpeedMps = numberConst('WALKING_SPEED_MPS');
const voterCount = Number(source.match(/const voterCount = (\d+);/)?.[1] ?? 0);
const tickMs = Number(process.env.CLIENT_TICK_MS ?? 700);
const volunteerCount = Number(process.env.CLIENTS ?? 10000);
const outcomeTrials = Number(process.env.SIM_VERIFY_OUTCOMES ?? 100000);
const metersPerDegreeLat = 111320;

const voters = seedVoters();
const votersByTurf = groupBy(voters, voter => voter.turf_id);
const reservedVoters = new Set();
const walkerStats = verifyWalkers();
const outcomeStats = verifyOutcomes();

add(
  'offline model uses module turf fixtures',
  turfFixtures.length === 6 && turfFixtures.every(turf => turf.walk_route.length >= 6),
  `${turfFixtures.length} turfs, route lengths ${turfFixtures
    .map(turf => turf.walk_route.length)
    .join('/')}`
);
add(
  'offline model recreates seeded voter volume',
  voters.length >= 10000,
  `${voters.length} voters from ${turfFixtures.length} turfs x ${voterCount}`
);
add(
  '10,000 walker assignment can reserve unique targets',
  walkerStats.uniqueTargets === volunteerCount &&
    walkerStats.missingTargets === 0 &&
    walkerStats.perTurf.every(row => row.targets > 0),
  `uniqueTargets=${walkerStats.uniqueTargets}, missingTargets=${walkerStats.missingTargets}, perTurf=${walkerStats.perTurf
    .map(row => `${row.turf}:${row.targets}`)
    .join(',')}`
);
add(
  'walkers move along route waypoints before doors',
  walkerStats.routeMoves >= Math.floor(volunteerCount * 0.8),
  `routeMoves=${walkerStats.routeMoves}, targetMoves=${walkerStats.targetMoves}`
);
add(
  'walking steps stay bounded by meter-based speed',
  walkerStats.maxStepMeters <= walkerStats.allowedStepMeters + 0.001 &&
    walkerStats.progressFailures === 0,
  `maxStep=${walkerStats.maxStepMeters.toFixed(3)}m, allowed=${walkerStats.allowedStepMeters.toFixed(3)}m, progressFailures=${walkerStats.progressFailures}`
);
add(
  'outcome model matches requested 80/15/5 split',
  within(outcomeStats.literatureRate, literatureRate, 0.006) &&
    within(outcomeStats.contactPoolRate, contactRate, 0.004) &&
    within(outcomeStats.refusedRate, refusedRate, 0.003),
  `literature=${percent(outcomeStats.literatureRate)}, contactPool=${percent(
    outcomeStats.contactPoolRate
  )}, refused=${percent(outcomeStats.refusedRate)}`
);
add(
  'donations remain a contact subcase',
  within(
    outcomeStats.donatedRate,
    contactRate * donationWithinContactRate,
    0.003
  ),
  `donated=${percent(outcomeStats.donatedRate)}, expected=${percent(
    contactRate * donationWithinContactRate
  )}`
);

const failed = checks.filter(check => !check.passed);
for (const check of checks) {
  console.log(
    `${check.passed ? 'PASS' : 'FAIL'}: ${check.name} (${check.detail})`
  );
}

if (failed.length > 0) {
  process.exitCode = 1;
}

function verifyWalkers() {
  const allowedStepMeters = walkingSpeedMps * (tickMs / 1000) * 1.15;
  let routeMoves = 0;
  let targetMoves = 0;
  let missingTargets = 0;
  let maxStepMeters = 0;
  let progressFailures = 0;
  const targetsByTurf = new Map();

  for (let index = 0; index < volunteerCount; index += 1) {
    const turf = turfFixtures[index % turfFixtures.length];
    const start = turf.walk_route[0] ?? {
      lat: turf.center_lat,
      lng: turf.center_lng,
    };
    const waypoint = turf.walk_route[(index % 12) % turf.walk_route.length] ?? start;
    const target = chooseTarget(turf.id, waypoint);
    if (!target) {
      missingTargets += 1;
      continue;
    }

    targetsByTurf.set(turf.id, (targetsByTurf.get(turf.id) ?? 0) + 1);
    const waypointDistanceBefore = distanceMeters(
      start.lat,
      start.lng,
      waypoint.lat,
      waypoint.lng
    );
    const destination =
      waypointDistanceBefore > allowedStepMeters ? waypoint : target;
    const destinationDistanceBefore = distanceMeters(
      start.lat,
      start.lng,
      destination.lat,
      destination.lng
    );
    const next = moveTowardCoordinate(
      start.lat,
      start.lng,
      destination.lat,
      destination.lng,
      allowedStepMeters
    );
    const stepDistance = distanceMeters(start.lat, start.lng, next.lat, next.lng);
    const destinationDistanceAfter = distanceMeters(
      next.lat,
      next.lng,
      destination.lat,
      destination.lng
    );

    maxStepMeters = Math.max(maxStepMeters, stepDistance);
    if (destinationDistanceAfter > destinationDistanceBefore + 0.000001) {
      progressFailures += 1;
    }

    if (destination === waypoint) {
      routeMoves += 1;
    } else {
      targetMoves += 1;
    }
  }

  return {
    allowedStepMeters,
    maxStepMeters,
    missingTargets,
    perTurf: turfFixtures.map(turf => ({
      targets: targetsByTurf.get(turf.id) ?? 0,
      turf: turf.id,
    })),
    progressFailures,
    routeMoves,
    targetMoves,
    uniqueTargets: reservedVoters.size,
  };
}

function verifyOutcomes() {
  const rng = mulberry32(0x5eed1234);
  const counts = {
    contacted: 0,
    donated: 0,
    literature: 0,
    refused: 0,
  };

  for (let i = 0; i < outcomeTrials; i += 1) {
    const status = chooseOutcome(rng);
    counts[status] += 1;
  }

  return {
    contactPoolRate: (counts.contacted + counts.donated) / outcomeTrials,
    donatedRate: counts.donated / outcomeTrials,
    literatureRate: counts.literature / outcomeTrials,
    refusedRate: counts.refused / outcomeTrials,
  };
}

function chooseTarget(turfId, routePoint) {
  const candidates = (votersByTurf.get(turfId) ?? [])
    .filter(voter => !reservedVoters.has(voter.id))
    .sort(
      (a, b) =>
        distanceBetween(routePoint.lat, routePoint.lng, a.lat, a.lng) -
        distanceBetween(routePoint.lat, routePoint.lng, b.lat, b.lng)
    );

  const target = candidates[0];
  if (target) {
    reservedVoters.add(target.id);
  }
  return target;
}

function chooseOutcome(rng) {
  const roll = rng();
  if (roll < literatureRate) {
    return 'literature';
  }
  if (roll < literatureRate + contactRate) {
    return rng() < donationWithinContactRate ? 'donated' : 'contacted';
  }
  if (roll >= 1 - refusedRate) {
    return 'refused';
  }
  return 'refused';
}

function seedVoters() {
  const seeded = [];
  for (const turf of turfFixtures) {
    const boundary = turf.boundary;
    const route = turf.walk_route;
    for (let i = 0; i < voterCount; i += 1) {
      const routePoint = route[i % route.length];
      const jitterLat = (((i * 17) % 101) - 50) * 0.000055;
      const jitterLng = (((i * 29) % 113) - 56) * 0.000057;
      const lat = clamp(
        routePoint.lat + jitterLat,
        Math.min(...boundary.map(point => point.lat)) + 0.0004,
        Math.max(...boundary.map(point => point.lat)) - 0.0004
      );
      const lng = clamp(
        routePoint.lng + jitterLng,
        Math.min(...boundary.map(point => point.lng)) + 0.0004,
        Math.max(...boundary.map(point => point.lng)) - 0.0004
      );
      seeded.push({
        address: `${1200 + turf.id * 100 + i} ${
          streetNames[(i + turf.id * 2) % streetNames.length]
        }`,
        household_name: `${
          householdNames[(i + turf.id) % householdNames.length]
        } household`,
        id: turf.id * 100000 + i + 1,
        lat,
        lng,
        turf_id: turf.id,
      });
    }
  }
  return seeded;
}

function evaluateConst(name) {
  const initializer = findConstInitializer(name);
  if (!initializer) {
    throw new Error(`Could not find ${name}`);
  }
  return evaluateNode(initializer);
}

function numberConst(name) {
  const initializer = findConstInitializer(name);
  if (!initializer || !ts.isNumericLiteral(initializer)) {
    throw new Error(`Could not find numeric const ${name}`);
  }
  return Number(initializer.text);
}

function findConstInitializer(name) {
  let initializer;
  function walk(node) {
    if (initializer) {
      return;
    }
    if (ts.isVariableStatement(node)) {
      for (const declaration of node.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name) && declaration.name.text === name) {
          initializer = declaration.initializer;
          return;
        }
      }
    }
    ts.forEachChild(node, walk);
  }
  walk(ast);
  return initializer;
}

function evaluateNode(node) {
  if (ts.isNumericLiteral(node)) {
    return Number(node.text);
  }
  if (
    ts.isPrefixUnaryExpression(node) &&
    node.operator === ts.SyntaxKind.MinusToken &&
    ts.isNumericLiteral(node.operand)
  ) {
    return -Number(node.operand.text);
  }
  if (ts.isStringLiteral(node)) {
    return node.text;
  }
  if (ts.isArrayLiteralExpression(node)) {
    return node.elements.map(evaluateNode);
  }
  if (ts.isObjectLiteralExpression(node)) {
    const object = {};
    for (const property of node.properties) {
      if (!ts.isPropertyAssignment(property)) {
        continue;
      }
      object[propertyName(property.name)] = evaluateNode(property.initializer);
    }
    return object;
  }
  throw new Error(`Unsupported literal in model verifier: ${node.getText(ast)}`);
}

function propertyName(node) {
  if (ts.isIdentifier(node) || ts.isStringLiteral(node)) {
    return node.text;
  }
  throw new Error(`Unsupported property name: ${node.getText(ast)}`);
}

function groupBy(values, keyFn) {
  const map = new Map();
  for (const value of values) {
    const key = keyFn(value);
    const rows = map.get(key) ?? [];
    rows.push(value);
    map.set(key, rows);
  }
  return map;
}

function distanceBetween(latA, lngA, latB, lngB) {
  const latDistance = latB - latA;
  const lngDistance = lngB - lngA;
  return Math.sqrt(latDistance * latDistance + lngDistance * lngDistance);
}

function distanceMeters(latA, lngA, latB, lngB) {
  const meanLatRadians = (((latA + latB) / 2) * Math.PI) / 180;
  const latDistance = (latB - latA) * metersPerDegreeLat;
  const lngDistance =
    (lngB - lngA) * metersPerDegreeLat * Math.cos(meanLatRadians);
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

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function within(actual, expected, tolerance) {
  return Math.abs(actual - expected) <= tolerance;
}

function percent(value) {
  return `${(value * 100).toFixed(2)}%`;
}

function mulberry32(seed) {
  return () => {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
