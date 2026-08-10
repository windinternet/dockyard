import { Module } from '@nestjs/common';
import { HealthController } from './health.controller.js';
import { ProjectsController } from './projects.controller.js';
import { ApplicationsController } from './applications.controller.js';
import { DatabaseService } from './database.service.js';
import { ProjectService } from './project.service.js';
import { RuntimeService } from './runtime.service.js';
import { SystemController } from './system.controller.js';
import { NativeDirectoryPickerService } from './native-directory-picker.service.js';
@Module({ controllers: [HealthController, ProjectsController, ApplicationsController, SystemController], providers: [DatabaseService, ProjectService, RuntimeService, NativeDirectoryPickerService] })
export class AppModule {}
