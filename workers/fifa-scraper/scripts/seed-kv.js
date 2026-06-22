#!/usr/bin/env node
// One-shot: upload seed/countries.json into KV under key 'countries'.
// Usage: node scripts/seed-kv.js [--dry-run]

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SEED_PATH = path.join(__dirname, '..', 'seed', 'countries.json');
const KV_NS = '278f1209ffd84662bd51921370a2fbe9';
const DRY_RUN = process.argv.includes('--dry-run');

function main() {
  if (!fs.existsSync(SEED_PATH)) {
    console.error(`seed file not found: ${SEED_PATH}`);
    process.exit(1);
  }
  const seed = JSON.parse(fs.readFileSync(SEED_PATH, 'utf8'));
  console.log(`seed has ${seed.items.length} countries`);
  if (DRY_RUN) {
    console.log('dry-run; sample item:', JSON.stringify(seed.items[0]));
    return;
  }
  // Write to remote KV via wrangler
  console.log('writing to KV...');
  execSync(
    `npx wrangler kv key put countries --path="${SEED_PATH}" --namespace-id=${KV_NS} --remote`,
    { stdio: 'inherit' }
  );
  console.log('✅ countries seed uploaded');
}

main();
