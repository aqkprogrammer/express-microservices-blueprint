import { pino } from 'pino';
import { describe, expect, it, vi } from 'vitest';
import type { RabbitMQClient } from '@emb/messaging';
import type { Redis } from 'ioredis';
import { MaintenanceScheduler } from './scheduler.js';

const definition = { routingKey: 'maintenance.order.check-saga-timeouts', intervalMs: 1_000 };

function setup(redis: Partial<Redis>) {
  const publish = vi.fn().mockResolvedValue(undefined);
  const record = vi.fn().mockResolvedValue(undefined);
  const scheduler = new MaintenanceScheduler(
    {
      rabbit: { publish } as unknown as RabbitMQClient,
      redis: redis as Redis,
      logger: pino({ level: 'silent' }),
      recorder: { record },
    },
    {},
  );
  return { scheduler, publish, record };
}

describe('MaintenanceScheduler', () => {
  it('publishes when it wins the leader lock', async () => {
    const { scheduler, publish } = setup({ status: 'ready', set: vi.fn().mockResolvedValue('OK') as never });
    expect(await scheduler.runTask('order.check-saga-timeouts', definition)).toBe('published');
    expect(publish).toHaveBeenCalledWith(
      'maintenance.commands',
      definition.routingKey,
      expect.any(Buffer),
      expect.objectContaining({ type: 'MaintenanceRequested.v1' }),
    );
  });

  it('stays quiet when another replica holds the lock', async () => {
    const { scheduler, publish } = setup({ status: 'ready', set: vi.fn().mockResolvedValue(null) as never });
    expect(await scheduler.runTask('order.check-saga-timeouts', definition)).toBe('not_leader');
    expect(publish).not.toHaveBeenCalled();
  });

  it('fails open when Redis is unavailable (tasks are idempotent)', async () => {
    const { scheduler, publish } = setup({ status: 'reconnecting' });
    expect(await scheduler.runTask('order.check-saga-timeouts', definition)).toBe('published_without_lock');
    expect(publish).toHaveBeenCalledOnce();
  });

  it('records failures when the broker rejects the publish', async () => {
    const { scheduler, publish, record } = setup({
      status: 'ready',
      set: vi.fn().mockResolvedValue('OK') as never,
    });
    publish.mockRejectedValueOnce(new Error('not connected'));
    expect(await scheduler.runTask('order.check-saga-timeouts', definition)).toBe('failed');
    expect(record).toHaveBeenCalledWith(
      'order.check-saga-timeouts',
      'failed',
      expect.any(Number),
      'not connected',
    );
  });
});
