import { BadRequestException, Injectable } from '@nestjs/common';
import { relative, resolve } from 'node:path';
import { parseApplicationCommand, parseCommandOptions, parseLogPolicy, parseProjectSettings, parseRestartPolicy, scanProject, scanProjectDirectory, type ImportPreview, type ImportPreviewApplication, type ProjectSettings } from '@dockyard/core';
import { DatabaseService } from './database.service.js';
import { RuntimeService } from './runtime.service.js';

@Injectable()
export class ProjectService {
  constructor(private readonly database: DatabaseService, private readonly runtime: RuntimeService) {}
  async scan(input: unknown) {
    const body = record(input);
    if (!body || typeof body.path !== 'string') throw new BadRequestException('path 必须是绝对目录路径。');
    if (body.includePm2 !== undefined && typeof body.includePm2 !== 'boolean') throw new BadRequestException('includePm2 必须是布尔值。');
    try {
      return this.preview(await scanProject(body.path, body.includePm2 !== false));
    } catch (error) { throw new BadRequestException(error instanceof Error ? error.message : '无法扫描项目。'); }
  }
  async scanDirectory(input: unknown) {
    const body = record(input);
    if (!body || typeof body.path !== 'string') throw new BadRequestException('path 必须是绝对目录路径。');
    if (body.includePm2 !== undefined && typeof body.includePm2 !== 'boolean') throw new BadRequestException('includePm2 必须是布尔值。');
    try {
      const root = resolve(body.path);
      const projects = await scanProjectDirectory(root, body.includePm2 !== false);
      return { root, projects: projects.map((project) => this.preview(project)) };
    } catch (error) { throw new BadRequestException(error instanceof Error ? error.message : '无法扫描项目目录。'); }
  }
  import(input: unknown) {
    const body = record(input);
    if (!body || typeof body.path !== 'string' || typeof body.name !== 'string' || !Array.isArray(body.applications)) throw new BadRequestException('导入请求无效。');
    const candidates = body.applications.map(parseCandidate);
    if (candidates.some((candidate) => candidate === null)) throw new BadRequestException('应用候选包含无效命令或策略。');
    const projectEntrypointOptions = body.projectEntrypointOptions === undefined ? [] : parseCommandOptions(body.projectEntrypointOptions);
    const selectedProjectEntrypoint = body.selectedProjectEntrypoint === undefined ? null : typeof body.selectedProjectEntrypoint === 'string' ? body.selectedProjectEntrypoint : body.selectedProjectEntrypoint === null ? null : undefined;
    if (!projectEntrypointOptions || selectedProjectEntrypoint === undefined || (selectedProjectEntrypoint !== null && !projectEntrypointOptions.some((option) => option.name === selectedProjectEntrypoint))) throw new BadRequestException('项目级启动入口无效。');
    const root = resolve(body.path);
    if ((candidates as ImportPreviewApplication[]).some((candidate) => outside(root, candidate.cwd))) throw new BadRequestException('应用工作目录必须位于导入项目内。');
    const project = this.database.db.listProjects().find((item) => item.path === root);
    if (project) {
      const stale = staleApplicationsFor(this.database.db.listApplications(project.id), candidates as ImportPreviewApplication[]);
      if (stale.length && body.replaceStale !== true) throw new BadRequestException('检测到过时的脚本级应用记录；请在导入预览中明确确认替换。');
      if (stale.some((application) => this.runtime.application(application.id).status === 'running')) throw new BadRequestException('请先停止过时的应用记录，再确认替换。');
      if (body.replaceStale === true) this.database.db.removeApplications(stale.map((application) => application.id));
    }
    return this.database.db.importProject(root, body.name, candidates as ImportPreviewApplication[], projectEntrypointOptions, selectedProjectEntrypoint);
  }
  importMany(input: unknown) {
    const body = record(input);
    if (!body || typeof body.root !== 'string' || !Array.isArray(body.projects)) throw new BadRequestException('批量导入请求无效。');
    const root = resolve(body.root);
    return { projects: body.projects.map((project) => {
      const candidate = record(project);
      if (!candidate || typeof candidate.path !== 'string' || !directChild(root, candidate.path)) throw new BadRequestException('批量导入项目必须是所选目录的直接子目录。');
      return this.import(candidate);
    }) };
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
  private preview(preview: ImportPreview) {
    const project = this.database.db.listProjects().find((item) => item.path === preview.root);
    const staleApplications = project ? staleApplicationsFor(this.database.db.listApplications(project.id), preview.applications).map((application) => ({ id: application.id, name: application.name, cwd: application.cwd })) : [];
    return { project: { path: preview.root, name: preview.projectName, entrypointOptions: preview.projectEntrypointOptions, selectedEntrypoint: preview.selectedProjectEntrypoint }, applications: preview.applications, warnings: preview.warnings, staleApplications };
  }
}
function parseCandidate(value: unknown): ImportPreviewApplication | null {
  const body = record(value);
  if (!body || (body.origin !== 'package-script' && body.origin !== 'pm2-ecosystem') || typeof body.key !== 'string' || typeof body.name !== 'string' || typeof body.cwd !== 'string') return null;
  const command = parseApplicationCommand(body.command); const commandOptions = parseCommandOptions(body.commandOptions); const selectedCommand = typeof body.selectedCommand === 'string' ? body.selectedCommand : null; const restartPolicy = parseRestartPolicy(body.restartPolicy); const logPolicy = parseLogPolicy(body.logPolicy);
  if (!command || !commandOptions || !selectedCommand || !commandOptions.some((option) => option.name === selectedCommand) || !restartPolicy || !logPolicy) return null;
  return { key: body.key, origin: body.origin, name: body.name, cwd: body.cwd, command, commandOptions, selectedCommand, restartPolicy, logPolicy, warnings: [] };
}
function record(value: unknown): Record<string, unknown> | null { return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null; }
function outside(root: string, candidate: string): boolean { const path = relative(root, resolve(candidate)); return path === '..' || path.startsWith(`..${'/'}`) || path.startsWith(`..${'\\'}`); }
function directChild(root: string, candidate: string): boolean { const path = relative(root, resolve(candidate)); return Boolean(path) && !outside(root, candidate) && !path.includes('/') && !path.includes('\\'); }
function staleApplicationsFor(existing: ReturnType<DatabaseService['db']['listApplications']>, candidates: readonly ImportPreviewApplication[]) { const desired = new Map<string, Set<string>>(); for (const candidate of candidates) { const names = desired.get(candidate.cwd) ?? new Set<string>(); names.add(candidate.name); desired.set(candidate.cwd, names); } return existing.filter((application) => !desired.get(application.cwd)?.has(application.name)); }
