/** Domain contracts shared by the daemon, the panel, the CLI and the database boundary. */

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
/**
 * A toolchain capability provider. Runners answer "what starts this application and how is it recognised";
 * `runtime*` values keep their existing meaning of live process state and ownership.
 */
export type RunnerKind = 'node' | 'shell' | 'java';

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
  /** Grace period before a manually stopped process is escalated from SIGTERM to SIGKILL. */
  gracefulShutdownTimeoutMs: number;
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
  /** Project-relative glob patterns. A path without a matching rule is always confirmation-required. */
  pathPatterns: readonly string[];
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
  /** Fragments expected in the command line of the process created by this service command; empty means no safe fingerprint is known. */
  processCommandHints: readonly string[];
  restartPolicy: RestartPolicy;
  changeRules: readonly ServiceChangeRule[];
}

export interface CompatibilityProfile {
  id: string;
  name: string;
  evidence: ProfileEvidence;
  services: readonly ServiceProfile[];
}

export interface ChangeAssessment {
  path: string;
  impact: ChangeImpact;
  evidence: ProfileEvidence;
  ruleId?: string;
  explanation: string;
}

/** Evidence gathered while detecting a runner type. Detection only reads files and never executes project code. */
export interface RunnerDetection {
  kind: RunnerKind;
  label: string;
  evidence: ProfileEvidence;
  /** Human-readable file evidence behind this detection. */
  reasons: readonly string[];
  /** False when the runner recognises the project type but cannot derive commands yet. */
  candidatesAvailable: boolean;
}

/** The runner catalog behind one project: what was detected, and what a person may still choose. */
export interface RunnerSummary {
  kind: RunnerKind;
  label: string;
  /** True when the runner can be chosen without any file evidence, as the general fallback. */
  alwaysAvailable: boolean;
  /** True when a person may register an explicit command under this runner. */
  userDefinedCommands: boolean;
  detection?: RunnerDetection;
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
  /** The runner that owns this application's discovery and command derivation. */
  runnerKind: RunnerKind;
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
  runnerKind: RunnerKind;
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
  /** Every known runner type with the detection evidence for this project. */
  runners: readonly RunnerSummary[];
  compatibilityProfile?: CompatibilityProfile;
  warnings: readonly Pm2ConversionWarning[];
}

export const defaultRestartPolicy: RestartPolicy = Object.freeze({ mode: 'on-failure', maxRetries: 5, retryDelayMs: 1_000, stableWindowMs: 30_000 });
export const defaultLogPolicy: LogPolicy = Object.freeze({ maxFiles: 5, maxBytesPerFile: 10 * 1024 * 1024, retentionDays: 14 });
export const defaultProjectSettings: ProjectSettings = Object.freeze({ startupApplicationIds: [], startupPreference: 'automatic', projectEntrypointOptions: [], selectedProjectEntrypoint: null, restartPolicy: defaultRestartPolicy, logPolicy: defaultLogPolicy });
export const defaultDockyardSettings: DockyardSettings = Object.freeze({ version: 0, sampleIntervalMs: 1_000, gracefulShutdownTimeoutMs: 5_000, logAutoScrollPauseMs: 30_000, metricRetentionDays: 7, retentionDays: 14, maxFiles: 5, maxBytesPerFile: 10 * 1024 * 1024, restartPreset: 'balanced' });

export function restartPolicyForPreset(preset: RestartPreset): RestartPolicy {
  if (preset === 'manual') return { mode: 'never', maxRetries: 0, retryDelayMs: 1_000, stableWindowMs: 30_000 };
  if (preset === 'resilient') return { mode: 'always', maxRetries: 10, retryDelayMs: 1_000, stableWindowMs: 30_000 };
  return { ...defaultRestartPolicy };
}

/** Every runner type the product supports; a persisted value outside this list falls back to the default. */
export const runnerKinds: readonly RunnerKind[] = Object.freeze(['node', 'shell', 'java']);
/** Applications persisted before runners existed were all Node applications. */
export const defaultRunnerKind: RunnerKind = 'node';
export function parseRunnerKind(value: unknown): RunnerKind | null {
  return typeof value === 'string' && (runnerKinds as readonly string[]).includes(value) ? value as RunnerKind : null;
}
