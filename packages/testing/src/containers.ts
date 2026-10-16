import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { RabbitMQContainer } from '@testcontainers/rabbitmq';
import { RedisContainer } from '@testcontainers/redis';

export interface StartedDependency {
  url: string;
  stop: () => Promise<void>;
  /** Pause/unpause the container to simulate an outage. */
  pause: () => Promise<void>;
  unpause: () => Promise<void>;
}

// Image tags match docker-compose.yml so integration tests exercise the same versions.
const POSTGRES_IMAGE = 'postgres:17-alpine';
const RABBITMQ_IMAGE = 'rabbitmq:4.1-management-alpine';
const REDIS_IMAGE = 'redis:8-alpine';

async function dockerPause(id: string, action: 'pause' | 'unpause') {
  const { execFile } = await import('node:child_process');
  await new Promise<void>((resolve, reject) =>
    execFile('docker', [action, id], (error) => {
      if (error) reject(new Error(`docker ${action} failed`, { cause: error }));
      else resolve();
    }),
  );
}

export async function startPostgres(database = 'test_db'): Promise<StartedDependency> {
  const container = await new PostgreSqlContainer(POSTGRES_IMAGE)
    .withDatabase(database)
    .withUsername('test')
    .withPassword('test')
    .start();
  return {
    url: container.getConnectionUri(),
    stop: async () => {
      await container.stop();
    },
    pause: () => dockerPause(container.getId(), 'pause'),
    unpause: () => dockerPause(container.getId(), 'unpause'),
  };
}

export async function startRabbitMQ(): Promise<StartedDependency> {
  const container = await new RabbitMQContainer(RABBITMQ_IMAGE).start();
  return {
    url: container.getAmqpUrl(),
    stop: async () => {
      await container.stop();
    },
    pause: () => dockerPause(container.getId(), 'pause'),
    unpause: () => dockerPause(container.getId(), 'unpause'),
  };
}

export async function startRedis(): Promise<StartedDependency> {
  const container = await new RedisContainer(REDIS_IMAGE).start();
  return {
    url: container.getConnectionUrl(),
    stop: async () => {
      await container.stop();
    },
    pause: () => dockerPause(container.getId(), 'pause'),
    unpause: () => dockerPause(container.getId(), 'unpause'),
  };
}
