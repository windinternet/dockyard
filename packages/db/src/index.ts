import { mkdir } from 'node:fs/promises';
import { homedir, platform } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { defaultDockyardSettings, restartPolicyForPreset, type Application, type ApplicationCommand, type ApplicationStatus, type DockyardSettings, type ImportPreviewApplication, type LifecycleEvent, type LogPolicy, type MetricRollup, type Project, type RestartPolicy } from '@dockyard/core';

export class PathResolver {
  constructor(private readonly stateDirectory = defaultStateDirectory()) {}
  databasePath(): string { return join(this.stateDirectory, 'dockyard.sqlite'); }
  logDirectory(projectId: string, applicationId: string): string { return join(this.stateDirectory, 'logs', projectId, applicationId); }
  diagnosticsDirectory(applicationId: string, timestamp = new Date().toISOString().replaceAll(':', '-')): string { return join(this.stateDirectory, 'diagnostics', `${timestamp}-${applicationId}`); }
}

export class DockyardDatabase {
  private readonly db: DatabaseSync;
  private constructor(private readonly paths: PathResolver, db: DatabaseSync) { this.db = db; }
  static async open(paths = new PathResolver()): Promise<DockyardDatabase> { await mkdir(dirname(paths.databasePath()), { recursive: true }); const db = new DatabaseSync(paths.databasePath()); const database = new DockyardDatabase(paths, db); database.upgradeLegacySchema(); database.migrate(); return database; }
  close(): void { this.db.close(); }
  get pathResolver(): PathResolver { return this.paths; }
  migrate(): void {
    this.db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, path TEXT NOT NULL UNIQUE, name TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS applications (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), name TEXT NOT NULL, cwd TEXT NOT NULL, command_json TEXT NOT NULL, restart_policy_json TEXT NOT NULL, log_policy_json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(project_id, name));
      CREATE TABLE IF NOT EXISTS lifecycle_events (id TEXT PRIMARY KEY, application_id TEXT NOT NULL REFERENCES applications(id), type TEXT NOT NULL, occurred_at TEXT NOT NULL, detail_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS metric_rollups (application_id TEXT NOT NULL REFERENCES applications(id), sampled_at TEXT NOT NULL, pid INTEGER, cpu_percent REAL, uptime_ms INTEGER NOT NULL, restart_count INTEGER NOT NULL, rss_bytes INTEGER, PRIMARY KEY(application_id, sampled_at));
      CREATE TABLE IF NOT EXISTS settings_versions (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL, config_json TEXT NOT NULL);
      INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (1, datetime('now'));`);
    this.ensureColumn('metric_rollups', 'pid', 'INTEGER');
    this.ensureColumn('metric_rollups', 'cpu_percent', 'REAL');
  }
  /** Migrates the pre-MVP prototype schema without requiring users to delete local state. */
  private upgradeLegacySchema(): void {
    const columns = this.db.prepare("SELECT name FROM pragma_table_info('applications')").all() as Array<{ name: string }>;
    if (!columns.length || columns.some((column) => column.name === 'command_json')) return;
    this.db.exec('BEGIN IMMEDIATE;');
    try {
      const projects = this.db.prepare('SELECT id, path, name, created_at AS createdAt FROM projects').all() as Array<{ id: string; path: string; name: string; createdAt: string }>;
      const applications = this.db.prepare('SELECT id, project_id AS projectId, name, cwd, command, args_json AS argsJson, restart_mode AS restartMode, max_retries AS maxRetries, retry_delay_ms AS retryDelayMs, stable_window_ms AS stableWindowMs, log_max_files AS maxFiles, log_max_bytes_per_file AS maxBytesPerFile, log_retention_days AS retentionDays, created_at AS createdAt, updated_at AS updatedAt FROM applications').all() as Array<Record<string, unknown>>;
      const events = this.tableExists('lifecycle_events') ? this.db.prepare('SELECT id, application_id AS applicationId, type, occurred_at AS occurredAt, detail_json AS detailJson FROM lifecycle_events').all() as Array<Record<string, unknown>> : [];
      const metrics = this.tableExists('metric_rollups') ? this.db.prepare('SELECT application_id AS applicationId, sampled_at AS sampledAt, uptime_ms AS uptimeMs, restart_count AS restartCount, rss_bytes AS rssBytes FROM metric_rollups').all() as Array<Record<string, unknown>> : [];
      this.db.exec('DROP TABLE IF EXISTS lifecycle_events; DROP TABLE IF EXISTS metric_rollups; DROP TABLE applications; DROP TABLE projects;');
      this.migrate();
      const insertProject = this.db.prepare('INSERT INTO projects(id, path, name, created_at) VALUES (?, ?, ?, ?)');
      for (const project of projects) insertProject.run(project.id, project.path, project.name, project.createdAt);
      const insertApplication = this.db.prepare('INSERT INTO applications(id, project_id, name, cwd, command_json, restart_policy_json, log_policy_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
      for (const application of applications) {
        const args = safeArray(application.argsJson); const command = { executable: String(application.command), args };
        const restart = { mode: application.restartMode, maxRetries: Number(application.maxRetries), retryDelayMs: Number(application.retryDelayMs), stableWindowMs: Number(application.stableWindowMs) };
        const log = { maxFiles: Number(application.maxFiles), maxBytesPerFile: Number(application.maxBytesPerFile), retentionDays: Number(application.retentionDays) };
        insertApplication.run(String(application.id), String(application.projectId), String(application.name), String(application.cwd), JSON.stringify(command), JSON.stringify(restart), JSON.stringify(log), String(application.createdAt), String(application.updatedAt));
      }
      const insertEvent = this.db.prepare('INSERT INTO lifecycle_events(id, application_id, type, occurred_at, detail_json) VALUES (?, ?, ?, ?, ?)');
      for (const event of events) insertEvent.run(String(event.id), String(event.applicationId), String(event.type), String(event.occurredAt), String(event.detailJson));
      const insertMetric = this.db.prepare('INSERT INTO metric_rollups(application_id, sampled_at, pid, cpu_percent, uptime_ms, restart_count, rss_bytes) VALUES (?, ?, ?, ?, ?, ?, ?)');
      for (const metric of metrics) insertMetric.run(String(metric.applicationId), String(metric.sampledAt), null, null, Number(metric.uptimeMs), Number(metric.restartCount), numberOrNull(metric.rssBytes));
      this.db.exec('COMMIT;');
    } catch (error) { this.db.exec('ROLLBACK;'); throw error; }
  }
  private tableExists(name: string): boolean { return Boolean(this.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name)); }
  private ensureColumn(table: string, column: string, declaration: string): void { const columns = this.db.prepare(`SELECT name FROM pragma_table_info('${table}')`).all() as Array<{ name: string }>; if (!columns.some((item) => item.name === column)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${declaration}`); }
  listProjects(): Project[] { return (this.db.prepare('SELECT id, path, name, created_at AS createdAt FROM projects ORDER BY name').all() as unknown as Project[]); }
  listApplications(projectId?: string): Application[] { const sql = `SELECT a.id, a.project_id AS projectId, a.name, a.cwd, a.command_json AS commandJson, a.restart_policy_json AS restartPolicyJson, a.log_policy_json AS logPolicyJson, a.created_at AS createdAt, a.updated_at AS updatedAt FROM applications a ${projectId ? 'WHERE a.project_id = ?' : ''} ORDER BY a.name`; return (projectId ? this.db.prepare(sql).all(projectId) : this.db.prepare(sql).all()).map(rowToApplication); }
  getApplication(id: string): Application | null { const row = this.db.prepare('SELECT id, project_id AS projectId, name, cwd, command_json AS commandJson, restart_policy_json AS restartPolicyJson, log_policy_json AS logPolicyJson, created_at AS createdAt, updated_at AS updatedAt FROM applications WHERE id = ?').get(id); return row ? rowToApplication(row) : null; }
  updateApplicationPolicies(id: string, restartPolicy: RestartPolicy, logPolicy: LogPolicy): Application { const result = this.db.prepare('UPDATE applications SET restart_policy_json = ?, log_policy_json = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(restartPolicy), JSON.stringify(logPolicy), new Date().toISOString(), id); if (result.changes !== 1) throw new Error('应用不存在。'); return this.getApplication(id)!; }
  deleteProject(id: string): void { this.db.exec('BEGIN IMMEDIATE;'); try { this.db.prepare('DELETE FROM metric_rollups WHERE application_id IN (SELECT id FROM applications WHERE project_id = ?)').run(id); this.db.prepare('DELETE FROM lifecycle_events WHERE application_id IN (SELECT id FROM applications WHERE project_id = ?)').run(id); this.db.prepare('DELETE FROM applications WHERE project_id = ?').run(id); const result = this.db.prepare('DELETE FROM projects WHERE id = ?').run(id); if (result.changes !== 1) throw new Error('项目不存在。'); this.db.exec('COMMIT;'); } catch (error) { this.db.exec('ROLLBACK;'); throw error; } }
  importProject(path: string, name: string, candidates: readonly ImportPreviewApplication[]): { project: Project; applications: Application[] } {
    const now = new Date().toISOString(); const existing = this.db.prepare('SELECT id, path, name, created_at AS createdAt FROM projects WHERE path = ?').get(resolve(path)) as Project | undefined;
    const project = existing ?? { id: randomUUID(), path: resolve(path), name, createdAt: now };
    if (!existing) this.db.prepare('INSERT INTO projects(id, path, name, created_at) VALUES (?, ?, ?, ?)').run(project.id, project.path, project.name, project.createdAt);
    const upsert = this.db.prepare(`INSERT INTO applications(id, project_id, name, cwd, command_json, restart_policy_json, log_policy_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(project_id, name) DO UPDATE SET cwd = excluded.cwd, command_json = excluded.command_json, updated_at = excluded.updated_at`);
    const settings = this.settings(); const restartPolicy = restartPolicyForPreset(settings.restartPreset); const logPolicy = { maxFiles: settings.maxFiles, maxBytesPerFile: settings.maxBytesPerFile, retentionDays: settings.retentionDays };
    for (const candidate of candidates) {
      const candidateRestartPolicy = candidate.origin === 'pm2-ecosystem' ? candidate.restartPolicy : restartPolicy;
      const candidateLogPolicy = candidate.origin === 'pm2-ecosystem' ? candidate.logPolicy : logPolicy;
      upsert.run(randomUUID(), project.id, candidate.name, candidate.cwd, JSON.stringify(candidate.command), JSON.stringify(candidateRestartPolicy), JSON.stringify(candidateLogPolicy), now, now);
    }
    return { project, applications: this.listApplications(project.id) };
  }
  recordEvent(event: Omit<LifecycleEvent, 'id' | 'occurredAt'> & Partial<Pick<LifecycleEvent, 'id' | 'occurredAt'>>): LifecycleEvent { const saved: LifecycleEvent = { id: event.id ?? randomUUID(), occurredAt: event.occurredAt ?? new Date().toISOString(), applicationId: event.applicationId, type: event.type, detail: event.detail }; this.db.prepare('INSERT INTO lifecycle_events(id, application_id, type, occurred_at, detail_json) VALUES (?, ?, ?, ?, ?)').run(saved.id, saved.applicationId, saved.type, saved.occurredAt, JSON.stringify(saved.detail)); return saved; }
  events(applicationId: string, limit = 100): LifecycleEvent[] { return (this.db.prepare('SELECT id, application_id AS applicationId, type, occurred_at AS occurredAt, detail_json AS detailJson FROM lifecycle_events WHERE application_id = ? ORDER BY occurred_at DESC LIMIT ?').all(applicationId, limit) as Record<string, unknown>[]).map((row) => ({ id: String(row.id), applicationId: String(row.applicationId), type: row.type as LifecycleEvent['type'], occurredAt: String(row.occurredAt), detail: JSON.parse(String(row.detailJson)) as Record<string, unknown> })); }
  recordMetric(metric: MetricRollup): void { this.db.prepare('INSERT OR REPLACE INTO metric_rollups(application_id, sampled_at, pid, cpu_percent, uptime_ms, restart_count, rss_bytes) VALUES (?, ?, ?, ?, ?, ?, ?)').run(metric.applicationId, metric.sampledAt, metric.pid, metric.cpuPercent, metric.uptimeMs, metric.restartCount, metric.rssBytes); }
  metrics(applicationId: string, since: string): MetricRollup[] { return this.db.prepare('SELECT application_id AS applicationId, sampled_at AS sampledAt, pid, cpu_percent AS cpuPercent, uptime_ms AS uptimeMs, restart_count AS restartCount, rss_bytes AS rssBytes FROM metric_rollups WHERE application_id = ? AND sampled_at >= ? ORDER BY sampled_at').all(applicationId, since) as unknown as MetricRollup[]; }
  settings(): DockyardSettings { const row = this.db.prepare('SELECT version, config_json AS configJson FROM settings_versions ORDER BY version DESC LIMIT 1').get() as { version: number; configJson: string } | undefined; return row ? { ...(JSON.parse(row.configJson) as Omit<DockyardSettings, 'version'>), version: row.version } : { ...defaultDockyardSettings }; }
  applySettings(input: Omit<DockyardSettings, 'version'>): DockyardSettings {
    const current = this.settings(); const next: DockyardSettings = { ...input, version: current.version + 1 }; const logPolicy = { maxFiles: next.maxFiles, maxBytesPerFile: next.maxBytesPerFile, retentionDays: next.retentionDays }; const restartPolicy = restartPolicyForPreset(next.restartPreset);
    this.db.exec('BEGIN IMMEDIATE;');
    try { this.db.prepare('INSERT INTO settings_versions(version, applied_at, config_json) VALUES (?, ?, ?)').run(next.version, new Date().toISOString(), JSON.stringify(input)); const update = this.db.prepare('UPDATE applications SET log_policy_json = ?, restart_policy_json = ?, updated_at = ?'); update.run(JSON.stringify(logPolicy), JSON.stringify(restartPolicy), new Date().toISOString()); this.db.exec('COMMIT;'); return next; } catch (error) { this.db.exec('ROLLBACK;'); throw error; }
  }
}
function rowToApplication(row: Record<string, unknown>): Application { return { id: String(row.id), projectId: String(row.projectId), name: String(row.name), cwd: String(row.cwd), command: JSON.parse(String(row.commandJson)) as ApplicationCommand, status: 'stopped', pid: null, restartPolicy: JSON.parse(String(row.restartPolicyJson)) as RestartPolicy, logPolicy: JSON.parse(String(row.logPolicyJson)) as LogPolicy, createdAt: String(row.createdAt), updatedAt: String(row.updatedAt) }; }
function defaultStateDirectory(): string { const base = process.env.XDG_STATE_HOME || (platform() === 'darwin' ? join(homedir(), 'Library', 'Application Support') : join(homedir(), '.local', 'state')); return join(base, 'dockyard'); }
function safeArray(value: unknown): string[] { try { const parsed: unknown = JSON.parse(String(value)); return Array.isArray(parsed) && parsed.every((item) => typeof item === 'string') ? parsed : []; } catch { return []; } }
function numberOrNull(value: unknown): number | null { return typeof value === 'number' ? value : null; }
