import { constants } from 'node:fs';
import { access, readdir, readFile } from 'node:fs/promises';
import { basename, join, relative, resolve } from 'node:path';
import { defaultLogPolicy, defaultRestartPolicy, type ApplicationCommand, type ApplicationCommandOption, type ImportPreviewApplication, type Pm2ConversionWarning, type RunnerDetection, type RunnerKind, type RunnerSummary } from './domain.js';

/** What one runner contributes to a project scan. */
export interface RunnerScanResult {
  applications: readonly ImportPreviewApplication[];
  projectEntrypointOptions: readonly ApplicationCommandOption[];
  warnings: readonly Pm2ConversionWarning[];
}

/**
 * A toolchain capability provider. Detection only reads files and never executes project code.
 * `candidates` may stay empty for a recognised type whose command derivation is not implemented yet.
 */
export interface Runner {
  kind: RunnerKind;
  label: string;
  /** True when a person may choose this runner without any file evidence. */
  alwaysAvailable: boolean;
  /** True when a person may register an explicit command under this runner. */
  userDefinedCommands: boolean;
  detect(root: string): Promise<RunnerDetection | null>;
  candidates(root: string, includePm2: boolean): Promise<RunnerScanResult>;
}

const emptyScan: RunnerScanResult = Object.freeze({ applications: [], projectEntrypointOptions: [], warnings: [] });

const excludedDirectories = new Set(['node_modules', '.git', 'dist', 'build', '.next', 'coverage', 'test', 'tests', 'fixtures', 'examples']);
const runnableScript = /^(dev|start|serve)$/i;
const oneShotBuildTool = /\b(?:tsc|esbuild|rimraf|rollup|swc|babel)\b/iu;
const persistentCommand = /\b(?:watch|serve|dev-server)\b/iu;
const pm2FileNames = ['ecosystem.config.js', 'ecosystem.config.cjs', 'ecosystem.config.mjs', 'ecosystem.json'] as const;
const javaBuildFiles = ['pom.xml', 'build.gradle', 'build.gradle.kts', 'settings.gradle', 'settings.gradle.kts'] as const;

interface PackageManifest { name?: unknown; scripts?: unknown; workspaces?: unknown; }

/** Reads manifests and static PM2 configuration only; it never executes package scripts or ecosystem files. */
const nodeRunner: Runner = {
  kind: 'node',
  label: 'Node.js',
  alwaysAvailable: false,
  userDefinedCommands: false,
  async detect(root) {
    const reasons: string[] = [];
    for (const name of ['package.json', 'pnpm-workspace.yaml', ...pm2FileNames]) if (await pathExists(join(root, name))) reasons.push(name);
    return reasons.length ? { kind: 'node', label: 'Node.js', evidence: 'source-inspected', reasons, candidatesAvailable: true } : null;
  },
  async candidates(root, includePm2) {
    const hasPnpmWorkspace = await pathExists(join(root, 'pnpm-workspace.yaml'));
    const manifests = await discoverPackageManifests(root, 3);
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
      applications.push({
        key: `script:${cwd}`, origin: 'package-script', runnerKind: 'node', name: manifestName(manifest, cwd), cwd,
        command: selected.command, commandOptions, selectedCommand: selected.name, restartPolicy: { ...defaultRestartPolicy }, logPolicy: { ...defaultLogPolicy }, warnings: []
      });
    }
    if (includePm2) {
      for (const file of await discoverPm2Files(root, 3)) {
        const result = await readPm2Preview(file);
        applications.push(...result.applications);
        warnings.push(...result.warnings);
      }
    }
    return { applications, projectEntrypointOptions, warnings };
  },
};

/** Java projects are recognised now; command derivation arrives with the next slice. */
const javaRunner: Runner = {
  kind: 'java',
  label: 'Java',
  alwaysAvailable: false,
  userDefinedCommands: false,
  async detect(root) {
    const reasons: string[] = [];
    for (const name of javaBuildFiles) if (await pathExists(join(root, name))) reasons.push(name);
    return reasons.length ? { kind: 'java', label: 'Java', evidence: 'source-inspected', reasons, candidatesAvailable: false } : null;
  },
  async candidates() { return emptyScan; },
};

/** The general fallback: a person registers the exact command, so no file evidence is required. */
const shellRunner: Runner = {
  kind: 'shell',
  label: 'Shell 命令',
  alwaysAvailable: true,
  userDefinedCommands: true,
  async detect() { return null; },
  async candidates() { return emptyScan; },
};

/** Registration order is the order the panel offers; the fallback stays last. */
export const runners: readonly Runner[] = [nodeRunner, javaRunner, shellRunner];

export async function detectRunners(root: string): Promise<RunnerDetection[]> {
  const detections = await Promise.all(runners.map(async (runner) => await runner.detect(root)));
  return detections.filter((detection): detection is RunnerDetection => detection !== null);
}

/** The panel catalog: every runner type, its detection evidence, and whether a person may still choose it. */
export async function runnerSummaries(root: string): Promise<RunnerSummary[]> {
  return await Promise.all(runners.map(async (runner) => {
    const detection = await runner.detect(root);
    return { kind: runner.kind, label: runner.label, alwaysAvailable: runner.alwaysAvailable, userDefinedCommands: runner.userDefinedCommands, ...(detection ? { detection } : {}) };
  }));
}

export async function runCandidates(root: string, includePm2: boolean): Promise<RunnerScanResult[]> {
  return await Promise.all(runners.map(async (runner) => await runner.candidates(root, includePm2)));
}

/** A directory is a project when a runner recognises it, or when it carries its own repository marker. */
export async function isProjectDirectory(path: string): Promise<boolean> {
  if (await pathExists(join(path, '.git'))) return true;
  const detections = await Promise.all(runners.map(async (runner) => await runner.detect(path)));
  return detections.some((detection) => detection !== null);
}

const unquotedControlSyntax = /[|&;<>`$\r\n]/u;
const expandingCharacter = /[`$]/u;

/**
 * Parses an explicit command into an argument array. Dockyard never spawns through a shell, so syntax a shell
 * would have interpreted is rejected instead of being half-interpreted. Quoted text is literal, except that
 * variable expansion stays unsupported even inside double quotes, where a shell would have expanded it.
 */
export function parseCommandLine(value: string): { command: ApplicationCommand } | { error: string } {
  const input = value.trim();
  if (!input) return { error: '命令不能为空。' };
  const tokens: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  let hasToken = false;
  for (let index = 0; index < input.length; index += 1) {
    const character = input[index]!;
    if (character === '\\' && quote !== "'" && index + 1 < input.length) { current += input[index + 1]!; hasToken = true; index += 1; continue; }
    if (quote === "'") { if (character === "'") quote = null; else { current += character; hasToken = true; } continue; }
    if (quote === '"') {
      if (character === '"') { quote = null; continue; }
      if (expandingCharacter.test(character)) return { error: unsupportedCommandSyntax(character) };
      current += character; hasToken = true; continue;
    }
    if (character === '"' || character === "'") { quote = character; hasToken = true; continue; }
    if (/\s/u.test(character)) { if (hasToken) { tokens.push(current); current = ''; hasToken = false; } continue; }
    if (unquotedControlSyntax.test(character)) return { error: unsupportedCommandSyntax(character) };
    current += character; hasToken = true;
  }
  if (quote) return { error: '命令中的引号没有闭合。' };
  if (hasToken) tokens.push(current);
  const executable = tokens[0];
  if (!executable) return { error: '命令缺少可执行文件。' };
  return { command: { executable, args: tokens.slice(1) } };
}

function unsupportedCommandSyntax(character: string): string {
  return expandingCharacter.test(character)
    ? `不支持变量展开「${character}」；请填写展开后的字面值。`
    : `不支持 shell 语法「${character}」；请只填写可执行文件及其参数，不要使用管道、重定向或命令串联。`;
}

function isRunnableScript(name: string, value: unknown): value is string {
  return typeof value === 'string' && runnableScript.test(name) && (!oneShotBuildTool.test(value) || persistentCommand.test(value));
}
function isProjectEntrypointScript(name: string, value: unknown): value is string {
  return typeof value === 'string' && (isRunnableScript(name, value) || /:(?:dev|start|serve)$/iu.test(name));
}

async function discoverPackageManifests(root: string, depth: number): Promise<string[]> {
  return await discoverFiles(root, depth, (name) => name === 'package.json');
}
async function discoverPm2Files(root: string, depth: number): Promise<string[]> {
  return await discoverFiles(root, depth, (name) => (pm2FileNames as readonly string[]).includes(name));
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
  const objects = appsMatch[1]!.match(/\{[^{}]*\}/g) ?? [];
  return objects.map((object) => staticObject(object));
}
function staticObject(source: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const match of source.matchAll(/([A-Za-z_$][\w$]*)\s*:\s*(?:'([^']*)'|"([^"]*)"|(true|false)|(\d+))/g)) {
    result[match[1]!] = match[2] ?? match[3] ?? (match[4] ? match[4] === 'true' : Number(match[5]));
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
  return [{ key: `pm2:${file}:${index}`, origin: 'pm2-ecosystem', runnerKind: 'node', name, cwd, command, commandOptions: [{ name: 'pm2', command }], selectedCommand: 'pm2', restartPolicy: {
    mode: value.autorestart === false ? 'never' : 'on-failure', maxRetries: numberOr(value.max_restarts, defaultRestartPolicy.maxRetries), retryDelayMs: numberOr(value.restart_delay, defaultRestartPolicy.retryDelayMs), stableWindowMs: numberOr(value.min_uptime, defaultRestartPolicy.stableWindowMs)
  }, logPolicy: { ...defaultLogPolicy }, warnings }];
}
function splitLiteralArgs(value: string): string[] { return value.trim() ? value.trim().split(/\s+/) : []; }
function manifestName(manifest: PackageManifest, cwd: string): string { return typeof manifest.name === 'string' && manifest.name ? manifest.name : basename(cwd); }
function packageManagerFor(cwd: string): string { return cwd.includes('node_modules') ? 'npm' : 'pnpm'; }
async function readJson<T>(path: string): Promise<T> { return JSON.parse(await readFile(path, 'utf8')) as T; }
async function pathExists(path: string): Promise<boolean> { try { await access(path, constants.R_OK); return true; } catch { return false; } }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function numberOr(value: unknown, fallback: number): number { return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.round(value) : fallback; }
