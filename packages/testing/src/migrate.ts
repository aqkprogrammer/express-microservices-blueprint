import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

/** Applies a service's committed Prisma migrations to a test database. */
export function migrateServiceDatabase(serviceDir: string, databaseUrl: string): void {
  const prismaBin = join(serviceDir, '..', '..', 'node_modules', '.bin', 'prisma');
  execFileSync(prismaBin, ['migrate', 'deploy'], {
    cwd: serviceDir,
    env: { ...process.env, DATABASE_URL: databaseUrl },
    stdio: 'pipe',
  });
}
