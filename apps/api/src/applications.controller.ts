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
  @Get(':id/metrics') @Header('Cache-Control', 'no-store') metrics(@Param('id') id: string, @Query('window') window?: string) { if (window !== undefined && window !== 'recent' && window !== 'day') throw new BadRequestException('window 必须是 recent 或 day。'); return { metrics: this.runtime.metrics(id, window ?? 'recent') }; }
  @Post(':id/start') async start(@Param('id') id: string) { return publicApplication(await this.runtime.start(id)); }
  @Post(':id/stop') async stop(@Param('id') id: string) { return publicApplication(await this.runtime.stop(id)); }
  @Post(':id/restart') async restart(@Param('id') id: string) { return publicApplication(await this.runtime.restart(id)); }
  @Post(':id/adopt') adopt(@Param('id') id: string) { return publicApplication(this.runtime.adoptExternal(id)); }
  @Post(':id/log-capture/inspector') async enableInspectorLogCapture(@Param('id') id: string) { return publicApplication(await this.runtime.enableInspectorLogCapture(id)); }
  @Get(':id/logs/history') async history(@Param('id') id: string, @Query('stream') stream = 'combined', @Query('before') before?: string, @Query('limit') limit?: string) {
    if (stream !== 'stdout' && stream !== 'stderr' && stream !== 'combined') throw new BadRequestException('stream 必须是 stdout、stderr 或 combined。');
    const parsedLimit = limit === undefined ? 500 : Number(limit);
    if (!Number.isInteger(parsedLimit) || parsedLimit < 1 || parsedLimit > 1_000) throw new BadRequestException('limit 必须在 1 到 1000 之间。');
    if (before !== undefined && (!before.trim() || before.length > 512)) throw new BadRequestException('before 日志游标无效。');
    return this.runtime.logHistory(id, stream, parsedLimit, before);
  }
  @Patch(':id/policies') policies(@Param('id') id: string, @Body() body: unknown) { const value = record(body); const restartPolicy = parseRestartPolicy(value?.restartPolicy); const logPolicy = parseLogPolicy(value?.logPolicy); if (!restartPolicy || !logPolicy) throw new BadRequestException('重启或日志策略无效。'); return publicApplication(this.runtime.updatePolicies(id, restartPolicy, logPolicy)); }
  @Patch(':id/command') command(@Param('id') id: string, @Body() body: unknown) { const value = record(body); if (!value || typeof value.selectedCommand !== 'string') throw new BadRequestException('启动命令无效。'); return publicApplication(this.runtime.updateCommand(id, value.selectedCommand)); }
  @Post(':id/diagnostics') diagnostics(@Param('id') id: string) { return this.runtime.diagnostics(id); }
  @Sse(':id/logs/tail') tail(@Param('id') id: string, @Query('stream') stream = 'combined'): Observable<MessageEvent> {
    this.runtime.application(id);
    if (stream !== 'stdout' && stream !== 'stderr' && stream !== 'combined') throw new BadRequestException('stream 必须是 stdout、stderr 或 combined。');
    return new Observable((subscriber) => {
      let replaying = true;
      const pending: LogMessage[] = [];
      const publish = (message: LogMessage) => subscriber.next({ data: message } as MessageEvent);
      const remove = this.runtime.onLog((message) => {
        if (message.applicationId !== id || (stream !== 'combined' && message.stream !== stream)) return;
        if (replaying) pending.push(message); else publish(message);
      });
      const history = this.runtime.logHistory(id, stream).then((result) => result.logs);
      void history.then((history) => {
        for (const message of history) publish(message);
        replaying = false;
        for (const message of pending) publish(message);
      }).catch((error: unknown) => subscriber.error(error));
      return remove;
    });
  }
}
function publicApplication(application: Application): Application { return { ...application, command: redactCommandForDisplay(application.command) }; }
export function runtimeEvent(update: RuntimeUpdate): MessageEvent { return update.type === 'application' ? { type: 'application', data: publicApplication(update.application) } as unknown as MessageEvent : update.type === 'metric' ? { type: 'metric', data: update.metric } as unknown as MessageEvent : { type: 'project', data: update.project } as unknown as MessageEvent; }
function record(value: unknown): Record<string, unknown> | null { return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null; }
