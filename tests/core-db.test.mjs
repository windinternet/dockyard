import assert from 'node:assert/strict';
import { appendFile, mkdtemp } from 'node:fs/promises';
import { closeSync, openSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { assessServiceChanges, parseServiceProfile, redactCommandForDisplay, redactDisplayText, redactDisplayValue, scanProject, withCompatibilityProfile } from '../packages/core/dist/index.js';
import { DockyardDatabase, PathResolver } from '../packages/db/dist/index.js';
import { normalizeSelection } from '../apps/api/dist/native-directory-picker.service.js';
import { ProjectService } from '../apps/api/dist/project.service.js';
import { detectDokployCompatibilityProfile, parseWorkspacePackagePaths } from '../apps/api/dist/dokploy-compatibility-profile.js';
import { externalLogFilesFromDescriptors, logCaptureStatusFor, matchingProcesses, parseProcessTable, probeServiceHealth, readLogTail, RuntimeService, sameProcessIdentity, selectObservedProcess } from '../apps/api/dist/runtime.service.js';
import { terminateChildProcess } from '../apps/api/dist/runtime.service.js';
import { ApplicationsController, runtimeEvent } from '../apps/api/dist/applications.controller.js';
import { DatabaseSync } from 'node:sqlite';

const fixture = resolve('tests/fixtures/scannable');
const monorepoFixture = resolve('tests/fixtures/monorepo');
const dokployFixture = resolve('tests/fixtures/dokploy');
async function profiledDokployPreview() { return withCompatibilityProfile(await scanProject(dokployFixture, false), await detectDokployCompatibilityProfile(dokployFixture)); }

test('runtime SSE emits named events so subscribed UI handlers receive metrics', () => {
  const event = runtimeEvent({ type: 'metric', metric: { applicationId: 'app-1', sampledAt: '2026-08-11T00:00:00.000Z', pid: 1, cpuPercent: 0, uptimeMs: 1, restartCount: 0, rssBytes: 1 } });
  assert.equal(event.type, 'metric');
});

test('service health keeps a reachable listener and a successful HTTP probe as separate facts', async () => {
  const requests = [];
  const request = async (url) => { requests.push(url); return { ok: true }; };
  assert.deepEqual(await probeServiceHealth({ defaultPort: 4318, healthCheck: { type: 'http', path: '/ready' } }, [4318], request), { portReachability: 'reachable', healthStatus: 'healthy' });
  assert.deepEqual(requests, ['http://127.0.0.1:4318/ready']);
  assert.deepEqual(await probeServiceHealth({ defaultPort: 4318, healthCheck: { type: 'http', path: '/ready' } }, [], request), { portReachability: 'unreachable', healthStatus: 'unknown' });
});

test('managed processes that ignore SIGTERM are force-stopped with SIGKILL after the grace period', { skip: process.platform === 'win32' }, async () => {
  const child = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); console.log('ready'); setInterval(() => {}, 1_000)"] , { detached: true, stdio: ['ignore', 'pipe', 'ignore'] });
  assert.ok(child.pid);
  try {
    await new Promise((resolve) => child.stdout?.once('data', resolve));
    const signal = await terminateChildProcess(child, { processGroup: true, gracePeriodMs: 25 });
    assert.equal(signal, 'SIGKILL');
    assert.equal(child.signalCode, 'SIGKILL');
  } finally {
    if (child.exitCode === null && child.signalCode === null) process.kill(-child.pid, 'SIGKILL');
  }
});

test('combined log tail replays and follows stdout and stderr through one subscription', async () => {
  let emit;
  const controller = new ApplicationsController({
    application: () => ({}),
    onLog: (listener) => { emit = listener; return () => undefined; },
    logHistory: async (_id, stream) => ({ logs: stream === 'combined' ? [{ applicationId: 'app-1', stream: 'stdout', at: '2026-08-11T00:00:00.000Z', line: 'stdout-history' }, { applicationId: 'app-1', stream: 'stderr', at: '2026-08-11T00:00:01.000Z', line: 'stderr-history' }] : [{ applicationId: 'app-1', stream, at: '2026-08-11T00:00:00.000Z', line: `${stream}-history` }], hasMore: false }),
  });
  const messages = [];
  const subscription = controller.tail('app-1', 'combined').subscribe((event) => messages.push(event.data));
  await new Promise((resolve) => setTimeout(resolve, 0));
  emit({ applicationId: 'app-1', stream: 'stderr', at: '2026-08-11T00:00:02.000Z', line: 'stderr-live' });
  emit({ applicationId: 'app-1', stream: 'stdout', at: '2026-08-11T00:00:03.000Z', line: 'stdout-live' });
  subscription.unsubscribe();
  assert.deepEqual(messages.map((message) => [message.stream, message.line]), [['stdout', 'stdout-history'], ['stderr', 'stderr-history'], ['stderr', 'stderr-live'], ['stdout', 'stdout-live']]);
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

test('scanner exposes the strict Dokploy service profile and keeps uncertain changes conservative', async () => {
  const preview = await profiledDokployPreview();
  assert.equal(preview.compatibilityProfile?.id, 'dokploy');
  assert.deepEqual(preview.compatibilityProfile?.services.map((service) => [service.id, service.cwd, service.defaultPort, service.changeRules.map((rule) => [rule.id, rule.impact, rule.evidence])]), [
    ['dashboard', join(dokployFixture, 'apps/dokploy'), 3000, [['next-ui', 'hot-reload', 'source-inspected'], ['custom-server', 'manual-restart', 'runtime-verified'], ['shared-runtime', 'confirmation-required', 'unverified']]],
    ['api', join(dokployFixture, 'apps/api'), 4000, [['service-source', 'auto-restart', 'runtime-verified'], ['shared-runtime', 'confirmation-required', 'unverified']]],
    ['schedules', join(dokployFixture, 'apps/schedules'), 4001, [['service-source', 'auto-restart', 'runtime-verified'], ['shared-runtime', 'confirmation-required', 'unverified']]],
  ]);
  assert.equal(preview.applications.find((application) => application.name === 'dokploy')?.serviceProfile?.healthCheck, undefined);
});

test('Dokploy adapter parses only the exact workspace package sequence and assesses unmatched files conservatively', async () => {
  assert.deepEqual(parseWorkspacePackagePaths('packages:\n  - "apps/api"\n  - "apps/dokploy"\n'), ['apps/api', 'apps/dokploy']);
  assert.equal(parseWorkspacePackagePaths('packages: ["apps/api"]'), null);
  const profile = await detectDokployCompatibilityProfile(dokployFixture);
  const api = profile?.services.find((service) => service.id === 'api');
  assert.ok(api);
  assert.deepEqual(assessServiceChanges(api, dokployFixture, ['apps/api/src/index.ts', 'packages/server/src/index.ts', 'README.md']).map((item) => [item.impact, item.ruleId]), [['auto-restart', 'service-source'], ['confirmation-required', 'shared-runtime'], ['confirmation-required', undefined]]);
});

test('an imported compatibility service profile survives a database round trip', async () => {
  const state = await mkdtemp(join(tmpdir(), 'dockyard-profile-persistence-test-'));
  const database = await DockyardDatabase.open(new PathResolver(state));
  const preview = await profiledDokployPreview();
  const imported = database.importProject(preview.root, preview.projectName, preview.applications, preview.projectEntrypointOptions, preview.selectedProjectEntrypoint);
  const dashboard = imported.applications.find((application) => application.name === 'dokploy');
  assert.deepEqual(database.getApplication(dashboard.id)?.serviceProfile?.changeRules.map((rule) => rule.impact), ['hot-reload', 'manual-restart', 'confirmation-required']);
  database.close();
});

test('project import discards client-supplied profiles and re-detects the local Dokploy baseline', async () => {
  const state = await mkdtemp(join(tmpdir(), 'dockyard-profile-boundary-test-'));
  const database = await DockyardDatabase.open(new PathResolver(state));
  const service = new ProjectService({ db: database }, {});
  const preview = await scanProject(dokployFixture, false);
  const imported = await service.import({ path: dokployFixture, name: 'client-name-is-not-profile-evidence', applications: preview.applications.map((application) => ({ ...application, serviceProfile: { profileId: 'forged', id: 'forged' } })) });
  assert.equal(imported.applications.find((application) => application.name === 'dokploy')?.serviceProfile?.profileId, 'dokploy');
  database.close();
});

test('a pre-path-profile SQLite record retains its service baseline but assesses paths conservatively after upgrade', async () => {
  const state = await mkdtemp(join(tmpdir(), 'dockyard-profile-upgrade-test-'));
  const resolver = new PathResolver(state);
  const database = await DockyardDatabase.open(resolver);
  const preview = await profiledDokployPreview();
  const imported = database.importProject(preview.root, preview.projectName, preview.applications);
  const dashboard = imported.applications.find((application) => application.name === 'dokploy');
  database.close();
  const raw = new DatabaseSync(resolver.databasePath());
  const stored = raw.prepare('SELECT service_profile_json AS serviceProfileJson FROM applications WHERE id = ?').get(dashboard.id);
  const legacy = JSON.parse(stored.serviceProfileJson);
  delete legacy.processCommandHints;
  legacy.changeRules = legacy.changeRules.map(({ pathPatterns, ...rule }) => rule);
  raw.prepare('UPDATE applications SET service_profile_json = ? WHERE id = ?').run(JSON.stringify(legacy), dashboard.id);
  raw.close();
  const reopened = await DockyardDatabase.open(resolver);
  const restored = reopened.getApplication(dashboard.id)?.serviceProfile;
  assert.equal(restored?.defaultPort, 3000);
  assert.deepEqual(restored?.processCommandHints, []);
  assert.deepEqual(restored?.changeRules.map((rule) => rule.pathPatterns), [[], [], []]);
  assert.deepEqual(assessServiceChanges(restored, dokployFixture, ['apps/dokploy/server/server.ts']).map((item) => item.impact), ['confirmation-required']);
  assert.equal(parseServiceProfile(legacy)?.profileId, 'dokploy');
  reopened.close();
});

test('changing a profiled service command clears its no-longer-accurate profile', async () => {
  const state = await mkdtemp(join(tmpdir(), 'dockyard-profile-command-test-'));
  const database = await DockyardDatabase.open(new PathResolver(state));
  const preview = await profiledDokployPreview();
  const imported = database.importProject(preview.root, preview.projectName, preview.applications);
  const dashboard = imported.applications.find((application) => application.name === 'dokploy');
  const replacement = { ...dashboard, commandOptions: [...dashboard.commandOptions, { name: 'start', command: { executable: 'pnpm', args: ['run', 'start'] } }] };
  database.importProject(preview.root, preview.projectName, imported.applications.map((application) => application.id === dashboard.id ? replacement : application));
  assert.equal(database.updateApplicationCommand(dashboard.id, 'start').serviceProfile, undefined);
  database.close();
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
  const settings = database.applySettings({ retentionDays: 30, maxFiles: 9, maxBytesPerFile: 2_097_152, restartPreset: 'manual', logAutoScrollPauseMs: 45_000 });
  const application = database.getApplication(imported.applications[0].id);
  assert.equal(settings.version, 1);
  assert.equal(settings.logAutoScrollPauseMs, 45_000);
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

test('external process discovery requires command evidence, follows its process tree, and prefers the declared port', () => {
  const now = Date.UTC(2026, 7, 11, 12, 0, 0);
  const processes = parseProcessTable(' 101 1 00:02:00 node /workspace/demo/node_modules/.bin/pnpm.cjs run dev\n 102 101 01:02:03 node server.js\n 103 1 00:01:00 node /workspace/demo/node_modules/.bin/vite\n 104 1 00:01:00 node /workspace/other/server.js', now).map((process) => process.pid === 101 || process.pid === 102 || process.pid === 103 ? { ...process, cwd: '/workspace/demo' } : { ...process, cwd: '/workspace/other' });
  const matches = matchingProcesses({ cwd: '/workspace/demo', command: { executable: 'pnpm', args: ['run', 'dev'] }, serviceProfile: undefined }, processes);
  const observed = selectObservedProcess(matches, new Map([[101, []], [102, [4318, 5173]], [103, [3000]]]), 5173);
  assert.deepEqual(matches.map((process) => process.pid), [101, 102]);
  assert.deepEqual(observed, { pid: 102, startedAt: now - 3_723_000, listeningPorts: [4318, 5173] });
  assert.equal(observed?.pid, 102, 'the actual declared-port listener in the matched process tree is the metric and PID target');
  assert.equal(sameProcessIdentity(102, now - 3_723_000, processes[1]), true);
  assert.equal(sameProcessIdentity(102, now - 3_700_000, processes[1]), false);
});

test('logs tail replays persisted output and external file-backed stdout/stderr can be collected', async () => {
  const { logCaptureStatusFor } = await import('../apps/api/dist/runtime.service.js');
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
  assert.equal(logCaptureStatusFor({ ownership: 'external', externalLogs: {} }), 'unavailable');
  assert.equal(logCaptureStatusFor({ ownership: 'external', externalLogs: { stdout: { path: stdout, position: 0 } } }), 'file-backed');
  assert.equal(logCaptureStatusFor({ ownership: 'dockyard', externalLogs: {} }), 'streaming');
  assert.equal(logCaptureStatusFor(undefined), 'inactive');
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
    const tail = await runtime.logTail(application.id, 'stdout');
    assert.deepEqual(tail.map((message) => message.line), ['external-ready', 'external-next']);
    const history = await runtime.logHistory(application.id, 'combined');
    assert.deepEqual(history.logs.map((message) => [message.stream, message.line]).sort(), [['stderr', 'external-warning'], ['stdout', 'external-next'], ['stdout', 'external-ready']]);
    assert.equal(history.logs.every((message) => Number.isFinite(Date.parse(message.at))), true);
    const recent = await runtime.logHistory(application.id, 'combined', 2);
    const older = await runtime.logHistory(application.id, 'combined', 2, recent.logs[0]?.cursor);
    assert.deepEqual([...recent.logs, ...older.logs].map((message) => message.line).sort(), ['external-next', 'external-ready', 'external-warning']);
    assert.equal(tail[0]?.at, (await import('node:fs/promises').then(({ stat }) => stat(join(state, 'dockyard-state', 'logs', imported.project.id, application.id, 'stdout.log')))).mtime.toISOString());
  } finally {
    remove();
    child.kill('SIGTERM');
    runtime.onModuleDestroy();
    database.close();
  }
});

test('an external process remains observation-only until the user explicitly adopts recovery management', { skip: process.platform === 'win32' }, async () => {
  const state = await mkdtemp(join(tmpdir(), 'dockyard-external-adoption-test-'));
  const database = await DockyardDatabase.open(new PathResolver(join(state, 'dockyard-state')));
  const preview = await scanProject(fixture, false);
  const imported = database.importProject(state, 'external-adoption', [{ ...preview.applications[0], cwd: state }]);
  const application = imported.applications[0];
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1_000)'], { cwd: state, stdio: 'ignore' });
  const runtime = new RuntimeService({ db: database });
  try {
    await runtime.adoptExternalRuntime(application, undefined, { pid: child.pid, startedAt: Date.now(), listeningPorts: [] });
    assert.equal(runtime.application(application.id).externalRuntimeManagement, 'observe');
    assert.equal(runtime.adoptExternal(application.id).externalRuntimeManagement, 'adopted');
  } finally {
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
