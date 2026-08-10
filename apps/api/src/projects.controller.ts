import { Body, Controller, Delete, Get, Param, Post } from '@nestjs/common';
import { ProjectService } from './project.service.js';
@Controller('api/projects')
export class ProjectsController {
  constructor(private readonly projects: ProjectService) {}
  @Get() list() { return { projects: this.projects.list() }; }
  @Post('scan') scan(@Body() body: unknown) { return this.projects.scan(body); }
  @Post('import') import(@Body() body: unknown) { return this.projects.import(body); }
  @Post(':id/start') start(@Param('id') id: string) { return this.projects.start(id); }
  @Post(':id/stop') stop(@Param('id') id: string) { return this.projects.stop(id); }
  @Post(':id/restart') restart(@Param('id') id: string) { return this.projects.restart(id); }
  @Delete(':id') remove(@Param('id') id: string) { return this.projects.remove(id); }
}
