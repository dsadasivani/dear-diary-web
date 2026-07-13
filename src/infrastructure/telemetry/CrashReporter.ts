export interface CrashReportContext {
  error_code?: string;
  platform?: string;
  app_version?: string;
  protocol_version?: number;
}

export interface CrashReporter {
  capture(error: unknown, context?: CrashReportContext): void;
}

export const NOOP_CRASH_REPORTER: CrashReporter = { capture: () => undefined };

export class AdapterCrashReporter implements CrashReporter {
  constructor(private readonly provider: (safe: { name: string; context: CrashReportContext }) => void) {}
  capture(error: unknown, context: CrashReportContext = {}): void {
    const name = error instanceof Error ? error.name : 'UnknownError';
    this.provider({ name, context });
  }
}
