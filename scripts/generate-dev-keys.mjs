#!/usr/bin/env node
// Generates an ES256 (P-256) signing key for LOCAL DEVELOPMENT ONLY.
// Usage: node scripts/generate-dev-keys.mjs [output-dir]   (default: ./secrets)
// The key never enters Git (.gitignore excludes *.pem and secrets/). In
// production, issue keys from a secret manager / KMS and mount them via
// JWT_PRIVATE_KEY_FILE.
import { generateKeyPairSync } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = process.argv[2] ?? 'secrets';
const target = join(dir, 'jwt-private.pem');
mkdirSync(dir, { recursive: true });
if (existsSync(target)) {
  console.log(`Signing key already exists at ${target}; leaving it unchanged.`);
  process.exit(0);
}
const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
writeFileSync(target, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o400 });
chmodSync(target, 0o400);
console.log(`Generated development signing key at ${target}`);
