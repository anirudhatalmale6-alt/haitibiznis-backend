/* Where Tikè Lakay's pages live (30 Oct 2026: tikelakay.com, Jeffery's "Go
 * live"). Every link the API hands out - payment returns, ticket links sent by
 * WhatsApp/email, the door QR, share pages, the flyer page - is built from
 * this one value, so a move never again means hunting through the code.
 * haitibiznis.com keeps forwarding its old Tikè pages here, so links already
 * sent keep working. */
module.exports = String(process.env.TL_PUBLIC_BASE || 'https://tikelakay.com').replace(/\/+$/, '');
