/* Ask SolutionIP whether a payment really happened.
 *
 * Both HaitiBiznis payment webhooks used to believe whatever was POSTed to
 * them: send {refference_id:"...", status:"completed"} with no credential and
 * a ticket was issued, or an order was marked paid and became releasable to a
 * seller out of escrow. The reference is printed on the buyer's own
 * confirmation screen, so it is not a secret.
 *
 * The gateway is the only thing allowed to say a payment happened.
 *
 * On the contract: the endpoint is a POST carrying refference_id (the
 * gateway's own spelling, with the double f). routes/orders.js used to call it
 * as a GET with order_id - that URL does not exist, and the gateway answers
 * HTTP 200 with an HTML 404 page, so .json() threw and the whole verify path
 * returned 500. Checking res.ok would not have caught it either. Verified
 * against the live gateway.
 */
const SIP_URL = process.env.SOLUTIONIP_URL || 'https://plopplop.solutionip.app';
const SIP_CLIENT = process.env.SOLUTIONIP_CLIENT_ID || 'pp_1ohu5zz2tcx';

/* Returns the gateway's answer, or throws. Never returns a made-up "paid".
 * A body that is not JSON is an error, not an empty result - that is exactly
 * how the broken URL went unnoticed. */
async function askGateway(referenceId) {
  const res = await fetch(SIP_URL + '/api/paiement-verify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: SIP_CLIENT, refference_id: referenceId })
  });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch (e) {
    throw new Error('gateway did not answer with JSON (http ' + res.status +
      '): ' + text.slice(0, 120).replace(/\s+/g, ' '));
  }
  return data;
}

/* true only when the gateway itself confirms the money arrived.
 * Anything else - not found, still pending, network down, a reply we do not
 * recognise - is false, and the caller must leave the order or ticket alone.
 * Failing closed costs a buyer a few minutes; failing open gives away goods. */
function isConfirmed(data) {
  if (!data || typeof data !== 'object') return false;
  return data.trans_status === 'ok' || data.status === true;
}

/* Convenience for the callers that only want a yes/no and want a refusal
 * logged rather than an exception. */
async function paymentConfirmed(referenceId, context) {
  if (!referenceId) return { confirmed: false, provider: null };
  try {
    const provider = await askGateway(referenceId);
    return { confirmed: isConfirmed(provider), provider };
  } catch (err) {
    console.error((context || 'payment check') + ': could not reach SolutionIP for ' +
      referenceId + ' - leaving it as it is. ' + err.message);
    return { confirmed: false, provider: null };
  }
}

module.exports = { askGateway, isConfirmed, paymentConfirmed, SIP_URL, SIP_CLIENT };
