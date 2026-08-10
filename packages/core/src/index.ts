import { access, readdir, readFile, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';

export type ApplicationStatus = 'stopped' | 'starting' | 'running' | 'restarting' | 'crashed';
export type RestartMode = 'never' | 'on-failure' | 'always';
export type LogStream = 'stdout' | 'stderr';

export interface RestartPolicy {
  mode: RestartMode;
  maxRetries: number;
  retryDelayMs: number;
  stableWindowMs: number;
}

export interface LogPolicy {
  maxFiles: number;
  maxBytesPerFile: number;
  retentionDays: number;
}

export type RestartPreset = 'balanced' | 'resilient' | 'manual';
export interface DockyardSettings {
  version: number;
  retentionDays: number;
  maxFiles: number;
  maxBytesPerFile: number;
  restartPreset: RestartPreset;
}

export interface ApplicationCommand {
  executable: string;
  args: readonly string[];
}

export interface Project {
  id: string;
  path: string;
  name: string;
  createdAt: string;
}

export interface Application {
  id: string;
  projectId: string;
  name: string;
  cwd: string;
  command: ApplicationCommand;
  status: ApplicationStatus;
  restartPolicy: RestartPolicy;
  logPolicy: LogPolicy;
  createdAt: string;
  updatedAt: string;
}

export interface LifecycleEvent {
  id: string;
  applicationId: string;
  type: 'started' | 'stopped' | 'exited' | 'restart-scheduled' | 'crashed' | 'diagnostics-exported';
  occurredAt: string;
  detail: Record<string, unknown>;
}

export interface MetricRollup {
  applicationId: string;
  sampledAt: string;
  uptimeMs: number;
  restartCount: number;
  rssBytes: number | null;
}

export interface Pm2ConversionWarning { field: string; reason: string; }
export interface ImportPreviewApplication {
  key: string;
  origin: 'package-script' | 'pm2-ecosystem';
  name: string;
  cwd: string;
  command: ApplicationCommand;
  restartPolicy: RestartPolicy;
  logPolicy: LogPolicy;
  warnings: readonly Pm2ConversionWarning[];
}
export interface ImportPreview {
  root: string;
  projectName: string;
  applications: readonly ImportPreviewApplication[];
  warnings: readonly Pm2ConversionWarning[];
}

export const defaultRestartPolicy: RestartPolicy = Object.freeze({ mode: 'on-failure', maxRetries: 5, retryDelayMs: 1_000, stableWindowMs: 30_000 });
export const defaultLogPolicy: LogPolicy = Object.freeze({ maxFiles: 5, maxBytesPerFile: 10 * 1024 * 1024, retentionDays: 14 });
export const defaultDockyardSettings: DockyardSettings = Object.freeze({ version: 0, retentionDays: 14, maxFiles: 5, maxBytesPerFile: 10 * 1024 * 1024, restartPreset: 'balanced' });

export function restartPolicyForPreset(preset: RestartPreset): RestartPolicy {
  if (preset === 'manual') return { mode: 'never', maxRetries: 0, retryDelayMs: 1_000, stableWindowMs: 30_000 };
  if (preset === 'resilient') return { mode: 'always', maxRetries: 10, retryDelayMs: 1_000, stableWindowMs: 30_000 };
  return { ...defaultRestartPolicy };
}

const runnableScript = /(^|:)(dev|start|serve|watch)(:|$)/i;
const excludedDirectories = new Set(['node_modules', '.git', 'dist', 'build', '.next', 'coverage']);

interface PackageManifest { name?: unknown; scripts?: unknown; workspaces?: unknown; }

/** Reads manifests only; it never executes package scripts or ecosystem files. */
export async function scanProject(rootInput: string, includePm2 = true): Promise<ImportPreview> {
  const root = resolve(rootInput);
  await assertDirectory(root);
  const manifests = await discoverPackageManifests(root, 3);
  const applications: ImportPreviewApplication[] = [];
  const warnings: Pm2ConversionWarning[] = [];
  for (const manifestPath of manifests) {
    const manifest = await readJson<PackageManifest>(manifestPath);
    const scripts = isRecord(manifest.scripts) ? manifest.scripts : {};
    for (const [script, value] of Object.entries(scripts)) {
      if (typeof value !== 'string' || !runnableScript.test(script)) continue;
      const cwd = resolve(manifestPath, '..');
      applications.push({
        key: `script:${cwd}:${script}`, origin: 'package-script', name: `${manifestName(manifest, cwd)}:${script}`, cwd,
        command: { executable: packageManagerFor(cwd), args: ['run', script] }, restartPolicy: { ...defaultRestartPolicy }, logPolicy: { ...defaultLogPolicy }, warnings: []
      });
    }
  }
  if (includePm2) {
    const pm2Files = await discoverPm2Files(root, 3);
    for (const file of pm2Files) {
      const result = await readPm2Preview(file);
      applications.push(...result.applications);
      warnings.push(...result.warnings);
    }
  }
  return { root, projectName: basename(root), applications: deduplicateCandidates(applications), warnings };
}

export function commandDisplay(command: ApplicationCommand): string {
  return [command.executable, ...command.args].map(quoteArgument).join(' ');
}

/** Redacts values that must never leave a local display boundary. */
export function redactDisplayText(value: string): string {
  return value
    .replace(/((?:authorization)\s*:\s*(?:bearer|basic)\s+)\S+/giu, '$1[REDACTED]')
    .replace(/((?:["']?(?:api[_-]?key|token|secret|password)["']?)\s*(?:=|:)\s*)(?:"[^"]*"|'[^']*'|[^\s,}\]]+)/giu, '$1[REDACTED]')
    .replace(/(--(?:api[_-]?key|token|secret|password)(?:=|\s+))\S+/giu, '$1[REDACTED]');
}

export function redactDisplayValue(value: unknown): unknown {
  if (typeof value === 'string') return redactDisplayText(value);
  if (Array.isArray(value)) return value.map(redactDisplayValue);
  if (isRecord(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, /(?:api[_-]?key|token|secret|password|authorization)/iu.test(key) ? '[REDACTED]' : redactDisplayValue(item)]));
  return value;
}

export function redactCommandForDisplay(command: ApplicationCommand): ApplicationCommand {
  return { executable: redactDisplayText(command.executable), args: command.args.map((argument, index) => index > 0 && /(?:api[_-]?key|token|secret|password)$/iu.test(command.args[index - 1]) ? '[REDACTED]' : redactDisplayText(argument)) };
}

export function parseApplicationCommand(value: unknown): ApplicationCommand | null {
  if (!isRecord(value) || typeof value.executable !== 'string' || !value.executable || !Array.isArray(value.args) || !value.args.every((arg) => typeof arg === 'string')) return null;
  return { executable: value.executable, args: value.args };
}

export function parseRestartPolicy(value: unknown): RestartPolicy | null {
  if (!isRecord(value) || !['never', 'on-failure', 'always'].includes(String(value.mode)) || !isNonNegativeInteger(value.maxRetries) || !isPositiveInteger(value.retryDelayMs) || !isPositiveInteger(value.stableWindowMs)) return null;
  return { mode: value.mode as RestartMode, maxRetries: value.maxRetries, retryDelayMs: value.retryDelayMs, stableWindowMs: value.stableWindowMs };
}

export function parseLogPolicy(value: unknown): LogPolicy | null {
  if (!isRecord(value) || !isPositiveInteger(value.maxFiles) || !isPositiveInteger(value.maxBytesPerFile) || !isPositiveInteger(value.retentionDays)) return null;
  return { maxFiles: value.maxFiles, maxBytesPerFile: value.maxBytesPerFile, retentionDays: value.retentionDays };
}

async function discoverPackageManifests(root: string, depth: number): Promise<string[]> {
  return discoverFiles(root, depth, (name) => name === 'package.json');
}
async function discoverPm2Files(root: string, depth: number): Promise<string[]> {
  return discoverFiles(root, depth, (name) => ['ecosystem.config.js', 'ecosystem.config.cjs', 'ecosystem.config.mjs', 'ecosystem.json'].includes(name));
}
async function discoverFiles(directory: string, remainingDepth: number, include: (name: string) => boolean): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const found: string[] = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isFile() && include(entry.name)) found.push(path);
    if (entry.isDirectory() && remainingDepth > 0 && !excludedDirectories.has(entry.name)) found.push(...await discoverFiles(path, remainingDepth - 1, include));
  }
  return found;
}

async function readPm2Preview(file: string): Promise<{ applications: ImportPreviewApplication[]; warnings: Pm2ConversionWarning[] }> {
  const source = await readFile(file, 'utf8');
  const warnings: Pm2ConversionWarning[] = [];
  const parsed = file.endsWith('.json') ? parseJsonPm2(source, file, warnings) : parseStaticPm2(source, file, warnings);
  const apps = Array.isArray(parsed) ? parsed : [];
  return { applications: apps.flatMap((candidate, index) => pm2Candidate(candidate, file, index, warnings)), warnings };
}

function parseJsonPm2(source: string, file: string, warnings: Pm2ConversionWarning[]): unknown[] | null {
  try {
    const parsed: unknown = JSON.parse(source);
    return Array.isArray(parsed) ? parsed : isRecord(parsed) && Array.isArray(parsed.apps) ? parsed.apps : null;
  } catch { warnings.push({ field: relative(process.cwd(), file), reason: 'PM2 JSON 不是有效的静态 JSON，已跳过。' }); return null; }
}

/** Conservative parser: extracts only literal object fields and deliberately ignores executable JavaScript. */
function parseStaticPm2(source: string, file: string, warnings: Pm2ConversionWarning[]): unknown[] | null {
  const appsMatch = source.match(/\bapps\s*:\s*\[([\s\S]*?)\]\s*[},;]/);
  if (!appsMatch) { warnings.push({ field: relative(process.cwd(), file), reason: '仅支持包含静态 apps 数组的 PM2 配置，已跳过。' }); return null; }
  const objects = appsMatch[1].match(/\{[^{}]*\}/g) ?? [];
  return objects.map((object) => staticObject(object));
}
function staticObject(source: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const match of source.matchAll(/([A-Za-z_$][\w$]*)\s*:\s*(?:'([^']*)'|"([^"]*)"|(true|false)|(\d+))/g)) {
    result[match[1]] = match[2] ?? match[3] ?? (match[4] ? match[4] === 'true' : Number(match[5]));
  }
  return result;
}
function pm2Candidate(value: unknown, file: string, index: number, sharedWarnings: Pm2ConversionWarning[]): ImportPreviewApplication[] {
  if (!isRecord(value) || typeof value.script !== 'string') { sharedWarnings.push({ field: `${file}:apps[${index}]`, reason: '缺少静态 script 字段，已跳过。' }); return []; }
  const cwd = resolve(file, '..', typeof value.cwd === 'string' ? value.cwd : '.');
  const name = typeof value.name === 'string' ? value.name : basename(value.script);
  const args = typeof value.args === 'string' ? splitLiteralArgs(value.args) : [];
  const warnings: Pm2ConversionWarning[] = [];
  for (const unsupported of ['instances', 'exec_mode', 'deploy', 'pmx']) if (unsupported in value) warnings.push({ field: unsupported, reason: 'PM2 生产/集群字段不受 MVP 支持。' });
  if ('env' in value) warnings.push({ field: 'env', reason: '环境变量不会持久化；请在导入后显式配置。' });
  const script = resolve(cwd, value.script);
  const command = /\.(?:[cm]?js|ts)$/u.test(script) ? { executable: process.execPath, args: [script, ...args] } : { executable: script, args };
  return [{ key: `pm2:${file}:${index}`, origin: 'pm2-ecosystem', name, cwd, command, restartPolicy: {
    mode: value.autorestart === false ? 'never' : 'on-failure', maxRetries: numberOr(value.max_restarts, defaultRestartPolicy.maxRetries), retryDelayMs: numberOr(value.restart_delay, defaultRestartPolicy.retryDelayMs), stableWindowMs: numberOr(value.min_uptime, defaultRestartPolicy.stableWindowMs)
  }, logPolicy: { ...defaultLogPolicy }, warnings }];
}
function splitLiteralArgs(value: string): string[] { return value.trim() ? value.trim().split(/\s+/) : []; }
function deduplicateCandidates(candidates: readonly ImportPreviewApplication[]): ImportPreviewApplication[] { const seen = new Set<string>(); return candidates.filter((candidate) => { const key = `${candidate.cwd}\0${candidate.command.executable}\0${candidate.command.args.join('\0')}`; if (seen.has(key)) return false; seen.add(key); return true; }); }
function manifestName(manifest: PackageManifest, cwd: string): string { return typeof manifest.name === 'string' && manifest.name ? manifest.name : basename(cwd); }
function packageManagerFor(cwd: string): string { return cwd.includes('node_modules') ? 'npm' : 'pnpm'; }
async function readJson<T>(path: string): Promise<T> { return JSON.parse(await readFile(path, 'utf8')) as T; }
async function assertDirectory(path: string): Promise<void> { if (!isAbsolute(path)) throw new Error('项目路径必须是绝对路径。'); const info = await stat(path); if (!info.isDirectory()) throw new Error('项目路径必须是目录。'); await access(path, constants.R_OK); }
function quoteArgument(value: string): string { return /[\s"']/u.test(value) ? JSON.stringify(value) : value; }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function isPositiveInteger(value: unknown): value is number { return typeof value === 'number' && Number.isInteger(value) && value > 0; }
function isNonNegativeInteger(value: unknown): value is number { return typeof value === 'number' && Number.isInteger(value) && value >= 0; }
function numberOr(value: unknown, fallback: number): number { return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.round(value) : fallback; }
