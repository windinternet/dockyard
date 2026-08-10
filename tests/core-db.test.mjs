import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { scanProject } from '../packages/core/dist/index.js';
import { DockyardDatabase, PathResolver } from '../packages/db/dist/index.js';
import { normalizeSelection } from '../apps/api/dist/native-directory-picker.service.js';
import { DatabaseSync } from 'node:sqlite';

const fixture = resolve('tests/fixtures/scannable');

test('scanner reads runnable package scripts and static PM2 literals without executing them', async () => {
  const preview = await scanProject(fixture, true);
  assert.equal(preview.applications.length, 2);
  assert.deepEqual(preview.applications.map((application) => application.origin).sort(), ['package-script', 'pm2-ecosystem']);
  const pm2 = preview.applications.find((application) => application.origin === 'pm2-ecosystem');
  assert.equal(pm2?.command.executable, process.execPath);
  assert.equal(pm2?.restartPolicy.mode, 'never');
  assert.match(pm2?.warnings[0]?.reason ?? '', /不受 MVP 支持/);
});

test('database import remains idempotent by project path and application name', async () => {
  const state = await mkdtemp(join(tmpdir(), 'dockyard-db-test-'));
  const database = await DockyardDatabase.open(new PathResolver(state));
  const preview = await scanProject(fixture, false);
  const first = database.importProject(preview.root, preview.projectName, preview.applications);
  const second = database.importProject(preview.root, preview.projectName, preview.applications);
  assert.equal(database.listProjects().length, 1);
  assert.equal(first.project.id, second.project.id);
  assert.equal(database.listApplications(first.project.id).length, 1);
  database.close();
});

test('native directory picker normalization preserves paths and treats cancellation as empty', () => {
  assert.equal(normalizeSelection('/Users/example/\n'), '/Users/example');
  assert.equal(normalizeSelection('   '), null);
});

test('database upgrades the legacy local schema while preserving project and application configuration', async () => {
  const state = await mkdtemp(join(tmpdir(), 'dockyard-legacy-db-'));
  const path = join(state, 'dockyard.sqlite');
  const legacy = new DatabaseSync(path);
  legacy.exec("CREATE TABLE projects (id TEXT PRIMARY KEY, path TEXT NOT NULL UNIQUE, name TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL); CREATE TABLE applications (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, name TEXT NOT NULL, cwd TEXT NOT NULL, command TEXT NOT NULL, args_json TEXT NOT NULL DEFAULT '[]', origin TEXT NOT NULL, restart_mode TEXT NOT NULL DEFAULT 'on-failure', max_retries INTEGER NOT NULL DEFAULT 5, retry_delay_ms INTEGER NOT NULL DEFAULT 1000, stable_window_ms INTEGER NOT NULL DEFAULT 60000, log_max_files INTEGER NOT NULL DEFAULT 5, log_max_bytes_per_file INTEGER NOT NULL DEFAULT 10485760, log_retention_days INTEGER NOT NULL DEFAULT 14, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);");
  legacy.prepare('INSERT INTO projects VALUES (?, ?, ?, ?, ?)').run('project-1', '/tmp/legacy', 'Legacy', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
  legacy.prepare('INSERT INTO applications VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run('app-1', 'project-1', 'legacy:dev', '/tmp/legacy', 'pnpm', '["run","dev"]', 'package-script', 'on-failure', 5, 1000, 60000, 5, 10485760, 14, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
  legacy.close();
  const database = await DockyardDatabase.open(new PathResolver(state));
  const app = database.getApplication('app-1');
  assert.deepEqual(app?.command, { executable: 'pnpm', args: ['run', 'dev'] });
  assert.equal(database.listProjects()[0]?.name, 'Legacy');
  database.close();
});
