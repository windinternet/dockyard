import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { defaultRestartPolicy, type CompatibilityProfile, type ServiceChangeRule, type ServiceProfile } from '@dockyard/core';

interface PackageManifest { name?: string; scripts?: Record<string, string>; }

const expectedWorkspacePaths = ['apps/api', 'apps/dokploy', 'apps/schedules', 'packages/i18n', 'packages/server'];

/**
 * Strict, read-only Dokploy adapter. It treats all repository files as untrusted
 * input and returns no profile unless every structural and script assertion holds.
 */
export async function detectDokployCompatibilityProfile(rootInput: string): Promise<CompatibilityProfile | undefined> {
  const root = resolve(rootInput);
  const [workspace, rootManifest, dashboardManifest, apiManifest, schedulesManifest, serverManifest, i18nManifest] = await Promise.all([
    readWorkspacePackages(join(root, 'pnpm-workspace.yaml')),
    readPackageManifest(join(root, 'package.json')),
    readPackageManifest(join(root, 'apps/dokploy/package.json')),
    readPackageManifest(join(root, 'apps/api/package.json')),
    readPackageManifest(join(root, 'apps/schedules/package.json')),
    readPackageManifest(join(root, 'packages/server/package.json')),
    readPackageManifest(join(root, 'packages/i18n/package.json')),
  ]);
  if (!sameStrings(workspace, expectedWorkspacePaths) || rootManifest?.name !== 'dokploy' || dashboardManifest?.name !== 'dokploy' || apiManifest?.name !== '@dokploy/api' || schedulesManifest?.name !== '@dokploy/schedules' || serverManifest?.name !== '@dokploy/server' || i18nManifest?.name !== '@dokploy/i18n') return undefined;
  if (dashboardManifest.scripts?.dev !== 'tsx -r dotenv/config ./server/server.ts --project tsconfig.server.json' || apiManifest.scripts?.dev !== 'PORT=4000 tsx watch src/index.ts' || schedulesManifest.scripts?.dev !== 'PORT=4001 tsx watch src/index.ts') return undefined;

  const service = (id: string, serviceName: string, cwd: string, defaultPort: number, processCommandHints: readonly string[], changeRules: readonly ServiceChangeRule[]): ServiceProfile => ({
    profileId: 'dokploy', id, serviceName, cwd: join(root, cwd), command: { executable: 'pnpm', args: ['run', 'dev'] }, defaultPort, processCommandHints, restartPolicy: { ...defaultRestartPolicy }, changeRules,
  });
  const needsConfirmation: ServiceChangeRule = {
    id: 'shared-runtime', label: '共享包、环境变量、依赖或数据库结构', pathPatterns: ['packages/**', 'pnpm-lock.yaml', 'package.json', '**/.env*', '**/drizzle/**'], impact: 'confirmation-required', evidence: 'unverified', explanation: '共享依赖、环境、锁文件或数据库结构必须结合依赖图和实际运行结果确认；画像不会猜测其影响。',
  };
  return {
    id: 'dokploy', name: 'Dokploy 开发运行画像', evidence: 'source-inspected', services: [
      service('dashboard', 'Dokploy 主面板', 'apps/dokploy', 3000, ['tsx', 'server/server.ts'], [
        { id: 'next-ui', label: 'Next 页面与组件', pathPatterns: ['apps/dokploy/pages/**', 'apps/dokploy/components/**', 'apps/dokploy/hooks/**'], impact: 'hot-reload', evidence: 'source-inspected', explanation: '自定义开发 server 显式把 HMR WebSocket 交给 Next；尚未对完整 Dokploy 进程做运行验证。' },
        { id: 'custom-server', label: '自定义 Node server、WebSocket 与启动初始化', pathPatterns: ['apps/dokploy/server/**', 'apps/dokploy/next.config.*', 'apps/dokploy/tsconfig.server.json'], impact: 'manual-restart', evidence: 'runtime-verified', explanation: '该开发命令使用 tsx 但没有 watch；Dokploy 锁定的 tsx 实验在文件变化后未重启。' },
        needsConfirmation,
      ]),
      service('api', 'Dokploy 部署 API', 'apps/api', 4000, ['tsx', 'watch', 'src/index.ts'], [
        { id: 'service-source', label: 'API 服务源文件', pathPatterns: ['apps/api/src/**'], impact: 'auto-restart', evidence: 'runtime-verified', explanation: '开发命令使用 tsx watch；Dokploy 锁定的 tsx 实验确认文件变化会重启受监控入口。' },
        needsConfirmation,
      ]),
      service('schedules', 'Dokploy 计划服务', 'apps/schedules', 4001, ['tsx', 'watch', 'src/index.ts'], [
        { id: 'service-source', label: '计划服务源文件', pathPatterns: ['apps/schedules/src/**'], impact: 'auto-restart', evidence: 'runtime-verified', explanation: '开发命令使用 tsx watch；Dokploy 锁定的 tsx 实验确认文件变化会重启受监控入口。' },
        needsConfirmation,
      ]),
    ],
  };
}

/** Parses only the narrow, quoted YAML sequence emitted by Dokploy's pnpm workspace file. */
export function parseWorkspacePackagePaths(source: string): string[] | null {
  if (source.length > 64 * 1024) return null;
  const paths: string[] = [];
  let packages = false;
  for (const rawLine of source.replace(/^\uFEFF/u, '').split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    if (!packages) { if (line !== 'packages:') return null; packages = true; continue; }
    const match = line.match(/^-\s+(["'])([^"'#\r\n]+)\1\s*(?:#.*)?$/u);
    if (!match) return null;
    paths.push(match[2]!);
  }
  return packages && paths.length ? paths : null;
}

async function readWorkspacePackages(path: string): Promise<string[] | null> {
  try { return parseWorkspacePackagePaths(await readFile(path, 'utf8')); } catch { return null; }
}
async function readPackageManifest(path: string): Promise<PackageManifest | null> {
  try {
    const value: unknown = JSON.parse(await readFile(path, 'utf8'));
    if (!isRecord(value)) return null;
    const name = typeof value.name === 'string' ? value.name : undefined;
    const scripts = isRecord(value.scripts) && Object.values(value.scripts).every((script) => typeof script === 'string') ? Object.fromEntries(Object.entries(value.scripts).map(([name, script]) => [name, normalizeScript(script as string)])) : undefined;
    return { ...(name ? { name } : {}), ...(scripts ? { scripts } : {}) };
  } catch { return null; }
}
function normalizeScript(script: string): string { return script.trim().replace(/\s+/gu, ' '); }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function sameStrings(left: readonly string[] | null, right: readonly string[]): boolean { return left !== null && left.length === right.length && left.every((value, index) => value === right[index]); }
