#!/usr/bin/env node

// Re-sync every purchasable piece against the deployed /api/stripe-sync,
// which now writes to the connected Stripe account (commit 749cef5). Updates
// stripe_price_id / stripe_product_id in content/*.json in place.
//
// Auth: uses `gh auth token` — the deployed endpoint just verifies the token
// against api.github.com/user, so any logged-in gh session works.
//
// Usage:
//   node scripts/resync-stripe.js [--dry-run] [--base-url https://...]
//
// After it runs, review with `git diff content/`, then commit and push.

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const baseUrlIdx = args.indexOf('--base-url');
const BASE_URL = (baseUrlIdx >= 0 ? args[baseUrlIdx + 1] : 'https://florezflorez.vercel.app').replace(/\/$/, '');

const ROOT = path.resolve(__dirname, '..');
const CONTENT_DIR = path.join(ROOT, 'content');
const SECTIONS = ['art.json', 'earrings.json', 'jewelry.json', 'necklaces.json', 'rings.json'];

let token;
try {
  token = execSync('gh auth token', { encoding: 'utf8' }).trim();
} catch (e) {
  console.error('Failed to read gh auth token. Run `gh auth login` first.');
  process.exit(1);
}
if (!token) {
  console.error('Empty gh auth token.');
  process.exit(1);
}

async function syncPiece(piece) {
  const hasIds = Boolean(piece.stripe_price_id || piece.stripe_product_id);
  const action = hasIds ? 'update' : 'create';
  const imagePath = piece.images && piece.images[0] ? piece.images[0].src : null;

  const body = {
    action,
    product: {
      title: piece.title,
      description: piece.description || '',
      price_display: piece.price_display,
      image_path: imagePath,
      stripe_price_id: piece.stripe_price_id || null,
      stripe_product_id: piece.stripe_product_id || null,
    },
  };

  const res = await fetch(`${BASE_URL}/api/stripe-sync`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer ' + token,
    },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error || `HTTP ${res.status}`);
  }
  return data;
}

(async () => {
  const summary = { synced: [], skipped: [], failed: [] };

  for (const filename of SECTIONS) {
    const filePath = path.join(CONTENT_DIR, filename);
    if (!fs.existsSync(filePath)) continue;

    const raw = fs.readFileSync(filePath, 'utf8');
    const json = JSON.parse(raw);
    const pieces = json.pieces || [];
    let modified = false;

    for (const piece of pieces) {
      const label = `${filename}:${piece.title || piece.id}`;

      if (!piece.purchasable) {
        summary.skipped.push(`${label} (not purchasable)`);
        continue;
      }
      if (!piece.price_display) {
        summary.skipped.push(`${label} (no price_display)`);
        continue;
      }

      process.stdout.write(`Syncing ${label}... `);
      if (DRY_RUN) {
        console.log('[dry-run]');
        summary.skipped.push(`${label} (dry-run)`);
        continue;
      }

      try {
        const result = await syncPiece(piece);
        const oldPriceId = piece.stripe_price_id;
        const oldProductId = piece.stripe_product_id;
        piece.stripe_price_id = result.stripe_price_id;
        piece.stripe_product_id = result.stripe_product_id;
        const changed =
          oldPriceId !== result.stripe_price_id ||
          oldProductId !== result.stripe_product_id;
        if (changed) modified = true;
        console.log(changed ? `→ ${result.stripe_price_id}` : '(unchanged)');
        summary.synced.push(`${label} ${changed ? '(rewritten)' : '(no-op)'}`);
      } catch (e) {
        console.log(`FAILED: ${e.message}`);
        summary.failed.push(`${label}: ${e.message}`);
      }
    }

    if (modified && !DRY_RUN) {
      fs.writeFileSync(filePath, JSON.stringify(json, null, 2) + '\n');
      console.log(`  wrote ${filename}`);
    }
  }

  console.log('\n--- summary ---');
  console.log(`synced: ${summary.synced.length}`);
  summary.synced.forEach((s) => console.log('  ' + s));
  console.log(`skipped: ${summary.skipped.length}`);
  summary.skipped.forEach((s) => console.log('  ' + s));
  if (summary.failed.length > 0) {
    console.log(`failed: ${summary.failed.length}`);
    summary.failed.forEach((s) => console.log('  ' + s));
    process.exit(1);
  }

  if (!DRY_RUN) {
    console.log('\nNext: review with `git diff content/`, then commit + push.');
  }
})();
