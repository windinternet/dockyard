#!/usr/bin/env node
import { Command } from 'commander';
const program = new Command().name('dockyard').description('Agent-friendly local Dockyard client').version('0.1.0');
program.command('status').option('--json', 'machine-readable output').action((options) => { const payload = { daemon: 'not-connected', message: 'Daemon adapter is not wired yet.' }; console.log(options.json ? JSON.stringify(payload) : `${payload.daemon}: ${payload.message}`); });
program.parse();
