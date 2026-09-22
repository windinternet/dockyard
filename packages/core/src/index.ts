import { constants } from 'node:fs';
import { access, readdir, stat } from 'node:fs/promises';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import type { ApplicationCommand, ApplicationCommandOption, ChangeAssessment, ChangeImpact, CompatibilityProfile, ImportPreview, ImportPreviewApplication, LogPolicy, ProfileEvidence, ProjectSettings, ProjectStartupPreference, RestartMode, RestartPolicy, ServiceChangeRule, ServiceHealthCheck, ServiceProfile } from './domain.js';
import { isProjectDirectory, runnerSummaries, runCandidates } from './runners.js';

export * from './domain.js';
export { detectRunners, isProjectDirectory, parseCommandLine, runners, runnerSummaries, type Runner, type RunnerScanResult } from './runners.js';

/**
 * Composes every runner into one import preview. Runner order decides application order; duplicates are dropped
 * by working directory and command so that two runners cannot register the same process twice.
 */
export async function scanProject(rootInput: string, includePm2 = true): Promise<ImportPreview> {
  const root = resolve(rootInput);
  await assertDirectory(root);
  const [runners, results] = await Promise.all([runnerSummaries(root), runCandidates(root, includePm2)]);
  const projectEntrypointOptions = results.flatMap((result) => result.projectEntrypointOptions);
  const selectedProjectEntrypoint = projectEntrypointOptions.find((option) => option.name === 'dev')?.name ?? projectEntrypointOptions.find((option) => /:dev$/iu.test(option.name))?.name ?? projectEntrypointOptions[0]?.name ?? null;
  return { root, projectName: basename(root), projectEntrypointOptions, selectedProjectEntrypoint, applications: deduplicateCandidates(results.flatMap((result) => result.applications)), runners, warnings: results.flatMap((result) => result.warnings) };
}

/** Attaches an adapter-provided baseline only when it exactly matches a scanned application command. */
export function withCompatibilityProfile(preview: ImportPreview, compatibilityProfile: CompatibilityProfile | undefined): ImportPreview {
  if (!compatibilityProfile) return preview;
  return {
    ...preview,
    compatibilityProfile,
    applications: preview.applications.map((application) => {
      const serviceProfile = compatibilityProfile.services.find((service) => resolve(service.cwd) === resolve(application.cwd) && sameCommand(service.command, application.command));
      return serviceProfile ? { ...application, serviceProfile } : application;
    }),
  };
}

/** Resolves concrete paths without inferring a lifecycle action for an unmatched path. */
export function assessServiceChanges(service: ServiceProfile, projectRoot: string, paths: readonly string[]): ChangeAssessment[] {
  const root = resolve(projectRoot);
  return paths.map((path) => {
    const relativePath = relative(root, resolve(root, path)).replaceAll('\\', '/');
    const rule = relativePath && !relativePath.startsWith('../') && !relativePath.startsWith('/') ? service.changeRules.find((candidate) => candidate.pathPatterns.some((pattern) => globMatches(pattern, relativePath))) : undefined;
    return rule
      ? { path, impact: rule.impact, evidence: rule.evidence, ruleId: rule.id, explanation: rule.explanation }
      : { path, impact: 'confirmation-required', evidence: 'unverified', explanation: '该路径没有已验证的画像规则；请检查依赖图与运行结果后再决定是否重启、重建或迁移。' };
  });
}

function sameCommand(left: ApplicationCommand, right: ApplicationCommand): boolean { return left.executable === right.executable && left.args.length === right.args.length && left.args.every((argument, index) => argument === right.args[index]); }
function globMatches(pattern: string, path: string): boolean {
  const expression = `^${pattern.replace(/[.+^${}()|[\]\\]/gu, '\\$&').replaceAll('**', '§').replaceAll('*', '[^/]*').replaceAll('§', '.*')}$`;
  return new RegExp(expression, 'u').test(path);
}

/** Discovers direct child code repositories without treating a parent folder as a Project itself. */
export async function scanProjectDirectory(rootInput: string, includePm2 = true): Promise<ImportPreview[]> {
  const root = resolve(rootInput);
  await assertDirectory(root);
  const entries = await readdir(root, { withFileTypes: true });
  const candidates = entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.') && !excludedScanDirectories.has(entry.name))
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
  return { executable: redactDisplayText(command.executable), args: command.args.map((argument, index) => index > 0 && /(?:api[_-]?key|token|secret|password)$/iu.test(command.args[index - 1]!) ? '[REDACTED]' : redactDisplayText(argument)) };
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
  const processCommandHints = value.processCommandHints === undefined ? [] : Array.isArray(value.processCommandHints) && value.processCommandHints.every((hint) => typeof hint === 'string' && hint) ? value.processCommandHints : null;
  const changeRules = parseChangeRules(value.changeRules);
  if (!command || !restartPolicy || defaultPort === null || !processCommandHints || !changeRules || (value.healthCheck !== undefined && !healthCheck)) return null;
  return { profileId: value.profileId, id: value.id, serviceName: value.serviceName, cwd: resolve(value.cwd), command, ...(defaultPort === undefined ? {} : { defaultPort }), ...(healthCheck ? { healthCheck } : {}), processCommandHints, restartPolicy, changeRules };
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

const excludedScanDirectories = new Set(['node_modules', '.git', 'dist', 'build', '.next', 'coverage', 'test', 'tests', 'fixtures', 'examples']);
function deduplicateCandidates(candidates: readonly ImportPreviewApplication[]): ImportPreviewApplication[] { const seen = new Set<string>(); return candidates.filter((candidate) => { const key = `${candidate.cwd}\0${candidate.command.executable}\0${candidate.command.args.join('\0')}`; if (seen.has(key)) return false; seen.add(key); return true; }); }
async function assertDirectory(path: string): Promise<void> { if (!isAbsolute(path)) throw new Error('项目路径必须是绝对路径。'); const info = await stat(path); if (!info.isDirectory()) throw new Error('项目路径必须是目录。'); await access(path, constants.R_OK); }
function quoteArgument(value: string): string { return /[\s"']/u.test(value) ? JSON.stringify(value) : value; }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function isPositiveInteger(value: unknown): value is number { return typeof value === 'number' && Number.isInteger(value) && value > 0; }
function isPort(value: unknown): value is number { return isPositiveInteger(value) && value <= 65_535; }
function isNonNegativeInteger(value: unknown): value is number { return typeof value === 'number' && Number.isInteger(value) && value >= 0; }
function parseHealthCheck(value: unknown): ServiceHealthCheck | null { return isRecord(value) && value.type === 'http' && typeof value.path === 'string' && value.path.startsWith('/') ? { type: 'http', path: value.path } : null; }
function parseChangeRules(value: unknown): ServiceChangeRule[] | null {
  if (!Array.isArray(value)) return null;
  const rules = value.map((item) => {
    if (!isRecord(item) || typeof item.id !== 'string' || !item.id || typeof item.label !== 'string' || typeof item.explanation !== 'string' || !['hot-reload', 'auto-restart', 'manual-restart', 'rebuild', 'migration', 'confirmation-required'].includes(String(item.impact)) || !['runtime-verified', 'source-inspected', 'unverified'].includes(String(item.evidence))) return null;
    const pathPatterns = item.pathPatterns === undefined ? [] : Array.isArray(item.pathPatterns) && item.pathPatterns.every((pattern) => typeof pattern === 'string' && pattern && !pattern.startsWith('/') && !pattern.includes('..')) ? item.pathPatterns : null;
    return pathPatterns === null ? null : { id: item.id, label: item.label, pathPatterns, explanation: item.explanation, impact: item.impact as ChangeImpact, evidence: item.evidence as ProfileEvidence };
  });
  return rules.some((rule) => rule === null) ? null : rules as ServiceChangeRule[];
}
