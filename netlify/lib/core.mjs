// Shared helpers for all Netlify Functions: config, auth, Airtable access.
import crypto from 'node:crypto';

const env = (k, d) => (process.env[k] && process.env[k].trim()) || d;

export const CFG = {
  token: () => env('AIRTABLE_TOKEN'),
  base: () => env('AIRTABLE_BASE_ID', 'appU50yPTSMZ2q40T'),          // Material Purchasing
  jobsBase: () => env('JOBS_BASE_ID', 'appmX8rxmEtdwrzSt'),          // Job Name List
  jobsTable: () => env('JOBS_TABLE_ID', 'tblg1mCHhTJXdZHCW'),
  poPrefix: () => env('PO_PREFIX', 'PO-'),
  poStart: () => parseInt(env('PO_START', '1001'), 10),
};

export const T = {
  vendors: 'Vendors',
  orders: 'Orders',
  lines: 'Order Lines',
  deliveries: 'Deliveries',
  dlines: 'Delivery Lines',
};

export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

export function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}

export function handler(fn) {
  return async (req, ctx) => {
    try {
      return await fn(req, ctx);
    } catch (e) {
      const status = e.status || 500;
      if (status >= 500) console.error(e);
      return json({ error: e.message || 'Server error' }, status);
    }
  };
}

export async function readBody(req) {
  try { return await req.json(); } catch { throw new HttpError(400, 'Invalid request body'); }
}

/* ---------------- Auth: signed session tokens ---------------- */

function secret() {
  const s = env('SESSION_SECRET');
  if (!s) throw new HttpError(500, 'SESSION_SECRET is not set in Netlify environment variables');
  return s;
}

export function safeEqual(a, b) {
  const A = Buffer.from(String(a)), B = Buffer.from(String(b));
  return A.length === B.length && crypto.timingSafeEqual(A, B);
}

export function signToken(role, days = 30) {
  const payload = Buffer.from(JSON.stringify({ role, exp: Date.now() + days * 864e5 })).toString('base64url');
  const sig = crypto.createHmac('sha256', secret()).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

export function requireAuth(req, needRole) {
  const tok = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  const [p, s] = tok.split('.');
  if (!p || !s) throw new HttpError(401, 'Please sign in');
  const expected = crypto.createHmac('sha256', secret()).update(p).digest('base64url');
  if (!safeEqual(s, expected)) throw new HttpError(401, 'Session is not valid, please sign in again');
  let data;
  try { data = JSON.parse(Buffer.from(p, 'base64url').toString()); } catch { throw new HttpError(401, 'Please sign in'); }
  if (!data.exp || data.exp < Date.now()) throw new HttpError(401, 'Session expired, please sign in again');
  if (needRole === 'admin' && data.role !== 'admin') throw new HttpError(403, 'View-only access cannot make changes');
  return data;
}

/* ---------------- Airtable REST helpers ---------------- */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function at(path, { method = 'GET', body, base = CFG.base(), host = 'https://api.airtable.com' } = {}, attempt = 0) {
  if (!CFG.token()) throw new HttpError(500, 'AIRTABLE_TOKEN is not set in Netlify environment variables');
  const res = await fetch(`${host}/v0/${base}/${path}`, {
    method,
    headers: { Authorization: `Bearer ${CFG.token()}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 429 && attempt < 4) {
    await sleep(1000 * (attempt + 1));
    return at(path, { method, body, base, host }, attempt + 1);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data?.error?.message || data?.error?.type || (typeof data?.error === 'string' ? data.error : '') || res.statusText;
    throw new HttpError(502, `Airtable error (${res.status}): ${msg}`);
  }
  return data;
}

const tbl = (t) => encodeURIComponent(t);

export async function listAll(table, params = {}, base) {
  const out = [];
  let offset;
  do {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (Array.isArray(v)) v.forEach((x) => q.append(`${k}[]`, x));
      else if (v != null) q.set(k, v);
    }
    q.set('pageSize', '100');
    if (offset) q.set('offset', offset);
    const d = await at(`${tbl(table)}?${q}`, { base });
    out.push(...d.records);
    offset = d.offset;
  } while (offset);
  return out;
}

export async function getOne(table, id) {
  if (!/^rec[A-Za-z0-9]{14}$/.test(id || '')) throw new HttpError(400, 'Invalid record id');
  return at(`${tbl(table)}/${id}`);
}

export async function getByIds(table, ids) {
  const clean = (ids || []).filter((id) => /^rec[A-Za-z0-9]{14}$/.test(id));
  const out = [];
  for (let i = 0; i < clean.length; i += 50) {
    const chunk = clean.slice(i, i + 50);
    const formula = `OR(${chunk.map((id) => `RECORD_ID()='${id}'`).join(',')})`;
    out.push(...(await listAll(table, { filterByFormula: formula })));
  }
  return out;
}

export async function createMany(table, fieldsList) {
  const out = [];
  for (let i = 0; i < fieldsList.length; i += 10) {
    const d = await at(tbl(table), {
      method: 'POST',
      body: { records: fieldsList.slice(i, i + 10).map((fields) => ({ fields })), typecast: true },
    });
    out.push(...d.records);
  }
  return out;
}

export async function updateMany(table, recs) {
  const out = [];
  for (let i = 0; i < recs.length; i += 10) {
    const d = await at(tbl(table), {
      method: 'PATCH',
      body: { records: recs.slice(i, i + 10), typecast: true },
    });
    out.push(...d.records);
  }
  return out;
}

export async function deleteMany(table, ids) {
  for (let i = 0; i < ids.length; i += 10) {
    const q = new URLSearchParams();
    ids.slice(i, i + 10).forEach((id) => q.append('records[]', id));
    await at(`${tbl(table)}?${q}`, { method: 'DELETE' });
  }
}

export async function uploadAttachment(recordId, fieldName, { contentType, base64, filename }) {
  return at(`${recordId}/${encodeURIComponent(fieldName)}/uploadAttachment`, {
    method: 'POST',
    host: 'https://content.airtable.com',
    body: { contentType, file: base64, filename },
  });
}

/* ---------------- Record mappers ---------------- */

const first = (v) => (Array.isArray(v) ? v[0] : v) || '';
const num = (v) => (typeof v === 'number' && isFinite(v) ? v : 0);
const files = (arr) =>
  (arr || []).map((a) => ({
    id: a.id,
    url: a.url,
    filename: a.filename,
    type: a.type,
    thumb: a.thumbnails?.large?.url || a.thumbnails?.small?.url || '',
  }));

export function mapOrder(r) {
  const f = r.fields;
  return {
    id: r.id,
    ref: f['Order Ref'] || '',
    po: f['PO #'] || '',
    vendorOrderNo: f['Vendor Order #'] || '',
    jobName: f['Job Name'] || '',
    jobNumber: f['Job Number'] || '',
    jobId: f['Job Record ID'] || '',
    vendorId: first(f['Vendor']),
    vendorName: first(f['Vendor Name']),
    orderDate: f['Order Date'] || '',
    requested: f['Requested Delivery'] || '',
    orderedBy: f['Ordered By'] || '',
    cancelled: !!f['Cancelled'],
    deliveryNotes: f['Delivery Notes'] || '',
    notes: f['Notes'] || '',
    status: f['Status'] || 'Open',
    total: num(f['Order Total']),
    qtyOrdered: num(f['Total Qty Ordered']),
    qtyDelivered: num(f['Total Qty Delivered']),
    lastDelivery: f['Last Delivery'] || '',
    attachments: files(f['Attachments']),
    lineIds: f['Order Lines'] || [],
    deliveryIds: f['Deliveries'] || [],
  };
}

export function mapLine(r) {
  const f = r.fields;
  return {
    id: r.id,
    description: f['Description'] || '',
    sku: f['SKU / Part #'] || '',
    unit: f['Unit'] || '',
    qty: num(f['Qty Ordered']),
    price: num(f['Unit Price']),
    ext: num(f['Extended Price']),
    delivered: num(f['Qty Delivered']),
    remaining: num(f['Qty Remaining']),
    status: f['Line Status'] || 'Open',
    notes: f['Line Notes'] || '',
    sort: typeof f['Sort'] === 'number' ? f['Sort'] : 9999,
  };
}

export function mapDelivery(r) {
  const f = r.fields;
  return {
    id: r.id,
    slipNo: f['Slip #'] || '',
    date: f['Delivery Date'] || '',
    receivedBy: f['Received By'] || '',
    notes: f['Notes'] || '',
    method: f['Entry Method']?.name || f['Entry Method'] || '',
    slip: files(f['Packing Slip']),
    lineIds: f['Delivery Lines'] || [],
  };
}

export function mapDLine(r) {
  const f = r.fields;
  return {
    id: r.id,
    item: f['Item'] || '',
    qty: num(f['Qty Received']),
    notes: f['Notes'] || '',
    orderLineId: first(f['Order Line']),
    deliveryId: first(f['Delivery']),
  };
}

export function mapVendor(r) {
  const f = r.fields;
  return {
    id: r.id,
    name: f['Vendor Name'] || '',
    requiresPO: !!f['Requires PO'],
    rep: f['Rep'] || '',
    phone: f['Phone'] || '',
    email: f['Email'] || '',
    account: f['Account #'] || '',
    notes: f['Notes'] || '',
  };
}

/** Full order detail: header + lines + deliveries (with their lines). */
export async function loadOrderDetail(id) {
  const order = mapOrder(await getOne(T.orders, id));
  const [lineRecs, delRecs] = await Promise.all([getByIds(T.lines, order.lineIds), getByIds(T.deliveries, order.deliveryIds)]);
  const lines = lineRecs.map(mapLine).sort((a, b) => a.sort - b.sort || a.description.localeCompare(b.description));
  const deliveries = delRecs.map(mapDelivery).sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  const dlineIds = deliveries.flatMap((d) => d.lineIds);
  const dlines = (await getByIds(T.dlines, dlineIds)).map(mapDLine);
  for (const d of deliveries) d.lines = dlines.filter((l) => l.deliveryId === d.id);
  return { order, lines, deliveries };
}
