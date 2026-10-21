/**
 * Card terminal transaction number requirement (`card_transaction_id_required`).
 * Run: node tests/run-electron-node-test.cjs tests/card-transaction-id.test.ts
 */

const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-card-transaction-id-'));
Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron')
    return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  return originalLoad.apply(this, arguments as any);
};

const {
  initTestDb,
  createApp,
  startServer,
  seedOwnerUser,
  seedCategory,
  seedProduct,
  api,
  assertEqualOrThrow,
  getResults,
  closeDatabase,
} = require('./helpers/test-setup');
const { orderRoutes } = require('../main/routes/orders');
const { billRoutes } = require('../main/routes/bills');
const { settingsRoutes } = require('../main/routes/settings');
const { paymentMethodRoutes } = require('../main/routes/payment-methods');
const { registerRoutes } = require('../main/routes/index');

async function main(): Promise<void> {
  console.log('Card transaction number requirement');
  const db = initTestDb();
  const { authHeader } = seedOwnerUser(db);
  seedCategory(db, 'cat-ctid', 'Card menu');
  seedProduct(db, 'prod-ctid', 'cat-ctid', 'Espresso', 100);

  const app = createApp({
    '/api/orders': orderRoutes,
    '/api/bills': billRoutes,
    '/api/settings': settingsRoutes,
    '/api/payment-methods': paymentMethodRoutes,
  });
  registerRoutes(app);
  const { baseUrl, server } = await startServer(app);

  async function newBill(): Promise<string> {
    const order = await api(baseUrl, '/api/orders', {
      method: 'POST',
      body: { type: 'takeaway', items: [{ product_id: 'prod-ctid', quantity: 1 }] },
      headers: authHeader,
    });
    assertEqualOrThrow(order.status, 201, 'takeaway order created');
    const bill = await api(baseUrl, '/api/bills/generate', {
      method: 'POST',
      body: { order_id: order.data.order.id },
      headers: authHeader,
    });
    assertEqualOrThrow(bill.status, 201, 'bill generated');
    return bill.data.bill.id;
  }
  function pay(billId: string, payments: unknown[]) {
    return api(baseUrl, `/api/bills/${billId}/payments`, {
      method: 'POST',
      body: { payments },
      headers: authHeader,
    });
  }

  try {
    const fallback = await api(baseUrl, '/api/settings/card_transaction_id_required', {
      headers: authHeader,
    });
    assertEqualOrThrow(fallback.status, 200, 'unset requirement reads as a default');
    assertEqualOrThrow(fallback.data.setting.value, 'false', 'requirement is off by default');

    const offBill = await newBill();
    const offPayment = await pay(offBill, [{ method: 'card' }]);
    assertEqualOrThrow(
      offPayment.status,
      200,
      'card payment without a number is accepted while off',
    );

    const invalid = await api(baseUrl, '/api/settings/card_transaction_id_required', {
      method: 'PUT',
      body: { value: 'maybe' },
      headers: authHeader,
    });
    assertEqualOrThrow(invalid.status, 400, 'non-boolean requirement value is rejected');
    const enable = await api(baseUrl, '/api/settings/card_transaction_id_required', {
      method: 'PUT',
      body: { value: true },
      headers: authHeader,
    });
    assertEqualOrThrow(enable.status, 200, 'requirement can be enabled');
    assertEqualOrThrow(
      enable.data.setting.value,
      'true',
      'requirement is stored as a canonical flag',
    );

    const billId = await newBill();
    const missing = await pay(billId, [{ method: 'card' }]);
    assertEqualOrThrow(missing.status, 400, 'card payment without a number is rejected while on');
    assertEqualOrThrow(
      missing.data.display_code,
      'card_transaction_id_required',
      'rejection names the missing number',
    );
    const unpaid = db.prepare('SELECT payment_status FROM bills WHERE id = ?').get(billId) as {
      payment_status: string;
    };
    assertEqualOrThrow(unpaid.payment_status, 'unpaid', 'rejected payment writes nothing');

    const custom = await api(baseUrl, '/api/payment-methods', {
      method: 'POST',
      body: { name: 'Bank QR' },
      headers: authHeader,
    });
    assertEqualOrThrow(custom.status, 201, 'custom method created');
    const customBill = await newBill();
    const customPayment = await pay(customBill, [
      { method: 'custom', payment_method_id: custom.data.payment_method.id },
    ]);
    assertEqualOrThrow(
      customPayment.status,
      200,
      'custom methods are not affected by the requirement',
    );

    const paid = await pay(billId, [{ method: 'card', transaction_id: '000123' }]);
    assertEqualOrThrow(paid.status, 200, 'card payment with a terminal number is accepted');
    assertEqualOrThrow(paid.data.bill.payment_status, 'paid', 'bill is settled');
    const ledger = JSON.parse(
      (
        db.prepare('SELECT payment_details FROM bills WHERE id = ?').get(billId) as {
          payment_details: string;
        }
      ).payment_details,
    );
    assertEqualOrThrow(
      ledger[0].transaction_id,
      '000123',
      'ledger keeps the terminal number verbatim',
    );

    const reused = await pay(await newBill(), [{ method: 'card', transaction_id: '000123' }]);
    assertEqualOrThrow(reused.status, 409, 'a terminal number cannot settle a second bill');
    assertEqualOrThrow(
      reused.data.display_code,
      'transaction_reference_used',
      'reuse keeps its existing code',
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    closeDatabase();
    try {
      fs.rmSync(testDir, { recursive: true, force: true });
    } catch {}
  }

  const { passed, failed, total } = getResults();
  console.log(`\n${passed}/${total} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
