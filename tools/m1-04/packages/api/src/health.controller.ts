import { Controller, Get } from '@nestjs/common';

@Controller('health/live')
export class HealthController {
  @Get()
  live(): { status: 'ok' } {
    return { status: 'ok' };
  }
}
