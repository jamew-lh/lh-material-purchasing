// Packing slip reader: /api/scan
// Sends the slip image/PDF plus the order's line items to Claude and returns
// structured, line-matched quantities for a person to review before saving.
import { handler, json, readBody, requireAuth, HttpError, loadOrderDetail } from '../lib/core.mjs';

const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
const MAX_BYTES = 4.5 * 1024 * 1024;

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

function parseJSON(text) {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end < start) throw new Error('No JSON in response');
  return JSON.parse(text.slice(start, end + 1));
}

export default handler(async (req) => {
  if (req.method !== 'POST') throw new HttpError(405, 'POST only');
  requireAuth(req, 'admin');

  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new HttpError(501, "Slip scanning isn't switched on yet. Add ANTHROPIC_API_KEY in Netlify's environment variables.");

  const { orderId, file } = await readBody(req);
  if (!file?.base64) throw new HttpError(400, 'No slip file received');
  const type = String(file.type || '').toLowerCase();
  const isPdf = type === 'application/pdf';
  if (!isPdf && !IMAGE_TYPES.includes(type)) throw new HttpError(400, 'Slip must be a photo (JPG/PNG) or a PDF');
  if ((file.base64.length * 3) / 4 > MAX_BYTES) throw new HttpError(400, 'Slip file is too large (max about 4.5 MB)');

  const { order, lines } = await loadOrderDetail(orderId);
  const idByKey = Object.fromEntries(lines.map((l, i) => [`L${i + 1}`, l.id]));

  const fileBlock = isPdf
    ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: file.base64 } }
    : { type: 'image', source: { type: 'base64', media_type: type, data: file.base64 } };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 26000);
  let res;
  try {
    res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: process.env.CLAUDE_MODEL || 'claude-sonnet-5-5',
        max_tokens: 4000,
        system: SYSTEM,
        messages: [{ role: 'user', content: [fileBlock, { type: 'text', text: buildPrompt(order, lines) }] }],
      }),
    });
  } catch (e) {
    if (e.name === 'AbortError') throw new HttpError(504, 'Reading the slip took too long. Try a clearer or smaller photo, or enter it manually.');
    throw new HttpError(502, `Could not reach the AI service: ${e.message}`);
  } finally {
    clearTimeout(timer);
  }

  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new HttpError(502, `AI service error (${res.status}): ${data?.error?.message || res.statusText}`);

  const text = (data.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('');
  let result;
  try { result = parseJSON(text); } catch { throw new HttpError(502, "Couldn't understand the AI's reading of this slip. Try another photo or enter it manually."); }

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
