import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';

const bash = process.env.BASH_PATH || (process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : 'bash');
const posix = path => process.platform === 'win32' ? path.replaceAll('\\', '/').replace(/^([A-Za-z]):/, (_, drive) => `/${drive.toLowerCase()}`) : path;
const backup = resolve('docs/examples/operations/backup-release.sh');
const restore = resolve('docs/examples/operations/restore-release.sh');
const docker = `#!/usr/bin/env bash
set -eu
printf '%s\\n' "$*" >> "$TEST_LOG"
case "$*" in
  *'ps -q deft'*) echo fixture-container ;;
  'inspect '*'.Mounts'*) echo fixture-uploads ;;
  'inspect '*) echo sha256:fixture ;;
  'image inspect '*) echo '["ghcr.io/maneek21/deft@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"]' ;;
  *'pg_dump'*) test "\${FAIL_DUMP:-0}" != 1 || exit 1; echo 'SELECT 1;' ;;
  *'psql -v ON_ERROR_STOP=1'*) cat > /dev/null ;;
  'exec '*'/app/apps/api/uploads'*) if [ "\${LEGACY_UPLOADS:-0}" = 1 ]; then printf present; fi ;;
  'cp '*'/app/apps/api/uploads/.'*) printf 'legacy attachment' > "\${@: -1}/legacy.txt" ;;
  *'tar -C /source'*) for mount in "$@"; do
      case "$mount" in *:/backup) tar -czf "\${mount%:/backup}/uploads.tar.gz" --files-from /dev/null ;; esac
    done ;;
esac
`;

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'deft-docs-'));
  mkdirSync(join(dir, 'bin'));
  writeFileSync(join(dir, 'bin/docker'), docker, { mode: 0o755 });
  for (const name of ['.env', 'docker-compose.yml', 'compose.prod.yml', 'compose.release.yml']) writeFileSync(join(dir, name), '# fictional test fixture\n');
  const log = join(dir, 'docker.log');
  return {
    dir,
    run(script, args = [], env = {}) {
      return spawnSync(bash, ['-c', 'export PATH="$PWD/bin:$PATH"; bash "$@"', '--', posix(script), ...args], {
        cwd: dir, encoding: 'utf8', env: { ...process.env, TEST_LOG: posix(log), ...env },
      });
    },
    log: () => readFileSync(log, 'utf8'),
    cleanup() {
      assert.equal(dirname(dir), tmpdir());
      assert(dir.startsWith(join(tmpdir(), 'deft-docs-')));
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test('normal backup resumes; upgrade backup stays stopped and retains a verifiable recovery set', () => {
  for (const args of [[], ['--leave-stopped']]) {
    const f = fixture();
    try {
      const result = f.run(backup, args);
      assert.equal(result.status, 0, result.stderr + result.stdout);
      assert(f.log().includes('stop deft'));
      assert.equal(f.log().includes('start deft'), args.length === 0);
      const folder = join(f.dir, 'backups', readdirSync(join(f.dir, 'backups'))[0]);
      const check = spawnSync(bash, ['-c', 'sha256sum -c SHA256SUMS'], { cwd: folder, encoding: 'utf8' });
      assert.equal(check.status, 0, check.stderr);
    } finally { f.cleanup(); }
  }
});

test('failed database dump leaves the app stopped and returns failure', () => {
  const f = fixture();
  try {
    const result = f.run(backup, [], { FAIL_DUMP: '1' });
    assert.notEqual(result.status, 0);
    assert(f.log().includes('stop deft'));
    assert(!f.log().includes('start deft'));
  } finally { f.cleanup(); }
});

test('backup preserves and checksums legacy container uploads', () => {
  const f = fixture();
  try {
    const result = f.run(backup, ['--leave-stopped'], { LEGACY_UPLOADS: '1' });
    assert.equal(result.status, 0, result.stderr + result.stdout);
    const recovery = join(f.dir, 'backups', readdirSync(join(f.dir, 'backups'))[0]);
    assert.equal(readFileSync(join(recovery, 'legacy-container-uploads/legacy.txt'), 'utf8'), 'legacy attachment');
    assert.match(readFileSync(join(recovery, 'SHA256SUMS'), 'utf8'), /legacy-container-uploads\/legacy.txt/);
  } finally { f.cleanup(); }
});

test('restore refuses an existing directory before starting containers', () => {
  const f = fixture();
  try {
    assert.equal(f.run(backup).status, 0);
    const recovery = join(f.dir, 'backups', readdirSync(join(f.dir, 'backups'))[0]);
    mkdirSync(join(f.dir, 'already-exists'));
    const result = f.run(restore, [], { RECOVERY: posix(recovery), DEFT_RESTORE_IMAGE: `ghcr.io/maneek21/deft@sha256:${'a'.repeat(64)}`, RESTORE_DIR: 'already-exists' });
    assert.notEqual(result.status, 0);
    assert.match(result.stdout, /RESTORE_DIR already exists/);
    assert(!f.log().includes('up -d postgres'));
  } finally { f.cleanup(); }
});

test('restore uses the chosen target, restores data, and checks services without initialization', () => {
  const f = fixture();
  try {
    assert.equal(f.run(backup, ['--leave-stopped']).status, 0);
    const recovery = join(f.dir, 'backups', readdirSync(join(f.dir, 'backups'))[0]);
    const result = f.run(restore, [], {
      RECOVERY: posix(recovery), DEFT_RESTORE_IMAGE: `ghcr.io/maneek21/deft@sha256:${'a'.repeat(64)}`,
      RESTORE_DIR: 'chosen-restore', RESTORE_PROJECT: 'chosen-project',
    });
    assert.equal(result.status, 0, result.stderr + result.stdout);
    const env = readFileSync(join(f.dir, 'chosen-restore', '.env'), 'utf8');
    assert.match(env, /COMPOSE_PROJECT_NAME=chosen-project/);
    assert.match(env, /DEFT_WEB_PORT=127\.0\.0\.1:3400/);
    const log = f.log();
    assert(log.includes('psql -v ON_ERROR_STOP=1 -U postgres deft'));
    assert(log.includes('chosen-project_uploads:/target'));
    assert(log.includes('run --rm doctor'));
    assert(log.includes('run --rm smoke'));
    assert(!log.includes('run --rm init'));
  } finally { f.cleanup(); }
});
