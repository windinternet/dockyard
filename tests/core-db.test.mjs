import assert from 'node:assert/strict';
import { appendFile, mkdtemp } from 'node:fs/promises';
import { closeSync, openSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { redactCommandForDisplay, redactDisplayText, redactDisplayValue, scanProject } from '../packages/core/dist/index.js';
import { DockyardDatabase, PathResolver } from '../packages/db/dist/index.js';
import { normalizeSelection } from '../apps/api/dist/native-directory-picker.service.js';
import { ProjectService } from '../apps/api/dist/project.service.js';
import { externalLogFilesFromDescriptors, matchingProcesses, parseProcessTable, readLogTail, RuntimeService, sameProcessIdentity, selectObservedProcess } from '../apps/api/dist/runtime.service.js';
import { runtimeEvent } from '../apps/api/dist/applications.controller.js';
import { DatabaseSync } from 'node:sqlite';

const fixture = resolve('tests/fixtures/scannable');
const monorepoFixture = resolve('tests/fixtures/monorepo');

test('runtime SSE emits named events so subscribed UI handlers receive metrics', () => {
  const event = runtimeEvent({ type: 'metric', metric: { applicationId: 'app-1', sampledAt: '2026-08-11T00:00:00.000Z', pid: 1, cpuPercent: 0, uptimeMs: 1, restartCount: 0, rssBytes: 1 } });
  assert.equal(event.type, 'metric');
});

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

test('scanner imports each runnable workspace module once and excludes workspace orchestration scripts', async () => {
  const preview = await scanProject(monorepoFixture, false);
  assert.deepEqual(preview.applications.map((application) => application.name), ['service']);
  assert.deepEqual(preview.applications[0]?.commandOptions.map((option) => option.name), ['dev', 'start']);
  assert.equal(preview.applications[0]?.selectedCommand, 'dev');
  assert.deepEqual(preview.projectEntrypointOptions.map((option) => option.name), ['dev']);
  assert.equal(preview.selectedProjectEntrypoint, 'dev');
});

test('project startup preferences preserve a selected workspace root entrypoint', async () => {
  const state = await mkdtemp(join(tmpdir(), 'dockyard-entrypoint-test-'));
  const database = await DockyardDatabase.open(new PathResolver(state));
  const preview = await scanProject(monorepoFixture, false);
  const imported = database.importProject(preview.root, preview.projectName, preview.applications, preview.projectEntrypointOptions, preview.selectedProjectEntrypoint);
  const settings = database.updateProjectSettings(imported.project.id, { ...imported.project.settings, startupPreference: 'project-first' });
  assert.equal(settings.settings.startupPreference, 'project-first');
  assert.equal(settings.settings.selectedProjectEntrypoint, 'dev');
  assert.deepEqual(settings.settings.projectEntrypointOptions.map((option) => option.command.args), [['run', 'dev']]);
  database.close();
});

test('project scan marks previously imported modules absent from the new candidates as stale', async () => {
  const state = await mkdtemp(join(tmpdir(), 'dockyard-stale-test-'));
  const database = await DockyardDatabase.open(new PathResolver(state));
  const preview = await scanProject(monorepoFixture, false);
  const stale = { ...preview.applications[0], key: `script:${join(monorepoFixture, 'packages/build-only')}`, name: 'build-only', cwd: join(monorepoFixture, 'packages/build-only') };
  database.importProject(preview.root, preview.projectName, [...preview.applications, stale]);
  const service = new ProjectService({ db: database }, {});
  const result = await service.scan({ path: monorepoFixture, includePm2: false });
  assert.deepEqual(result.staleApplications.map((application) => application.name), ['build-only']);
  database.close();
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
  assert.equal(project.settings.restartPolicy.mode, 'always');
  assert.equal(database.getApplication(application.id)?.restartPolicy.mode, 'on-failure');
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
  database.recordMetric({ applicationId: imported.applications[0].id, sampledAt: '2026-08-11T00:00:00.000Z', pid: 1234, cpuPercent: 13, uptimeMs: 6_000, restartCount: 0, rssBytes: 1_048_576 });
  assert.equal(database.metrics(imported.applications[0].id, '2026-08-09T00:00:00.000Z', 1).length, 1);
  assert.equal(database.pruneMetrics(1, Date.parse('2026-08-12T12:00:00.000Z')), 2);
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

test('external process discovery matches an imported application by cwd and prefers its listening process', () => {
  const now = Date.UTC(2026, 7, 11, 12, 0, 0);
  const processes = parseProcessTable(' 101 1 00:02:00 node /workspace/demo/node_modules/.bin/vite\n 102 101 01:02:03 node server.js\n 103 1 00:01:00 node /workspace/other/server.js', now).map((process) => process.pid === 101 || process.pid === 102 ? { ...process, cwd: '/workspace/demo' } : { ...process, cwd: '/workspace/other' });
  const matches = matchingProcesses({ cwd: '/workspace/demo' }, processes);
  const observed = selectObservedProcess(matches, new Map([[101, []], [102, [4318, 5173]]]));
  assert.deepEqual(matches.map((process) => process.pid), [101, 102]);
  assert.deepEqual(observed, { pid: 102, startedAt: now - 3_723_000, listeningPorts: [4318, 5173] });
  assert.equal(observed?.pid, 102, 'the actual listening child is the metric and PID target');
  assert.equal(sameProcessIdentity(102, now - 3_723_000, processes[1]), true);
  assert.equal(sameProcessIdentity(102, now - 3_700_000, processes[1]), false);
});

test('logs tail replays persisted output and external file-backed stdout/stderr can be collected', async () => {
  const state = await mkdtemp(join(tmpdir(), 'dockyard-log-tail-test-'));
  const stdout = join(state, 'external.stdout.log');
  const stderr = join(state, 'external.stderr.log');
  await Promise.all([
    import('node:fs/promises').then(({ writeFile }) => writeFile(stdout, 'booted\nready\n')),
    import('node:fs/promises').then(({ writeFile }) => writeFile(stderr, 'warning\n')),
  ]);
  assert.deepEqual(await readLogTail(stdout), ['booted', 'ready']);
  assert.deepEqual(externalLogFilesFromDescriptors({ 1: stdout, 2: stderr }), { stdout, stderr });
  assert.deepEqual(externalLogFilesFromDescriptors({ 1: '/dev/ttys001', 2: 'pipe' }), {});
});

test('runtime follows file-backed logs from an externally started process', { skip: process.platform === 'win32' }, async () => {
  const state = await mkdtemp(join(tmpdir(), 'dockyard-external-runtime-test-'));
  const database = await DockyardDatabase.open(new PathResolver(join(state, 'dockyard-state')));
  const preview = await scanProject(fixture, false);
  const imported = database.importProject(state, 'external-runtime', [{ ...preview.applications[0], cwd: state }]);
  const application = imported.applications[0];
  assert.ok(application);
  const stdoutPath = join(state, 'external.stdout.log');
  const stderrPath = join(state, 'external.stderr.log');
  const stdout = openSync(stdoutPath, 'a');
  const stderr = openSync(stderrPath, 'a');
  const child = spawn(process.execPath, ['-e', "console.log('external-ready'); console.error('external-warning'); setInterval(() => {}, 1_000)"], { cwd: state, stdio: ['ignore', stdout, stderr] });
  closeSync(stdout); closeSync(stderr);
  assert.ok(child.pid);
  const runtime = new RuntimeService({ db: database });
  const messages = [];
  const remove = runtime.onLog((message) => messages.push(message));
  try {
    await runtime.adoptExternalRuntime(application, undefined, { pid: child.pid, startedAt: Date.now(), listeningPorts: [] });
    await appendFile(stdoutPath, 'external-next\n');
    await runtime.collectExternalLogs(runtime.runtimes.get(application.id));
    assert.deepEqual(messages.map((message) => [message.stream, message.line]).sort(), [['stderr', 'external-warning'], ['stdout', 'external-next'], ['stdout', 'external-ready']]);
    assert.deepEqual((await runtime.logTail(application.id, 'stdout')).map((message) => message.line), ['external-ready', 'external-next']);
  } finally {
    remove();
    child.kill('SIGTERM');
    runtime.onModuleDestroy();
    database.close();
  }
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
