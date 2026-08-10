import { mkdir } from 'node:fs/promises';
import { homedir, platform } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import type { Application, ApplicationCommand, ApplicationStatus, ImportPreviewApplication, LifecycleEvent, LogPolicy, MetricRollup, Project, RestartPolicy } from '@dockyard/core';

export class PathResolver {
  constructor(private readonly stateDirectory = defaultStateDirectory()) {}
  databasePath(): string { return join(this.stateDirectory, 'dockyard.sqlite'); }
  logDirectory(projectId: string, applicationId: string): string { return join(this.stateDirectory, 'logs', projectId, applicationId); }
  diagnosticsDirectory(applicationId: string, timestamp = new Date().toISOString().replaceAll(':', '-')): string { return join(this.stateDirectory, 'diagnostics', `${timestamp}-${applicationId}`); }
}

export class DockyardDatabase {
  private readonly db: DatabaseSync;
  private constructor(private readonly paths: PathResolver, db: DatabaseSync) { this.db = db; }
  static async open(paths = new PathResolver()): Promise<DockyardDatabase> { await mkdir(dirname(paths.databasePath()), { recursive: true }); const db = new DatabaseSync(paths.databasePath()); const database = new DockyardDatabase(paths, db); database.migrate(); return database; }
  close(): void { this.db.close(); }
  get pathResolver(): PathResolver { return this.paths; }
  migrate(): void {
    this.db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, path TEXT NOT NULL UNIQUE, name TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS applications (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), name TEXT NOT NULL, cwd TEXT NOT NULL, command_json TEXT NOT NULL, restart_policy_json TEXT NOT NULL, log_policy_json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(project_id, name));
      CREATE TABLE IF NOT EXISTS lifecycle_events (id TEXT PRIMARY KEY, application_id TEXT NOT NULL REFERENCES applications(id), type TEXT NOT NULL, occurred_at TEXT NOT NULL, detail_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS metric_rollups (application_id TEXT NOT NULL REFERENCES applications(id), sampled_at TEXT NOT NULL, uptime_ms INTEGER NOT NULL, restart_count INTEGER NOT NULL, rss_bytes INTEGER, PRIMARY KEY(application_id, sampled_at));
      INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (1, datetime('now'));`);
  }
  listProjects(): Project[] { return (this.db.prepare('SELECT id, path, name, created_at AS createdAt FROM projects ORDER BY name').all() as unknown as Project[]); }
  listApplications(projectId?: string): Application[] { const sql = `SELECT a.id, a.project_id AS projectId, a.name, a.cwd, a.command_json AS commandJson, a.restart_policy_json AS restartPolicyJson, a.log_policy_json AS logPolicyJson, a.created_at AS createdAt, a.updated_at AS updatedAt FROM applications a ${projectId ? 'WHERE a.project_id = ?' : ''} ORDER BY a.name`; return (projectId ? this.db.prepare(sql).all(projectId) : this.db.prepare(sql).all()).map(rowToApplication); }
  getApplication(id: string): Application | null { const row = this.db.prepare('SELECT id, project_id AS projectId, name, cwd, command_json AS commandJson, restart_policy_json AS restartPolicyJson, log_policy_json AS logPolicyJson, created_at AS createdAt, updated_at AS updatedAt FROM applications WHERE id = ?').get(id); return row ? rowToApplication(row) : null; }
  importProject(path: string, name: string, candidates: readonly ImportPreviewApplication[]): { project: Project; applications: Application[] } {
    const now = new Date().toISOString(); const existing = this.db.prepare('SELECT id, path, name, created_at AS createdAt FROM projects WHERE path = ?').get(resolve(path)) as Project | undefined;
    const project = existing ?? { id: randomUUID(), path: resolve(path), name, createdAt: now };
    if (!existing) this.db.prepare('INSERT INTO projects(id, path, name, created_at) VALUES (?, ?, ?, ?)').run(project.id, project.path, project.name, project.createdAt);
    const upsert = this.db.prepare(`INSERT INTO applications(id, project_id, name, cwd, command_json, restart_policy_json, log_policy_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(project_id, name) DO UPDATE SET cwd = excluded.cwd, command_json = excluded.command_json, restart_policy_json = excluded.restart_policy_json, log_policy_json = excluded.log_policy_json, updated_at = excluded.updated_at`);
    for (const candidate of candidates) upsert.run(randomUUID(), project.id, candidate.name, candidate.cwd, JSON.stringify(candidate.command), JSON.stringify(candidate.restartPolicy), JSON.stringify(candidate.logPolicy), now, now);
    return { project, applications: this.listApplications(project.id) };
  }
  recordEvent(event: Omit<LifecycleEvent, 'id' | 'occurredAt'> & Partial<Pick<LifecycleEvent, 'id' | 'occurredAt'>>): LifecycleEvent { const saved: LifecycleEvent = { id: event.id ?? randomUUID(), occurredAt: event.occurredAt ?? new Date().toISOString(), applicationId: event.applicationId, type: event.type, detail: event.detail }; this.db.prepare('INSERT INTO lifecycle_events(id, application_id, type, occurred_at, detail_json) VALUES (?, ?, ?, ?, ?)').run(saved.id, saved.applicationId, saved.type, saved.occurredAt, JSON.stringify(saved.detail)); return saved; }
  events(applicationId: string, limit = 100): LifecycleEvent[] { return (this.db.prepare('SELECT id, application_id AS applicationId, type, occurred_at AS occurredAt, detail_json AS detailJson FROM lifecycle_events WHERE application_id = ? ORDER BY occurred_at DESC LIMIT ?').all(applicationId, limit) as Record<string, unknown>[]).map((row) => ({ id: String(row.id), applicationId: String(row.applicationId), type: row.type as LifecycleEvent['type'], occurredAt: String(row.occurredAt), detail: JSON.parse(String(row.detailJson)) as Record<string, unknown> })); }
  recordMetric(metric: MetricRollup): void { this.db.prepare('INSERT OR REPLACE INTO metric_rollups(application_id, sampled_at, uptime_ms, restart_count, rss_bytes) VALUES (?, ?, ?, ?, ?)').run(metric.applicationId, metric.sampledAt, metric.uptimeMs, metric.restartCount, metric.rssBytes); }
  metrics(applicationId: string, since: string): MetricRollup[] { return this.db.prepare('SELECT application_id AS applicationId, sampled_at AS sampledAt, uptime_ms AS uptimeMs, restart_count AS restartCount, rss_bytes AS rssBytes FROM metric_rollups WHERE application_id = ? AND sampled_at >= ? ORDER BY sampled_at').all(applicationId, since) as unknown as MetricRollup[]; }
}
function rowToApplication(row: Record<string, unknown>): Application { return { id: String(row.id), projectId: String(row.projectId), name: String(row.name), cwd: String(row.cwd), command: JSON.parse(String(row.commandJson)) as ApplicationCommand, status: 'stopped', restartPolicy: JSON.parse(String(row.restartPolicyJson)) as RestartPolicy, logPolicy: JSON.parse(String(row.logPolicyJson)) as LogPolicy, createdAt: String(row.createdAt), updatedAt: String(row.updatedAt) }; }
function defaultStateDirectory(): string { const base = process.env.XDG_STATE_HOME || (platform() === 'darwin' ? join(homedir(), 'Library', 'Application Support') : join(homedir(), '.local', 'state')); return join(base, 'dockyard'); }
