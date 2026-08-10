#!/usr/bin/env node
import { Command } from 'commander';
import { basename, dirname, resolve } from 'node:path';
import { scanProject } from '@dockyard/core';
import { DockyardDatabase, PathResolver } from '@dockyard/db';

const program = new Command().name('dockyard').description('Agent-friendly local Dockyard client').version('0.1.0');
const project = program.command('project').description('项目发现和目录读取');
project.command('scan <path>').option('--include-pm2', '扫描静态 PM2 配置').option('--json', 'machine-readable output').action(async (path, options) => output(await scanProject(path, options.includePm2 === true), options.json));
project.command('list').option('--json', 'machine-readable output').action(async (options) => {
  const database = await DockyardDatabase.open(new PathResolver(process.env.DOCKYARD_STATE_DIR));
  try { output({ projects: database.listProjects() }, options.json); } finally { database.close(); }
});

const importCommand = program.command('import').description('通过守护进程导入已审核的候选项');
importCommand.command('pm2 <file>').option('--dry-run', '仅预览').option('--json', 'machine-readable output').action(async (file, options) => {
  const preview = await scanProject(dirname(resolve(file)), true);
  const resolvedFile = resolve(file); const pm2 = preview.applications.filter((application) => application.origin === 'pm2-ecosystem' && application.key.startsWith(`pm2:${resolvedFile}:`));
  const result = options.dryRun ? { file: resolvedFile, applications: pm2, warnings: preview.warnings, dryRun: true } : await daemonPost(`/api/projects/import`, { path: preview.root, name: preview.projectName, applications: pm2 });
  output(result, options.json);
});

const app = program.command('app').description('通过本机守护进程管理运行时');
app.command('status [id]').option('--json', 'machine-readable output').action(async (id, options) => output(await daemonGet(id ? `/api/applications/${encodeURIComponent(id)}` : '/api/applications'), options.json));
for (const action of ['start', 'stop', 'restart'] as const) app.command(`${action} <id>`).option('--json', 'machine-readable output').action(async (id, options) => output(await daemonPost(`/api/applications/${encodeURIComponent(id)}/${action}`), options.json));

program.command('start <target>').option('--json', 'machine-readable output').description('启动一个项目或 project:module 应用').action(async (target, options) => output(await startTarget(target), options.json));

const logs = program.command('logs').description('读取本机守护进程日志流');
logs.command('tail <id>').option('--stream <stream>', 'stdout or stderr', 'stdout').option('--jsonl', 'one JSON object per line').action(async (id, options) => tailLogs(id, options.stream, options.jsonl));
program.command('diagnostics <id>').option('--json', 'machine-readable output').action(async (id, options) => output(await daemonPost(`/api/applications/${encodeURIComponent(id)}/diagnostics`), options.json));
program.command('status').option('--json', 'machine-readable output').action(async (options) => output(await daemonGet('/health'), options.json));

function daemonUrl(): URL { const url = new URL(process.env.DOCKYARD_API_URL ?? 'http://127.0.0.1:4318'); if (!['127.0.0.1', 'localhost', '::1'].includes(url.hostname)) fail('DOCKYARD_API_URL 只能指向本机守护进程。', 2); return url; }
async function daemonGet(path: string): Promise<unknown> { return request(path, { method: 'GET' }); }
async function daemonPost(path: string, body?: unknown): Promise<unknown> { return request(path, { method: 'POST', headers: body === undefined ? undefined : { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }); }
async function startTarget(target: string): Promise<unknown> { const [projectResult, applicationResult] = await Promise.all([daemonGet('/api/projects') as Promise<{ projects: Array<{ id: string; name: string }> }>, daemonGet('/api/applications') as Promise<{ applications: Array<{ id: string; projectId: string; name: string }> }>]); const project = projectResult.projects.find((item) => item.name === target); if (project) return daemonPost(`/api/projects/${encodeURIComponent(project.id)}/start`); const application = applicationResult.applications.find((item) => { const owner = projectResult.projects.find((project) => project.id === item.projectId); return item.name === target || (owner !== undefined && `${owner.name}:${item.name.split(':').at(-1)}` === target); }); if (!application) fail(`找不到项目或应用：${target}`, 4); return daemonPost(`/api/applications/${encodeURIComponent(application.id)}/start`); }
async function request(path: string, init: RequestInit): Promise<unknown> { try { const response = await fetch(new URL(path, daemonUrl()), { ...init, signal: AbortSignal.timeout(5_000) }); const payload = await response.json().catch(() => ({ message: `HTTP ${response.status}` })); if (!response.ok) fail(typeof payload.message === 'string' ? payload.message : `守护进程返回 HTTP ${response.status}`, response.status === 404 ? 4 : 5); return payload; } catch (error) { if (error instanceof CliError) throw error; fail(error instanceof Error ? error.message : '守护进程不可用。', 3); } }
async function tailLogs(id: string, stream: string, jsonl: boolean): Promise<void> { if (stream !== 'stdout' && stream !== 'stderr') fail('stream 必须是 stdout 或 stderr。', 2); const response = await fetch(new URL(`/api/applications/${encodeURIComponent(id)}/logs/tail?stream=${stream}`, daemonUrl())); if (!response.ok || !response.body) fail(`无法订阅日志（HTTP ${response.status}）。`, response.status === 404 ? 4 : 3); const reader = response.body.getReader(); const decoder = new TextDecoder(); let buffered = ''; for (;;) { const next = await reader.read(); if (next.done) return; buffered += decoder.decode(next.value, { stream: true }); const messages = buffered.split('\n\n'); buffered = messages.pop() ?? ''; for (const message of messages) { const data = message.split('\n').find((line) => line.startsWith('data:'))?.slice(5).trim(); if (!data) continue; const payload = JSON.parse(data); console.log(jsonl ? JSON.stringify(payload) : `${payload.at} [${payload.stream}] ${payload.line}`); } } }
function output(value: unknown, json = false): void { console.log(json ? JSON.stringify(value) : JSON.stringify(value, null, 2)); }
class CliError extends Error { constructor(message: string, readonly code: number) { super(message); } }
function fail(message: string, code: number): never { throw new CliError(message, code); }
program.showHelpAfterError();
program.parseAsync().catch((error: unknown) => { const code = error instanceof CliError ? error.code : 2; console.error(error instanceof Error ? error.message : '未知错误'); process.exitCode = code; });
