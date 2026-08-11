import { BadRequestException, Body, Controller, Get, Header, Param, Patch, Post, Query, Sse } from '@nestjs/common';
import { parseLogPolicy, parseRestartPolicy, redactCommandForDisplay, type Application } from '@dockyard/core';
import { Observable } from 'rxjs';
import { RuntimeService, type LogMessage, type RuntimeUpdate } from './runtime.service.js';
@Controller('api/applications')
export class ApplicationsController {
  constructor(private readonly runtime: RuntimeService) {}
  @Get() list() { return { applications: this.runtime.applications().map(publicApplication) }; }
  @Sse('stream') stream(): Observable<MessageEvent> { return new Observable((subscriber) => this.runtime.onUpdate((update) => subscriber.next(runtimeEvent(update)))); }
  @Get(':id') get(@Param('id') id: string) { return publicApplication(this.runtime.application(id)); }
  @Get(':id/events') events(@Param('id') id: string) { return { events: this.runtime.events(id) }; }
  @Get(':id/metrics') @Header('Cache-Control', 'no-store') metrics(@Param('id') id: string) { return { metrics: this.runtime.metrics(id) }; }
  @Post(':id/start') async start(@Param('id') id: string) { return publicApplication(await this.runtime.start(id)); }
  @Post(':id/stop') async stop(@Param('id') id: string) { return publicApplication(await this.runtime.stop(id)); }
  @Post(':id/restart') async restart(@Param('id') id: string) { return publicApplication(await this.runtime.restart(id)); }
  @Patch(':id/policies') policies(@Param('id') id: string, @Body() body: unknown) { const value = record(body); const restartPolicy = parseRestartPolicy(value?.restartPolicy); const logPolicy = parseLogPolicy(value?.logPolicy); if (!restartPolicy || !logPolicy) throw new BadRequestException('重启或日志策略无效。'); return publicApplication(this.runtime.updatePolicies(id, restartPolicy, logPolicy)); }
  @Patch(':id/command') command(@Param('id') id: string, @Body() body: unknown) { const value = record(body); if (!value || typeof value.selectedCommand !== 'string') throw new BadRequestException('启动命令无效。'); return publicApplication(this.runtime.updateCommand(id, value.selectedCommand)); }
  @Post(':id/diagnostics') diagnostics(@Param('id') id: string) { return this.runtime.diagnostics(id); }
  @Sse(':id/logs/tail') tail(@Param('id') id: string, @Query('stream') stream = 'stdout'): Observable<MessageEvent> { this.runtime.application(id); if (stream !== 'stdout' && stream !== 'stderr') throw new BadRequestException('stream 必须是 stdout 或 stderr。'); return new Observable((subscriber) => { const remove = this.runtime.onLog((message: LogMessage) => { if (message.applicationId === id && message.stream === stream) subscriber.next({ data: message } as MessageEvent); }); return remove; }); }
}
function publicApplication(application: Application): Application { return { ...application, command: redactCommandForDisplay(application.command) }; }
function runtimeEvent(update: RuntimeUpdate): MessageEvent { return update.type === 'application' ? { event: 'application', data: publicApplication(update.application) } as unknown as MessageEvent : { event: 'metric', data: update.metric } as unknown as MessageEvent; }
function record(value: unknown): Record<string, unknown> | null { return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null; }
