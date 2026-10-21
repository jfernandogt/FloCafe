/**
 * Per-guest billing on dine-in order lines.
 *
 * Usage: node tests/run-electron-node-test.cjs tests/order-guest-billing.test.ts
 *
 * A line's `guest_number` is accepted on both item creation paths
 * (POST /api/orders and POST /api/orders/:id/items), validated, survives a
 * quantity edit, and prints under the line on the one kitchen ticket.
 */
const Module = require('module');
const originalLoad = Module._load;
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-order-guest-billing-'));

Module._load = function (request: string) {
  if (request === 'electron')
    return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  return originalLoad.apply(this, arguments as any);
};

process.env.JWT_SECRET = 'test-secret-order-guest-billing';

const assert = require('node:assert/strict');
const {
  initTestDb,
  createApp,
  startServer,
  seedOwnerUser,
  seedCategory,
  seedProduct,
  api,
  closeDatabase,
} = require('./helpers/test-setup');
const { orderRoutes } = require('../main/routes/orders');
const { buildKotDocument } = require('../shared/print/document');
const { buildKotPrintData, renderKotDocumentToLines } = require('../main/printers/document-kot');

async function main() {
  console.log('Per-guest billing on order lines');
  console.log('='.repeat(60));

  const db = initTestDb();
  const owner = seedOwnerUser(db);
  seedCategory(db, 'cat-guests', 'Guests');
  seedProduct(db, 'prod-burger', 'cat-guests', 'Burger', 100);
  seedProduct(db, 'prod-soda', 'cat-guests', 'Soda', 30);

  const app = createApp({ '/api/orders': orderRoutes });
  const { baseUrl, server } = await startServer(app);
  const linesOf = (orderId: string | number) =>
    db
      .prepare("SELECT * FROM order_items WHERE order_id = ? AND status != 'cancelled' ORDER BY id")
      .all(orderId) as any[];

  try {
    const created = await api(baseUrl, '/api/orders', {
      method: 'POST',
      headers: owner.authHeader,
      body: {
        type: 'dine_in',
        guest_count: 2,
        items: [
          { product_id: 'prod-burger', quantity: 1, guest_number: 1 },
          { product_id: 'prod-burger', quantity: 1, guest_number: 2 },
          { product_id: 'prod-soda', quantity: 2 },
        ],
      },
    });
    assert.equal(created.status, 201, `order is created (${JSON.stringify(created.data)})`);
    const orderId = created.data.order.id;
    assert.deepEqual(
      linesOf(orderId).map((line) => line.guest_number),
      [1, 2, null],
      'each line keeps its guest, and a shared line stores none',
    );
    console.log('  ✓ order creation stores guest_number per line');

    for (const guest_number of [0, 1.5, 100, '1']) {
      const rejected = await api(baseUrl, '/api/orders', {
        method: 'POST',
        headers: owner.authHeader,
        body: { type: 'dine_in', items: [{ product_id: 'prod-soda', quantity: 1, guest_number }] },
      });
      assert.equal(
        rejected.status,
        400,
        `guest_number ${JSON.stringify(guest_number)} is rejected`,
      );
    }
    console.log('  ✓ invalid guest numbers are rejected');

    const appended = await api(baseUrl, `/api/orders/${orderId}/items`, {
      method: 'POST',
      headers: owner.authHeader,
      body: { items: [{ product_id: 'prod-soda', quantity: 1, guest_number: 2 }] },
    });
    assert.equal(appended.status, 200, `items are appended (${JSON.stringify(appended.data)})`);
    assert.equal(linesOf(orderId).at(-1).guest_number, 2, 'an appended line keeps its guest');
    console.log('  ✓ appended items store guest_number');

    const guestOneBurger = linesOf(orderId)[0];
    const edited = await api(baseUrl, `/api/orders/${orderId}/items/${guestOneBurger.id}/edit`, {
      method: 'PATCH',
      headers: { ...owner.authHeader, 'Idempotency-Key': 'guest-edit-1' },
      body: { quantity: 3, expected_edit_version: 0 },
    });
    assert.equal(edited.status, 200, `the line is edited (${JSON.stringify(edited.data)})`);
    const burgers = linesOf(orderId).filter((line) => line.product_id === 'prod-burger');
    assert.deepEqual(
      burgers.map((line) => [line.quantity, line.guest_number]).sort(),
      [
        [1, 2],
        [3, 1],
      ],
      'the edited line stays with its guest',
    );
    console.log('  ✓ a quantity edit keeps the guest');

    const resolveLabel = (conceptId: string) =>
      conceptId === 'print.kot.guest' ? 'Guest' : conceptId;
    const kotDocument = buildKotDocument(
      buildKotPrintData({ order_number: 'K-1' }, linesOf(orderId), ''),
      {
        columns: 42,
        languages: ['en'],
        baseDirection: 'ltr',
        locale: 'en-US',
        currency: '',
        currencySymbol: '',
        trimDecimals: false,
        resolveLabel,
      },
    );
    const lines = renderKotDocumentToLines(kotDocument, {
      columns: 42,
      language: 'en',
      locale: 'en-US',
      useUnicode: false,
      arabicShaping: false,
      cutMode: 'full',
    });
    assert.ok(lines.includes('  [Guest 1]'), 'the guest prints under its line');
    assert.ok(lines.includes('  [Guest 2]'), 'every guest prints on the same ticket');
    const rows = (kotDocument.blocks[1] as any).rows;
    assert.equal(
      rows.find((row: any) => row.name.text === 'Soda' && !row.guest) !== undefined,
      true,
      'a shared line prints without a guest',
    );
    console.log('  ✓ the kitchen ticket labels each guest line');
  } finally {
    server.close();
    closeDatabase();
  }
  console.log('\nAll per-guest billing checks passed');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
