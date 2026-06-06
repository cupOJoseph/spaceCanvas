import { existsSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const root = new URL('..', import.meta.url);
const apkPath = new URL(
  'android/app/build/outputs/apk/debug/app-debug.apk',
  root
).pathname;
const appId = 'com.spacecanvas.fieldops';
const install = process.env.ANDROID_INSTALL === '1';
const launch = process.env.ANDROID_LAUNCH === '1';

const adb = resolveAdb();
const checks = [];

checkApk();
checkAdb();

const failed = checks.filter(check => check.level === 'FAIL');
for (const check of checks) {
  console.log(`${check.level}: ${check.name} (${check.detail})`);
}

if (failed.length > 0) {
  process.exitCode = 1;
}

function add(level, name, detail) {
  checks.push({ level, name, detail });
}

function checkApk() {
  if (!existsSync(apkPath)) {
    add(
      'FAIL',
      'debug APK',
      'missing; run `npm run mobile:android:apk` first'
    );
    return;
  }

  const sizeMb = (statSync(apkPath).size / 1024 / 1024).toFixed(1);
  add('PASS', 'debug APK', `${apkPath} (${sizeMb} MB)`);
}

function checkAdb() {
  if (!adb) {
    add(
      'FAIL',
      'adb',
      'not found; install Android platform tools or set ADB=/path/to/adb'
    );
    return;
  }

  const version = spawnSync(adb, ['version'], { encoding: 'utf8', stdio: 'pipe' });
  add(
    version.status === 0 ? 'PASS' : 'FAIL',
    'adb',
    (version.stdout || version.stderr).split('\n')[0].trim() || adb
  );

  if (version.status !== 0) {
    return;
  }

  const devices = spawnSync(adb, ['devices'], {
    encoding: 'utf8',
    stdio: 'pipe',
  });
  if (devices.status !== 0) {
    add('FAIL', 'Android devices', devices.stderr.trim() || 'adb devices failed');
    return;
  }

  const rows = devices.stdout
    .split('\n')
    .slice(1)
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => {
      const [serial, state] = line.split(/\s+/);
      return { serial, state };
    });
  const ready = rows.filter(row => row.state === 'device');
  const blocked = rows.filter(row => row.state !== 'device');

  if (ready.length === 0 && blocked.length === 0) {
    add(
      'WARN',
      'Android devices',
      'none connected; plug in a phone with USB debugging enabled'
    );
    return;
  }

  if (blocked.length > 0) {
    add(
      'WARN',
      'Android devices needing attention',
      blocked.map(row => `${row.serial}:${row.state}`).join(', ')
    );
  }

  if (ready.length === 0) {
    return;
  }

  add(
    'PASS',
    'Android devices ready',
    ready.map(row => row.serial).join(', ')
  );

  if (!install) {
    add(
      'INFO',
      'install command',
      `adb install -r ${apkPath}`
    );
    add(
      'INFO',
      'doctor install',
      'set ANDROID_INSTALL=1 to install from this script'
    );
    return;
  }

  const installResult = spawnSync(adb, ['install', '-r', apkPath], {
    encoding: 'utf8',
    stdio: 'pipe',
  });
  add(
    installResult.status === 0 ? 'PASS' : 'FAIL',
    'APK install',
    (installResult.stdout || installResult.stderr).trim() ||
      `exit ${installResult.status}`
  );

  if (launch && installResult.status === 0) {
    const launchResult = spawnSync(
      adb,
      ['shell', 'monkey', '-p', appId, '1'],
      { encoding: 'utf8', stdio: 'pipe' }
    );
    add(
      launchResult.status === 0 ? 'PASS' : 'WARN',
      'APK launch',
      (launchResult.stdout || launchResult.stderr).trim() ||
        `exit ${launchResult.status}`
    );
  }
}

function resolveAdb() {
  const candidates = [
    process.env.ADB,
    process.env.ANDROID_HOME
      ? `${process.env.ANDROID_HOME}/platform-tools/adb`
      : undefined,
    process.env.ANDROID_SDK_ROOT
      ? `${process.env.ANDROID_SDK_ROOT}/platform-tools/adb`
      : undefined,
    process.env.HOME
      ? `${process.env.HOME}/Library/Android/sdk/platform-tools/adb`
      : undefined,
    'adb',
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (candidate.includes('/') && !existsSync(candidate)) {
      continue;
    }

    const result = spawnSync(candidate, ['version'], {
      encoding: 'utf8',
      stdio: 'pipe',
    });
    if (result.status === 0) {
      return candidate;
    }
  }

  return undefined;
}
