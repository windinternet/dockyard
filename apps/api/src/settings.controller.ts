import { Body, Controller, Get, Put } from '@nestjs/common';
import { SettingsService } from './settings.service.js';

@Controller('api/settings')
export class SettingsController {
  constructor(private readonly settings: SettingsService) {}
  @Get() get() { return this.settings.get(); }
  @Put() apply(@Body() body: unknown) { return this.settings.apply(body); }
}
