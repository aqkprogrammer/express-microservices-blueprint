export interface HealthCheck {
  name: string;
  check: () => Promise<void>;
  /** Non-critical checks are reported but do not fail readiness (e.g. a cache). */
  critical?: boolean;
  timeoutMs?: number;
}

export interface HealthReport {
  status: 'ok' | 'degraded' | 'unavailable';
  checks: Record<string, { status: 'ok' | 'failed'; durationMs: number; error?: string }>;
}

export async function runHealthChecks(checks: HealthCheck[]): Promise<HealthReport> {
  const results = await Promise.all(
    checks.map(async (healthCheck) => {
      const started = performance.now();
      try {
        await Promise.race([
          healthCheck.check(),
          new Promise((_, reject) =>
            setTimeout(() => {
              reject(new Error('health check timed out'));
            }, healthCheck.timeoutMs ?? 2_000).unref(),
          ),
        ]);
        return { healthCheck, status: 'ok' as const, durationMs: performance.now() - started };
      } catch (error) {
        return {
          healthCheck,
          status: 'failed' as const,
          durationMs: performance.now() - started,
          // Error messages from drivers can include hostnames; keep only the message text.
          error: error instanceof Error ? error.message.slice(0, 200) : 'failed',
        };
      }
    }),
  );
  const report: HealthReport = { status: 'ok', checks: {} };
  for (const result of results) {
    report.checks[result.healthCheck.name] = {
      status: result.status,
      durationMs: Math.round(result.durationMs),
      ...(result.error ? { error: result.error } : {}),
    };
    if (result.status === 'failed') {
      if (result.healthCheck.critical === false) {
        if (report.status === 'ok') report.status = 'degraded';
      } else {
        report.status = 'unavailable';
      }
    }
  }
  return report;
}
