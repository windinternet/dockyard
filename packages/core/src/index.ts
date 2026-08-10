export type ApplicationStatus = 'stopped' | 'starting' | 'running' | 'restarting' | 'crashed';
export interface Project { id: string; path: string; name: string; createdAt: string; }
export interface Application { id: string; projectId: string; name: string; cwd: string; command: string; status: ApplicationStatus; }
export interface RestartPolicy { mode: 'never' | 'on-failure' | 'always'; maxRetries: number; retryDelayMs: number; stableWindowMs: number; }
export interface LogPolicy { stdoutPath: string; stderrPath: string; maxFiles: number; maxBytesPerFile: number; retentionDays: number; }
export type ImportOrigin = 'package-script' | 'pm2-ecosystem';
export interface Pm2ConversionWarning { field: string; reason: string; }
export interface ImportPreviewApplication { origin: ImportOrigin; name: string; cwd: string; command: string; restartPolicy?: Partial<RestartPolicy>; logPolicy?: Partial<LogPolicy>; warnings: readonly Pm2ConversionWarning[]; }
