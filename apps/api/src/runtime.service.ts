import { Injectable, NotFoundException, OnApplicationBootstrap, OnModuleDestroy, RequestTimeoutException } from '@nestjs/common';
import { appendFileSync, mkdirSync, readdirSync, renameSync, statSync, unlinkSync } from 'node:fs';
import { mkdir, open, readlink, stat, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { EventEmitter } from 'node:events';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { platform } from 'node:os';
import { promisify } from 'node:util';
import { redactCommandForDisplay, redactDisplayText, redactDisplayValue, type Application, type ApplicationStatus, type LogCaptureStatus, type LogStream, type MetricRollup, type Project, type ProjectSettings, type RuntimeOwnership } from '@dockyard/core';
import { DatabaseService } from './database.service.js';
import { startInspectorLogCapture, type InspectorLogCapture } from './inspector-log-capture.js';

interface Runtime {
  child?: ChildProcess;
  pid: number | null;
  ownership: Exclude<RuntimeOwnership, null>;
  application: Application;
  status: ApplicationStatus;
  startedAt: number;
  retries: number;
  manuallyStopped: boolean;
  listeningPorts: readonly number[];
  externalLogs?: Partial<Record<LogStream, ExternalLogCursor>>;
  inspectorCapture?: InspectorLogCapture;
  logBuffers: Partial<Record<LogStream, string>>;
}

export interface HostProcess { pid: number; ppid: number; startedAt: number; command: string; cwd?: string; }
export interface ObservedProcess { pid: number; startedAt: number; listeningPorts: readonly number[]; }
interface ExternalLogCursor { path: string; position: number; }
interface RestartRequest { application: Application; retries: number; }
interface ProjectRuntime { child: ChildProcess; project: Project; status: ApplicationStatus; startedAt: number; retries: number; manuallyStopped: boolean; }
export interface LogMessage { applicationId: string; stream: LogStream; at: string; line: string; }
export type RuntimeUpdate = { type: 'application'; application: Application } | { type: 'metric'; metric: MetricRollup } | { type: 'project'; project: Project };

const execFileAsync = promisify(execFile);
const nodeRelatedCommand = /\b(?:node(?:js)?|npm|pnpm|yarn|bun|vite|next|webpack|ts-node|tsx|deno)\b/iu;
const maxLogReadBytes = 64 * 1_024;
const gracefulShutdownTimeoutMs = 2_000;

export interface ChildTerminationOptions { processGroup?: boolean; gracePeriodMs?: number; }

@Injectable()
export class RuntimeService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly runtimes = new Map<string, Runtime>();
  private readonly terminalStatuses = new Map<string, ApplicationStatus>();
  private readonly retryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly restartQueues = new Map<string, RestartRequest[]>();
  private readonly restartingProjects = new Set<string>();
  private readonly projectRuntimes = new Map<string, ProjectRuntime>();
  private readonly projectTerminalStatuses = new Map<string, ApplicationStatus>();
  private readonly projectRetryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly stoppingProjects = new Set<string>();
  private readonly logs = new EventEmitter();
  private readonly updates = new EventEmitter();
  private metricRetentionDays = 7;
  private sampler: ReturnType<typeof setInterval>;
  private discovering = false;

  constructor(private readonly database: DatabaseService) { this.sampler = this.createSampler(1_000); }

  onApplicationBootstrap(): void { const settings = this.database.db.settings(); this.metricRetentionDays = settings.metricRetentionDays; this.setSampleInterval(settings.sampleIntervalMs); }
  onModuleDestroy(): void {
    clearInterval(this.sampler);
    for (const timer of this.retryTimers.values()) clearTimeout(timer);
    for (const timer of this.projectRetryTimers.values()) clearTimeout(timer);
    this.retryTimers.clear();
    this.restartQueues.clear();
    for (const runtime of this.runtimes.values()) runtime.inspectorCapture?.close();
    for (const runtime of this.runtimes.values()) if (runtime.ownership === 'dockyard') runtime.child?.kill('SIGTERM');
    for (const runtime of this.projectRuntimes.values()) runtime.child.kill('SIGTERM');
  }

  projects(): Project[] { return this.database.db.listProjects().map((project) => this.withProjectRuntime(project)); }
  applications(): Application[] { return this.database.db.listApplications().map((application) => this.withStatus(application)); }
  application(id: string): Application { const application = this.database.db.getApplication(id); if (!application) throw new NotFoundException('应用不存在。'); return this.withStatus(application); }
  events(id: string) { this.application(id); return this.database.db.events(id).map((event) => ({ ...event, detail: redactDisplayValue(event.detail) as Record<string, unknown> })); }
  metrics(id: string, window: 'recent' | 'day' = 'recent') { this.application(id); const since = new Date(Date.now() - (window === 'day' ? 24 * 60 * 60 * 1_000 : this.metricRetentionDays * 86_400_000)).toISOString(); return this.database.db.metrics(id, since, window === 'recent' ? 60 : undefined); }
  async diagnostics(id: string): Promise<{ path: string }> { const application = this.application(id); const directory = this.database.db.pathResolver.diagnosticsDirectory(id); const path = `${directory}.json`; await mkdir(dirname(path), { recursive: true }); await writeFile(path, JSON.stringify({ generatedAt: new Date().toISOString(), application: { ...application, command: redactCommandForDisplay(application.command) }, events: this.events(id), metrics: this.metrics(id) }, null, 2), { encoding: 'utf8', flag: 'wx' }); this.database.db.recordEvent({ applicationId: id, type: 'diagnostics-exported', detail: { path } }); return { path }; }

  async start(id: string): Promise<Application> { const application = this.application(id); if (this.runtimes.has(id)) return application; this.stoppingProjects.delete(application.projectId); this.cancelRetry(id); this.terminalStatuses.delete(id); this.launch(application, 0); return this.application(id); }
  async restart(id: string): Promise<Application> { await this.stop(id); return this.start(id); }
  async enableInspectorLogCapture(id: string): Promise<Application> {
    const runtime = this.runtimes.get(id);
    if (!runtime || runtime.ownership !== 'external' || !runtime.pid) throw new RequestTimeoutException('仅运行中的外部 Node 应用可启用 Inspector 日志捕获。');
    if (runtime.inspectorCapture) return this.application(id);
    const captured = await startInspectorLogCapture(runtime.pid, (stream, data) => {
      if (this.runtimes.get(id) !== runtime) return;
      const directory = this.database.db.pathResolver.logDirectory(runtime.application.projectId, runtime.application.id);
      mkdirSync(directory, { recursive: true });
      this.recordLogData(runtime, stream, data, directory);
    }, () => {
      if (runtime.inspectorCapture === captured) { delete runtime.inspectorCapture; this.emitApplication(id); }
    });
    runtime.inspectorCapture = captured;
    this.database.db.recordEvent({ applicationId: id, type: 'external-log-following', detail: { streams: ['stdout', 'stderr'], source: 'node-inspector' } });
    this.emitApplication(id);
    return this.application(id);
  }
  async startProject(projectId: string): Promise<Application[]> { const project = this.project(projectId); if (this.shouldUseProjectEntrypoint(project)) { this.startProjectEntrypoint(project); return []; } const applications = this.database.db.listApplications(projectId); const startup = project.settings.startupApplicationIds.length ? applications.filter((application) => project.settings.startupApplicationIds.includes(application.id)) : applications; return Promise.all(startup.map((application) => this.start(application.id))); }
  async stopProject(projectId: string): Promise<Application[]> { const project = this.project(projectId); const projectRuntime = this.projectRuntimes.get(projectId); if (projectRuntime) { await this.stopProjectEntrypoint(projectRuntime); return []; } if (this.projectRetryTimers.has(projectId)) { this.stoppingProjects.add(projectId); this.cancelProjectRetry(projectId); this.cancelModuleRestarts(projectId); this.projectTerminalStatuses.set(projectId, 'stopped'); this.database.db.recordProjectEvent(projectId, 'stopped', { entrypoint: project.settings.selectedProjectEntrypoint, source: 'dockyard', reason: 'restart-cancelled' }); this.emitProject(projectId); return []; } const applications = this.database.db.listApplications(projectId); return Promise.all(applications.map((application) => this.stop(application.id))); }
  async restartProject(projectId: string): Promise<Application[]> { await this.stopProject(projectId); return this.startProject(projectId); }
  async deleteProject(projectId: string): Promise<void> { this.project(projectId); await this.stopProject(projectId); this.database.db.deleteProject(projectId); }
  updatePolicies(id: string, restartPolicy: Application['restartPolicy'], logPolicy: Application['logPolicy']): Application { const application = this.database.db.updateApplicationPolicies(id, restartPolicy, logPolicy); const runtime = this.runtimes.get(id); if (runtime) runtime.application = application; return this.withStatus(application); }
  updateCommand(id: string, selectedCommand: string): Application { if (this.runtimes.has(id)) throw new RequestTimeoutException('运行中的应用不能切换启动命令；请先停止它。'); return this.withStatus(this.database.db.updateApplicationCommand(id, selectedCommand)); }
  updateProjectSettings(projectId: string, settings: ProjectSettings) { const project = this.database.db.updateProjectSettings(projectId, settings); this.reloadRunningPolicies(); const runtime = this.projectRuntimes.get(projectId); if (runtime) runtime.project = project; this.emitProject(projectId); return this.withProjectRuntime(project); }
  setSampleInterval(intervalMs: number): void { clearInterval(this.sampler); this.sampler = this.createSampler(intervalMs); this.sample(); }
  setMetricRetentionDays(days: number): void { this.metricRetentionDays = days; }

  async stop(id: string): Promise<Application> {
    const runtime = this.runtimes.get(id);
    this.cancelRetry(id);
    this.terminalStatuses.set(id, 'stopped');
    if (!runtime) return this.application(id);
    if (runtime.ownership === 'external') return this.stopExternal(id, runtime);
    runtime.manuallyStopped = true;
    runtime.status = 'stopped';
    if (!runtime.child) throw new RequestTimeoutException('托管应用缺少子进程句柄，无法安全停止。');
    let signal: NodeJS.Signals;
    try { signal = await terminateChildProcess(runtime.child, { processGroup: platform() !== 'win32' }); }
    catch (error) { runtime.status = 'running'; this.terminalStatuses.set(id, 'running'); throw error; }
    this.database.db.recordEvent({ applicationId: id, type: 'stopped', detail: { signal, forced: signal === 'SIGKILL', source: 'dockyard' } });
    return this.application(id);
  }

  reloadRunningPolicies(): void { for (const [id, runtime] of this.runtimes) { const current = this.database.db.getApplication(id); if (current) runtime.application = current; } }
  onLog(listener: (message: LogMessage) => void): () => void { this.logs.on('line', listener); return () => this.logs.off('line', listener); }
  async logTail(id: string, stream: LogStream): Promise<LogMessage[]> {
    const application = this.application(id);
    const path = `${this.database.db.pathResolver.logDirectory(application.projectId, application.id)}/${stream}.log`;
    const [lines, info] = await Promise.all([readLogTail(path), stat(path).catch(() => null)]);
    const at = info?.isFile() ? info.mtime.toISOString() : new Date(0).toISOString();
    return lines.map((line) => ({ applicationId: id, stream, at, line: redactDisplayText(line) }));
  }
  onUpdate(listener: (update: RuntimeUpdate) => void): () => void { this.updates.on('update', listener); return () => this.updates.off('update', listener); }

  private launch(application: Application, retries: number): void {
    const child = spawn(application.command.executable, [...application.command.args], { cwd: application.cwd, shell: false, detached: platform() !== 'win32', stdio: ['ignore', 'pipe', 'pipe'], env: inheritedEnvironment() });
    const runtime: Runtime = { child, pid: child.pid ?? null, ownership: 'dockyard', application, status: 'running', startedAt: Date.now(), retries, manuallyStopped: false, listeningPorts: [], logBuffers: {} };
    this.runtimes.set(application.id, runtime);
    this.emitApplication(application.id);
    const logDirectory = this.database.db.pathResolver.logDirectory(application.projectId, application.id); mkdirSync(logDirectory, { recursive: true });
    if (child.stdout) this.pipeLogs(runtime, 'stdout', child.stdout, logDirectory);
    if (child.stderr) this.pipeLogs(runtime, 'stderr', child.stderr, logDirectory);
    this.database.db.recordEvent({ applicationId: application.id, type: 'started', detail: { command: redactCommandForDisplay(application.command), cwd: application.cwd, pid: child.pid, source: 'dockyard' } });
    child.once('error', (error) => this.finish(application.id, runtime, null, null, error.message));
    child.once('exit', (code, signal) => this.finish(application.id, runtime, code, signal, undefined));
  }

  private startProjectEntrypoint(project: Project, retries = 0): void {
    if (this.projectRuntimes.has(project.id)) return;
    const entrypoint = this.entrypointFor(project);
    if (!entrypoint) throw new RequestTimeoutException('项目优先模式需要先在项目设置中选择项目级启动入口。');
    this.cancelProjectRetry(project.id);
    this.stoppingProjects.delete(project.id);
    this.cancelModuleRestarts(project.id);
    this.projectTerminalStatuses.delete(project.id);
    const child = spawn(entrypoint.command.executable, [...entrypoint.command.args], { cwd: project.path, shell: false, detached: platform() !== 'win32', stdio: 'ignore', env: inheritedEnvironment() });
    const runtime: ProjectRuntime = { child, project, status: 'running', startedAt: Date.now(), retries, manuallyStopped: false };
    this.projectRuntimes.set(project.id, runtime);
    this.database.db.recordProjectEvent(project.id, 'started', { entrypoint: entrypoint.name, command: redactCommandForDisplay(entrypoint.command), pid: child.pid, source: 'dockyard' });
    this.emitProject(project.id);
    child.once('error', (error) => this.finishProjectEntrypoint(project.id, runtime, null, null, error.message));
    child.once('exit', (code, signal) => this.finishProjectEntrypoint(project.id, runtime, code, signal, undefined));
  }
  private async stopProjectEntrypoint(runtime: ProjectRuntime): Promise<void> {
    this.stoppingProjects.add(runtime.project.id);
    this.cancelModuleRestarts(runtime.project.id);
    runtime.manuallyStopped = true;
    runtime.status = 'stopped';
    this.cancelProjectRetry(runtime.project.id);
    let signal: NodeJS.Signals;
    try { signal = await terminateChildProcess(runtime.child, { processGroup: platform() !== 'win32' }); }
    catch (error) { this.stoppingProjects.delete(runtime.project.id); runtime.status = 'running'; throw error; }
    this.database.db.recordProjectEvent(runtime.project.id, 'stopped', { entrypoint: runtime.project.settings.selectedProjectEntrypoint, signal, forced: signal === 'SIGKILL', source: 'dockyard' });
  }
  private finishProjectEntrypoint(projectId: string, runtime: ProjectRuntime, code: number | null, signal: NodeJS.Signals | null, error: string | undefined): void {
    if (this.projectRuntimes.get(projectId) !== runtime) return;
    this.projectRuntimes.delete(projectId);
    const project = runtime.project;
    this.database.db.recordProjectEvent(projectId, 'exited', { entrypoint: project.settings.selectedProjectEntrypoint, code, signal, error, runtimeMs: Date.now() - runtime.startedAt, source: 'dockyard' });
    const failed = code !== 0;
    const shouldRetry = !runtime.manuallyStopped && (project.settings.restartPolicy.mode === 'always' || (project.settings.restartPolicy.mode === 'on-failure' && failed));
    if (!shouldRetry) { this.projectTerminalStatuses.set(projectId, runtime.manuallyStopped || code === 0 ? 'stopped' : 'crashed'); this.emitProject(projectId); return; }
    if (Date.now() - runtime.startedAt >= project.settings.restartPolicy.stableWindowMs) runtime.retries = 0;
    if (runtime.retries >= project.settings.restartPolicy.maxRetries) { this.projectTerminalStatuses.set(projectId, 'crashed'); this.database.db.recordProjectEvent(projectId, 'crashed', { reason: 'restart-budget-exhausted', retries: runtime.retries }); this.emitProject(projectId); return; }
    this.cancelModuleRestarts(projectId);
    this.projectTerminalStatuses.set(projectId, 'restarting');
    this.emitProject(projectId);
    const delay = project.settings.restartPolicy.retryDelayMs * 2 ** runtime.retries;
    this.database.db.recordProjectEvent(projectId, 'restart-scheduled', { delayMs: delay, retry: runtime.retries + 1 });
    const timer = setTimeout(() => { this.projectRetryTimers.delete(projectId); this.startProjectEntrypoint(project, runtime.retries + 1); }, delay);
    timer.unref();
    this.projectRetryTimers.set(projectId, timer);
    void error;
  }

  private async stopExternal(id: string, runtime: Runtime): Promise<Application> {
    if (!runtime.pid) throw new RequestTimeoutException('外部进程缺少 PID，无法安全停止。');
    if (!await this.isCurrentExternalRuntime(runtime)) {
      runtime.status = 'running';
      this.terminalStatuses.set(id, 'running');
      throw new RequestTimeoutException('外部进程已变化，已拒绝发送信号；请刷新后确认目标。');
    }
    runtime.manuallyStopped = true;
    runtime.status = 'stopped';
    let signal: NodeJS.Signals = 'SIGTERM';
    try {
      process.kill(runtime.pid, signal);
      await waitForProcessExit(runtime.pid, gracefulShutdownTimeoutMs);
    } catch (error) {
      if (!(error instanceof RequestTimeoutException)) { runtime.status = 'running'; runtime.manuallyStopped = false; this.terminalStatuses.set(id, 'running'); throw new RequestTimeoutException(`无法向外部进程发送 SIGTERM：${error instanceof Error ? error.message : '未知错误'}`); }
      if (!await this.isCurrentExternalRuntime(runtime)) { runtime.status = 'running'; runtime.manuallyStopped = false; this.terminalStatuses.set(id, 'running'); throw new RequestTimeoutException('外部进程在强制终止前已变化，已拒绝向可能复用的 PID 发送 SIGKILL。'); }
      signal = 'SIGKILL';
      try { process.kill(runtime.pid, signal); await waitForProcessExit(runtime.pid, gracefulShutdownTimeoutMs); }
      catch (forceError) { runtime.status = 'running'; runtime.manuallyStopped = false; this.terminalStatuses.set(id, 'running'); throw new RequestTimeoutException(`外部进程在 SIGKILL 后仍未退出：${forceError instanceof Error ? forceError.message : '未知错误'}`); }
    }
    if (this.runtimes.get(id) === runtime) this.runtimes.delete(id);
    this.database.db.recordEvent({ applicationId: id, type: 'exited', detail: { code: null, signal, runtimeMs: Date.now() - runtime.startedAt, source: 'external' } });
    this.database.db.recordEvent({ applicationId: id, type: 'stopped', detail: { signal, forced: signal === 'SIGKILL', source: 'external' } });
    this.emitApplication(id);
    return this.application(id);
  }

  private pipeLogs(runtime: Runtime, stream: LogStream, source: NodeJS.ReadableStream, directory: string): void {
    source.on('data', (data: Buffer) => this.recordLogData(runtime, stream, data, directory));
    source.on('end', () => this.flushLogBuffer(runtime, stream));
  }
  private recordLogData(runtime: Runtime, stream: LogStream, data: Buffer, directory: string): void {
    appendRotatedLog(directory, stream, data, runtime.application.logPolicy);
    const lines = `${runtime.logBuffers[stream] ?? ''}${data.toString('utf8')}`.split(/\r?\n/);
    runtime.logBuffers[stream] = lines.pop() ?? '';
    for (const line of lines) this.logs.emit('line', { applicationId: runtime.application.id, stream, at: new Date().toISOString(), line: redactDisplayText(line) });
  }
  private flushLogBuffer(runtime: Runtime, stream: LogStream): void {
    const line = runtime.logBuffers[stream];
    if (line) this.logs.emit('line', { applicationId: runtime.application.id, stream, at: new Date().toISOString(), line: redactDisplayText(line) });
    delete runtime.logBuffers[stream];
  }

  private finish(applicationId: string, runtime: Runtime, code: number | null, signal: NodeJS.Signals | null, error: string | undefined): void {
    if (this.runtimes.get(applicationId) !== runtime) return;
    runtime.inspectorCapture?.close();
    this.runtimes.delete(applicationId);
    const application = runtime.application;
    const elapsed = Date.now() - runtime.startedAt;
    this.database.db.recordEvent({ applicationId, type: 'exited', detail: { code, signal, error, runtimeMs: elapsed, source: runtime.ownership } });
    const failed = runtime.ownership === 'external' || code !== 0;
    const projectOwnsLifecycle = this.projectRuntimes.has(application.projectId) || this.projectRetryTimers.has(application.projectId) || this.stoppingProjects.has(application.projectId);
    const shouldRetry = !projectOwnsLifecycle && !runtime.manuallyStopped && (application.restartPolicy.mode === 'always' || (application.restartPolicy.mode === 'on-failure' && failed));
    if (!shouldRetry) { this.terminalStatuses.set(application.id, runtime.manuallyStopped || this.stoppingProjects.has(application.projectId) || code === 0 ? 'stopped' : 'crashed'); this.emitApplication(application.id); return; }
    if (elapsed >= application.restartPolicy.stableWindowMs) runtime.retries = 0;
    if (runtime.retries >= application.restartPolicy.maxRetries) { this.terminalStatuses.set(application.id, 'crashed'); this.database.db.recordEvent({ applicationId: application.id, type: 'crashed', detail: { reason: 'restart-budget-exhausted', retries: runtime.retries, source: runtime.ownership } }); this.emitApplication(application.id); return; }
    const delay = application.restartPolicy.retryDelayMs * 2 ** runtime.retries;
    this.terminalStatuses.set(application.id, 'restarting');
    this.emitApplication(application.id);
    this.database.db.recordEvent({ applicationId: application.id, type: 'restart-scheduled', detail: { delayMs: delay, retry: runtime.retries + 1, source: runtime.ownership } });
    const timer = setTimeout(() => { this.retryTimers.delete(application.id); this.enqueueRestart(application, runtime.retries + 1); }, delay);
    timer.unref();
    this.retryTimers.set(application.id, timer);
  }

  private cancelRetry(id: string): void {
    const timer = this.retryTimers.get(id);
    if (timer) clearTimeout(timer);
    this.retryTimers.delete(id);
    for (const queue of this.restartQueues.values()) {
      const index = queue.findIndex((request) => request.application.id === id);
      if (index >= 0) queue.splice(index, 1);
    }
  }
  private cancelProjectRetry(id: string): void { const timer = this.projectRetryTimers.get(id); if (timer) clearTimeout(timer); this.projectRetryTimers.delete(id); }
  private cancelModuleRestarts(projectId: string): void { for (const application of this.database.db.listApplications(projectId)) this.cancelRetry(application.id); }
  private enqueueRestart(application: Application, retries: number): void {
    const queue = this.restartQueues.get(application.projectId) ?? [];
    queue.push({ application, retries });
    this.restartQueues.set(application.projectId, queue);
    if (this.restartingProjects.has(application.projectId)) return;
    this.restartingProjects.add(application.projectId);
    void this.drainProjectRestartQueue(application.projectId);
  }
  private async drainProjectRestartQueue(projectId: string): Promise<void> {
    try {
      const queue = this.restartQueues.get(projectId);
      while (queue?.length) {
        const request = queue.shift()!;
        if (!this.runtimes.has(request.application.id)) this.launch(request.application, request.retries);
        await new Promise((done) => setTimeout(done, 50));
      }
    } finally {
      this.restartQueues.delete(projectId);
      this.restartingProjects.delete(projectId);
    }
  }
  private withStatus(application: Application): Application { const runtime = this.runtimes.get(application.id); return { ...application, status: runtime?.status ?? this.terminalStatuses.get(application.id) ?? 'stopped', pid: runtime?.pid ?? null, runtimeOwnership: runtime?.ownership ?? null, logCaptureStatus: logCaptureStatusFor(runtime), listeningPorts: runtime?.listeningPorts ?? [] }; }
  private withProjectRuntime(project: Project): Project { const runtime = this.projectRuntimes.get(project.id); return { ...project, runtime: { status: runtime?.status ?? this.projectTerminalStatuses.get(project.id) ?? 'stopped', pid: runtime?.child.pid ?? null, ownership: runtime ? 'dockyard' : null, selectedEntrypoint: project.settings.selectedProjectEntrypoint } }; }
  private project(id: string) { const project = this.database.db.listProjects().find((item) => item.id === id); if (!project) throw new NotFoundException('项目不存在。'); return this.withProjectRuntime(project); }
  private entrypointFor(project: Project) { return project.settings.selectedProjectEntrypoint === null ? null : project.settings.projectEntrypointOptions.find((option) => option.name === project.settings.selectedProjectEntrypoint) ?? null; }
  private shouldUseProjectEntrypoint(project: Project): boolean { const hasEntrypoint = this.entrypointFor(project) !== null; if (project.settings.startupPreference === 'project-first') { if (!hasEntrypoint) throw new RequestTimeoutException('项目优先模式需要先在项目设置中选择项目级启动入口。'); return true; } return project.settings.startupPreference === 'automatic' && hasEntrypoint; }
  private sample(): void { void this.reconcileExternalRuntimes(); for (const [applicationId, runtime] of this.runtimes) void this.sampleRuntime(applicationId, runtime); }
  private createSampler(intervalMs: number): ReturnType<typeof setInterval> { const sampler = setInterval(() => this.sample(), intervalMs); sampler.unref(); return sampler; }

  private async reconcileExternalRuntimes(): Promise<void> {
    if (this.discovering || platform() === 'win32') return;
    this.discovering = true;
    try {
      const result = await listHostProcesses();
      if (!result.available) return;
      const applications = this.database.db.listApplications();
      const matches = new Map(applications.map((application) => [application.id, matchingProcesses(application, result.processes)]));
      const pids = [...new Set([...matches.values()].flatMap((processes) => processes.map((process) => process.pid)))];
      const ports = await listeningPortsByPid(pids);
      for (const application of applications) {
        const runtime = this.runtimes.get(application.id);
        const observed = selectObservedProcess(matches.get(application.id) ?? [], ports);
        if (runtime?.ownership === 'dockyard') {
          const nextPorts = observed?.listeningPorts ?? [];
          const nextPid = observed?.pid ?? runtime.child?.pid ?? runtime.pid;
          const nextStartedAt = observed?.startedAt ?? runtime.startedAt;
          if (runtime.pid !== nextPid || runtime.startedAt !== nextStartedAt || !samePorts(runtime.listeningPorts, nextPorts)) {
            runtime.pid = nextPid;
            runtime.startedAt = nextStartedAt;
            runtime.listeningPorts = nextPorts;
            this.emitApplication(application.id);
          }
          continue;
        }
        if (observed) await this.adoptExternalRuntime(application, runtime, observed);
        else if (runtime?.ownership === 'external') this.finish(application.id, runtime, null, null, '外部进程已从本机进程表消失。');
      }
    } finally { this.discovering = false; }
  }

  private async adoptExternalRuntime(application: Application, runtime: Runtime | undefined, observed: ObservedProcess): Promise<void> {
    if (!runtime) {
      this.cancelRetry(application.id);
      const adopted: Runtime = { pid: observed.pid, ownership: 'external', application, status: 'running', startedAt: observed.startedAt, retries: 0, manuallyStopped: false, listeningPorts: observed.listeningPorts, logBuffers: {}, externalLogs: await externalLogCursors(observed.pid) };
      this.runtimes.set(application.id, adopted);
      this.terminalStatuses.delete(application.id);
      this.database.db.recordEvent({ applicationId: application.id, type: 'started', detail: { pid: observed.pid, listeningPorts: observed.listeningPorts, source: 'external-discovery' } });
      const streams = Object.keys(adopted.externalLogs ?? {}) as LogStream[];
      this.database.db.recordEvent({ applicationId: application.id, type: streams.length ? 'external-log-following' : 'external-log-unavailable', detail: streams.length ? { streams, source: 'file-descriptor' } : { reason: 'stdout-stderr-not-file-backed' } });
      await this.collectExternalLogs(adopted);
      this.emitApplication(application.id);
      return;
    }
    const changed = runtime.pid !== observed.pid || !samePorts(runtime.listeningPorts, observed.listeningPorts);
    runtime.application = application;
    runtime.pid = observed.pid;
    runtime.startedAt = observed.startedAt;
    runtime.listeningPorts = observed.listeningPorts;
    runtime.status = 'running';
    if (changed) { runtime.inspectorCapture?.close(); delete runtime.inspectorCapture; runtime.externalLogs = await externalLogCursors(observed.pid); }
    await this.collectExternalLogs(runtime);
    if (changed) this.emitApplication(application.id);
  }

  private async collectExternalLogs(runtime: Runtime): Promise<void> {
    if (runtime.ownership !== 'external' || !runtime.externalLogs) return;
    const directory = this.database.db.pathResolver.logDirectory(runtime.application.projectId, runtime.application.id);
    mkdirSync(directory, { recursive: true });
    await Promise.all((Object.entries(runtime.externalLogs) as Array<[LogStream, ExternalLogCursor]>).map(async ([stream, cursor]) => {
      const next = await readLogChunk(cursor.path, cursor.position);
      if (!next) return;
      cursor.position = next.position;
      if (next.data.length) this.recordLogData(runtime, stream, next.data, directory);
    }));
  }

  private async sampleRuntime(applicationId: string, runtime: Runtime): Promise<void> {
    const process = await inspectProcess(runtime.pid ?? undefined);
    if (this.runtimes.get(applicationId) !== runtime) return;
    const metric: MetricRollup = { applicationId, sampledAt: new Date().toISOString(), pid: runtime.pid, cpuPercent: process?.cpuPercent ?? null, uptimeMs: Date.now() - runtime.startedAt, restartCount: runtime.retries, rssBytes: process?.rssBytes ?? null };
    this.database.db.recordMetric(metric, this.metricRetentionDays);
    this.updates.emit('update', { type: 'metric', metric } satisfies RuntimeUpdate);
  }
  private async isCurrentExternalRuntime(runtime: Runtime): Promise<boolean> {
    const result = await listHostProcesses();
    if (!result.available || runtime.pid === null) return false;
    return matchingProcesses(runtime.application, result.processes).some((process) => sameProcessIdentity(runtime.pid!, runtime.startedAt, process));
  }
  private emitApplication(id: string): void { const application = this.database.db.getApplication(id); if (application) this.updates.emit('update', { type: 'application', application: this.withStatus(application) } satisfies RuntimeUpdate); }
  private emitProject(id: string): void { const project = this.database.db.listProjects().find((item) => item.id === id); if (project) this.updates.emit('update', { type: 'project', project: this.withProjectRuntime(project) } satisfies RuntimeUpdate); }
}

/** Parses a POSIX `ps -axo pid=,ppid=,etime=,command=` listing without executing untrusted process data. */
export function parseProcessTable(output: string, now = Date.now()): HostProcess[] {
  return output.split(/\r?\n/u).flatMap((line) => {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\S+)\s*(.*)$/u);
    if (!match) return [];
    const elapsedMs = parseElapsedMs(match[3]!);
    return elapsedMs === null ? [] : [{ pid: Number(match[1]), ppid: Number(match[2]), startedAt: now - elapsedMs, command: match[4] ?? '' }];
  });
}

export function matchingProcesses(application: Pick<Application, 'cwd'>, processes: readonly HostProcess[]): HostProcess[] {
  const cwd = resolve(application.cwd);
  return processes.filter((process) => process.cwd !== undefined && resolve(process.cwd) === cwd);
}

export function selectObservedProcess(processes: readonly HostProcess[], ports: ReadonlyMap<number, readonly number[]>): ObservedProcess | null {
  if (!processes.length) return null;
  const ordered = [...processes].sort((left, right) => (ports.get(right.pid)?.length ?? 0) - (ports.get(left.pid)?.length ?? 0) || left.startedAt - right.startedAt || left.pid - right.pid);
  const listeningPorts = [...new Set(processes.flatMap((process) => ports.get(process.pid) ?? []))].sort((left, right) => left - right);
  return { pid: ordered[0]!.pid, startedAt: ordered[0]!.startedAt, listeningPorts };
}

/** Only regular local files are safe to tail after an independently-owned process has started. */
export function externalLogFilesFromDescriptors(descriptors: Partial<Record<1 | 2, string>>): Partial<Record<LogStream, string>> {
  const result: Partial<Record<LogStream, string>> = {};
  if (isRegularLogFile(descriptors[1])) result.stdout = descriptors[1]!;
  if (isRegularLogFile(descriptors[2])) result.stderr = descriptors[2]!;
  return result;
}

export function logCaptureStatusFor(runtime: Pick<Runtime, 'ownership' | 'externalLogs' | 'inspectorCapture'> | undefined): LogCaptureStatus {
  if (!runtime) return 'inactive';
  if (runtime.ownership === 'dockyard') return 'streaming';
  if (runtime.inspectorCapture) return 'inspector';
  return Object.keys(runtime.externalLogs ?? {}).length ? 'file-backed' : 'unavailable';
}

/** Reads the recent persisted tail so reconnecting SSE clients immediately receive useful context. */
export async function readLogTail(path: string): Promise<string[]> {
  try {
    const info = await stat(path);
    if (!info.isFile()) return [];
    const chunk = await readLogChunk(path, Math.max(0, info.size - maxLogReadBytes));
    return chunk ? splitLogLines(chunk.data.toString('utf8')) : [];
  } catch { return []; }
}

/** PID reuse is possible, so a destructive operation requires both PID and process start time to still match. */
export function sameProcessIdentity(pid: number, startedAt: number, process: Pick<HostProcess, 'pid' | 'startedAt'>): boolean { return pid === process.pid && Math.abs(startedAt - process.startedAt) < 2_000; }

async function listHostProcesses(): Promise<{ available: boolean; processes: HostProcess[] }> {
  try {
    const { stdout } = await execFileAsync('ps', ['-axo', 'pid=,ppid=,etime=,command='], { timeout: 2_000, maxBuffer: 1_024 * 1_024 });
    const candidates = parseProcessTable(stdout).filter((process) => nodeRelatedCommand.test(process.command));
    const cwdResult = await processCwds(candidates.map((process) => process.pid));
    if (!cwdResult.available) return { available: false, processes: [] };
    return { available: true, processes: candidates.map((process) => ({ ...process, cwd: cwdResult.cwds.get(process.pid) })) };
  } catch { return { available: false, processes: [] }; }
}

async function processCwds(pids: readonly number[]): Promise<{ available: boolean; cwds: Map<number, string> }> {
  if (platform() === 'linux') {
    const entries = await Promise.all(pids.map(async (pid) => {
      try { return [pid, await readlink(`/proc/${pid}/cwd`)] as const; } catch { return null; }
    }));
    return { available: true, cwds: new Map(entries.filter((entry): entry is readonly [number, string] => entry !== null)) };
  }
  if (platform() !== 'darwin') return { available: false, cwds: new Map() };
  try {
    const cwds = new Map<number, string>();
    for (const group of chunks(pids, 64)) {
      const { stdout } = await execFileAsync('lsof', ['-n', '-a', '-d', 'cwd', '-p', group.join(','), '-Fn'], { timeout: 2_000, maxBuffer: 1_024 * 1_024 });
      let pid: number | undefined;
      let cwd = false;
      for (const line of stdout.split(/\r?\n/u)) {
        if (line.startsWith('p')) { pid = Number(line.slice(1)); cwd = false; }
        else if (line === 'fcwd') cwd = true;
        else if (cwd && pid && line.startsWith('n')) { cwds.set(pid, line.slice(1)); cwd = false; }
      }
    }
    return { available: true, cwds };
  } catch { return { available: false, cwds: new Map() }; }
}

async function externalLogCursors(pid: number): Promise<Partial<Record<LogStream, ExternalLogCursor>>> {
  const files = externalLogFilesFromDescriptors(await standardStreamDescriptors(pid));
  const entries = await Promise.all((Object.entries(files) as Array<[LogStream, string]>).map(async ([stream, path]) => {
    try {
      const info = await stat(path);
      return [stream, { path, position: Math.max(0, info.size - maxLogReadBytes) }] as const;
    } catch { return null; }
  }));
  return Object.fromEntries(entries.filter((entry): entry is readonly [LogStream, ExternalLogCursor] => entry !== null));
}

async function standardStreamDescriptors(pid: number): Promise<Partial<Record<1 | 2, string>>> {
  if (platform() === 'linux') {
    const entries = await Promise.all(([1, 2] as const).map(async (descriptor) => {
      try { return [descriptor, await readlink(`/proc/${pid}/fd/${descriptor}`)] as const; } catch { return null; }
    }));
    return Object.fromEntries(entries.filter((entry): entry is readonly [1 | 2, string] => entry !== null));
  }
  if (platform() !== 'darwin') return {};
  try {
    const { stdout } = await execFileAsync('lsof', ['-n', '-a', '-p', String(pid), '-d', '1,2', '-Ffn'], { timeout: 1_000, maxBuffer: 64 * 1_024 });
    let descriptor: 1 | 2 | undefined;
    const result: Partial<Record<1 | 2, string>> = {};
    for (const line of stdout.split(/\r?\n/u)) {
      if (line === 'f1') descriptor = 1;
      else if (line === 'f2') descriptor = 2;
      else if (descriptor && line.startsWith('n')) result[descriptor] = line.slice(1);
    }
    return result;
  } catch { return {}; }
}

async function readLogChunk(path: string, position: number): Promise<{ data: Buffer; position: number } | null> {
  try {
    const info = await stat(path);
    if (!info.isFile()) return null;
    const start = info.size < position ? 0 : position;
    const length = Math.min(maxLogReadBytes, Math.max(0, info.size - start));
    if (!length) return { data: Buffer.alloc(0), position: start };
    const handle = await open(path, 'r');
    try {
      const data = Buffer.allocUnsafe(length);
      const { bytesRead } = await handle.read(data, 0, length, start);
      return { data: data.subarray(0, bytesRead), position: start + bytesRead };
    } finally { await handle.close(); }
  } catch { return null; }
}

function isRegularLogFile(path: string | undefined): path is string {
  if (!path || !path.startsWith('/')) return false;
  try { return statSync(path).isFile(); } catch { return false; }
}

function splitLogLines(text: string): string[] {
  const lines = text.split(/\r?\n/u);
  if (lines.at(-1) === '') lines.pop();
  return lines;
}

async function listeningPortsByPid(pids: readonly number[]): Promise<Map<number, readonly number[]>> {
  const result = new Map<number, readonly number[]>();
  if (!pids.length || platform() === 'win32') return result;
  try {
    const { stdout } = await execFileAsync('lsof', ['-nP', '-a', '-p', pids.join(','), '-iTCP', '-sTCP:LISTEN', '-Fpn'], { timeout: 2_000, maxBuffer: 1_024 * 1_024 });
    let pid: number | undefined;
    const ports = new Map<number, Set<number>>();
    for (const line of stdout.split(/\r?\n/u)) {
      if (line.startsWith('p')) pid = Number(line.slice(1));
      else if (pid && line.startsWith('n')) { const port = Number(line.slice(1).match(/:(\d+)$/u)?.[1]); if (Number.isInteger(port) && port > 0 && port <= 65_535) (ports.get(pid) ?? ports.set(pid, new Set()).get(pid)!).add(port); }
    }
    for (const [processId, values] of ports) result.set(processId, [...values].sort((left, right) => left - right));
  } catch { /* Port visibility is optional; process discovery remains safe without it. */ }
  return result;
}

async function inspectProcess(pid: number | undefined): Promise<{ cpuPercent: number | null; rssBytes: number | null } | null> { if (!pid || platform() === 'win32') return null; try { const { stdout } = await execFileAsync('ps', ['-o', 'rss=,pcpu=', '-p', String(pid)], { timeout: 1_000 }); const [rss, cpu] = stdout.trim().split(/\s+/u).map(Number); return Number.isFinite(rss) && Number.isFinite(cpu) ? { rssBytes: rss * 1024, cpuPercent: cpu } : null; } catch { return null; } }
function parseElapsedMs(value: string): number | null { const [daysPart, clock] = value.includes('-') ? value.split('-', 2) : [undefined, value]; const units = clock!.split(':').map(Number); if (units.length < 2 || units.length > 3 || units.some((unit) => !Number.isInteger(unit) || unit < 0)) return null; const [hours, minutes, seconds] = units.length === 3 ? units : [0, units[0]!, units[1]!]; const days = daysPart === undefined ? 0 : Number(daysPart); return Number.isInteger(days) && days >= 0 && minutes < 60 && seconds < 60 ? (((days * 24 + hours!) * 60 + minutes!) * 60 + seconds!) * 1_000 : null; }
function samePorts(left: readonly number[], right: readonly number[]): boolean { return left.length === right.length && left.every((port, index) => port === right[index]); }
function chunks<T>(items: readonly T[], size: number): T[][] { const result: T[][] = []; for (let index = 0; index < items.length; index += size) result.push(items.slice(index, index + size)); return result; }
function inheritedEnvironment(): NodeJS.ProcessEnv { const names = ['PATH', 'HOME', 'USER', 'TMPDIR', 'TEMP', 'TMP', 'LANG', 'TERM', 'SystemRoot']; const entries = names.flatMap((name): [string, string][] => { const value = process.env[name]; return value === undefined ? [] : [[name, value]]; }); return Object.fromEntries(entries); }
/** Sends SIGTERM first, then escalates to SIGKILL when a Dockyard-owned process does not exit. */
export async function terminateChildProcess(child: ChildProcess, options: ChildTerminationOptions = {}): Promise<NodeJS.Signals> {
  const { processGroup = false, gracePeriodMs = gracefulShutdownTimeoutMs } = options;
  const exited = new Promise<void>((done) => child.once('exit', () => done()));
  sendChildSignal(child, 'SIGTERM', processGroup);
  try {
    await waitFor(exited, gracePeriodMs, '应用未在优雅退出期限内停止。');
    return 'SIGTERM';
  } catch {
    sendChildSignal(child, 'SIGKILL', processGroup);
    await waitFor(exited, gracePeriodMs, '应用在 SIGKILL 后仍未退出；请检查操作系统进程状态。');
    return 'SIGKILL';
  }
}

function sendChildSignal(child: ChildProcess, signal: NodeJS.Signals, processGroup: boolean): void {
  if (processGroup && child.pid) process.kill(-child.pid, signal);
  else if (!child.kill(signal)) throw new RequestTimeoutException(`无法向托管应用发送 ${signal}。`);
}

async function waitFor<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new RequestTimeoutException(message)), timeoutMs); timer.unref(); })]);
  } finally { if (timer) clearTimeout(timer); }
}
async function waitForProcessExit(pid: number, timeoutMs: number): Promise<void> { const deadline = Date.now() + timeoutMs; while (Date.now() < deadline) { try { process.kill(pid, 0); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return; throw new RequestTimeoutException('外部进程无法确认已退出。'); } await new Promise((done) => setTimeout(done, 100)); } throw new RequestTimeoutException('应用未在 5 秒内优雅退出。它仍在运行，未执行强制终止；请检查日志和进程状态。'); }
function appendRotatedLog(directory: string, stream: LogStream, data: Buffer, policy: Application['logPolicy']): void { const path = `${directory}/${stream}.log`; if (existsAndExceeds(path, data.length, policy.maxBytesPerFile)) { const archive = `${directory}/archive`; mkdirSync(archive, { recursive: true }); renameSync(path, `${archive}/${stream}-${Date.now()}.log`); pruneArchives(archive, policy); } appendFileSync(path, data); }
function existsAndExceeds(path: string, incoming: number, limit: number): boolean { try { return statSync(path).size + incoming > limit; } catch { return false; } }
function pruneArchives(directory: string, policy: Application['logPolicy']): void { const cutoff = Date.now() - policy.retentionDays * 86_400_000; const files = readdirSync(directory).map((name) => ({ name, path: `${directory}/${name}`, stat: statSync(`${directory}/${name}`) })).sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs); for (const file of files.slice(policy.maxFiles)) unlinkSync(file.path); for (const file of files) if (file.stat.mtimeMs < cutoff) { try { unlinkSync(file.path); } catch {} } }
