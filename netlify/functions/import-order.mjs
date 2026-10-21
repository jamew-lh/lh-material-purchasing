// Order PDF reader: /api/import-order
// Reads an order confirmation / quote / emailed order and returns a draft order
// (vendor + job matched against our lists, plus every line item) for review.
// Nothing is saved here — the person reviews and saves from the New Order form.
import { handler, json, readBody, requireAuth, HttpError, fileBlock, askClaudeJSON, loadJobs, loadVendors } from '../lib/core.mjs';

const SYSTEM = `You read construction material order documents (order confirmations, quotes, sales orders, emailed orders) and extract them into structured data.
Return ONLY a JSON object, no markdown, no commentary.`;

function buildPrompt(vendors, jobs) {
  const vList = vendors.map((v, i) => `V${i + 1} | ${v.name}`).join('\n') || '(none yet)';
  const jList = jobs.map((j, i) => `J${i + 1} | ${j.number} | ${j.name}${j.address ? ` | ${j.address}` : ''}`).join('\n') || '(none)';
  return `Our vendor list (id | name):
${vList}

Our active jobs (id | job number | job name | address if known):
${jList}

Read the attached order document and return this JSON:
{
  "vendor": {
    "match": "V1".."Vn" or null,           // the vendor in our list that issued this document; null if not in the list
    "name": string or null,                // vendor/company name as printed (the seller, NOT our company and NOT the ship-to)
    "phone": string or null, "email": string or null, "rep": string or null   // salesperson / rep if shown
  },
  "vendor_order_number": string or null,   // vendor's order / sales order / confirmation / quote number
  "po_number": string or null,             // customer PO number if printed
  "order_date": "YYYY-MM-DD" or null,
  "requested_date": "YYYY-MM-DD" or null,  // requested / ship / delivery date if shown
  "job": {
    "match": "J1".."Jn" or null,           // the job this order is for
    "confidence": "high" | "medium" | "low",
    "reason": string,                      // short: what on the document pointed to that job
    "ship_to": string or null              // ship-to / job name / address as printed
  },
  "ordered_by": string or null,            // our person who placed the order, if shown
  "delivery_notes": string or null,        // delivery / ship-to instructions
  "lines": [
    {
      "description": string,
      "sku": string or null,               // item / part / product number
      "unit": string or null,              // EA, FT, LF, JT, BOX, etc.
      "qty": number,                       // quantity ordered (on a slip with no ordered column: the quantity shipped / picked up)
      "qty_shipped": number or null,       // packing/delivery/pickup slips only: quantity shipped or handed over on THIS slip
      "unit_price": number or null,        // price per unit (per the unit above)
      "ext_price": number or null,         // line total as printed
      "note": string or null               // e.g. "price per 100", "backordered", "special order"
    }
  ],
  "subtotal": number or null,              // merchandise subtotal as printed (before tax/freight)
  "total": number or null,
  "document_type": "order confirmation" | "quote" | "invoice" | "packing slip" | "other",   // packing slip includes delivery tickets, pickup / counter tickets, will-call slips
  "slip_number": string or null,           // packing slip / delivery ticket / pickup ticket number (slips only)
  "delivery_date": "YYYY-MM-DD" or null,   // ship / delivery / pickup date printed on a slip
  "warnings": [string]
}

Rules:
- Include every merchandise line, in document order. Do not include tax, freight, fuel, delivery, or pallet charges as lines; mention them in warnings with amounts.
- If a price is per 100 / per 1000 / per foot while qty is in another unit, convert unit_price so qty * unit_price = the printed extended price, and explain in "note".
- If unit_price is missing but ext_price and qty are present, set unit_price = ext_price / qty.
- Match the vendor by company name (ignore Inc/LLC/Co, abbreviations). Match the job by job name, job number, or ship-to address; use null when unsure rather than guessing.
- Dates: convert to YYYY-MM-DD. Leave null if not printed.
- If this looks like a quote (not a confirmed order), say so in warnings. Packing slips, delivery tickets and pickup tickets are expected; don't warn about them.
- On a slip, if a line shows ordered, shipped and backordered columns, qty = ordered and qty_shipped = shipped. Prices are often not printed on slips: leave unit_price null rather than guessing.
- Never invent values.`;
}

const num = (v) => (v == null || v === '' || !isFinite(Number(v)) ? null : Number(v));
const date = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(v || '') ? v : '');
const s = (v) => (v == null ? '' : String(v).trim());

export default handler(async (req) => {
  if (req.method !== 'POST') throw new HttpError(405, 'POST only');
  requireAuth(req, 'admin');
  const { file } = await readBody(req);
  const block = fileBlock(file);

  const [vendors, jobs] = await Promise.all([loadVendors(), loadJobs()]);
  const { result: r, truncated } = await askClaudeJSON({ block, system: SYSTEM, prompt: buildPrompt(vendors, jobs), maxTokens: 12000, what: 'this order' });

  const vIdx = /^V(\d+)$/.exec(r.vendor?.match || '');
  const jIdx = /^J(\d+)$/.exec(r.job?.match || '');
  const vendor = vIdx ? vendors[+vIdx[1] - 1] : null;
  const job = jIdx ? jobs[+jIdx[1] - 1] : null;

  const lines = (Array.isArray(r.lines) ? r.lines : [])
    .map((l) => {
      const qty = num(l.qty) ?? 0;
      let price = num(l.unit_price);
      const ext = num(l.ext_price);
      if (price == null && ext != null && qty) price = Math.round((ext / qty) * 10000) / 10000;
      const shipped = num(l.qty_shipped);
      return { description: s(l.description), sku: s(l.sku), unit: s(l.unit), qty, price: price ?? 0, priceMissing: price == null, ext, qtyShipped: shipped ?? qty, note: s(l.note) };
    })
    .filter((l) => l.description);

  const warnings = Array.isArray(r.warnings) ? r.warnings.map(String) : [];
  if (truncated) warnings.push('The document was very long and may not have been read completely. Check the last lines against the PDF.');

  return json({
    draft: {
      vendorId: vendor?.id || '',
      vendorFound: s(r.vendor?.name),
      vendorContact: { phone: s(r.vendor?.phone), email: s(r.vendor?.email), rep: s(r.vendor?.rep) },
      vendorOrderNo: s(r.vendor_order_number),
      po: s(r.po_number),
      orderDate: date(r.order_date),
      requested: date(r.requested_date),
      jobId: job?.id || '',
      jobConfidence: ['high', 'medium', 'low'].includes(r.job?.confidence) ? r.job.confidence : 'low',
      jobReason: s(r.job?.reason),
      shipTo: s(r.job?.ship_to),
      orderedBy: s(r.ordered_by),
      deliveryNotes: s(r.delivery_notes),
      lines,
      subtotal: num(r.subtotal),
      total: num(r.total),
      documentType: s(r.document_type),
      isSlip: /packing slip/i.test(s(r.document_type)),
      slipNo: s(r.slip_number),
      deliveryDate: date(r.delivery_date),
      warnings,
    },
  });
});

export const config = { path: '/api/import-order' };
