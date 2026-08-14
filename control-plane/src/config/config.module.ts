import { Global, Module } from '@nestjs/common';
import { EnvService } from './env.service.js';

// Global so every slice reads config via DI without re-importing.
@Global()
@Module({
  providers: [EnvService],
  exports: [EnvService],
})
export class ConfigModule {}
