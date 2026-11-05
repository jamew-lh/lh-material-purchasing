// AI readers: turn staged pages into a draft order (import) or matched delivery quantities (slip scan).
// Line items use a compact array format so Claude has less to write, which is the slow part.
import { askClaudeJSON, fileBlock, loadJobs, loadVendors, loadOrderDetail } from './core.mjs';

const num = (v) => (v == null || v === '' || !isFinite(Number(v)) ? null : Number(v));
const date = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(v || '') ? v : '');
const s = (v) => (v == null ? '' : String(v).trim());
const CONF = { h: 'high', m: 'medium', l: 'low', high: 'high', medium: 'medium', low: 'low' };

/* ======================= Order import (order confirmation / quote / slip) ======================= */

const IMPORT_SYSTEM = `You read construction material order documents (order confirmations, quotes, sales orders, emailed orders, packing slips, delivery and pickup tickets) and extract them into structured data.
Return ONLY a compact JSON object, no markdown, no commentary, no extra whitespace.`;

function importPrompt(vendors, jobs) {
  const vList = vendors.map((v, i) => `V${i + 1}|${v.name}`).join('\n') || '(none yet)';
  const jList = jobs.map((j, i) => `J${i + 1}|${j.number}|${j.name}${j.address ? `|${j.address}` : ''}`).join('\n') || '(none)';
  return `Our vendors (id|name):
${vList}

Our active jobs (id|job number|job name|address if known):
${jList}

Read the attached document and return this JSON:
{
 "vendor":{"match":"V#" or null,"name":str|null,"phone":str|null,"email":str|null,"rep":str|null},
 "vendor_order_number":str|null,
 "po_number":str|null,
 "order_date":"YYYY-MM-DD"|null,
 "requested_date":"YYYY-MM-DD"|null,
 "job":{"match":"J#" or null,"confidence":"high"|"medium"|"low","reason":str,"ship_to":str|null},
 "ordered_by":str|null,
 "delivery_notes":str|null,
 "lines":[[description, sku, unit, qty, unit_price, ext_price, qty_shipped, note], ...],
 "subtotal":num|null,
 "total":num|null,
 "document_type":"order confirmation"|"quote"|"invoice"|"packing slip"|"other",
 "slip_number":str|null,
 "delivery_date":"YYYY-MM-DD"|null,
 "warnings":[str]
}

Field notes:
- vendor.match: the vendor in our list that issued this document (the seller — NOT our company and NOT the ship-to); null if not in our list. vendor.name as printed. rep = salesperson if shown.
- vendor_order_number: vendor's order / sales order / confirmation / quote number. po_number: customer PO if printed.
- requested_date: requested / ship / delivery date if shown.
- job.match: the job this is for, by job name, job number, or ship-to address; null when unsure rather than guessing. reason: a few words on what pointed to it.
- lines: one array per merchandise line, in document order, exactly 8 positions, null where not printed:
  description (str), sku (item/part #), unit (EA, FT, LF, JT, BOX…), qty (number ordered; on a slip with no ordered column, the quantity shipped/picked up),
  unit_price (per the unit), ext_price (line total as printed), qty_shipped (slips only: shipped/handed over on THIS slip), note (short, e.g. "price per 100", "backordered").
- document_type "packing slip" includes delivery tickets, pickup/counter tickets, will-call slips. slip_number / delivery_date: slips only.

Rules:
- Include every merchandise line. Do not include tax, freight, fuel, delivery, or pallet charges as lines; mention them in warnings with amounts.
- If a price is per 100 / per 1000 / per foot while qty is in another unit, convert unit_price so qty * unit_price = the printed extended price, and say so in note.
- If unit_price is missing but ext_price and qty are present, set unit_price = ext_price / qty.
- Dates as YYYY-MM-DD; null if not printed.
- If this looks like a quote (not a confirmed order), say so in warnings. Slips are expected; don't warn about them.
- On a slip with ordered, shipped and backordered columns: qty = ordered, qty_shipped = shipped. Prices are often not printed on slips: leave unit_price null rather than guessing.
- Never invent values. Keep notes and reasons short.`;
}

/** Accepts the compact array form, or the older object form, for one line. */
function importLine(l) {
  const o = Array.isArray(l)
    ? { description: l[0], sku: l[1], unit: l[2], qty: l[3], unit_price: l[4], ext_price: l[5], qty_shipped: l[6], note: l[7] }
    : l || {};
  const qty = num(o.qty) ?? 0;
  let price = num(o.unit_price);
  const ext = num(o.ext_price);
  if (price == null && ext != null && qty) price = Math.round((ext / qty) * 10000) / 10000;
  const shipped = num(o.qty_shipped);
  return { description: s(o.description), sku: s(o.sku), unit: s(o.unit), qty, price: price ?? 0, priceMissing: price == null, ext, qtyShipped: shipped ?? qty, note: s(o.note) };
}

export async function readOrderImport(files, { timeoutMs } = {}) {
  const blocks = files.map(fileBlock);
  const [vendors, jobs] = await Promise.all([loadVendors(), loadJobs()]);
  const { result: r, truncated } = await askClaudeJSON({
    blocks, system: IMPORT_SYSTEM, prompt: importPrompt(vendors, jobs), maxTokens: 16000, what: 'this order', timeoutMs,
  });

  const vIdx = /^V(\d+)$/.exec(r.vendor?.match || '');
  const jIdx = /^J(\d+)$/.exec(r.job?.match || '');
  const vendor = vIdx ? vendors[+vIdx[1] - 1] : null;
  const job = jIdx ? jobs[+jIdx[1] - 1] : null;
  const lines = (Array.isArray(r.lines) ? r.lines : []).map(importLine).filter((l) => l.description);

  const warnings = Array.isArray(r.warnings) ? r.warnings.map(String) : [];
  if (truncated) warnings.push('The document was very long and may not have been read completely. Check the last lines against the original.');

  return {
    draft: {
      vendorId: vendor?.id || '',
      vendorFound: s(r.vendor?.name),
      vendorContact: { phone: s(r.vendor?.phone), email: s(r.vendor?.email), rep: s(r.vendor?.rep) },
      vendorOrderNo: s(r.vendor_order_number),
      po: s(r.po_number),
      orderDate: date(r.order_date),
      requested: date(r.requested_date),
      jobId: job?.id || '',
      jobConfidence: CONF[r.job?.confidence] || 'low',
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
      pages: files.length,
    },
  };
}

/* ======================= Packing slip scan against an existing order ======================= */

const SCAN_SYSTEM = `You read construction material packing slips / delivery tickets and match them against a purchase order.
Return ONLY a compact JSON object, no markdown, no commentary, no extra whitespace.`;

function scanPrompt(order, lines) {
  const lineList = lines
    .map((l, i) => `L${i + 1}|${l.description}|${l.sku || ''}|${l.unit || '?'}|ordered ${l.qty}|received ${l.delivered}|remaining ${l.remaining}`)
    .join('\n');
  return `This delivery is expected to belong to this order:
Vendor: ${order.vendorName}
PO #: ${order.po || '(none)'}
Vendor order #: ${order.vendorOrderNo || '(none)'}
Job: ${order.jobNumber} ${order.jobName}

Order lines (id|description|sku|unit|ordered|already received|remaining):
${lineList || '(no lines)'}

Read the attached packing slip and return this JSON:
{
 "slip_number":str|null,
 "delivery_date":"YYYY-MM-DD"|null,
 "vendor_name":str|null,
 "order_reference":str|null,
 "items":[[description, sku, unit, qty_shipped, qty_ordered, qty_backordered, line, confidence, note], ...],
 "warnings":[str]
}

Field notes:
- slip_number: packing slip / ticket / delivery number. delivery_date: ship or delivery date printed. order_reference: PO or order number printed on the slip.
- items: one array per item on the slip, exactly 9 positions, null where not printed:
  description (as printed), sku, unit, qty_shipped (number that physically came on THIS delivery), qty_ordered, qty_backordered,
  line ("L1".."Ln" = the matching order line, null if no confident match), confidence ("h","m","l"), note (short: unit mismatch, damaged, substitution…).

Rules:
- qty_shipped is the shipped / delivered column, NOT ordered and NOT backordered. If only one quantity is shown, use it.
- Match by SKU first, then by description meaning (sizes, materials, fittings). Do not force a match; use null when unsure.
- If the slip's unit differs from the order line's unit (EA vs BOX, LF vs JT), do NOT convert. Report the slip quantity and explain in note.
- If a line is crossed out, hand-corrected, or annotated, use the corrected value and say so in note.
- If order_reference clearly does not match the PO or vendor order # above, add a warning.
- Never invent items. Skip freight, fuel surcharge, and pallet charges unless they appear on the order.`;
}

function scanItem(it, idByKey) {
  const o = Array.isArray(it)
    ? { description: it[0], sku: it[1], unit: it[2], qty_shipped: it[3], qty_ordered: it[4], qty_backordered: it[5], line: it[6], confidence: it[7], note: it[8] }
    : it || {};
  return {
    description: s(o.description),
    sku: o.sku || null,
    unit: o.unit || null,
    qty_shipped: num(o.qty_shipped) || 0,
    qty_ordered: num(o.qty_ordered),
    qty_backordered: num(o.qty_backordered),
    orderLineId: idByKey[o.line] || null,
    confidence: CONF[o.confidence] || 'low',
    note: o.note || null,
  };
}

export async function readSlipScan(files, { orderId, timeoutMs } = {}) {
  const blocks = files.map(fileBlock);
  const { order, lines } = await loadOrderDetail(orderId);
  const idByKey = Object.fromEntries(lines.map((l, i) => [`L${i + 1}`, l.id]));
  const { result } = await askClaudeJSON({
    blocks, system: SCAN_SYSTEM, prompt: scanPrompt(order, lines), maxTokens: 8000, what: 'this slip', timeoutMs,
  });
  result.items = (Array.isArray(result.items) ? result.items : []).map((it) => scanItem(it, idByKey));
  result.warnings = Array.isArray(result.warnings) ? result.warnings.map(String) : [];
  return { result };
}

export async function runReader(job, files, opts = {}) {
  if (job.kind === 'import') return readOrderImport(files, opts);
  if (job.kind === 'scan') return readSlipScan(files, { ...opts, orderId: job.orderId });
  throw new Error('Unknown job type');
}
