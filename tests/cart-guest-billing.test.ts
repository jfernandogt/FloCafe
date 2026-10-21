/**
 * Unit Test: the cart bills dine-in lines per guest when split checks are on.
 *
 * Run: ts-node --transpile-only -P tests/tsconfig.json tests/cart-guest-billing.test.ts
 */

import assert from 'node:assert/strict';
import path from 'node:path';

const ROOT = path.join(__dirname, '..');
const Module = require('module');
const frontendRequire = Module.createRequire(path.join(ROOT, 'frontend/package.json'));
const moduleApi = require('module') as {
  _resolveFilename: (...args: any[]) => string;
};
const originalResolveFilename = moduleApi._resolveFilename;
const zustandPath = frontendRequire.resolve('zustand');
moduleApi._resolveFilename = function (
  request: string,
  parent: any,
  isMain: boolean,
  options?: any,
) {
  const resolvedRequest =
    request === 'zustand'
      ? zustandPath
      : request.startsWith('@/')
        ? path.resolve(ROOT, 'frontend/src', request.slice(2))
        : request;
  return originalResolveFilename.call(this, resolvedRequest, parent, isMain, options);
};

const { generateCartItemId } = require('../frontend/src/lib/cart-identity');
const { cartItemToOrderItem } = require('../frontend/src/lib/cart-order-item');
const { SHARED_GUEST, useCartStore } = require('../frontend/src/store/cart');

const burger = { id: 'prod-burger', name: 'Burger', price: 10 } as any;
const cart = () => useCartStore.getState();
const guestsOf = () =>
  cart()
    .items.map((item: any) => [item.product.id, item.quantity, item.guest_number ?? null])
    .sort();

assert.equal(
  generateCartItemId('prod-1', null, [], ''),
  generateCartItemId('prod-1', null, [], '', null),
  'a whole-table line keeps its existing identity',
);
assert.notEqual(
  generateCartItemId('prod-1', null, [], '', 1),
  generateCartItemId('prod-1', null, [], '', 2),
  'the same product for two guests is two lines',
);

cart().clearCart();
cart().setGuestCount(3);
cart().addItem(burger);
assert.deepEqual(
  guestsOf(),
  [['prod-burger', 1, null]],
  'without split checks lines stay unassigned',
);

cart().clearCart();
cart().setGuestBillingEnabled(true);
cart().addItem(burger);
assert.deepEqual(guestsOf(), [['prod-burger', 1, null]], 'a single guest is not billed per guest');

cart().clearCart();
cart().setGuestCount(3);
assert.equal(cart().guestBilling(), true, 'dine-in with three guests bills per guest');
cart().addItem(burger);
cart().setActiveGuest(3);
cart().addItem(burger);
cart().addItem(burger);
cart().setActiveGuest(SHARED_GUEST);
cart().addItem(burger);
assert.deepEqual(
  guestsOf(),
  [
    ['prod-burger', 1, null],
    ['prod-burger', 1, 1],
    ['prod-burger', 2, 3],
  ],
  'new lines go to the selected guest and merge per guest',
);

const guestThreeLine = cart().items.find((item: any) => item.guest_number === 3);
assert.equal(cartItemToOrderItem(guestThreeLine).guest_number, 3, 'the payload carries the guest');
const sharedLine = cart().items.find((item: any) => !item.guest_number);
assert.equal(
  'guest_number' in cartItemToOrderItem(sharedLine),
  false,
  'a shared line payload is unchanged',
);

cart().moveItemToGuest(guestThreeLine.id, 1);
assert.deepEqual(
  guestsOf(),
  [
    ['prod-burger', 1, null],
    ['prod-burger', 3, 1],
  ],
  'moving a line onto a guest merges it with that guest’s equal line',
);

const payloadGuests = () =>
  cart()
    .orderItems()
    .map((item: any) => [item.quantity, item.guest_number ?? null])
    .sort();

cart().setActiveGuest(3);
cart().addItem(burger);
cart().setGuestCount(2);
assert.deepEqual(
  payloadGuests(),
  [
    [1, null],
    [1, null],
    [3, 1],
  ],
  'a line of a removed guest is sent as shared',
);
cart().setGuestCount(1);
assert.deepEqual(
  payloadGuests(),
  [
    [1, null],
    [1, null],
    [3, null],
  ],
  'a single guest sends no guest at all',
);
cart().setGuestCount(3);
assert.deepEqual(
  payloadGuests(),
  [
    [1, null],
    [1, 3],
    [3, 1],
  ],
  'assignments survive an intermediate guest count while typing',
);

cart().setOrderType('takeaway');
assert.equal(
  cart()
    .orderItems()
    .every((item: any) => !('guest_number' in item)),
  true,
  'a takeaway cart sends no guests',
);

cart().clearCart();
console.log('✓ cart guest billing');
