import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { redactCommandForDisplay, redactDisplayText, redactDisplayValue, scanProject } from '../packages/core/dist/index.js';
import { DockyardDatabase, PathResolver } from '../packages/db/dist/index.js';
import { normalizeSelection } from '../apps/api/dist/native-directory-picker.service.js';
import { DatabaseSync } from 'node:sqlite';

const fixture = resolve('tests/fixtures/scannable');

test('scanner reads runnable package scripts and static PM2 literals without executing them', async () => {
  const preview = await scanProject(fixture, true);
  assert.equal(preview.applications.length, 2);
  assert.deepEqual(preview.applications.map((application) => application.origin).sort(), ['package-script', 'pm2-ecosystem']);
  const pm2 = preview.applications.find((application) => application.origin === 'pm2-ecosystem');
  const packageModule = preview.applications.find((application) => application.origin === 'package-script');
  assert.equal(pm2?.command.executable, process.execPath);
  assert.equal(pm2?.restartPolicy.mode, 'never');
  assert.match(pm2?.warnings[0]?.reason ?? '', /不受 MVP 支持/);
  assert.equal(packageModule?.name, 'scannable-fixture');
  assert.equal(packageModule?.selectedCommand, 'dev');
  assert.deepEqual(packageModule?.commandOptions.map((option) => option.name), ['dev', 'start']);
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
  const application = database.listApplications(first.project.id)[0];
  assert.ok(application);
  assert.equal(application?.selectedCommand, 'dev');
  assert.deepEqual(application?.commandOptions.map((option) => option.name), ['dev', 'start']);
  const project = database.updateProjectSettings(first.project.id, { startupApplicationIds: [application.id], restartPolicy: { mode: 'always', maxRetries: 2, retryDelayMs: 1_000, stableWindowMs: 30_000 }, logPolicy: { maxFiles: 3, maxBytesPerFile: 1_024, retentionDays: 7 } });
  assert.deepEqual(project.settings.startupApplicationIds, [application.id]);
  assert.equal(database.getApplication(application.id)?.restartPolicy.mode, 'always');
  const changed = database.updateApplicationCommand(application.id, 'start');
  assert.equal(changed.selectedCommand, 'start');
  assert.deepEqual(changed.command.args, ['run', 'start']);
  database.close();
});

test('settings are versioned and apply retention and restart presets to managed applications', async () => {
  const state = await mkdtemp(join(tmpdir(), 'dockyard-settings-test-'));
  const database = await DockyardDatabase.open(new PathResolver(state));
  const preview = await scanProject(fixture, false);
  const imported = database.importProject(preview.root, preview.projectName, preview.applications);
  const settings = database.applySettings({ retentionDays: 30, maxFiles: 9, maxBytesPerFile: 2_097_152, restartPreset: 'manual' });
  const application = database.getApplication(imported.applications[0].id);
  assert.equal(settings.version, 1);
  assert.equal(database.settings().version, 1);
  assert.deepEqual(application?.logPolicy, { retentionDays: 30, maxFiles: 9, maxBytesPerFile: 2_097_152 });
  assert.equal(application?.restartPolicy.mode, 'never');
  database.updateApplicationPolicies(imported.applications[0].id, { mode: 'always', maxRetries: 3, retryDelayMs: 2_000, stableWindowMs: 60_000 }, { retentionDays: 90, maxFiles: 12, maxBytesPerFile: 4_194_304 });
  database.importProject(preview.root, preview.projectName, preview.applications);
  assert.deepEqual(database.getApplication(imported.applications[0].id)?.restartPolicy, { mode: 'always', maxRetries: 3, retryDelayMs: 2_000, stableWindowMs: 60_000 });
  assert.deepEqual(database.getApplication(imported.applications[0].id)?.logPolicy, { retentionDays: 90, maxFiles: 12, maxBytesPerFile: 4_194_304 });
  database.recordMetric({ applicationId: imported.applications[0].id, sampledAt: '2026-08-10T00:00:00.000Z', pid: 1234, cpuPercent: 12.5, uptimeMs: 5_000, restartCount: 0, rssBytes: 1_048_576 });
  assert.deepEqual({ ...database.metrics(imported.applications[0].id, '2026-08-09T00:00:00.000Z')[0] }, { applicationId: imported.applications[0].id, sampledAt: '2026-08-10T00:00:00.000Z', pid: 1234, cpuPercent: 12.5, uptimeMs: 5_000, restartCount: 0, rssBytes: 1_048_576 });
  database.close();
});

test('native directory picker normalization preserves paths and treats cancellation as empty', () => {
  assert.equal(normalizeSelection('/Users/example/\n'), '/Users/example');
  assert.equal(normalizeSelection('/'), '/');
  assert.equal(normalizeSelection('C:\\'), 'C:\\');
  assert.equal(normalizeSelection('   '), null);
});

test('display redaction covers command flags, JSON values, and authorization headers', () => {
  assert.equal(redactDisplayText('token=abc Authorization: Bearer xyz {"secret":"keep-out"}'), 'token=[REDACTED] Authorization: Bearer [REDACTED] {"secret":[REDACTED]}');
  assert.deepEqual(redactCommandForDisplay({ executable: 'node', args: ['--api-key', 'abc', '--token=xyz', '{"password":"no"}'] }), { executable: 'node', args: ['--api-key', '[REDACTED]', '--token=[REDACTED]', '{"password":[REDACTED]}'] });
  assert.deepEqual(redactDisplayValue({ command: { token: 'abc' }, authorization: 'Bearer xyz' }), { command: { token: '[REDACTED]' }, authorization: '[REDACTED]' });
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
