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
  // GET /api/orders with no filter returns EVERY order: the buyer's name,
  // phone, home address, what they bought, what they paid, and the 4-digit
  // delivery PIN the driver has to be given. Anyone reading it could collect
  // somebody else's delivery. It is the seller/admin list, so it takes the
  // console code. Fetching ONE order by its reference stays open - that is
  // the buyer's own order-status page, and they have to know the reference.
  ['GET', /^\/api\/orders\/?$/],
  ['POST', /^\/api\/rides\/driver\/verify\/[^/]+$/],
  ['POST', /^\/api\/rides\/refund\/process\/[^/]+$/],
  /* PUT and DELETE /api/events/:id used to sit here and no longer do.
   *
   * They are not open now - they are checked inside routes/events.js by
   * openEventFor(), which accepts the console code exactly as this gate did,
   * OR the event's own manage code, which is generated when the event is
   * created and belongs to the organiser who created it.
   *
   * The reason for moving it: an organiser could not delete their own
   * duplicate event without being given the code that also opens escrow,
   * refunds and driver approval. This gate can only answer yes or no to "is
   * this him"; it cannot look up which event is being touched or who owns it,
   * and that lookup is the whole question. Nobody who was refused before is
   * admitted now - there is still no way through without one of two codes. */

  /* The POS kill switch. Everything that decides whether a phone still works
   * takes the console code. The one route left open is POST /api/pos/hello,
   * because a phone cannot prove who it is before it has been told - and it
   * can only ever write the display fields of its own row. */
  ['GET', /^\/api\/pos\/devices\/?$/],
  ['POST', /^\/api\/pos\/devices\/[^/]+\/(status|grant)$/],
  ['POST', /^\/api\/pos\/devices\/block-others$/]
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
