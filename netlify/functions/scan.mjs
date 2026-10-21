// Packing slip reader: /api/scan
// Sends the slip image/PDF plus the order's line items to Claude and returns
// structured, line-matched quantities for a person to review before saving.
import { handler, json, readBody, requireAuth, HttpError, loadOrderDetail, fileBlock, askClaudeJSON } from '../lib/core.mjs';

const SYSTEM = `You read construction material packing slips / delivery tickets and match them against a purchase order.
Return ONLY a JSON object, no markdown, no commentary.`;

function buildPrompt(order, lines) {
  const lineList = lines
    .map((l, i) => `L${i + 1} | ${l.description}${l.sku ? ` | SKU ${l.sku}` : ''} | unit ${l.unit || '?'} | ordered ${l.qty} | already received ${l.delivered} | remaining ${l.remaining}`)
    .join('\n');
  return `This delivery is expected to belong to this order:
Vendor: ${order.vendorName}
PO #: ${order.po || '(none)'}
Vendor order #: ${order.vendorOrderNo || '(none)'}
Job: ${order.jobNumber} ${order.jobName}

Order lines (id | description | sku | unit | ordered | already received | remaining):
${lineList || '(no lines)'}

Read the attached packing slip and return this JSON:
{
  "slip_number": string or null,          // packing slip / ticket / delivery number
  "delivery_date": "YYYY-MM-DD" or null,  // ship or delivery date printed on the slip
  "vendor_name": string or null,
  "order_reference": string or null,      // PO or order number printed on the slip
  "items": [
    {
      "description": string,              // as printed
      "sku": string or null,
      "unit": string or null,
      "qty_shipped": number,              // quantity that physically came on THIS delivery
      "qty_ordered": number or null,      // if the slip shows it
      "qty_backordered": number or null,  // if the slip shows it
      "line": "L1".."Ln" or null,         // the matching order line, null if no confident match
      "confidence": "high" | "medium" | "low",
      "note": string or null              // e.g. unit mismatch, partial, damaged, substitution
    }
  ],
  "warnings": [string]                    // anything the receiver should double-check
}

Rules:
- qty_shipped is the shipped / delivered column, NOT ordered and NOT backordered. If only one quantity is shown, use it.
- Match by SKU first, then by description meaning (sizes, materials, fittings). Do not force a match; use null when unsure.
- If the slip's unit differs from the order line's unit (e.g. EA vs BOX, LF vs JT), do NOT convert. Report the slip quantity and explain in "note".
- If a line item is crossed out, hand-corrected, or annotated, use the corrected value and say so in "note".
- If the order_reference clearly does not match the PO or vendor order # above, add a warning.
- Never invent items. Skip freight, fuel surcharge, and pallet charges unless they appear on the order.`;
}

export default handler(async (req) => {
  if (req.method !== 'POST') throw new HttpError(405, 'POST only');
  requireAuth(req, 'admin');
  const { orderId, file } = await readBody(req);
  const block = fileBlock(file);

  const { order, lines } = await loadOrderDetail(orderId);
  const idByKey = Object.fromEntries(lines.map((l, i) => [`L${i + 1}`, l.id]));

  const { result } = await askClaudeJSON({ block, system: SYSTEM, prompt: buildPrompt(order, lines), maxTokens: 4000, what: 'this slip' });

  result.items = (Array.isArray(result.items) ? result.items : []).map((it) => ({
    description: String(it.description || ''),
    sku: it.sku || null,
    unit: it.unit || null,
    qty_shipped: Number(it.qty_shipped) || 0,
    qty_ordered: it.qty_ordered == null ? null : Number(it.qty_ordered),
    qty_backordered: it.qty_backordered == null ? null : Number(it.qty_backordered),
    orderLineId: idByKey[it.line] || null,
    confidence: ['high', 'medium', 'low'].includes(it.confidence) ? it.confidence : 'low',
    note: it.note || null,
  }));
  result.warnings = Array.isArray(result.warnings) ? result.warnings.map(String) : [];

  return json({ result });
});

export const config = { path: '/api/scan' };
