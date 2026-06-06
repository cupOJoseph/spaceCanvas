import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

const root = new URL('..', import.meta.url);
const cwd = new URL('.', root);
const spacetimeJson = JSON.parse(
  readFileSync(new URL('spacetime.json', root), 'utf8')
);
const cliCandidates = [
  process.env.SPACETIME_CLI,
  new URL('.spacetime/spacetime', root).pathname,
  new URL('.spacetime/bin/spacetime', root).pathname,
  process.env.HOME ? `${process.env.HOME}/.local/bin/spacetime` : undefined,
  'spacetime',
].filter(Boolean);

function run(command, args, options = {}) {
  console.log(`\n$ ${[command, ...args].join(' ')}`);
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    env: process.env,
    stdio: options.capture ? 'pipe' : 'inherit',
  });

  if (result.status !== 0) {
    if (options.capture) {
      if (result.stdout) {
        process.stdout.write(result.stdout);
      }
      if (result.stderr) {
        process.stderr.write(result.stderr);
      }
    }
    throw new Error(`${command} ${args.join(' ')} failed with exit ${result.status}`);
  }

  return result;
}

function resolveCli() {
  for (const candidate of cliCandidates) {
    if (candidate.includes('/') && !existsSync(candidate)) {
      continue;
    }

    const result = spawnSync(candidate, ['--version'], {
      cwd,
      encoding: 'utf8',
      stdio: 'pipe',
    });

    if (result.status === 0) {
      console.log((result.stdout || result.stderr).trim());
      return candidate;
    }
  }

  throw new Error(
    'SpacetimeDB CLI not found. Run `curl -sSf https://install.spacetimedb.com | sh`, then `spacetime login`, or set SPACETIME_CLI to the spacetime executable.'
  );
}

function assertProdConfig() {
  const generateTarget = spacetimeJson.generate?.some(
    target =>
      target.language === 'typescript' &&
      target['out-dir'] === './src/module_bindings'
  );

  if (
    spacetimeJson.server !== 'maincloud' ||
    spacetimeJson.database !== 'spacecanvas-5rvak' ||
    spacetimeJson['module-path'] !== './spacetimedb' ||
    !generateTarget
  ) {
    throw new Error(
      'spacetime.json must target maincloud/spacecanvas-5rvak with ./spacetimedb and TypeScript bindings before publishing.'
    );
  }
}

try {
  assertProdConfig();
  const cli = resolveCli();

  run(cli, ['login', 'show']);
  run(process.execPath, ['scripts/verify-demo.mjs']);
  run(cli, [
    'generate',
    '--lang',
    'typescript',
    '--out-dir',
    'src/module_bindings',
    '--module-path',
    'spacetimedb',
  ]);
  run('npm', ['run', 'verify']);
  run(cli, [
    'publish',
    'spacecanvas-5rvak',
    '--server',
    'maincloud',
    '--module-path',
    'spacetimedb',
    '--delete-data',
    'never',
    '--yes=remote,migrate,break-clients',
  ]);
  run('npm', ['run', 'readiness:publish']);

  if (process.env.SKIP_SMOKE === '1') {
    console.log('\nSKIP_SMOKE=1 set; skipping mutating realtime smoke test.');
  } else {
    run('npm', ['run', 'smoke:realtime']);
  }

  if (process.env.SKIP_LIVE_SIM === '1') {
    console.log('\nSKIP_LIVE_SIM=1 set; skipping live simulation verification.');
  } else {
    run('npm', ['run', 'verify:live-simulation']);
  }

  console.log('\nProd publish and verification finished.');
} catch (error) {
  console.error(`\nPublish aborted: ${error.message}`);
  process.exitCode = 1;
}
