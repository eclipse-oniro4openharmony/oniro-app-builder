import { Logger, noopLogger } from './logger.js';
import { ConfigProvider, staticConfig } from './config.js';

/**
 * Carries the cross-cutting dependencies most core functions need: a Logger and a ConfigProvider.
 * Functions that report progress or prompt the user take those as additional parameters.
 */
export interface OniroContext {
  logger: Logger;
  config: ConfigProvider;
}

export function defaultContext(overrides: Partial<OniroContext> = {}): OniroContext {
  return {
    logger: overrides.logger ?? noopLogger,
    config: overrides.config ?? staticConfig(),
  };
}
