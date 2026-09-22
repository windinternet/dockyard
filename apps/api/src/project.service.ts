import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { constants } from 'node:fs';
import { access } from 'node:fs/promises';
import { delimiter, join, relative, resolve } from 'node:path';
import { platform } from 'node:os';
import { defaultRunnerKind, parseApplicationCommand, parseCommandLine, parseCommandOptions, parseLogPolicy, parseProjectSettings, parseRestartPolicy, parseRunnerKind, runnerSummaries, runners, scanProject, scanProjectDirectory, withCompatibilityProfile, type Application, type ImportPreview, type ImportPreviewApplication, type ProjectSettings } from '@dockyard/core';
import { DatabaseService } from './database.service.js';
import { detectDokployCompatibilityProfile } from './dokploy-compatibility-profile.js';
import { RuntimeService } from './runtime.service.js';

@Injectable()
export class ProjectService {
  constructor(private readonly database: DatabaseService, private readonly runtime: RuntimeService) {}
  async scan(input: unknown) {
    const body = record(input);
    if (!body || typeof body.path !== 'string') throw new BadRequestException('path 必须是绝对目录路径。');
    if (body.includePm2 !== undefined && typeof body.includePm2 !== 'boolean') throw new BadRequestException('includePm2 必须是布尔值。');
    try {
      return this.preview(await this.profile(await scanProject(body.path, body.includePm2 !== false)));
    } catch (error) { throw new BadRequestException(error instanceof Error ? error.message : '无法扫描项目。'); }
  }
  async scanDirectory(input: unknown) {
    const body = record(input);
    if (!body || typeof body.path !== 'string') throw new BadRequestException('path 必须是绝对目录路径。');
    if (body.includePm2 !== undefined && typeof body.includePm2 !== 'boolean') throw new BadRequestException('includePm2 必须是布尔值。');
    try {
      const root = resolve(body.path);
      const projects = await scanProjectDirectory(root, body.includePm2 !== false);
      return { root, projects: (await Promise.all(projects.map(async (project) => this.profile(project)))).map((project) => this.preview(project)) };
    } catch (error) { throw new BadRequestException(error instanceof Error ? error.message : '无法扫描项目目录。'); }
  }
  /** Re-detects runner types for an already imported project so the panel can offer the fallback runner. */
  async runnerCatalog(id: string) {
    const project = this.database.db.listProjects().find((item) => item.id === id);
    if (!project) throw new NotFoundException('项目不存在。');
    return { path: project.path, runners: await runnerSummaries(project.path) };
  }
  /** Registers an explicit command under a runner that accepts user-defined applications. */
  async addUserApplication(projectId: string, input: unknown) {
    const project = this.database.db.listProjects().find((item) => item.id === projectId);
    if (!project) throw new NotFoundException('项目不存在。');
    const draft = await parseUserApplication(input, project.path);
    try {
      return this.database.db.createUserApplication(projectId, draft);
    } catch (error) { throw new BadRequestException(error instanceof Error ? error.message : '无法创建应用。'); }
  }
  /** Re-points an existing user-defined application. Scanned applications keep their discovered commands. */
  async updateUserApplication(applicationId: string, input: unknown) {
    const application = this.runtime.application(applicationId);
    if (!userDefinedRunnerKind(application.runnerKind)) throw new BadRequestException('只有手动登记的应用可以修改命令。');
    if (application.status !== 'stopped' && application.status !== 'crashed') throw new BadRequestException('请先停止应用，再修改它的命令。');
    const project = this.database.db.listProjects().find((item) => item.id === application.projectId);
    if (!project) throw new NotFoundException('项目不存在。');
    const draft = await parseUserApplication(input, project.path, application.runnerKind);
    try {
      return this.database.db.updateUserApplication(applicationId, draft);
    } catch (error) { throw new BadRequestException(error instanceof Error ? error.message : '无法更新应用。'); }
  }
  async import(input: unknown) {
    const body = record(input);
    if (!body || typeof body.path !== 'string' || typeof body.name !== 'string' || !Array.isArray(body.applications)) throw new BadRequestException('导入请求无效。');
    const candidates = body.applications.map(parseCandidate);
    if (candidates.some((candidate) => candidate === null)) throw new BadRequestException('应用候选包含无效命令或策略。');
    const projectEntrypointOptions = body.projectEntrypointOptions === undefined ? [] : parseCommandOptions(body.projectEntrypointOptions);
    const selectedProjectEntrypoint = body.selectedProjectEntrypoint === undefined ? null : typeof body.selectedProjectEntrypoint === 'string' ? body.selectedProjectEntrypoint : body.selectedProjectEntrypoint === null ? null : undefined;
    if (!projectEntrypointOptions || selectedProjectEntrypoint === undefined || (selectedProjectEntrypoint !== null && !projectEntrypointOptions.some((option) => option.name === selectedProjectEntrypoint))) throw new BadRequestException('项目级启动入口无效。');
    const root = resolve(body.path);
    if ((candidates as ImportPreviewApplication[]).some((candidate) => outside(root, candidate.cwd))) throw new BadRequestException('应用工作目录必须位于导入项目内。');
    const trustedCandidates = withCompatibilityProfile({ root, projectName: body.name, projectEntrypointOptions, selectedProjectEntrypoint, applications: candidates as ImportPreviewApplication[], runners: await runnerSummaries(root), warnings: [] }, await detectDokployCompatibilityProfile(root)).applications;
    const project = this.database.db.listProjects().find((item) => item.path === root);
    if (project) {
      const stale = staleApplicationsFor(this.database.db.listApplications(project.id), trustedCandidates);
      if (stale.length && body.replaceStale !== true) throw new BadRequestException('检测到过时的脚本级应用记录；请在导入预览中明确确认替换。');
      if (stale.some((application) => this.runtime.application(application.id).status === 'running')) throw new BadRequestException('请先停止过时的应用记录，再确认替换。');
      if (body.replaceStale === true) this.database.db.removeApplications(stale.map((application) => application.id));
    }
    return this.database.db.importProject(root, body.name, trustedCandidates, projectEntrypointOptions, selectedProjectEntrypoint);
  }
  async importMany(input: unknown) {
    const body = record(input);
    if (!body || typeof body.root !== 'string' || !Array.isArray(body.projects)) throw new BadRequestException('批量导入请求无效。');
    const root = resolve(body.root);
    return { projects: await Promise.all(body.projects.map(async (project) => {
      const candidate = record(project);
      if (!candidate || typeof candidate.path !== 'string' || !directChild(root, candidate.path)) throw new BadRequestException('批量导入项目必须是所选目录的直接子目录。');
      return await this.import(candidate);
    })) };
  }
  list() { return this.runtime.projects(); }
  async start(id: string) { return { applications: await this.runtime.startProject(id) }; }
  async stop(id: string) { return { applications: await this.runtime.stopProject(id) }; }
  async restart(id: string) { return { applications: await this.runtime.restartProject(id) }; }
  settings(id: string, input: unknown) {
    const body = record(input); const settings = parseProjectSettings(body);
    if (!settings) throw new BadRequestException('项目启动、守护或日志设置无效。');
    const applications = this.database.db.listApplications(id); const ids = new Set(applications.map((application) => application.id));
    if (settings.startupApplicationIds.some((applicationId) => !ids.has(applicationId))) throw new BadRequestException('一键启动规则只能引用本项目应用。');
    return this.runtime.updateProjectSettings(id, settings as ProjectSettings);
  }
  async remove(id: string) { await this.runtime.deleteProject(id); return { deleted: true }; }
  private async profile(preview: ImportPreview): Promise<ImportPreview> { return withCompatibilityProfile(preview, await detectDokployCompatibilityProfile(preview.root)); }
  private preview(preview: ImportPreview) {
    const project = this.database.db.listProjects().find((item) => item.path === preview.root);
    const staleApplications = project ? staleApplicationsFor(this.database.db.listApplications(project.id), preview.applications).map((application) => ({ id: application.id, name: application.name, cwd: application.cwd })) : [];
    return { project: { path: preview.root, name: preview.projectName, entrypointOptions: preview.projectEntrypointOptions, selectedEntrypoint: preview.selectedProjectEntrypoint }, applications: preview.applications, runners: preview.runners, compatibilityProfile: preview.compatibilityProfile, warnings: preview.warnings, staleApplications };
  }
}

interface UserApplicationDraft { name: string; cwd: string; runnerKind: ImportPreviewApplication['runnerKind']; command: ImportPreviewApplication['command']; }

/** Validates a user-defined application before it is persisted, including that its executable is reachable. */
async function parseUserApplication(input: unknown, projectPath: string, runnerKindOverride?: ImportPreviewApplication['runnerKind']): Promise<UserApplicationDraft> {
  const body = record(input);
  if (!body) throw new BadRequestException('请求无效。');
  if (typeof body.name !== 'string' || !body.name.trim() || body.name.trim().length > 120) throw new BadRequestException('应用名称必须是 1 到 120 个字符。');
  // An update keeps the runner that already owns the application; the client cannot switch it by editing.
  const runnerKind = runnerKindOverride ?? parseRunnerKind(body.runnerKind);
  if (!runnerKind || !userDefinedRunnerKind(runnerKind)) throw new BadRequestException('该运行器类型不支持手动登记命令。');
  if (typeof body.cwd !== 'string' || !body.cwd.trim()) throw new BadRequestException('工作目录不能为空。');
  if (typeof body.commandLine !== 'string' || body.commandLine.length > 2_000) throw new BadRequestException('命令必须是 2000 字符以内的字符串。');
  const parsed = parseCommandLine(body.commandLine);
  if ('error' in parsed) throw new BadRequestException(parsed.error);
  const cwd = resolve(projectPath, body.cwd.trim());
  if (outside(projectPath, cwd)) throw new BadRequestException('工作目录必须位于项目内。');
  await assertExecutableReachable(parsed.command.executable);
  return { name: body.name.trim(), cwd, runnerKind, command: parsed.command };
}

/** The daemon spawns with its own PATH, so that is the PATH a registered command must resolve in. */
async function assertExecutableReachable(executable: string): Promise<void> {
  const mode = platform() === 'win32' ? constants.F_OK : constants.X_OK;
  const candidates = executable.includes('/') || executable.includes('\\')
    ? [resolve(executable)]
    : (process.env.PATH ?? '').split(delimiter).filter(Boolean).map((directory) => join(directory, executable));
  for (const candidate of candidates) {
    try { await access(candidate, mode); return; } catch { /* try the next PATH entry */ }
  }
  throw new BadRequestException(`找不到可执行文件「${executable}」；请确认它在守护进程的 PATH 中，或填写绝对路径。`);
}
function userDefinedRunnerKind(kind: ImportPreviewApplication['runnerKind']): boolean { return runners.find((runner) => runner.kind === kind)?.userDefinedCommands === true; }
function parseCandidate(value: unknown): ImportPreviewApplication | null {
  const body = record(value);
  if (!body || (body.origin !== 'package-script' && body.origin !== 'pm2-ecosystem') || typeof body.key !== 'string' || typeof body.name !== 'string' || typeof body.cwd !== 'string') return null;
  const command = parseApplicationCommand(body.command); const commandOptions = parseCommandOptions(body.commandOptions); const selectedCommand = typeof body.selectedCommand === 'string' ? body.selectedCommand : null; const restartPolicy = parseRestartPolicy(body.restartPolicy); const logPolicy = parseLogPolicy(body.logPolicy);
  const runnerKind = body.runnerKind === undefined ? defaultRunnerKind : parseRunnerKind(body.runnerKind);
  if (!command || !commandOptions || !selectedCommand || !commandOptions.some((option) => option.name === selectedCommand) || !restartPolicy || !logPolicy || !runnerKind) return null;
  // User-defined runners are never import candidates; they are registered explicitly by a person.
  if (userDefinedRunnerKind(runnerKind)) return null;
  return { key: body.key, origin: body.origin, runnerKind, name: body.name, cwd: body.cwd, command, commandOptions, selectedCommand, restartPolicy, logPolicy, warnings: [] };
}
function record(value: unknown): Record<string, unknown> | null { return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null; }
function outside(root: string, candidate: string): boolean { const path = relative(root, resolve(candidate)); return path === '..' || path.startsWith(`..${'/'}`) || path.startsWith(`..${'\\'}`); }
function directChild(root: string, candidate: string): boolean { const path = relative(root, resolve(candidate)); return Boolean(path) && !outside(root, candidate) && !path.includes('/') && !path.includes('\\'); }
/** Only discovered applications can become stale; a person's explicit command is never replaced by a scan. */
function staleApplicationsFor(existing: readonly Application[], candidates: readonly ImportPreviewApplication[]): Application[] { const desired = new Map<string, Set<string>>(); for (const candidate of candidates) { const names = desired.get(candidate.cwd) ?? new Set<string>(); names.add(candidate.name); desired.set(candidate.cwd, names); } return existing.filter((application) => !userDefinedRunnerKind(application.runnerKind) && !desired.get(application.cwd)?.has(application.name)); }
