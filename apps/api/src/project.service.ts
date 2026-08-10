import { BadRequestException, Injectable } from '@nestjs/common';
import { relative, resolve } from 'node:path';
import { parseApplicationCommand, parseLogPolicy, parseRestartPolicy, scanProject, type ImportPreviewApplication } from '@dockyard/core';
import { DatabaseService } from './database.service.js';

@Injectable()
export class ProjectService {
  constructor(private readonly database: DatabaseService) {}
  async scan(input: unknown) {
    const body = record(input);
    if (!body || typeof body.path !== 'string') throw new BadRequestException('path 必须是绝对目录路径。');
    if (body.includePm2 !== undefined && typeof body.includePm2 !== 'boolean') throw new BadRequestException('includePm2 必须是布尔值。');
    try { return await scanProject(body.path, body.includePm2 !== false); } catch (error) { throw new BadRequestException(error instanceof Error ? error.message : '无法扫描项目。'); }
  }
  import(input: unknown) {
    const body = record(input);
    if (!body || typeof body.path !== 'string' || typeof body.name !== 'string' || !Array.isArray(body.applications)) throw new BadRequestException('导入请求无效。');
    const candidates = body.applications.map(parseCandidate);
    if (candidates.some((candidate) => candidate === null)) throw new BadRequestException('应用候选包含无效命令或策略。');
    const root = resolve(body.path);
    if ((candidates as ImportPreviewApplication[]).some((candidate) => outside(root, candidate.cwd))) throw new BadRequestException('应用工作目录必须位于导入项目内。');
    return this.database.db.importProject(root, body.name, candidates as ImportPreviewApplication[]);
  }
  list() { return this.database.db.listProjects(); }
}
function parseCandidate(value: unknown): ImportPreviewApplication | null {
  const body = record(value);
  if (!body || (body.origin !== 'package-script' && body.origin !== 'pm2-ecosystem') || typeof body.key !== 'string' || typeof body.name !== 'string' || typeof body.cwd !== 'string') return null;
  const command = parseApplicationCommand(body.command); const restartPolicy = parseRestartPolicy(body.restartPolicy); const logPolicy = parseLogPolicy(body.logPolicy);
  if (!command || !restartPolicy || !logPolicy) return null;
  return { key: body.key, origin: body.origin, name: body.name, cwd: body.cwd, command, restartPolicy, logPolicy, warnings: [] };
}
function record(value: unknown): Record<string, unknown> | null { return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null; }
function outside(root: string, candidate: string): boolean { const path = relative(root, resolve(candidate)); return path === '..' || path.startsWith(`..${'/'}`) || path.startsWith(`..${'\\'}`); }
