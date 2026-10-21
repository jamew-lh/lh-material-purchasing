// Main data API: /api/data?action=...
import {
  CFG, T, HttpError, handler, json, readBody, requireAuth,
  listAll, getOne, getByIds, createMany, updateMany, deleteMany, uploadAttachment,
  mapOrder, mapLine, mapDelivery, mapVendor, loadOrderDetail,
} from '../lib/core.mjs';

const ORDER_SUMMARY_FIELDS = [
  'Order Ref', 'PO #', 'Vendor Order #', 'Job Name', 'Job Number', 'Job Record ID', 'Vendor', 'Vendor Name',
  'Order Date', 'Requested Delivery', 'Ordered By', 'Cancelled', 'Status', 'Order Total',
  'Total Qty Ordered', 'Total Qty Delivered', 'Last Delivery',
];

const str = (v, max = 500) => (v == null ? '' : String(v).trim().slice(0, max));
const dateOrNull = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(v || '') ? v : null);
const isRec = (id) => /^rec[A-Za-z0-9]{14}$/.test(id || '');
const toNum = (v) => {
  const n = typeof v === 'number' ? v : parseFloat(String(v ?? '').replace(/[$,\s]/g, ''));
  return isFinite(n) ? n : 0;
};

/* ---------------- Reads ---------------- */

async function loadJobs() {
  const recs = await listAll(
    CFG.jobsTable(),
    { fields: ['Job Name', 'Number', 'Year', 'Active', 'Supervisor'], filterByFormula: '{Active}' },
    CFG.jobsBase(),
  );
  return recs
    .map((r) => ({
      id: r.id,
      name: str(r.fields['Job Name']),
      number: str(r.fields['Number']),
      year: str(r.fields['Year']),
      supervisor: r.fields['Supervisor']?.name || r.fields['Supervisor'] || '',
    }))
    .filter((j) => j.name)
    .sort((a, b) => (b.year || '').localeCompare(a.year || '') || a.name.localeCompare(b.name));
}

async function loadVendors() {
  return (await listAll(T.vendors)).map(mapVendor).sort((a, b) => a.name.localeCompare(b.name));
}

async function loadOrders() {
  return (await listAll(T.orders, { fields: ORDER_SUMMARY_FIELDS })).map(mapOrder);
}

/* ---------------- PO numbers ---------------- */

async function nextPO() {
  const prefix = CFG.poPrefix();
  const recs = await listAll(T.orders, { fields: ['PO #'], filterByFormula: "{PO #}!=''" });
  let max = CFG.poStart() - 1;
  for (const r of recs) {
    const m = String(r.fields['PO #'] || '').match(/(\d+)\s*$/);
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return `${prefix}${max + 1}`;
}

/* ---------------- Writes ---------------- */

async function saveOrder(body) {
  const h = body.order || {};
  const lines = Array.isArray(body.lines) ? body.lines : [];
  if (!isRec(h.vendorId)) throw new HttpError(400, 'Choose a vendor');
  if (!str(h.jobName)) throw new HttpError(400, 'Choose a job');
  if (h.id && !isRec(h.id)) throw new HttpError(400, 'Invalid order id');

  const vendor = mapVendor(await getOne(T.vendors, h.vendorId));
  let po = str(h.po, 60);
  let generatedPO = false;
  if (!po && vendor.requiresPO) { po = await nextPO(); generatedPO = true; }
  const vendorOrderNo = str(h.vendorOrderNo, 80);
  const ref = po || vendorOrderNo || `${vendor.name} ${h.orderDate || ''}`.trim();

  const fields = {
    'Order Ref': ref,
    'PO #': po,
    'Vendor Order #': vendorOrderNo,
    'Vendor': [h.vendorId],
    'Job Name': str(h.jobName, 200),
    'Job Number': str(h.jobNumber, 60),
    'Job Record ID': str(h.jobId, 30),
    'Order Date': dateOrNull(h.orderDate),
    'Requested Delivery': dateOrNull(h.requested),
    'Ordered By': str(h.orderedBy, 100),
    'Cancelled': !!h.cancelled,
    'Delivery Notes': str(h.deliveryNotes, 5000),
    'Notes': str(h.notes, 5000),
  };

  let orderId = h.id;
  if (orderId) await updateMany(T.orders, [{ id: orderId, fields }]);
  else orderId = (await createMany(T.orders, [fields]))[0].id;

  // Line items
  const existing = orderId && h.id ? (await getByIds(T.lines, mapOrder(await getOne(T.orders, orderId)).lineIds)).map(mapLine) : [];
  const existingIds = new Set(existing.map((l) => l.id));
  const keepIds = new Set();
  const toCreate = [], toUpdate = [];
  lines.forEach((l, i) => {
    const desc = str(l.description, 300);
    if (!desc) return; // skip blank rows
    const f = {
      'Description': desc,
      'SKU / Part #': str(l.sku, 100),
      'Unit': str(l.unit, 20),
      'Qty Ordered': toNum(l.qty),
      'Unit Price': toNum(l.price),
      'Line Notes': str(l.notes, 300),
      'Sort': i + 1,
    };
    if (l.id && existingIds.has(l.id)) { keepIds.add(l.id); toUpdate.push({ id: l.id, fields: f }); }
    else toCreate.push({ ...f, 'Order': [orderId] });
  });
  const toDelete = existing.filter((l) => !keepIds.has(l.id));
  const blocked = toDelete.filter((l) => l.delivered !== 0);
  if (blocked.length) {
    throw new HttpError(400, `Can't remove "${blocked[0].description}" because deliveries have been recorded against it. Set its quantity instead, or delete those deliveries first.`);
  }
  if (toUpdate.length) await updateMany(T.lines, toUpdate);
  if (toCreate.length) await createMany(T.lines, toCreate);
  if (toDelete.length) await deleteMany(T.lines, toDelete.map((l) => l.id));

  return { ...(await loadOrderDetail(orderId)), generatedPO: generatedPO ? po : null };
}

async function deleteOrder(body) {
  const { order, lines, deliveries } = await loadOrderDetail(body.id);
  if (deliveries.length) throw new HttpError(400, 'This order has deliveries recorded. Delete them first, or mark the order Cancelled instead.');
  if (lines.length) await deleteMany(T.lines, lines.map((l) => l.id));
  await deleteMany(T.orders, [order.id]);
  return { ok: true };
}

const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;

async function saveDelivery(body) {
  if (!isRec(body.orderId)) throw new HttpError(400, 'Missing order');
  const detail = await loadOrderDetail(body.orderId);
  const validLineIds = new Set(detail.lines.map((l) => l.id));
  const lineById = Object.fromEntries(detail.lines.map((l) => [l.id, l]));

  const dlines = (Array.isArray(body.lines) ? body.lines : [])
    .map((l) => ({ ...l, qty: toNum(l.qty) }))
    .filter((l) => l.qty !== 0 && validLineIds.has(l.orderLineId));

  const fields = {
    'Slip #': str(body.slipNo, 80),
    'Delivery Date': dateOrNull(body.date),
    'Received By': str(body.receivedBy, 100),
    'Notes': str(body.notes, 5000),
    'Entry Method': body.method === 'Slip Scan' ? 'Slip Scan' : 'Manual',
    'Order': [body.orderId],
  };
  if (body.scanData) fields['Scan Data'] = str(typeof body.scanData === 'string' ? body.scanData : JSON.stringify(body.scanData, null, 2), 90000);

  let deliveryId = body.deliveryId;
  if (deliveryId) {
    if (!isRec(deliveryId)) throw new HttpError(400, 'Invalid delivery id');
    const existing = mapDelivery(await getOne(T.deliveries, deliveryId));
    await updateMany(T.deliveries, [{ id: deliveryId, fields }]);
    if (existing.lineIds.length) await deleteMany(T.dlines, existing.lineIds);
  } else {
    if (!dlines.length && !body.file) throw new HttpError(400, 'Enter at least one quantity received');
    deliveryId = (await createMany(T.deliveries, [fields]))[0].id;
  }

  if (dlines.length) {
    await createMany(
      T.dlines,
      dlines.map((l) => ({
        'Item': lineById[l.orderLineId]?.description || str(l.item, 300),
        'Qty Received': l.qty,
        'Notes': str(l.notes, 300),
        'Delivery': [deliveryId],
        'Order Line': [l.orderLineId],
      })),
    );
  }

  let uploadWarning = null;
  if (body.file?.base64) {
    const bytes = Math.floor((body.file.base64.length * 3) / 4);
    if (bytes > MAX_UPLOAD_BYTES) uploadWarning = 'Packing slip file was over 5 MB and was not attached.';
    else {
      try {
        await uploadAttachment(deliveryId, 'Packing Slip', {
          contentType: str(body.file.type, 100) || 'application/octet-stream',
          base64: body.file.base64,
          filename: str(body.file.name, 150) || 'packing-slip',
        });
      } catch (e) {
        uploadWarning = `Delivery saved, but the slip file didn't attach: ${e.message}`;
      }
    }
  }
  return { ...(await loadOrderDetail(body.orderId)), uploadWarning };
}

async function deleteDelivery(body) {
  if (!isRec(body.deliveryId)) throw new HttpError(400, 'Invalid delivery id');
  const d = mapDelivery(await getOne(T.deliveries, body.deliveryId));
  if (d.lineIds.length) await deleteMany(T.dlines, d.lineIds);
  await deleteMany(T.deliveries, [d.id]);
  return body.orderId ? await loadOrderDetail(body.orderId) : { ok: true };
}

async function saveVendor(body) {
  const v = body.vendor || {};
  const name = str(v.name, 150);
  if (!name) throw new HttpError(400, 'Vendor name is required');
  const fields = {
    'Vendor Name': name,
    'Requires PO': !!v.requiresPO,
    'Rep': str(v.rep, 100),
    'Phone': str(v.phone, 40),
    'Email': str(v.email, 150) || null,
    'Account #': str(v.account, 80),
    'Notes': str(v.notes, 3000),
  };
  let rec;
  if (v.id) { if (!isRec(v.id)) throw new HttpError(400, 'Invalid vendor id'); rec = (await updateMany(T.vendors, [{ id: v.id, fields }]))[0]; }
  else rec = (await createMany(T.vendors, [fields]))[0];
  return { vendor: mapVendor(rec) };
}

/* ---------------- Router ---------------- */

const READS = {
  bootstrap: async () => {
    const [jobs, vendors, orders] = await Promise.all([loadJobs(), loadVendors(), loadOrders()]);
    return { jobs, vendors, orders };
  },
  orders: async () => ({ orders: await loadOrders() }),
  order: async (url) => loadOrderDetail(url.searchParams.get('id')),
  nextPO: async () => ({ po: await nextPO() }),
};

const WRITES = { saveOrder, deleteOrder, saveDelivery, deleteDelivery, saveVendor };

export default handler(async (req) => {
  const url = new URL(req.url);
  const action = url.searchParams.get('action') || '';
  if (req.method === 'GET' && READS[action]) {
    const session = requireAuth(req);
    return json({ ...(await READS[action](url)), role: session.role });
  }
  if (req.method === 'POST' && WRITES[action]) {
    requireAuth(req, 'admin');
    return json(await WRITES[action](await readBody(req)));
  }
  throw new HttpError(404, 'Unknown action');
});

export const config = { path: '/api/data' };
