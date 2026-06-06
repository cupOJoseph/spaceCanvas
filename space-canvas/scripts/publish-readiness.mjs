import { spawnSync } from 'node:child_process';

const checks = [
  {
    name: 'local SpacetimeDB CLI and login preflight',
    script: 'scripts/spacetime-preflight.mjs',
  },
  {
    name: 'remote schema subscription probe',
    script: 'scripts/probe-realtime.mjs',
  },
];

const results = [];

for (const check of checks) {
  console.log(`\n== ${check.name} ==`);
  const result = spawnSync(process.execPath, [check.script], {
    cwd: new URL('..', import.meta.url),
    encoding: 'utf8',
    env: process.env,
    stdio: 'pipe',
  });

  if (result.stdout) {
    process.stdout.write(result.stdout);
  }
  if (result.stderr) {
    process.stderr.write(result.stderr);
  }

  results.push({
    name: check.name,
    passed: result.status === 0,
    status: result.status,
  });
}

console.log('\n== publish readiness summary ==');
for (const result of results) {
  console.log(
    `${result.passed ? 'PASS' : 'FAIL'}: ${result.name} (exit ${result.status})`
  );
}

const failed = results.filter(result => !result.passed);
if (failed.length > 0) {
  console.log(
    '\nNext step: install/login with the SpacetimeDB CLI, publish the module to spacecanvas-5rvak, then rerun this command before the mutating smoke/load tests.'
  );
  process.exitCode = 1;
} else {
  console.log(
    '\nReady for mutating verification: run npm run demo:verify-prod, or run npm run smoke:realtime followed by the simulator/load demo commands.'
  );
}
