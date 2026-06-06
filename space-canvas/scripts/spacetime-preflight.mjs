import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const root = new URL('..', import.meta.url);
const read = path => readFileSync(new URL(path, root), 'utf8');

const spacetimeJson = JSON.parse(read('spacetime.json'));
const envExample = read('.env.example');
const candidates = [
  process.env.SPACETIME_CLI,
  new URL('.spacetime/spacetime', root).pathname,
  new URL('.spacetime/bin/spacetime', root).pathname,
  process.env.HOME ? `${process.env.HOME}/.local/bin/spacetime` : undefined,
  'spacetime',
].filter(Boolean);

const checks = [];
const add = (level, name, detail) => {
  checks.push({ level, name, detail });
};

const cli = candidates.find(candidate => {
  if (candidate.includes('/')) {
    if (!existsSync(candidate)) {
      return false;
    }

    const result = spawnSync(candidate, ['--version'], {
      encoding: 'utf8',
      stdio: 'pipe',
    });
    return result.status === 0;
  }

  const result = spawnSync(candidate, ['--version'], {
    encoding: 'utf8',
    stdio: 'pipe',
  });
      return result.status === 0;
});

if (
  spacetimeJson.server === 'maincloud' &&
  spacetimeJson.database === 'spacecanvas-5rvak' &&
  spacetimeJson['module-path'] === './spacetimedb' &&
  spacetimeJson.generate?.some(
    target =>
      target.language === 'typescript' &&
      target['out-dir'] === './src/module_bindings'
  )
) {
  add('PASS', 'spacetime.json prod target', 'maincloud/spacecanvas-5rvak');
} else {
  add('FAIL', 'spacetime.json prod target', 'config does not match prod database');
}

if (
  envExample.includes('VITE_SPACETIMEDB_DB_NAME=spacecanvas-5rvak') &&
  envExample.includes('SPACETIMEDB_DB_NAME=spacecanvas-5rvak')
) {
  add('PASS', 'env example prod defaults', 'web and simulator default to prod database');
} else {
  add('FAIL', 'env example prod defaults', 'missing prod database defaults');
}

if (!cli) {
  add(
    'FAIL',
    'SpacetimeDB CLI',
    'not found on PATH, .spacetime/spacetime, or .spacetime/bin/spacetime; run `curl -sSf https://install.spacetimedb.com | sh`, then `spacetime login` before publish'
  );
} else {
  const version = spawnSync(cli, ['--version'], {
    cwd: new URL('.', root),
    encoding: 'utf8',
    stdio: 'pipe',
  });
  add(
    version.status === 0 ? 'PASS' : 'FAIL',
    'SpacetimeDB CLI',
    (version.stdout || version.stderr).trim() || `exit ${version.status}`
  );

  const ping = spawnSync(cli, ['server', 'ping', 'maincloud'], {
    cwd: new URL('.', root),
    encoding: 'utf8',
    stdio: 'pipe',
  });
  add(
    ping.status === 0 ? 'PASS' : 'WARN',
    'Maincloud reachability',
    (ping.stdout || ping.stderr).trim() || `exit ${ping.status}`
  );

  const login = spawnSync(cli, ['login', 'show'], {
    cwd: new URL('.', root),
    encoding: 'utf8',
    stdio: 'pipe',
  });
  add(
    login.status === 0 ? 'PASS' : 'FAIL',
    'SpacetimeDB login',
    (login.stdout || login.stderr).trim() || 'not logged in'
  );
}

const failed = checks.filter(check => check.level === 'FAIL');
for (const check of checks) {
  console.log(`${check.level}: ${check.name} (${check.detail})`);
}

if (failed.length > 0) {
  process.exitCode = 1;
}
