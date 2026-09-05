/* One gate in front of the HaitiBiznis routes that only an administrator
 * should reach.
 *
 * The lock already existed and works - utils/consolePin.js hashes a console
 * code and checks it against the x-admin-pin header - but it was fitted to the
 * /api/verify/admin/* routes and nowhere else. Everything below answered
 * anybody, with no credential at all:
 *
 *   POST /api/orders/:ref/release   pays the seller out of escrow
 *   POST /api/orders/:ref/refund    refunds an order
 *   POST /api/orders/auto-release   releases every order that is due
 *   POST /api/rides/driver/verify/:id   approves a driver
 *   POST /api/rides/refund/process/:id  approves a refund
 *   PUT / DELETE /api/events/:id    edits or deletes somebody else's event
 *
 * Deliberately NOT listed here, because real people call them with no
 * credential and locking them would break the apps:
 *   - the order lifecycle a seller or driver drives (preparing, ready, pickup,
 *     on-the-way, deliver, seller-confirm, confirm-received, dispute)
 *   - POST /api/events, which is the public "post your event" form
 *   - driver login / register / status / location
 * Those need a real per-person identity, which is a bigger change than a gate.
 */
const { requirePin } = require('../utils/consolePin');

const ADMIN_ONLY = [
  ['POST', /^\/api\/orders\/[^/]+\/(release|refund)$/],
  ['POST', /^\/api\/orders\/auto-release$/],
  ['POST', /^\/api\/rides\/driver\/verify\/[^/]+$/],
  ['POST', /^\/api\/rides\/refund\/process\/[^/]+$/],
  ['PUT', /^\/api\/events\/[^/]+$/],
  ['DELETE', /^\/api\/events\/[^/]+$/]
];

function isAdminOnly(method, path) {
  for (const [m, re] of ADMIN_ONLY) {
    if (m === method && re.test(path)) return true;
  }
  return false;
}

function adminOnly(req, res, next) {
  if (!isAdminOnly(req.method, req.path.split('?')[0])) return next();
  return requirePin(req, res, next);
}

module.exports = { adminOnly, isAdminOnly, ADMIN_ONLY };
