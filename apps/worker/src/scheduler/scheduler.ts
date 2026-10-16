import { randomUUID } from 'node:crypto';
import {
  MAINTENANCE_EVENT_TYPE,
  MAINTENANCE_EXCHANGE,
  MAINTENANCE_TASKS,
  buildEnvelope,
  type MaintenanceRequested,
  type MaintenanceTask,
} from '@emb/contracts';
import type { Logger } from '@emb/logger';
import { serializeError } from '@emb/logger';
import { publishEnvelope, type RabbitMQClient } from '@emb/messaging';
import { counter, histogram } from '@emb/observability';
import type { Redis } from 'ioredis';

const jobsTotal = counter('worker_jobs_total', 'Scheduled maintenance jobs by outcome', ['task', 'outcome']);
const jobDuration = histogram('worker_job_duration_seconds', 'Time to schedule a maintenance job', ['task']);

export interface JobRecorder {
  record(task: string, outcome: string, durationMs: number, error?: string): Promise<void>;
}

/**
 * Publishes maintenance commands on fixed intervals. A Redis `SET NX PX`
 * lock per task and interval elects one publisher among worker replicas.
 * If Redis is unavailable the scheduler fails open — every maintenance task
 * is idempotent, so an occasional duplicate run is harmless, whereas skipping
 * runs would stall saga timeouts and reservation expiry.
 */
export class MaintenanceScheduler {
  private readonly timers: NodeJS.Timeout[] = [];
  private readonly running = new Set<MaintenanceTask>();
  private readonly instanceId = randomUUID();
  private stopped = false;

  constructor(
    private readonly deps: { rabbit: RabbitMQClient; redis: Redis; logger: Logger; recorder: JobRecorder },
    private readonly tasks: Partial<
      Record<MaintenanceTask, { routingKey: string; intervalMs: number }>
    > = MAINTENANCE_TASKS,
  ) {}

  start(): void {
    for (const [task, definition] of Object.entries(this.tasks) as [
      MaintenanceTask,
      { routingKey: string; intervalMs: number },
    ][]) {
      const timer = setInterval(() => void this.runTask(task, definition), definition.intervalMs);
      this.timers.push(timer);
    }
    this.deps.logger.info({ tasks: Object.keys(this.tasks) }, 'maintenance scheduler started');
  }

  async stop(): Promise<void> {
    this.stopped = true;
    for (const timer of this.timers) clearInterval(timer);
    // Let in-flight publications finish.
    while (this.running.size > 0) await new Promise((resolve) => setTimeout(resolve, 50));
  }

  /** Exposed for tests: runs one scheduling attempt for `task`. Returns the outcome. */
  async runTask(
    task: MaintenanceTask,
    definition: { routingKey: string; intervalMs: number },
  ): Promise<string> {
    // Bounded concurrency: never overlap runs of the same task.
    if (this.stopped || this.running.has(task)) return 'skipped';
    this.running.add(task);
    const started = Date.now();
    const timer = jobDuration.startTimer({ task });
    let outcome = 'published';
    let errorText: string | undefined;
    try {
      const leader = await this.acquireLock(task, definition.intervalMs);
      if (leader === false) {
        outcome = 'not_leader';
        return outcome;
      }
      if (leader === undefined) outcome = 'published_without_lock';
      const scheduledAt = new Date();
      const envelope = buildEnvelope<MaintenanceRequested>(
        MAINTENANCE_EVENT_TYPE,
        1,
        { task, scheduledAt: scheduledAt.toISOString() },
        { producer: 'worker', correlationId: `maintenance:${task}:${scheduledAt.getTime()}`, subject: task },
      );
      await publishEnvelope(this.deps.rabbit, MAINTENANCE_EXCHANGE, definition.routingKey, envelope);
      return outcome;
    } catch (error) {
      outcome = 'failed';
      errorText = error instanceof Error ? error.message : String(error);
      this.deps.logger.warn({ err: serializeError(error), task }, 'failed to publish maintenance command');
      return outcome;
    } finally {
      timer();
      jobsTotal.inc({ task, outcome });
      this.running.delete(task);
      if (outcome !== 'not_leader') {
        await this.deps.recorder
          .record(task, outcome, Date.now() - started, errorText)
          .catch(() => undefined);
      }
    }
  }

  /** true = lock acquired, false = another replica holds it, undefined = Redis unavailable. */
  private async acquireLock(task: string, intervalMs: number): Promise<boolean | undefined> {
    if (this.deps.redis.status !== 'ready') return undefined;
    try {
      const result = await this.deps.redis.set(
        `worker:scheduler:${task}`,
        this.instanceId,
        'PX',
        Math.floor(intervalMs * 0.9),
        'NX',
      );
      return result === 'OK';
    } catch {
      return undefined;
    }
  }
}
