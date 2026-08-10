import { Injectable, NotFoundException, OnModuleDestroy, RequestTimeoutException } from '@nestjs/common';
import { appendFileSync, mkdirSync, readdirSync, renameSync, statSync, unlinkSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { EventEmitter } from 'node:events';
import { spawn, type ChildProcess } from 'node:child_process';
import { redactCommandForDisplay, redactDisplayText, redactDisplayValue, type Application, type ApplicationStatus, type LogStream } from '@dockyard/core';
import { DatabaseService } from './database.service.js';

interface Runtime { child: ChildProcess; application: Application; status: ApplicationStatus; startedAt: number; retries: number; manuallyStopped: boolean; }
export interface LogMessage { applicationId: string; stream: LogStream; at: string; line: string; }

@Injectable()
export class RuntimeService implements OnModuleDestroy {
  private readonly runtimes = new Map<string, Runtime>();
  private readonly terminalStatuses = new Map<string, ApplicationStatus>();
  private readonly logs = new EventEmitter();
  private readonly sampler: ReturnType<typeof setInterval>;
  constructor(private readonly database: DatabaseService) { this.sampler = setInterval(() => this.sample(), 5_000); this.sampler.unref(); }
  onModuleDestroy(): void { clearInterval(this.sampler); for (const id of this.runtimes.keys()) void this.stop(id); }
  applications(): Application[] { return this.database.db.listApplications().map((application) => this.withStatus(application)); }
  application(id: string): Application { const application = this.database.db.getApplication(id); if (!application) throw new NotFoundException('应用不存在。'); return this.withStatus(application); }
  events(id: string) { this.application(id); return this.database.db.events(id).map((event) => ({ ...event, detail: redactDisplayValue(event.detail) as Record<string, unknown> })); }
  metrics(id: string) { this.application(id); return this.database.db.metrics(id, new Date(Date.now() - 24 * 60 * 60 * 1_000).toISOString()); }
  async diagnostics(id: string): Promise<{ path: string }> { const application = this.application(id); const directory = this.database.db.pathResolver.diagnosticsDirectory(id); const path = `${directory}.json`; await mkdir(dirname(path), { recursive: true }); await writeFile(path, JSON.stringify({ generatedAt: new Date().toISOString(), application: { ...application, command: redactCommandForDisplay(application.command) }, events: this.events(id), metrics: this.metrics(id) }, null, 2), { encoding: 'utf8', flag: 'wx' }); this.database.db.recordEvent({ applicationId: id, type: 'diagnostics-exported', detail: { path } }); return { path }; }
  async start(id: string): Promise<Application> { const application = this.application(id); if (this.runtimes.has(id)) return application; this.terminalStatuses.delete(id); this.launch(application, 0); return this.application(id); }
  async restart(id: string): Promise<Application> { await this.stop(id); return this.start(id); }
  async stop(id: string): Promise<Application> { const runtime = this.runtimes.get(id); this.terminalStatuses.set(id, 'stopped'); if (!runtime) return this.application(id); runtime.manuallyStopped = true; runtime.status = 'stopped'; const exited = new Promise<void>((done) => runtime.child.once('exit', () => done())); runtime.child.kill('SIGTERM'); try { await Promise.race([exited, new Promise<never>((_, reject) => { const timer = setTimeout(() => reject(new RequestTimeoutException('应用未在 5 秒内优雅退出。未配置强制终止，因此它仍在运行；请检查日志或在应用策略中明确允许强制终止。')), 5_000); timer.unref(); })]); } catch (error) { runtime.manuallyStopped = false; runtime.status = 'running'; this.terminalStatuses.set(id, 'running'); throw error; } this.database.db.recordEvent({ applicationId: id, type: 'stopped', detail: { signal: 'SIGTERM' } }); return this.application(id); }
  reloadRunningPolicies(): void { for (const [id, runtime] of this.runtimes) { const current = this.database.db.getApplication(id); if (current) runtime.application = current; } }
  onLog(listener: (message: LogMessage) => void): () => void { this.logs.on('line', listener); return () => this.logs.off('line', listener); }
  private launch(application: Application, retries: number): void {
    const child = spawn(application.command.executable, [...application.command.args], { cwd: application.cwd, shell: false, stdio: ['ignore', 'pipe', 'pipe'], env: inheritedEnvironment() });
    const runtime: Runtime = { child, application, status: 'running', startedAt: Date.now(), retries, manuallyStopped: false }; this.runtimes.set(application.id, runtime);
    const logDirectory = this.database.db.pathResolver.logDirectory(application.projectId, application.id); mkdirSync(logDirectory, { recursive: true });
    if (child.stdout) this.pipeLogs(application.id, 'stdout', child.stdout, logDirectory, () => runtime.application.logPolicy);
    if (child.stderr) this.pipeLogs(application.id, 'stderr', child.stderr, logDirectory, () => runtime.application.logPolicy);
    this.database.db.recordEvent({ applicationId: application.id, type: 'started', detail: { command: redactCommandForDisplay(application.command), cwd: application.cwd, pid: child.pid } });
    child.once('error', (error) => this.finish(application.id, runtime, null, null, error.message));
    child.once('exit', (code, signal) => this.finish(application.id, runtime, code, signal, undefined));
  }
  private pipeLogs(applicationId: string, stream: LogStream, source: NodeJS.ReadableStream, directory: string, policy: () => Application['logPolicy']): void { let buffered = ''; source.on('data', (data: Buffer) => { appendRotatedLog(directory, stream, data, policy()); buffered += data.toString('utf8'); const lines = buffered.split(/\r?\n/); buffered = lines.pop() ?? ''; for (const line of lines) this.logs.emit('line', { applicationId, stream, at: new Date().toISOString(), line: redactDisplayText(line) }); }); source.on('end', () => { if (buffered) this.logs.emit('line', { applicationId, stream, at: new Date().toISOString(), line: redactDisplayText(buffered) }); }); }
  private finish(applicationId: string, runtime: Runtime, code: number | null, signal: NodeJS.Signals | null, error: string | undefined): void {
    if (this.runtimes.get(applicationId) !== runtime) return; this.runtimes.delete(applicationId); const application = runtime.application; const elapsed = Date.now() - runtime.startedAt;
    this.database.db.recordEvent({ applicationId, type: 'exited', detail: { code, signal, error, runtimeMs: elapsed } });
    const shouldRetry = !runtime.manuallyStopped && (application.restartPolicy.mode === 'always' || (application.restartPolicy.mode === 'on-failure' && code !== 0));
    if (!shouldRetry) { this.terminalStatuses.set(application.id, runtime.manuallyStopped ? 'stopped' : code === 0 ? 'stopped' : 'crashed'); return; }
    if (elapsed >= application.restartPolicy.stableWindowMs) runtime.retries = 0;
    if (runtime.retries >= application.restartPolicy.maxRetries) { this.terminalStatuses.set(application.id, 'crashed'); this.database.db.recordEvent({ applicationId: application.id, type: 'crashed', detail: { reason: 'restart-budget-exhausted', retries: runtime.retries } }); return; }
    const delay = application.restartPolicy.retryDelayMs * 2 ** runtime.retries; this.database.db.recordEvent({ applicationId: application.id, type: 'restart-scheduled', detail: { delayMs: delay, retry: runtime.retries + 1 } }); const timer = setTimeout(() => this.launch(application, runtime.retries + 1), delay); timer.unref();
  }
  private withStatus(application: Application): Application { return { ...application, status: this.runtimes.get(application.id)?.status ?? this.terminalStatuses.get(application.id) ?? 'stopped' }; }
  private sample(): void { for (const [applicationId, runtime] of this.runtimes) this.database.db.recordMetric({ applicationId, sampledAt: new Date().toISOString(), uptimeMs: Date.now() - runtime.startedAt, restartCount: runtime.retries, rssBytes: null }); }
}
function inheritedEnvironment(): NodeJS.ProcessEnv {
  const names = ['PATH', 'HOME', 'USER', 'TMPDIR', 'TEMP', 'TMP', 'LANG', 'TERM', 'SystemRoot'];
  const entries = names.flatMap((name): [string, string][] => {
    const value = process.env[name];
    return value === undefined ? [] : [[name, value]];
  });
  return Object.fromEntries(entries);
}
function appendRotatedLog(directory: string, stream: LogStream, data: Buffer, policy: Application['logPolicy']): void { const path = `${directory}/${stream}.log`; if (existsAndExceeds(path, data.length, policy.maxBytesPerFile)) { const archive = `${directory}/archive`; mkdirSync(archive, { recursive: true }); renameSync(path, `${archive}/${stream}-${Date.now()}.log`); pruneArchives(archive, policy); } appendFileSync(path, data); }
function existsAndExceeds(path: string, incoming: number, limit: number): boolean { try { return statSync(path).size + incoming > limit; } catch { return false; } }
function pruneArchives(directory: string, policy: Application['logPolicy']): void { const cutoff = Date.now() - policy.retentionDays * 86_400_000; const files = readdirSync(directory).map((name) => ({ name, path: `${directory}/${name}`, stat: statSync(`${directory}/${name}`) })).sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs); for (const file of files.slice(policy.maxFiles)) unlinkSync(file.path); for (const file of files) if (file.stat.mtimeMs < cutoff) { try { unlinkSync(file.path); } catch {} } }
