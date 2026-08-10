import { Module } from '@nestjs/common';
import { HealthController } from './health.controller.js';
import { ProjectsController } from './projects.controller.js';
import { ApplicationsController } from './applications.controller.js';
import { DatabaseService } from './database.service.js';
import { ProjectService } from './project.service.js';
import { RuntimeService } from './runtime.service.js';
@Module({ controllers: [HealthController, ProjectsController, ApplicationsController], providers: [DatabaseService, ProjectService, RuntimeService] })
export class AppModule {}
