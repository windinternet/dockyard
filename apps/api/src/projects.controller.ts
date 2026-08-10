import { Body, Controller, Get, Post } from '@nestjs/common';
import { ProjectService } from './project.service.js';
@Controller('api/projects')
export class ProjectsController {
  constructor(private readonly projects: ProjectService) {}
  @Get() list() { return { projects: this.projects.list() }; }
  @Post('scan') scan(@Body() body: unknown) { return this.projects.scan(body); }
  @Post('import') import(@Body() body: unknown) { return this.projects.import(body); }
}
