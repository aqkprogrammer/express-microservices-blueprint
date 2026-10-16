#!/usr/bin/env node
// Exports every service's OpenAPI document to docs/api/openapi/<service>.json
// and validates it. With --check, fails if the committed files are stale.
// Requires `npm run build` (imports compiled service modules).
import { readFileSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import SwaggerParser from '@apidevtools/swagger-parser';

const SPECS = {
  'auth-service': ['app.js', 'authOpenApi'],
  'user-service': ['app.js', 'userOpenApi'],
  'product-service': ['app.js', 'productOpenApi'],
  'inventory-service': ['app.js', 'inventoryOpenApi'],
  'order-service': ['app.js', 'orderOpenApi'],
  'payment-service': ['app.js', 'paymentOpenApi'],
  'notification-service': ['app.js', 'notificationOpenApi'],
  'audit-service': ['app.js', 'auditOpenApi'],
};
const check = process.argv.includes('--check');
mkdirSync('docs/api/openapi', { recursive: true });
let failed = false;
for (const [service, [file, exportName]] of Object.entries(SPECS)) {
  const module = await import(`../apps/${service}/dist/${file}`);
  const document = module[exportName]();
  await SwaggerParser.validate(structuredClone(document));
  const target = `docs/api/openapi/${service}.json`;
  const rendered = `${JSON.stringify(document, null, 2)}\n`;
  if (check) {
    if (!existsSync(target) || readFileSync(target, 'utf8') !== rendered) {
      console.error(`✗ ${target} is out of date — run npm run docs:openapi`);
      failed = true;
    } else {
      console.log(
        `✓ ${service}: valid OpenAPI ${document.openapi}, ${Object.keys(document.paths).length} paths, up to date`,
      );
    }
  } else {
    writeFileSync(target, rendered);
    console.log(`✓ ${service}: valid OpenAPI ${document.openapi}, wrote ${target}`);
  }
}
process.exit(failed ? 1 : 0);
