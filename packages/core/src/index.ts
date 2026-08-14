import { access, readdir, readFile, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';

export type ApplicationStatus = 'stopped' | 'starting' | 'running' | 'restarting' | 'crashed';
export type ProjectStartupPreference = 'automatic' | 'project-first' | 'module-first';
/** Identifies whether the currently observed process was created by Dockyard or adopted from the host. */
export type RuntimeOwnership = 'dockyard' | 'external' | null;
/** External processes are observed safely until a person explicitly allows recovery management. */
export type ExternalRuntimeManagement = 'observe' | 'adopted';
/** Describes whether Dockyard can receive newly emitted log output for this runtime. */
export type LogCaptureStatus = 'streaming' | 'file-backed' | 'inspector' | 'unavailable' | 'inactive';
export type RestartMode = 'never' | 'on-failure' | 'always';
export type LogStream = 'stdout' | 'stderr';
/** A profile declares the expected response to a source change; it never sends a signal itself. */
export type ChangeImpact = 'hot-reload' | 'auto-restart' | 'manual-restart' | 'rebuild' | 'migration' | 'confirmation-required';
/** Distinguishes a conclusion observed at runtime from one inferred from checked source. */
export type ProfileEvidence = 'runtime-verified' | 'source-inspected' | 'unverified';
export type PortReachability = 'not-configured' | 'unknown' | 'reachable' | 'unreachable';
export type ServiceHealthStatus = 'not-configured' | 'unknown' | 'healthy' | 'unhealthy';

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
  sampleIntervalMs: number;
  /** Time after manual log scrolling before new lines may pull the viewport back to the bottom. */
  logAutoScrollPauseMs: number;
  /** SQLite keeps raw metric samples for this bounded number of days. */
  metricRetentionDays: number;
  retentionDays: number;
  maxFiles: number;
  maxBytesPerFile: number;
  restartPreset: RestartPreset;
}

export interface ApplicationCommand {
  executable: string;
  args: readonly string[];
}

export interface ApplicationCommandOption {
  name: string;
  command: ApplicationCommand;
}

export interface ServiceHealthCheck {
  type: 'http';
  path: string;
}

export interface ServiceChangeRule {
  id: string;
  label: string;
  impact: ChangeImpact;
  evidence: ProfileEvidence;
  explanation: string;
}

/** A project-specific, declarative service baseline. It deliberately contains no process handle. */
export interface ServiceProfile {
  profileId: string;
  id: string;
  serviceName: string;
  cwd: string;
  command: ApplicationCommand;
  defaultPort?: number;
  healthCheck?: ServiceHealthCheck;
  restartPolicy: RestartPolicy;
  changeRules: readonly ServiceChangeRule[];
}

export interface CompatibilityProfile {
  id: string;
  name: string;
  evidence: ProfileEvidence;
  services: readonly ServiceProfile[];
}

export interface ProjectSettings {
  /** Empty means every application in the project participates in one-click start. */
  startupApplicationIds: readonly string[];
  /** Determines whether a project root entrypoint or individual modules own one-click lifecycle actions. */
  startupPreference: ProjectStartupPreference;
  projectEntrypointOptions: readonly ApplicationCommandOption[];
  selectedProjectEntrypoint: string | null;
  restartPolicy: RestartPolicy;
  logPolicy: LogPolicy;
}

export interface ProjectRuntime {
  status: ApplicationStatus;
  pid: number | null;
  ownership: RuntimeOwnership;
  selectedEntrypoint: string | null;
}

export interface Project {
  id: string;
  path: string;
  name: string;
  settings: ProjectSettings;
  runtime: ProjectRuntime;
  createdAt: string;
}

export interface Application {
  id: string;
  projectId: string;
  name: string;
  cwd: string;
  command: ApplicationCommand;
  commandOptions: readonly ApplicationCommandOption[];
  selectedCommand: string;
  status: ApplicationStatus;
  pid: number | null;
  runtimeOwnership: RuntimeOwnership;
  externalRuntimeManagement: ExternalRuntimeManagement;
  /** Runtime-only state. Persisted application records do not carry this value. */
  logCaptureStatus?: LogCaptureStatus;
  listeningPorts: readonly number[];
  /** Runtime-only observations, deliberately independent from process ownership. */
  portReachability: PortReachability;
  healthStatus: ServiceHealthStatus;
  serviceProfile?: ServiceProfile;
  restartPolicy: RestartPolicy;
  logPolicy: LogPolicy;
  createdAt: string;
  updatedAt: string;
}

export interface LifecycleEvent {
  id: string;
  applicationId: string;
  type: 'started' | 'stopped' | 'exited' | 'restart-scheduled' | 'crashed' | 'diagnostics-exported' | 'external-log-following' | 'external-log-unavailable' | 'external-adopted';
  occurredAt: string;
  detail: Record<string, unknown>;
}

export interface MetricRollup {
  applicationId: string;
  sampledAt: string;
  pid: number | null;
  cpuPercent: number | null;
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
  commandOptions: readonly ApplicationCommandOption[];
  selectedCommand: string;
  restartPolicy: RestartPolicy;
  logPolicy: LogPolicy;
  serviceProfile?: ServiceProfile;
  warnings: readonly Pm2ConversionWarning[];
}
export interface ImportPreview {
  root: string;
  projectName: string;
  projectEntrypointOptions: readonly ApplicationCommandOption[];
  selectedProjectEntrypoint: string | null;
  applications: readonly ImportPreviewApplication[];
  compatibilityProfile?: CompatibilityProfile;
  warnings: readonly Pm2ConversionWarning[];
}

export const defaultRestartPolicy: RestartPolicy = Object.freeze({ mode: 'on-failure', maxRetries: 5, retryDelayMs: 1_000, stableWindowMs: 30_000 });
export const defaultLogPolicy: LogPolicy = Object.freeze({ maxFiles: 5, maxBytesPerFile: 10 * 1024 * 1024, retentionDays: 14 });
export const defaultProjectSettings: ProjectSettings = Object.freeze({ startupApplicationIds: [], startupPreference: 'automatic', projectEntrypointOptions: [], selectedProjectEntrypoint: null, restartPolicy: defaultRestartPolicy, logPolicy: defaultLogPolicy });
export const defaultDockyardSettings: DockyardSettings = Object.freeze({ version: 0, sampleIntervalMs: 1_000, logAutoScrollPauseMs: 30_000, metricRetentionDays: 7, retentionDays: 14, maxFiles: 5, maxBytesPerFile: 10 * 1024 * 1024, restartPreset: 'balanced' });

export function restartPolicyForPreset(preset: RestartPreset): RestartPolicy {
  if (preset === 'manual') return { mode: 'never', maxRetries: 0, retryDelayMs: 1_000, stableWindowMs: 30_000 };
  if (preset === 'resilient') return { mode: 'always', maxRetries: 10, retryDelayMs: 1_000, stableWindowMs: 30_000 };
  return { ...defaultRestartPolicy };
}

const runnableScript = /^(dev|start|serve)$/i;
const oneShotBuildTool = /\b(?:tsc|esbuild|rimraf|rollup|swc|babel)\b/iu;
const persistentCommand = /\b(?:watch|serve|dev-server)\b/iu;
const excludedDirectories = new Set(['node_modules', '.git', 'dist', 'build', '.next', 'coverage', 'test', 'tests', 'fixtures', 'examples']);

interface PackageManifest { name?: unknown; scripts?: unknown; workspaces?: unknown; }

/** Reads manifests only; it never executes package scripts or ecosystem files. */
export async function scanProject(rootInput: string, includePm2 = true): Promise<ImportPreview> {
  const root = resolve(rootInput);
  await assertDirectory(root);
  const hasPnpmWorkspace = await pathExists(join(root, 'pnpm-workspace.yaml'));
  const manifests = await discoverPackageManifests(root, 3);
  const compatibilityProfile = await detectCompatibilityProfile(root);
  const applications: ImportPreviewApplication[] = [];
  const warnings: Pm2ConversionWarning[] = [];
  let projectEntrypointOptions: ApplicationCommandOption[] = [];
  for (const manifestPath of manifests) {
    const manifest = await readJson<PackageManifest>(manifestPath);
    const scripts = isRecord(manifest.scripts) ? manifest.scripts : {};
    const cwd = resolve(manifestPath, '..');
    if (cwd === root) {
      projectEntrypointOptions = Object.entries(scripts)
        .filter(([script, value]) => isProjectEntrypointScript(script, value))
        .map(([name]) => ({ name, command: { executable: packageManagerFor(cwd), args: ['run', name] } }));
      if (manifest.workspaces !== undefined || hasPnpmWorkspace) continue;
    }
    const commandOptions = Object.entries(scripts)
      .filter(([script, value]) => isRunnableScript(script, value))
      .map(([name]) => ({ name, command: { executable: packageManagerFor(cwd), args: ['run', name] } }));
    if (!commandOptions.length) continue;
    const selected = commandOptions.find((option) => option.name === 'dev') ?? commandOptions.find((option) => option.name === 'start') ?? commandOptions[0]!;
    const serviceProfile = compatibilityProfile?.services.find((service) => service.cwd === cwd && sameCommand(service.command, selected.command));
    applications.push({
      key: `script:${cwd}`, origin: 'package-script', name: manifestName(manifest, cwd), cwd,
      command: selected.command, commandOptions, selectedCommand: selected.name, restartPolicy: { ...defaultRestartPolicy }, logPolicy: { ...defaultLogPolicy }, serviceProfile, warnings: []
    });
  }
  if (includePm2) {
    const pm2Files = await discoverPm2Files(root, 3);
    for (const file of pm2Files) {
      const result = await readPm2Preview(file);
      applications.push(...result.applications);
      warnings.push(...result.warnings);
    }
  }
  const selectedProjectEntrypoint = projectEntrypointOptions.find((option) => option.name === 'dev')?.name ?? projectEntrypointOptions.find((option) => /:dev$/iu.test(option.name))?.name ?? projectEntrypointOptions[0]?.name ?? null;
  return { root, projectName: basename(root), projectEntrypointOptions, selectedProjectEntrypoint, applications: deduplicateCandidates(applications), compatibilityProfile, warnings };
}

/** A dev/start name alone is not enough: known build pipelines exit successfully after one run. */
function isRunnableScript(name: string, value: unknown): value is string {
  return typeof value === 'string' && runnableScript.test(name) && (!oneShotBuildTool.test(value) || persistentCommand.test(value));
}
function isProjectEntrypointScript(name: string, value: unknown): value is string {
  return typeof value === 'string' && (isRunnableScript(name, value) || /:(?:dev|start|serve)$/iu.test(name));
}

async function detectCompatibilityProfile(root: string): Promise<CompatibilityProfile | undefined> {
  const [workspace, rootManifest, dashboardManifest, apiManifest, schedulesManifest, serverManifest, i18nManifest] = await Promise.all([
    readFile(join(root, 'pnpm-workspace.yaml'), 'utf8').catch(() => null),
    readPackageManifest(join(root, 'package.json')),
    readPackageManifest(join(root, 'apps/dokploy/package.json')),
    readPackageManifest(join(root, 'apps/api/package.json')),
    readPackageManifest(join(root, 'apps/schedules/package.json')),
    readPackageManifest(join(root, 'packages/server/package.json')),
    readPackageManifest(join(root, 'packages/i18n/package.json')),
  ]);
  const expectedWorkspacePaths = ['apps/api', 'apps/dokploy', 'apps/schedules', 'packages/i18n', 'packages/server'];
  const workspaceMatches = workspace !== null && expectedWorkspacePaths.every((path) => workspace.includes(`"${path}"`) || workspace.includes(`'${path}'`));
  if (!workspaceMatches || rootManifest?.name !== 'dokploy' || dashboardManifest?.name !== 'dokploy' || apiManifest?.name !== '@dokploy/api' || schedulesManifest?.name !== '@dokploy/schedules' || serverManifest?.name !== '@dokploy/server' || i18nManifest?.name !== '@dokploy/i18n') return undefined;
  if (scriptFor(dashboardManifest, 'dev') !== 'tsx -r dotenv/config ./server/server.ts --project tsconfig.server.json' || scriptFor(apiManifest, 'dev') !== 'PORT=4000 tsx watch src/index.ts' || scriptFor(schedulesManifest, 'dev') !== 'PORT=4001 tsx watch src/index.ts') return undefined;
  const service = (id: string, serviceName: string, cwd: string, defaultPort: number, healthCheck: ServiceHealthCheck | undefined, changeRules: readonly ServiceChangeRule[]): ServiceProfile => ({ profileId: 'dokploy', id, serviceName, cwd: join(root, cwd), command: { executable: 'pnpm', args: ['run', 'dev'] }, defaultPort, ...(healthCheck ? { healthCheck } : {}), restartPolicy: { ...defaultRestartPolicy }, changeRules });
  return {
    id: 'dokploy', name: 'Dokploy 开发运行画像', evidence: 'source-inspected', services: [
      service('dashboard', 'Dokploy 主面板', 'apps/dokploy', 3000, { type: 'http', path: '/' }, [
        { id: 'next-ui', label: 'Next 页面与组件', impact: 'hot-reload', evidence: 'source-inspected', explanation: '自定义开发 server 显式把 HMR WebSocket 交给 Next；尚未对完整 Dokploy 进程做运行验证。' },
        { id: 'custom-server', label: '自定义 Node server、WebSocket 与启动初始化', impact: 'manual-restart', evidence: 'runtime-verified', explanation: '该开发命令使用 tsx 但没有 watch；Dokploy 锁定的 tsx 实验在文件变化后未重启。' },
        { id: 'shared-runtime', label: '共享包、环境变量、依赖或数据库结构', impact: 'confirmation-required', evidence: 'unverified', explanation: '这些影响须以依赖图和实际运行结果确认，不能由静态画像猜测。' },
      ]),
      service('api', 'Dokploy 部署 API', 'apps/api', 4000, { type: 'http', path: '/' }, [
        { id: 'service-source', label: 'API 服务源文件', impact: 'auto-restart', evidence: 'runtime-verified', explanation: '开发命令使用 tsx watch；Dokploy 锁定的 tsx 实验确认文件变化会重启受监控入口。' },
        { id: 'shared-runtime', label: '共享包、环境变量、依赖或数据库结构', impact: 'confirmation-required', evidence: 'unverified', explanation: '这些影响须以依赖图和实际运行结果确认，不能由静态画像猜测。' },
      ]),
      service('schedules', 'Dokploy 计划服务', 'apps/schedules', 4001, { type: 'http', path: '/' }, [
        { id: 'service-source', label: '计划服务源文件', impact: 'auto-restart', evidence: 'runtime-verified', explanation: '开发命令使用 tsx watch；Dokploy 锁定的 tsx 实验确认文件变化会重启受监控入口。' },
        { id: 'shared-runtime', label: '共享包、环境变量、依赖或数据库结构', impact: 'confirmation-required', evidence: 'unverified', explanation: '这些影响须以依赖图和实际运行结果确认，不能由静态画像猜测。' },
      ]),
    ]
  };
}
async function readPackageManifest(path: string): Promise<PackageManifest | null> { try { return await readJson<PackageManifest>(path); } catch { return null; } }
/** Package scripts are shell text, so insignificant whitespace is normalized before an otherwise exact match. */
function scriptFor(manifest: PackageManifest, name: string): string | undefined { return isRecord(manifest.scripts) && typeof manifest.scripts[name] === 'string' ? manifest.scripts[name].trim().replace(/\s+/gu, ' ') : undefined; }
function sameCommand(left: ApplicationCommand, right: ApplicationCommand): boolean { return left.executable === right.executable && left.args.length === right.args.length && left.args.every((argument, index) => argument === right.args[index]); }

/** Discovers direct child code repositories without treating a parent folder as a Project itself. */
export async function scanProjectDirectory(rootInput: string, includePm2 = true): Promise<ImportPreview[]> {
  const root = resolve(rootInput);
  await assertDirectory(root);
  const entries = await readdir(root, { withFileTypes: true });
  const candidates = entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.') && !excludedDirectories.has(entry.name))
    .map((entry) => join(root, entry.name));
  const projects = await Promise.all(candidates.map(async (candidate) => await isProjectDirectory(candidate) ? scanProject(candidate, includePm2) : null));
  return projects.filter((project): project is ImportPreview => project !== null).sort((left, right) => left.projectName.localeCompare(right.projectName));
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

export function parseCommandOptions(value: unknown): ApplicationCommandOption[] | null {
  if (!Array.isArray(value)) return null;
  const options = value.map((item) => isRecord(item) && typeof item.name === 'string' && item.name ? { name: item.name, command: parseApplicationCommand(item.command) } : null);
  if (options.some((option) => option === null || option.command === null)) return null;
  return options.map((option) => ({ name: option!.name, command: option!.command! }));
}

export function parseServiceProfile(value: unknown): ServiceProfile | null {
  if (!isRecord(value) || typeof value.profileId !== 'string' || !value.profileId || typeof value.id !== 'string' || !value.id || typeof value.serviceName !== 'string' || !value.serviceName || typeof value.cwd !== 'string' || !isAbsolute(value.cwd)) return null;
  const command = parseApplicationCommand(value.command);
  const restartPolicy = parseRestartPolicy(value.restartPolicy);
  const healthCheck = parseHealthCheck(value.healthCheck);
  const defaultPort = value.defaultPort === undefined ? undefined : isPort(value.defaultPort) ? value.defaultPort : null;
  const changeRules = parseChangeRules(value.changeRules);
  if (!command || !restartPolicy || defaultPort === null || !changeRules || (value.healthCheck !== undefined && !healthCheck)) return null;
  return { profileId: value.profileId, id: value.id, serviceName: value.serviceName, cwd: resolve(value.cwd), command, ...(defaultPort === undefined ? {} : { defaultPort }), ...(healthCheck ? { healthCheck } : {}), restartPolicy, changeRules };
}

export function parseProjectSettings(value: unknown): ProjectSettings | null {
  if (!isRecord(value) || !Array.isArray(value.startupApplicationIds) || !value.startupApplicationIds.every((id) => typeof id === 'string')) return null;
  const restartPolicy = parseRestartPolicy(value.restartPolicy); const logPolicy = parseLogPolicy(value.logPolicy);
  const startupPreference = value.startupPreference === undefined ? 'automatic' : ['automatic', 'project-first', 'module-first'].includes(String(value.startupPreference)) ? value.startupPreference as ProjectStartupPreference : null;
  const projectEntrypointOptions = value.projectEntrypointOptions === undefined ? [] : parseCommandOptions(value.projectEntrypointOptions);
  const selectedProjectEntrypoint = value.selectedProjectEntrypoint === undefined ? null : typeof value.selectedProjectEntrypoint === 'string' ? value.selectedProjectEntrypoint : value.selectedProjectEntrypoint === null ? null : undefined;
  return restartPolicy && logPolicy && startupPreference && projectEntrypointOptions && selectedProjectEntrypoint !== undefined && (selectedProjectEntrypoint === null || projectEntrypointOptions.some((option) => option.name === selectedProjectEntrypoint)) ? { startupApplicationIds: value.startupApplicationIds, startupPreference, projectEntrypointOptions, selectedProjectEntrypoint, restartPolicy, logPolicy } : null;
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
  return [{ key: `pm2:${file}:${index}`, origin: 'pm2-ecosystem', name, cwd, command, commandOptions: [{ name: 'pm2', command }], selectedCommand: 'pm2', restartPolicy: {
    mode: value.autorestart === false ? 'never' : 'on-failure', maxRetries: numberOr(value.max_restarts, defaultRestartPolicy.maxRetries), retryDelayMs: numberOr(value.restart_delay, defaultRestartPolicy.retryDelayMs), stableWindowMs: numberOr(value.min_uptime, defaultRestartPolicy.stableWindowMs)
  }, logPolicy: { ...defaultLogPolicy }, warnings }];
}
function splitLiteralArgs(value: string): string[] { return value.trim() ? value.trim().split(/\s+/) : []; }
function deduplicateCandidates(candidates: readonly ImportPreviewApplication[]): ImportPreviewApplication[] { const seen = new Set<string>(); return candidates.filter((candidate) => { const key = `${candidate.cwd}\0${candidate.command.executable}\0${candidate.command.args.join('\0')}`; if (seen.has(key)) return false; seen.add(key); return true; }); }
function manifestName(manifest: PackageManifest, cwd: string): string { return typeof manifest.name === 'string' && manifest.name ? manifest.name : basename(cwd); }
function packageManagerFor(cwd: string): string { return cwd.includes('node_modules') ? 'npm' : 'pnpm'; }
async function readJson<T>(path: string): Promise<T> { return JSON.parse(await readFile(path, 'utf8')) as T; }
async function pathExists(path: string): Promise<boolean> { try { await access(path, constants.R_OK); return true; } catch { return false; } }
async function isProjectDirectory(path: string): Promise<boolean> {
  if (await pathExists(join(path, 'package.json')) || await pathExists(join(path, 'pnpm-workspace.yaml')) || await pathExists(join(path, '.git'))) return true;
  const pm2Files = await Promise.all(['ecosystem.config.js', 'ecosystem.config.cjs', 'ecosystem.config.mjs', 'ecosystem.json'].map((name) => pathExists(join(path, name))));
  return pm2Files.some(Boolean);
}
async function assertDirectory(path: string): Promise<void> { if (!isAbsolute(path)) throw new Error('项目路径必须是绝对路径。'); const info = await stat(path); if (!info.isDirectory()) throw new Error('项目路径必须是目录。'); await access(path, constants.R_OK); }
function quoteArgument(value: string): string { return /[\s"']/u.test(value) ? JSON.stringify(value) : value; }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function isPositiveInteger(value: unknown): value is number { return typeof value === 'number' && Number.isInteger(value) && value > 0; }
function isPort(value: unknown): value is number { return isPositiveInteger(value) && value <= 65_535; }
function isNonNegativeInteger(value: unknown): value is number { return typeof value === 'number' && Number.isInteger(value) && value >= 0; }
function numberOr(value: unknown, fallback: number): number { return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.round(value) : fallback; }
function parseHealthCheck(value: unknown): ServiceHealthCheck | null { return isRecord(value) && value.type === 'http' && typeof value.path === 'string' && value.path.startsWith('/') ? { type: 'http', path: value.path } : null; }
function parseChangeRules(value: unknown): ServiceChangeRule[] | null {
  if (!Array.isArray(value)) return null;
  const rules = value.map((item) => isRecord(item) && typeof item.id === 'string' && item.id && typeof item.label === 'string' && typeof item.explanation === 'string' && ['hot-reload', 'auto-restart', 'manual-restart', 'rebuild', 'migration', 'confirmation-required'].includes(String(item.impact)) && ['runtime-verified', 'source-inspected', 'unverified'].includes(String(item.evidence)) ? { id: item.id, label: item.label, explanation: item.explanation, impact: item.impact as ChangeImpact, evidence: item.evidence as ProfileEvidence } : null);
  return rules.some((rule) => rule === null) ? null : rules as ServiceChangeRule[];
}
