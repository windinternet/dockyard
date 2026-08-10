import { Controller, Get } from '@nestjs/common';
@Controller('health')
export class HealthController { @Get() getHealth() { return { status: 'ok', service: 'dockyard-daemon', version: '0.1.0' }; } }
