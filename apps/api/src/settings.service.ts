import { BadRequestException, Injectable } from '@nestjs/common';
import type { DockyardSettings, RestartPreset } from '@dockyard/core';
import { DatabaseService } from './database.service.js';
import { RuntimeService } from './runtime.service.js';

type SettingsInput = Omit<DockyardSettings, 'version'>;

@Injectable()
export class SettingsService {
  constructor(private readonly database: DatabaseService, private readonly runtime: RuntimeService) {}
  get(): DockyardSettings & { stateDirectory: string } { return { ...this.database.db.settings(), stateDirectory: this.database.db.pathResolver.databasePath().replace(/[/\\]dockyard\.sqlite$/u, '') }; }
  apply(value: unknown): DockyardSettings & { stateDirectory: string } {
    const input = parseSettings(value);
    const settings = this.database.db.applySettings(input);
    this.runtime.reloadRunningPolicies();
    return { ...settings, stateDirectory: this.get().stateDirectory };
  }
}

function parseSettings(value: unknown): SettingsInput {
  if (!isRecord(value) || !isPositiveInteger(value.retentionDays) || !isPositiveInteger(value.maxFiles) || !isPositiveInteger(value.maxBytesPerFile) || !['balanced', 'resilient', 'manual'].includes(String(value.restartPreset))) throw new BadRequestException('设置值无效。保留期、文件数和单文件限制必须为正整数。');
  return { retentionDays: value.retentionDays, maxFiles: value.maxFiles, maxBytesPerFile: value.maxBytesPerFile, restartPreset: value.restartPreset as RestartPreset };
}
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null; }
function isPositiveInteger(value: unknown): value is number { return typeof value === 'number' && Number.isInteger(value) && value > 0; }
