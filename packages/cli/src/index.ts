#!/usr/bin/env node
import { Command } from 'commander';
const program = new Command().name('dockyard').description('Agent-friendly local Dockyard client').version('0.1.0');
program.command('status').option('--json', 'machine-readable output').action(async (options) => {
  try {
    const response = await fetch(new URL('/health', resolveDaemonUrl()), { signal: AbortSignal.timeout(1_000) });
    if (!response.ok) throw new Error(`守护进程返回 HTTP ${response.status}`);
    const payload = await response.json();
    console.log(options.json ? JSON.stringify(payload) : `${payload.service}: ${payload.status}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : '未知错误';
    const payload = { daemon: 'unavailable', message };
    console.log(options.json ? JSON.stringify(payload) : `${payload.daemon}: ${payload.message}`);
    process.exitCode = 3;
  }
});

function resolveDaemonUrl(): URL {
  const url = new URL(process.env.DOCKYARD_API_URL ?? 'http://127.0.0.1:4318');
  if (!['127.0.0.1', 'localhost', '::1'].includes(url.hostname)) {
    throw new Error('DOCKYARD_API_URL 只能指向本机守护进程。');
  }
  return url;
}
program.parse();
