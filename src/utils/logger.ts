import chalk from 'chalk';
import ora, { type Ora } from 'ora';

let verboseEnabled = false;

/**
 * Enable or disable verbose (debug) output.
 */
export function setVerbose(enabled: boolean): void {
  verboseEnabled = enabled;
}

/**
 * Returns whether verbose mode is currently enabled.
 */
export function isVerbose(): boolean {
  return verboseEnabled;
}

/**
 * Structured logger with color-coded output levels.
 */
export const logger = {
  /** Informational message (blue). */
  info(message: string, ...args: unknown[]): void {
    console.log(chalk.blue('info'), message, ...args);
  },

  /** Warning message (yellow). */
  warn(message: string, ...args: unknown[]): void {
    console.warn(chalk.yellow('warn'), message, ...args);
  },

  /** Error message (red). */
  error(message: string, ...args: unknown[]): void {
    console.error(chalk.red('error'), message, ...args);
  },

  /** Success message (green). */
  success(message: string, ...args: unknown[]): void {
    console.log(chalk.green('success'), message, ...args);
  },

  /** Debug message (gray). Only printed when verbose mode is enabled. */
  debug(message: string, ...args: unknown[]): void {
    if (verboseEnabled) {
      console.log(chalk.gray('debug'), message, ...args);
    }
  },
};

/**
 * Create an ora spinner with the given text.
 * The spinner is returned in a stopped state -- call `.start()` to begin.
 */
export function createSpinner(text: string): Ora {
  return ora({ text });
}
