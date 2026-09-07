import type { LoggerService } from '@nestjs/common';
import { pino, type Logger } from 'pino';

// Pino structured logger as the Nest application logger
// (docs/component-h-hardening.md §6.2, §9.1). nestjs-pino's global middleware
// breaks the Fastify middleware stack the raw SSE routes rely on, so we drive
// Pino through Nest's LoggerService interface instead — JSON out, level from
// EnvService, no transport needed (logs go to stdout). Nest calls these with a
// string message plus optional context; the meta is folded onto one structured
// line (`{ msg, meta }` — pino's object-first overload).
export class PinoLoggerAdapter implements LoggerService {
  private readonly logger: Logger;

  constructor(level = 'debug') {
    this.logger = pino({ level });
  }

  log(message: unknown, ...optionalParams: unknown[]): void {
    this.logger.info(this.field(message, optionalParams));
  }
  error(message: unknown, ...optionalParams: unknown[]): void {
    this.logger.error(this.field(message, optionalParams));
  }
  warn(message: unknown, ...optionalParams: unknown[]): void {
    this.logger.warn(this.field(message, optionalParams));
  }
  debug(message: unknown, ...optionalParams: unknown[]): void {
    this.logger.debug(this.field(message, optionalParams));
  }
  verbose(message: unknown, ...optionalParams: unknown[]): void {
    this.logger.trace(this.field(message, optionalParams));
  }
  fatal(message: unknown, ...optionalParams: unknown[]): void {
    this.logger.fatal(this.field(message, optionalParams));
  }

  private field(message: unknown, optionalParams: unknown[]): unknown {
    const text = typeof message === 'string' ? message : JSON.stringify(message);
    return optionalParams.length > 0 ? { msg: text, meta: optionalParams } : { msg: text };
  }
}