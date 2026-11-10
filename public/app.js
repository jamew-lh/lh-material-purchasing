/* Material Purchasing — single-page front end.
   Talks to Netlify Functions at /api/login, /api/data, /api/ai. */
'use strict';

/* ================= State & utilities ================= */

const S = {
  token: null,
  role: null,
  jobs: [],
  vendors: [],
  nonJob: [],
  orders: [],
  loaded: false,
  stale: false,
  filters: { q: '', job: '', vendor: '', status: 'active' },
};

const app = document.getElementById('app');
const isAdmin = () => S.role === 'admin';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (n) => (Number(n) || 0).toLocaleString('en-US', { style: 'currency', currency: 'USD' });
const qty = (n) => { const v = Number(n) || 0; return Number.isInteger(v) ? v.toLocaleString('en-US') : v.toLocaleString('en-US', { maximumFractionDigits: 2 }); };
const fdate = (d) => { if (!d) return ''; const [y, m, day] = d.split('-'); return `${+m}/${+day}/${y}`; };
const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const parseNum = (v) => { const n = parseFloat(String(v ?? '').replace(/[$,\s]/g, '')); return isFinite(n) ? n : 0; };
const jobLabel = (j) => [j.number, j.name].filter(Boolean).join(' · ');
const orderJobLabel = (o) => [o.jobNumber, o.jobName].filter(Boolean).join(' · ');
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

function store(key, val) {
  try { if (val === undefined) return JSON.parse(localStorage.getItem(key) || 'null'); if (val === null) localStorage.removeItem(key); else localStorage.setItem(key, JSON.stringify(val)); } catch { return null; }
}

let toastTimer;
function toast(msg, type = '') {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = `toast show ${type}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.className = 'toast'), type === 'error' ? 6000 : 3500);
}

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    headers: { 'content-type': 'application/json', ...(S.token ? { authorization: `Bearer ${S.token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = {};
  try { data = await res.json(); } catch { /* non-JSON */ }
  if (res.status === 401 && path !== '/api/login') { signOut(); throw new Error(data.error || 'Please sign in again'); }
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

const loadingHTML = (msg = 'Loading…') => `<div class="loading"><span class="spinner"></span>${esc(msg)}</div>`;

/* ================= Auth ================= */

function signOut() {
  store('mp_session', null);
  S.token = S.role = null;
  S.loaded = false;
  render();
}

function renderLogin() {
  document.getElementById('topbar').hidden = true;
  document.getElementById('tabbar').hidden = true;
  app.className = '';
  app.innerHTML = `
    <div class="login">
      <div class="card">
        <img src="/logo.png" alt="Lyons &amp; Hohl Site Contractors" class="login-logo">
        <h1>Material Purchasing</h1>
        <div class="muted">Sign in to view job site orders.</div>
        <form id="loginForm">
          <label class="field"><span>Password</span><input type="password" id="pw" autocomplete="current-password" required autofocus></label>
          <div class="err" id="loginErr"></div>
          <button class="btn primary" type="submit">Sign in</button>
        </form>
      </div>
    </div>`;
  $('#loginForm').onsubmit = async (e) => {
    e.preventDefault();
    const btn = e.submitter || $('#loginForm button');
    btn.disabled = true;
    $('#loginErr').textContent = '';
    try {
      const { token, role } = await api('/api/login', { method: 'POST', body: { password: $('#pw').value } });
      S.token = token; S.role = role;
      store('mp_session', { token, role });
      app.className = 'app';
      render();
    } catch (err) {
      $('#loginErr').textContent = err.message;
      btn.disabled = false;
    }
  };
}

/* ================= Data ================= */

async function ensureData(force = false) {
  if (S.loaded && !force && !S.stale) return;
  if (!S.loaded || force) {
    const d = await api('/api/data?action=bootstrap');
    S.jobs = d.jobs; S.vendors = d.vendors; S.orders = d.orders; S.role = d.role; S.nonJob = d.nonJob || [];
  } else {
    const d = await api('/api/data?action=orders');
    S.orders = d.orders;
  }
  S.loaded = true; S.stale = false;
}

const vendorById = (id) => S.vendors.find((v) => v.id === id);
const vno = (v) => (v && v.vendorNo ? String(v.vendorNo).padStart(2, '0') : '');
const vendorLabel = (v) => (vno(v) ? `${vno(v)} · ${v.name}` : v.name);
const poJobCode = (n) => String(n || '').replace(/\s+/g, '').toUpperCase();
function poDateToday() {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', year: '2-digit', month: '2-digit', day: '2-digit' }).formatToParts(new Date()).map((x) => [x.type, x.value]));
  return `${p.month}${p.day}${p.year}`;
}

/* ================= Router ================= */

function nav() {
  const hash = location.hash || '#/';
  const sel = (yes) => `aria-selected="${yes ? 'true' : 'false'}"`;
  const onOrders = hash === '#/' || hash === '#' || /^#\/(order|edit|receive)/.test(hash);
  $('#topnav').innerHTML = `
    <a role="tab" href="#/" ${sel(onOrders)}>Orders</a>
    <a role="tab" href="#/vendors" ${sel(hash.startsWith('#/vendors'))}>Vendors</a>
    ${isAdmin() ? `<a role="tab" href="#/new" class="tab-new" ${sel(hash.startsWith('#/new'))}>+ New Order</a>` : ''}`;
  $('#who').innerHTML = `${isAdmin() ? 'Admin' : 'View only'} · <button type="button" class="linkbtn" id="signOutBtn">Sign out</button>`;
  $('#signOutBtn').onclick = signOut;
}

async function render() {
  if (!S.token) return renderLogin();
  document.getElementById('topbar').hidden = false;
  document.getElementById('tabbar').hidden = false;
  app.className = 'app';
  nav();
  const parts = (location.hash || '#/').replace(/^#\/?/, '').split('/');
  window.scrollTo(0, 0);
  try {
    if (!S.loaded) app.innerHTML = loadingHTML();
    await ensureData();
    nav();
    const [route, id, sub] = parts;
    if (!route) return renderList();
    if (route === 'order' && id) return await renderOrder(id);
    if (route === 'new') return guard() && renderOrderForm(null);
    if (route === 'edit' && id) return guard() && (await renderOrderForm(id));
    if (route === 'receive' && id) return guard() && (await renderReceive(id, sub || null));
    if (route === 'vendors') return renderVendors();
    location.hash = '#/';
  } catch (err) {
    app.innerHTML = `<div class="card"><div class="card-body"><h2>Something went wrong</h2><p class="muted">${esc(err.message)}</p><button class="btn" onclick="location.reload()">Reload</button></div></div>`;
  }
}

function guard() {
  if (isAdmin()) return true;
  app.innerHTML = `<div class="card"><div class="card-body"><h2>View-only access</h2><p class="muted">Sign in with the admin password to make changes.</p><a class="btn" href="#/">Back to orders</a></div></div>`;
  return false;
}

window.addEventListener('hashchange', render);

/* ================= Order list / search ================= */

const STATUS_FILTERS = {
  active: (o) => o.status === 'Open' || o.status === 'Partial',
  Open: (o) => o.status === 'Open',
  Partial: (o) => o.status === 'Partial',
  Received: (o) => o.status === 'Received',
  Cancelled: (o) => o.status === 'Cancelled',
  all: () => true,
};

function filteredOrders() {
  const f = S.filters;
  const terms = f.q.toLowerCase().split(/\s+/).filter(Boolean);
  return S.orders
    .filter(STATUS_FILTERS[f.status] || STATUS_FILTERS.all)
    .filter((o) => !f.job || (o.jobId ? o.jobId === f.job : `name:${o.jobName}` === f.job))
    .filter((o) => !f.vendor || o.vendorId === f.vendor)
    .filter((o) => {
      if (!terms.length) return true;
      const hay = [o.ref, o.po, o.vendorOrderNo, o.jobName, o.jobNumber, o.vendorName, o.orderedBy].join(' ').toLowerCase();
      return terms.every((t) => hay.includes(t));
    })
    .sort((a, b) => (b.orderDate || '').localeCompare(a.orderDate || '') || b.ref.localeCompare(a.ref));
}

function renderList() {
  const counts = { active: 0, Partial: 0, Received: 0, all: S.orders.length };
  S.orders.forEach((o) => { if (STATUS_FILTERS.active(o)) counts.active++; if (o.status === 'Partial') counts.Partial++; if (o.status === 'Received') counts.Received++; });

  // jobs that appear on orders (plus active jobs) for the filter
  const jobOpts = new Map();
  S.orders.forEach((o) => { const k = o.jobId || `name:${o.jobName}`; if (o.jobName && !jobOpts.has(k)) jobOpts.set(k, orderJobLabel(o)); });
  const vendorOpts = S.vendors.filter((v) => S.orders.some((o) => o.vendorId === v.id));

  const f = S.filters;
  app.innerHTML = `
    <div class="page-head">
      <div class="grow"><h1>Orders</h1><div class="sub">Search by job, vendor, PO # or order #.</div></div>
      ${isAdmin() ? '<div class="actions"><a class="btn primary" href="#/new">+ New Order</a></div>' : ''}
    </div>
    <div class="stats">
      ${[['active', 'Open orders'], ['Partial', 'Partially received'], ['Received', 'Fully received'], ['all', 'All orders']]
        .map(([k, label]) => `<button class="stat ${f.status === k ? 'on' : ''}" data-status="${k}"><b>${counts[k]}</b><span>${label}</span></button>`).join('')}
    </div>
    <div class="card">
      <div class="filters">
        <div class="search"><input id="q" type="search" placeholder="Search PO #, order #, job, vendor…" value="${esc(f.q)}" autocomplete="off"></div>
        <select id="fJob"><option value="">All jobs</option>${[...jobOpts].sort((a, b) => a[1].localeCompare(b[1])).map(([k, l]) => `<option value="${esc(k)}" ${f.job === k ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>
        <select id="fVendor"><option value="">All vendors</option>${vendorOpts.map((v) => `<option value="${v.id}" ${f.vendor === v.id ? 'selected' : ''}>${esc(v.name)}</option>`).join('')}</select>
        <select id="fStatus">
          ${[['active', 'Open + Partial'], ['Open', 'Open'], ['Partial', 'Partial'], ['Received', 'Received'], ['Cancelled', 'Cancelled'], ['all', 'All statuses']]
            .map(([k, l]) => `<option value="${k}" ${f.status === k ? 'selected' : ''}>${l}</option>`).join('')}
        </select>
      </div>
      <div class="list-head"><div>Order</div><div>Job</div><div>Vendor</div><div>Status</div><div>Received</div><div class="right">Total</div></div>
      <div id="orderList"></div>
    </div>`;

  const drawList = () => {
    const rows = filteredOrders();
    $('#orderList').innerHTML = rows.length
      ? rows.map((o) => {
          const pct = o.qtyOrdered > 0 ? Math.min(100, (o.qtyDelivered / o.qtyOrdered) * 100) : 0;
          const sec = [
            o.po && o.po !== o.ref ? `PO ${o.po}` : '',
            o.vendorOrderNo && o.vendorOrderNo !== o.ref ? `Order ${o.vendorOrderNo}` : '',
            fdate(o.orderDate),
          ].filter(Boolean).join(' · ');
          return `<a class="order-row" href="#/order/${o.id}">
            <div class="cell c-ref"><div class="ref">${esc(o.ref || '(no number)')}</div><div class="sub">${esc(sec)}</div></div>
            <div class="cell c-job"><div>${esc(orderJobLabel(o) || '—')}</div></div>
            <div class="cell c-vendor"><div>${esc(o.vendorName || '—')}</div></div>
            <div class="cell c-status"><span class="pill ${esc(o.status)}">${esc(o.status)}</span></div>
            <div class="cell c-prog"><div class="small muted">${qty(o.qtyDelivered)} of ${qty(o.qtyOrdered)}</div><div class="meter"><i style="width:${pct}%"></i></div></div>
            <div class="cell c-total right"><b>${money(o.total)}</b></div>
          </a>`;
        }).join('')
      : `<div class="empty">${S.orders.length ? 'No orders match these filters.' : isAdmin() ? 'No orders yet. <a href="#/new">Create the first one</a>.' : 'No orders yet.'}</div>`;
  };
  drawList();

  $('#q').oninput = (e) => { f.q = e.target.value; drawList(); };
  $('#fJob').onchange = (e) => { f.job = e.target.value; drawList(); };
  $('#fVendor').onchange = (e) => { f.vendor = e.target.value; drawList(); };
  $('#fStatus').onchange = (e) => { f.status = e.target.value; renderList(); };
  $$('.stat').forEach((b) => (b.onclick = () => { f.status = b.dataset.status; renderList(); }));
}

/* ================= Order detail ================= */

async function fetchOrder(id) {
  return api(`/api/data?action=order&id=${encodeURIComponent(id)}`);
}

async function renderOrder(id) {
  app.innerHTML = loadingHTML();
  const { order: o, lines, deliveries } = await fetchOrder(id);
  const pct = o.qtyOrdered > 0 ? Math.min(100, (o.qtyDelivered / o.qtyOrdered) * 100) : 0;
  const lineDesc = Object.fromEntries(lines.map((l) => [l.id, l]));

  app.innerHTML = `
    <a class="back" href="#/">← All orders</a>
    <div class="page-head">
      <div class="grow">
        <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap"><h1>${esc(o.ref || '(no number)')}</h1><span class="pill ${esc(o.status)}">${esc(o.status)}</span></div>
        <div class="sub">${esc(o.vendorName)} · ${esc(orderJobLabel(o))}</div>
      </div>
      ${isAdmin() ? `<div class="actions">
        <a class="btn" href="#/edit/${o.id}">Edit order</a>
        ${o.status !== 'Cancelled' ? `<a class="btn primary" href="#/receive/${o.id}">Receive delivery</a>` : ''}
      </div>` : ''}
    </div>

    <div class="card"><div class="card-body">
      <div class="facts">
        <div class="fact"><span>Vendor</span><div>${esc(o.vendorName || '—')}</div></div>
        <div class="fact"><span>Job</span><div>${esc(orderJobLabel(o) || '—')}</div></div>
        <div class="fact"><span>PO #</span><div class="mono">${esc(o.po || '—')}</div></div>
        <div class="fact"><span>Vendor order #</span><div class="mono">${esc(o.vendorOrderNo || '—')}</div></div>
        <div class="fact"><span>Order date</span><div>${esc(fdate(o.orderDate) || '—')}</div></div>
        <div class="fact"><span>Requested delivery</span><div>${esc(fdate(o.requested) || '—')}</div></div>
        <div class="fact"><span>Ordered by</span><div>${esc(o.orderedBy || '—')}</div></div>
        <div class="fact"><span>Last delivery</span><div>${esc(fdate(o.lastDelivery) || '—')}</div></div>
        ${o.deliveryNotes ? `<div class="fact wide"><span>Delivery notes</span><div class="note">${esc(o.deliveryNotes)}</div></div>` : ''}
        ${o.notes ? `<div class="fact wide"><span>Notes</span><div class="note">${esc(o.notes)}</div></div>` : ''}
      </div>
      ${o.attachments.length ? `<div class="thumbs">${o.attachments.map(thumb).join('')}</div>` : ''}
    </div></div>

    <div class="card">
      <div class="card-head">
        <h2 class="grow">Items on order</h2>
        <div class="summary">
          <div><div class="small muted">Received</div><div><b>${qty(o.qtyDelivered)}</b> <span class="muted">of ${qty(o.qtyOrdered)}</span></div><div class="meter"><i style="width:${pct}%"></i></div></div>
          <div><div class="small muted">Order total</div><div class="big">${money(o.total)}</div></div>
        </div>
      </div>
      <div class="table-wrap"><table class="stack">
        <thead><tr><th>Item</th><th>SKU / Part #</th><th>Unit</th><th class="num">Ordered</th><th class="num">Unit price</th><th class="num">Ext. price</th><th class="num">Delivered</th><th class="num">Remaining</th><th>Status</th></tr></thead>
        <tbody>${lines.length ? lines.map((l) => `<tr>
          <td class="lead"><b>${esc(l.description)}</b>${l.notes ? `<div class="small muted">${esc(l.notes)}</div>` : ''}</td>
          <td class="mono ${l.sku ? '' : 'sm-hide'}" data-label="SKU">${esc(l.sku)}</td><td class="${l.unit ? '' : 'sm-hide'}" data-label="Unit">${esc(l.unit)}</td>
          <td class="num" data-label="Ordered">${qty(l.qty)}</td><td class="num" data-label="Unit price">${money(l.price)}</td><td class="num" data-label="Ext. price">${money(l.ext)}</td>
          <td class="num" data-label="Delivered">${qty(l.delivered)}</td>
          <td class="num ${l.remaining > 0 ? 'short' : 'zero'}" data-label="Remaining">${qty(l.remaining)}</td>
          <td class="status-cell"><span class="pill ${esc(l.status)}">${esc(l.status)}</span></td></tr>`).join('')
          : `<tr><td colspan="9" class="empty">No items on this order yet.</td></tr>`}</tbody>
        ${lines.length ? `<tfoot><tr><td colspan="5" class="lead">Total</td><td class="num" data-label="Order total">${money(o.total)}</td><td class="num" data-label="Delivered">${qty(o.qtyDelivered)}</td><td class="num" data-label="Remaining">${qty(Math.max(0, o.qtyOrdered - o.qtyDelivered))}</td><td class="sm-hide"></td></tr></tfoot>` : ''}
      </table></div>
    </div>

    <div class="card">
      <div class="card-head"><h2 class="grow">Deliveries</h2><span class="muted small">${deliveries.length} recorded</span></div>
      <div>${deliveries.length ? deliveries.map((d) => `
        <div class="delivery">
          <div>
            <div class="meta"><b>${esc(fdate(d.date) || 'No date')}</b>${d.slipNo ? `<span class="mono">Slip ${esc(d.slipNo)}</span>` : ''}${d.receivedBy ? `<span class="muted">Received by ${esc(d.receivedBy)}</span>` : ''}<span class="tag ${d.method === 'Slip Scan' ? 'scan' : ''}">${esc(d.method || 'Manual')}</span></div>
            <ul>${d.lines.map((dl) => `<li><b>${qty(dl.qty)}</b> ${esc(lineDesc[dl.orderLineId]?.unit || '')} ${esc(lineDesc[dl.orderLineId]?.description || dl.item)}${dl.notes ? ` <span class="muted">— ${esc(dl.notes)}</span>` : ''}</li>`).join('') || '<li class="muted">No quantities recorded</li>'}</ul>
            ${d.notes ? `<div class="small muted" style="margin-top:6px;white-space:pre-wrap">${esc(d.notes)}</div>` : ''}
            ${d.slip.length ? `<div class="thumbs">${d.slip.map(thumb).join('')}</div>` : ''}
          </div>
          ${isAdmin() ? `<div class="actions" style="align-content:flex-start"><a class="btn sm" href="#/receive/${o.id}/${d.id}">Edit</a><button class="btn sm danger" data-del="${d.id}">Delete</button></div>` : ''}
        </div>`).join('') : '<div class="empty">No deliveries yet.</div>'}
      </div>
    </div>`;

  $$('[data-del]').forEach((b) => (b.onclick = async () => {
    if (!confirm('Delete this delivery? Quantities received will be removed from the order.')) return;
    b.disabled = true;
    try {
      await api('/api/data?action=deleteDelivery', { method: 'POST', body: { deliveryId: b.dataset.del, orderId: o.id } });
      S.stale = true;
      toast('Delivery deleted');
      renderOrder(o.id);
    } catch (err) { toast(err.message, 'error'); b.disabled = false; }
  }));
}

function thumb(a) {
  const isImg = (a.type || '').startsWith('image/');
  return `<a href="${esc(a.url)}" target="_blank" rel="noopener" title="${esc(a.filename)}">${isImg && a.thumb ? `<img src="${esc(a.thumb)}" alt="${esc(a.filename)}">` : `<span class="file" style="height:100%">${esc((a.filename || 'FILE').split('.').pop().toUpperCase())}</span>`}</a>`;
}

/* ================= Order form (new / edit) ================= */

async function renderOrderForm(id) {
  let o = { vendorId: '', jobId: '', jobName: '', jobNumber: '', po: '', vendorOrderNo: '', orderDate: today(), requested: '', orderedBy: store('mp_orderedBy') || '', deliveryNotes: '', notes: '', cancelled: false };
  let lines = [];
  let deliveriesCount = 0;
  if (id) {
    app.innerHTML = loadingHTML();
    const d = await fetchOrder(id);
    o = d.order; lines = d.lines; deliveriesCount = d.deliveries.length;
  }
  if (!lines.length) lines = [blankLine(), blankLine(), blankLine()];

  const jobList = [
    ...S.nonJob.map((c) => ({ id: '', nonJob: true, name: c.name, number: c.code, supervisor: 'Non-job', label: `${c.code} · ${c.name}` })),
    ...S.jobs.map((j) => ({ ...j, label: jobLabel(j) })),
  ];
  const currentJobLabel = o.jobName ? orderJobLabel(o) : '';

  app.innerHTML = `
    <a class="back" href="${id ? `#/order/${id}` : '#/'}">← ${id ? 'Back to order' : 'All orders'}</a>
    <div class="page-head"><div class="grow"><h1>${id ? `Edit ${esc(o.ref)}` : 'New order'}</h1></div></div>
    <form id="orderForm" autocomplete="off">
      ${!id ? `<div class="card import-card"><div class="card-body">
        <div class="import-row">
          <div class="grow"><b>Have this order as a PDF or slip?</b><div class="small muted">Upload the vendor's order confirmation or quote — or photos of a pickup / delivery slip — and the form fills itself in. Add every page first, then tap Read. You review and adjust everything before anything is saved.</div></div>
        </div>
        <div id="impPages" class="pages-wrap"></div>
        <div id="importOut"></div>
      </div></div>` : ''}
      <div class="card"><div class="card-body grid c4">
        <label class="field span-2"><span>Vendor</span>
          <div style="display:flex;gap:8px"><select id="vendor" required><option value="">Choose vendor…</option>${S.vendors.map((v) => `<option value="${v.id}" ${o.vendorId === v.id ? 'selected' : ''}>${esc(vendorLabel(v))}</option>`).join('')}</select>
          <button type="button" class="btn" id="addVendor">+ New</button></div>
        </label>
        <label class="field span-2"><span>Job</span>
          <input id="job" list="jobList" placeholder="Type job number or name…" value="${esc(currentJobLabel)}" required>
          <datalist id="jobList">${jobList.map((j) => `<option value="${esc(j.label)}">${esc(j.nonJob ? 'Non-job code' : j.supervisor || '')}</option>`).join('')}</datalist>
          <span class="hint" id="jobHint"></span>
        </label>
        <div class="field span-2 po-field"><label for="po"><span>PO #</span></label>
          <div class="po-row"><input id="po" value="${esc(o.po)}" placeholder="Optional" autocomplete="off">
            <label class="check po-toggle"><input type="checkbox" id="buildPO" ${id ? '' : 'checked'}> ${id && o.po ? 'Rebuild PO #' : 'Create PO #'}</label></div>
          <span class="hint" id="poHint"></span></div>
        <label class="field"><span>Vendor order #</span><input id="vendorOrderNo" value="${esc(o.vendorOrderNo)}" placeholder="Confirmation / order #"></label>
        <label class="field"><span>Order date</span><input type="date" id="orderDate" value="${esc(o.orderDate)}"></label>
        <label class="field"><span>Requested delivery</span><input type="date" id="requested" value="${esc(o.requested)}"></label>
        <label class="field"><span>Ordered by</span><input id="orderedBy" value="${esc(o.orderedBy)}"></label>
        <label class="field span-2"><span>Delivery notes</span><input id="deliveryNotes" value="${esc(o.deliveryNotes)}" placeholder="Site contact, gate code, drop location…"></label>
        <div class="field" style="display:flex;align-items:flex-end">${id ? `<label class="check"><input type="checkbox" id="cancelled" ${o.cancelled ? 'checked' : ''}> Order cancelled</label>` : ''}</div>
        <label class="field span-all"><span>Notes</span><textarea id="notes" rows="2">${esc(o.notes)}</textarea></label>
      </div></div>

      <div class="card">
        <div class="card-head"><h2 class="grow">Items</h2><span class="muted small" id="itemsHint">Blank rows are ignored</span></div>
        <div class="table-wrap"><table class="line-editor">
          <thead id="lineHead"></thead>
          <tbody id="lineBody"></tbody>
        </table></div>
        <div class="form-foot">
          <button type="button" class="btn" id="addLine">+ Add item</button>
          <div class="grow"></div>
          <div>Order total <b id="orderTotal" style="font-size:18px;margin-left:8px">$0.00</b></div>
        </div>
      </div>

      <div class="card"><div class="form-foot" style="border-top:0">
        ${id && !deliveriesCount ? '<button type="button" class="btn danger" id="deleteOrder">Delete order</button>' : ''}
        <div class="grow"></div>
        <a class="btn ghost" href="${id ? `#/order/${id}` : '#/'}">Cancel</a>
        <button class="btn primary" type="submit" id="saveBtn">${id ? 'Save changes' : 'Create order'}</button>
      </div></div>
    </form>`;

  const body = $('#lineBody');
  let imported = false; // true once a PDF has filled the form
  let impPicker = null; // pages picked for import (attached on save)
  let impRead = null;   // {uploadId, version}: the staged upload that was read
  let recvMode = false; // pickup / already delivered: record the delivery with the order
  const drawLines = () => {
    const allOn = lines.every((l) => l.include !== false);
    $('#lineHead').innerHTML = `<tr>${imported ? `<th class="w-inc"><input type="checkbox" id="incAll" title="Include all" ${allOn ? 'checked' : ''}></th>` : ''}<th>Description</th><th>SKU / Part #</th><th>Unit</th><th class="num">Qty</th>${recvMode ? '<th class="num">Rec\'d now</th>' : ''}<th class="num">Unit price</th><th class="num">Ext.</th><th></th></tr>`;
    if ($('#incAll')) $('#incAll').onchange = (e) => { lines.forEach((l) => (l.include = e.target.checked)); drawLines(); };
    body.innerHTML = lines.map((l, i) => `
      <tr data-i="${i}" class="${l.imported ? 'imp' : ''} ${l.include === false ? 'excluded' : ''}">
        ${imported ? `<td class="w-inc">${l.imported ? `<input type="checkbox" data-inc ${l.include !== false ? 'checked' : ''} title="Include this item">` : ''}</td>` : ''}
        <td class="w-desc"><input data-k="description" value="${esc(l.description)}" placeholder="Item description">${l.imported && l.notes ? `<div class="line-note">${esc(l.notes)}</div>` : ''}</td>
        <td class="w-sku"><input data-k="sku" value="${esc(l.sku)}"></td>
        <td class="w-unit"><input data-k="unit" value="${esc(l.unit)}" placeholder="EA"></td>
        <td class="w-num"><input data-k="qty" class="num" inputmode="decimal" value="${l.qty === '' ? '' : esc(l.qty)}"></td>
        ${recvMode ? `<td class="w-num"><input data-k="recv" class="num recv-in" inputmode="decimal" value="${esc(l.recv ?? '')}" placeholder="0"></td>` : ''}
        <td class="w-num"><input data-k="price" class="num ${l.priceMissing && parseNum(l.price) === 0 ? 'missing' : ''}" inputmode="decimal" value="${l.price === '' ? '' : esc(l.price)}"></td>
        <td class="ext">${money(parseNum(l.qty) * parseNum(l.price))}</td>
        <td>${l.delivered ? `<span class="recd" title="Can't remove: deliveries recorded">${qty(l.delivered)} rec'd</span>` : `<button type="button" class="icon-btn" data-rm="${i}" title="Remove item">×</button>`}</td>
      </tr>`).join('');
    updateTotal();
  };
  const lineTotal = () => lines.filter((l) => l.include !== false).reduce((s, l) => s + parseNum(l.qty) * parseNum(l.price), 0);
  const updateTotal = () => {
    $('#orderTotal').textContent = money(lineTotal());
    if (imported) {
      const n = lines.filter((l) => l.imported).length, on = lines.filter((l) => l.imported && l.include !== false).length;
      $('#itemsHint').textContent = `${on} of ${n} imported items included`;
    }
  };
  drawLines();

  body.addEventListener('input', (e) => {
    const tr = e.target.closest('tr'); const k = e.target.dataset.k;
    if (!tr || !k) return;
    const l = lines[+tr.dataset.i]; l[k] = e.target.value;
    if (k === 'qty' || k === 'price') { tr.querySelector('.ext').textContent = money(parseNum(l.qty) * parseNum(l.price)); updateTotal(); }
  });
  body.addEventListener('change', (e) => {
    if (!e.target.matches('[data-inc]')) return;
    const tr = e.target.closest('tr'); lines[+tr.dataset.i].include = e.target.checked;
    tr.classList.toggle('excluded', !e.target.checked);
    if ($('#incAll')) $('#incAll').checked = lines.every((l) => l.include !== false);
    updateTotal();
  });
  body.addEventListener('click', (e) => {
    const rm = e.target.closest('[data-rm]');
    if (rm) { lines.splice(+rm.dataset.rm, 1); if (!lines.length) lines.push(blankLine()); drawLines(); }
  });
  body.addEventListener('keydown', (e) => {
    // Enter in the last row adds a new row
    if (e.key === 'Enter' && e.target.tagName === 'INPUT') {
      e.preventDefault();
      const tr = e.target.closest('tr');
      if (+tr.dataset.i === lines.length - 1) { lines.push(blankLine()); drawLines(); $(`tr[data-i="${lines.length - 1}"] input`, body).focus(); }
    }
  });
  $('#addLine').onclick = () => { lines.push(blankLine()); drawLines(); $(`tr[data-i="${lines.length - 1}"] input`, body).focus(); };

  // Job match hint
  const matchJob = () => {
    const v = $('#job').value.trim();
    const j = jobList.find((x) => x.label.toLowerCase() === v.toLowerCase());
    $('#jobHint').textContent = !v ? '' : j ? (j.nonJob ? 'Non-job code — used in the PO # in place of a job number' : j.supervisor ? `Supervisor: ${j.supervisor}` : '') : (v === currentJobLabel ? '' : 'Not in your active job list — will be saved as typed.');
    return j;
  };
  $('#job').oninput = matchJob; matchJob();

  // PO builder (SOP): VV-JOB-MMDDYY, then -02, -03 … for more POs the same day
  const manualPO = o.po || '';
  let poSeq = 0;
  const poHint = async () => {
    if (!$('#buildPO')) return; // left the form
    const on = $('#buildPO').checked;
    const poIn = $('#po');
    poIn.readOnly = on;
    poIn.classList.toggle('built', on);
    const hint = $('#poHint');
    hint.className = 'hint';
    if (!on) {
      if (poIn.dataset.wasBuilt) { poIn.value = manualPO; delete poIn.dataset.wasBuilt; }
      hint.textContent = id && o.po ? '' : 'No PO # for this order — or type one the vendor gave you.';
      return;
    }
    poIn.dataset.wasBuilt = '1';
    const v = vendorById($('#vendor').value);
    const j = matchJob();
    const jobNo = j ? j.number : ($('#job').value.trim() === currentJobLabel ? o.jobNumber : '');
    if (!v) { poIn.value = ''; hint.textContent = 'Pick a vendor and job to build the PO #.'; return; }
    if (!v.vendorNo) { poIn.value = ''; hint.className = 'hint warn'; hint.textContent = `${v.name} has no Vendor # yet — add one on the Vendors page (or uncheck Create PO #).`; return; }
    if (!poJobCode(jobNo)) { poIn.value = ''; hint.textContent = $('#job').value.trim() ? 'Pick the job from the list so its job number can go in the PO #.' : 'Pick a job to build the PO #.'; return; }
    const base = `${vno(v)}-${poJobCode(jobNo)}-${poDateToday()}`;
    poIn.value = base;
    hint.textContent = `Vendor ${vno(v)} · job ${poJobCode(jobNo)} · issued today. Checking for other POs today…`;
    const mine = ++poSeq;
    try {
      const r = await api(`/api/data?action=previewPO&vendorId=${v.id}&job=${encodeURIComponent(jobNo)}${id ? `&exclude=${id}` : ''}`);
      if (mine !== poSeq || !$('#buildPO')?.checked) return;
      if (r.problem) { poIn.value = ''; hint.className = 'hint warn'; hint.textContent = r.problem; return; }
      const keep = id && o.po && (o.po === base || o.po.startsWith(`${base}-`));
      poIn.value = keep ? o.po : r.po;
      hint.textContent = poIn.value === base
        ? `Vendor ${vno(v)} · job ${poJobCode(jobNo)} · issued today. Confirmed when you save.`
        : `Another PO already exists for this vendor, job and day, so this one gets the next sequence. Confirmed when you save.`;
    } catch { if (mine === poSeq && $('#buildPO')) hint.textContent = `Vendor ${vno(v)} · job ${poJobCode(jobNo)} · issued today. Confirmed when you save.`; }
  };
  $('#vendor').onchange = poHint; $('#buildPO').onchange = poHint;
  $('#job').addEventListener('change', poHint);
  let poTimer; $('#job').addEventListener('input', () => { clearTimeout(poTimer); poTimer = setTimeout(poHint, 350); });
  poHint();

  const selectNewVendor = (v) => {
    const sel = $('#vendor');
    if (!sel.querySelector(`option[value="${v.id}"]`)) sel.insertAdjacentHTML('beforeend', `<option value="${v.id}">${esc(vendorLabel(v))}</option>`);
    sel.value = v.id; sel.classList.remove('filled'); poHint();
  };
  $('#addVendor').onclick = () => vendorModal(null, selectNewVendor);

  // ---- Import from PDF ----
  const markFilled = (sel, val) => { if (val) { $(sel).value = val; $(sel).classList.add('filled'); } };
  $('#orderForm').addEventListener('input', (e) => e.target.classList?.remove('filled', 'missing'));
  $('#orderForm').addEventListener('change', (e) => e.target.classList?.remove('filled'));

  if ($('#impPages')) {
    impPicker = pagePicker($('#impPages'), {
      emptyLabel: 'Import PDF / photos',
      readLabel: (n) => `Read ${n === 1 ? 'it' : `${n} pages`}`,
      onRead: async () => {
        if (imported && !confirm('Replace the items and details filled from the previous file?')) return;
        const out = $('#importOut');
        impPicker.busy(true);
        const version = impPicker.version;
        try {
          const { uploadId, result } = await readPages('import', impPicker.pages, '', (msg) => {
            out.innerHTML = `<div class="scan-status"><span class="spinner"></span>${esc(msg)}</div>`;
          });
          impRead = { uploadId, version };
          const names = impPicker.pages.length > 1 ? `${impPicker.pages.length} pages` : impPicker.pages[0].name;
          applyDraft(result.draft, names);
        } catch (err) {
          out.innerHTML = `<div class="callout warn" style="margin-top:12px">${esc(err.message)}</div>`;
        } finally {
          impPicker.busy(false);
        }
      },
    });
  }

  function applyDraft(d, fileName) {
    if (d.vendorId) { $('#vendor').value = d.vendorId; $('#vendor').classList.add('filled'); }
    if (d.po) { $('#buildPO').checked = false; $('#po').readOnly = false; delete $('#po').dataset.wasBuilt; markFilled('#po', d.po); }
    markFilled('#vendorOrderNo', d.vendorOrderNo);
    markFilled('#orderDate', d.orderDate);
    markFilled('#requested', d.requested);
    if (!$('#orderedBy').value.trim()) markFilled('#orderedBy', d.orderedBy);
    markFilled('#deliveryNotes', d.deliveryNotes);
    const job = d.jobId ? jobList.find((j) => j.id === d.jobId) : null;
    if (job) markFilled('#job', job.label);
    matchJob(); poHint();
    if (d.po) $('#poHint').textContent = 'PO # read from the document. Check Create PO # to build a new one instead.';

    imported = true;
    const kept = lines.filter((l) => !l.imported && String(l.description).trim()); // keep anything typed by hand
    lines = [...kept, ...d.lines.map((l) => ({ ...blankLine(), description: l.description, sku: l.sku, unit: l.unit, qty: String(l.qty), price: l.priceMissing ? '' : String(l.price), priceMissing: l.priceMissing, recv: String(l.qtyShipped ?? l.qty), notes: l.note, imported: true, include: true }))];
    recvMode = !!d.isSlip;
    if (!lines.length) lines.push(blankLine());
    drawLines();

    const sum = lines.filter((l) => l.imported).reduce((s, l) => s + parseNum(l.qty) * parseNum(l.price), 0);
    const parts = [];
    parts.push(`<div class="callout ok"><b>Read ${d.lines.length} item${d.lines.length === 1 ? '' : 's'} from ${esc(fileName)}.</b> Highlighted fields came from the ${d.isSlip ? 'slip' : 'PDF'}. Check them, uncheck any items you don't want, then <b>Create order</b>. The file will be attached ${d.isSlip ? 'to the delivery' : 'to the order'}.</div>`);
    if (d.isSlip) {
      parts.push(`<div class="callout recv-box">
        <label class="check"><input type="checkbox" id="recvToggle" checked> Already picked up / delivered — mark these items received</label>
        <div class="grid c3" id="recvFields" style="margin-top:10px">
          <label class="field"><span>Received date</span><input type="date" id="rcvDate" value="${esc(d.deliveryDate || d.orderDate || today())}"></label>
          <label class="field"><span>Slip / ticket #</span><input id="rcvSlip" value="${esc(d.slipNo || '')}"></label>
          <label class="field"><span>Received by</span><input id="rcvBy" value="${esc(store('mp_receivedBy') || '')}"></label>
        </div>
        <div class="small muted" style="margin-top:6px">Uncheck if this slip is for an order that hasn't arrived yet. "Rec'd now" quantities are what came with this slip.</div>
      </div>`);
    }
    const noPrice = d.lines.filter((l) => l.priceMissing).length;
    if (noPrice) parts.push(`<div class="callout warn"><b>${noPrice} item${noPrice === 1 ? ' has' : 's have'} no price on the ${d.isSlip ? 'slip' : 'document'}.</b> ${noPrice === 1 ? 'It' : 'They'}'ll save at $0.00 — add prices now, or later with Edit order when the invoice comes.</div>`);
    if (!d.vendorId) {
      parts.push(d.vendorFound
        ? `<div class="callout warn"><b>Vendor "${esc(d.vendorFound)}" isn't in your list.</b> <button type="button" class="btn sm" id="impAddVendor" style="margin-left:6px">Add as new vendor</button> or choose an existing one above.</div>`
        : '<div class="callout warn"><b>Couldn\'t tell which vendor this is.</b> Choose it above.</div>');
    }
    if (job) {
      parts.push(`<div class="callout ${d.jobConfidence === 'high' ? 'info' : 'warn'}"><b>Job: ${esc(job.label)}</b>${d.jobConfidence !== 'high' ? ` (${esc(d.jobConfidence)} confidence — please confirm)` : ''}${d.jobReason ? `<div class="small">${esc(d.jobReason)}</div>` : ''}</div>`);
    } else {
      parts.push(`<div class="callout warn"><b>Couldn't match a job.</b>${d.shipTo ? ` Ship-to on the PDF: ${esc(d.shipTo)}.` : ''} Choose the job above.</div>`);
    }
    if (d.subtotal != null && d.lines.length) {
      parts.push(Math.abs(sum - d.subtotal) < 0.05
        ? `<div class="callout info">Items add up to the PDF subtotal of <b>${money(d.subtotal)}</b>.</div>`
        : `<div class="callout warn"><b>Totals don't match:</b> items add up to ${money(sum)}, but the PDF subtotal is ${money(d.subtotal)}. Check quantities and prices.</div>`);
    }
    if (d.warnings.length) parts.push(`<div class="callout warn"><b>Check:</b><ul>${d.warnings.map((w) => `<li>${esc(w)}</li>`).join('')}</ul></div>`);
    $('#importOut').innerHTML = `<div style="margin-top:12px">${parts.join('')}</div>`;
    if ($('#recvToggle')) $('#recvToggle').onchange = (e) => { recvMode = e.target.checked; $('#recvFields').hidden = !recvMode; drawLines(); setSaveLabel(); };
    setSaveLabel();
    if ($('#impAddVendor')) $('#impAddVendor').onclick = () => vendorModal({ name: d.vendorFound, vendorNo: '', ...d.vendorContact, account: '', notes: '' }, (v) => { selectNewVendor(v); $('#impAddVendor')?.closest('.callout')?.remove(); });
  }

  if ($('#deleteOrder')) $('#deleteOrder').onclick = async () => {
    if (!confirm('Delete this order and all of its items? This cannot be undone.')) return;
    try { await api('/api/data?action=deleteOrder', { method: 'POST', body: { id } }); S.stale = true; toast('Order deleted'); location.hash = '#/'; }
    catch (err) { toast(err.message, 'error'); }
  };

  function setSaveLabel() { $('#saveBtn').textContent = id ? 'Save changes' : recvMode ? 'Create order & mark received' : 'Create order'; }

  $('#orderForm').onsubmit = async (e) => {
    e.preventDefault();
    const job = matchJob();
    const jobText = $('#job').value.trim();
    let jobFields;
    if (job) jobFields = { jobId: job.id || '', jobName: job.name, jobNumber: job.number };
    else if (jobText === currentJobLabel && o.jobName) jobFields = { jobId: o.jobId, jobName: o.jobName, jobNumber: o.jobNumber };
    else jobFields = { jobId: '', jobName: jobText, jobNumber: '' };

    const payload = {
      order: {
        id: id || undefined,
        vendorId: $('#vendor').value,
        ...jobFields,
        po: $('#po').value, buildPO: $('#buildPO').checked, vendorOrderNo: $('#vendorOrderNo').value,
        orderDate: $('#orderDate').value, requested: $('#requested').value,
        orderedBy: $('#orderedBy').value, deliveryNotes: $('#deliveryNotes').value, notes: $('#notes').value,
        cancelled: $('#cancelled')?.checked || false,
      },
      lines: lines.filter((l) => l.include !== false).map((l) => ({ id: l.id, description: l.description, sku: l.sku, unit: l.unit, qty: parseNum(l.qty), price: parseNum(l.price), notes: l.notes, receiveQty: recvMode ? parseNum(l.recv) : undefined })),
      receive: recvMode && !id ? { date: $('#rcvDate')?.value, slipNo: $('#rcvSlip')?.value, receivedBy: $('#rcvBy')?.value } : undefined,
    };
    if (payload.receive) {
      store('mp_receivedBy', payload.receive.receivedBy);
      if (!payload.lines.some((l) => l.receiveQty)) { if (!confirm('No "Rec\'d now" quantities are filled in. Create the order without recording a delivery?')) return; payload.receive = undefined; }
    }
    if (payload.order.buildPO && !$('#po').value.trim()) {
      if (!confirm(`A PO # can't be built: ${$('#poHint').textContent}\n\nSave this order without a PO #?`)) return;
      payload.order.buildPO = false; payload.order.po = '';
    }
    if (!payload.lines.some((l) => String(l.description || '').trim())) {
      if (!confirm('This order has no items. Save it anyway?')) return;
    }
    const pages = impPicker?.pages || [];
    const btn = $('#saveBtn'); btn.disabled = true; btn.textContent = pages.length ? 'Saving & attaching files…' : 'Saving…';
    try {
      if (pages.length) {
        payload.uploadId = impRead && impRead.version === impPicker.version
          ? impRead.uploadId
          : await uploadPages('stage', pages, '', (m) => (btn.textContent = m));
      }
      store('mp_orderedBy', payload.order.orderedBy);
      const res = await api('/api/data?action=saveOrder', { method: 'POST', body: payload });
      S.stale = true;
      if (res.uploadWarning) toast(res.uploadWarning, 'error');
      else toast([res.received ? 'Order created and marked received' : 'Order saved', res.generatedPO ? `PO # ${res.generatedPO}` : ''].filter(Boolean).join(' — '));
      location.hash = `#/order/${res.order.id}`;
    } catch (err) {
      toast(err.message, 'error'); btn.disabled = false; setSaveLabel();
    }
  };
}

function blankLine() { return { id: null, description: '', sku: '', unit: '', qty: '', price: '', recv: '', notes: '', delivered: 0, include: true, imported: false, priceMissing: false }; }

/* ================= Receive delivery (manual + slip scan) ================= */

async function renderReceive(orderId, deliveryId) {
  app.innerHTML = loadingHTML();
  const { order: o, lines, deliveries } = await fetchOrder(orderId);
  const editing = deliveryId ? deliveries.find((d) => d.id === deliveryId) : null;
  if (deliveryId && !editing) { toast('Delivery not found', 'error'); location.hash = `#/order/${orderId}`; return; }

  // Quantities already received on THIS delivery (when editing) don't count as "previously received"
  const thisQty = {}; const thisNote = {};
  (editing?.lines || []).forEach((dl) => { thisQty[dl.orderLineId] = (thisQty[dl.orderLineId] || 0) + dl.qty; if (dl.notes) thisNote[dl.orderLineId] = dl.notes; });
  const rows = lines.map((l) => {
    const prev = l.delivered - (thisQty[l.id] || 0);
    return { ...l, prev, open: l.qty - prev, recv: thisQty[l.id] ?? '', note: thisNote[l.id] || '', filled: false };
  });

  const st = { picker: null, read: null, scan: null, method: editing?.method === 'Slip Scan' ? 'Slip Scan' : 'Manual' };

  app.innerHTML = `
    <a class="back" href="#/order/${o.id}">← Back to ${esc(o.ref)}</a>
    <div class="page-head"><div class="grow"><h1>${editing ? 'Edit delivery' : 'Receive delivery'}</h1><div class="sub">${esc(o.ref)} · ${esc(o.vendorName)} · ${esc(orderJobLabel(o))}</div></div></div>
    <form id="recvForm" autocomplete="off">
      <div class="card">
        <div class="card-head"><h2 class="grow">Packing slip</h2></div>
        <div class="card-body">
          ${editing?.slip?.length ? `<div class="small muted" style="margin-bottom:8px">${editing.slip.length} file(s) already attached to this delivery. Pages added here are attached alongside them.</div>` : ''}
          <div id="slipPages" class="pages-wrap"></div>
          <div class="small muted" style="margin-top:8px">Add every page of the slip, then tap Read to fill in the slip #, date and quantities for you to check.</div>
          <div id="scanOut"></div>
        </div>
      </div>

      <div class="card"><div class="card-body grid c4">
        <label class="field"><span>Delivery date</span><input type="date" id="date" value="${esc(editing?.date || today())}" required></label>
        <label class="field"><span>Slip / ticket #</span><input id="slipNo" value="${esc(editing?.slipNo || '')}"></label>
        <label class="field"><span>Received by</span><input id="receivedBy" value="${esc(editing?.receivedBy || store('mp_receivedBy') || '')}"></label>
        <label class="field"><span>Notes</span><input id="dnotes" value="${esc(editing?.notes || '')}" placeholder="Damage, shortages, refused items…"></label>
      </div></div>

      <div class="card">
        <div class="card-head"><h2 class="grow">Quantities received</h2><button type="button" class="btn sm" id="fillAll">Fill all remaining</button><button type="button" class="btn sm ghost" id="clearAll">Clear</button></div>
        <div class="table-wrap"><table class="recv-table stack">
          <thead><tr><th>Item</th><th>Unit</th><th class="num">Ordered</th><th class="num">Prev. received</th><th class="num">Open</th><th class="num">Received now</th><th>Note</th></tr></thead>
          <tbody id="recvBody"></tbody>
        </table></div>
        <div class="form-foot">
          ${editing ? '<button type="button" class="btn danger" id="delDelivery">Delete delivery</button>' : ''}
          <div class="grow"></div>
          <a class="btn ghost" href="#/order/${o.id}">Cancel</a>
          <button class="btn primary" type="submit" id="saveRecv">${editing ? 'Save changes' : 'Save delivery'}</button>
        </div>
      </div>
    </form>`;

  const drawRows = () => {
    $('#recvBody').innerHTML = rows.length ? rows.map((r, i) => {
      const over = parseNum(r.recv) > r.open && r.recv !== '';
      return `<tr data-i="${i}" class="${over ? 'over' : ''}">
        <td class="lead"><b>${esc(r.description)}</b>${r.sku ? `<div class="small muted mono">${esc(r.sku)}</div>` : ''}</td>
        <td class="${r.unit ? '' : 'sm-hide'}" data-label="Unit">${esc(r.unit)}</td>
        <td class="num" data-label="Ordered">${qty(r.qty)}</td>
        <td class="num" data-label="Prev. received">${qty(r.prev)}</td>
        <td class="num ${r.open > 0 ? 'short' : 'zero'}" data-label="Open">${qty(r.open)}</td>
        <td class="num recv-cell" data-label="Received now"><input data-k="recv" inputmode="decimal" class="${r.filled ? 'filled' : ''}" value="${esc(r.recv)}" placeholder="0"></td>
        <td class="note-cell" data-label="Note"><input data-k="note" class="note" value="${esc(r.note)}"></td>
      </tr>`;
    }).join('') : '<tr><td colspan="7" class="empty">This order has no items. Add items to the order first.</td></tr>';
  };
  drawRows();

  $('#recvBody').addEventListener('input', (e) => {
    const tr = e.target.closest('tr'); const k = e.target.dataset.k;
    if (!tr || !k) return;
    const r = rows[+tr.dataset.i];
    r[k] = e.target.value;
    if (k === 'recv') { r.filled = false; e.target.classList.remove('filled'); tr.classList.toggle('over', r.recv !== '' && parseNum(r.recv) > r.open); }
  });
  $('#fillAll').onclick = () => { rows.forEach((r) => { if (r.open > 0) { r.recv = String(r.open); r.filled = false; } }); drawRows(); };
  $('#clearAll').onclick = () => { rows.forEach((r) => { r.recv = ''; r.filled = false; }); drawRows(); };

  // ---- Slip pages + scan ----
  st.picker = pagePicker($('#slipPages'), {
    emptyLabel: 'Add slip photo / PDF',
    readLabel: (n) => `Read slip${n > 1 ? ` (${n} pages)` : ''}`,
    onChange: () => { $('#scanOut').innerHTML = ''; },
    onRead: async () => {
      st.picker.busy(true);
      const version = st.picker.version;
      try {
        const { uploadId, result } = await readPages('scan', st.picker.pages, o.id, (msg) => {
          $('#scanOut').innerHTML = `<div class="scan-status"><span class="spinner"></span>${esc(msg)}</div>`;
        });
        st.read = { uploadId, version };
        st.scan = result.result; st.method = 'Slip Scan';
        applyScan(result.result);
      } catch (err) {
        $('#scanOut').innerHTML = `<div class="callout warn" style="margin-top:12px">${esc(err.message)}</div>`;
      } finally {
        st.picker.busy(false);
      }
    },
  });

  function applyScan(r) {
    if (r.slip_number && !$('#slipNo').value) $('#slipNo').value = r.slip_number;
    if (r.delivery_date && /^\d{4}-\d{2}-\d{2}$/.test(r.delivery_date)) $('#date').value = r.delivery_date;

    // Sum matched quantities per order line
    const byLine = {};
    const unmatched = [];
    r.items.forEach((it) => {
      if (it.orderLineId && rows.some((x) => x.id === it.orderLineId)) {
        byLine[it.orderLineId] = byLine[it.orderLineId] || { qty: 0, notes: [], low: false };
        byLine[it.orderLineId].qty += it.qty_shipped;
        if (it.note) byLine[it.orderLineId].notes.push(it.note);
        if (it.confidence === 'low') byLine[it.orderLineId].low = true;
      } else if (it.qty_shipped) unmatched.push(it);
    });
    let filled = 0;
    const lowItems = [];
    rows.forEach((row) => {
      const m = byLine[row.id];
      if (!m) return;
      row.recv = String(+m.qty.toFixed(4)); row.filled = true; filled++;
      if (m.notes.length && !row.note) row.note = m.notes.join('; ').slice(0, 280);
      if (m.low) lowItems.push(row.description);
    });
    drawRows();

    const refs = [o.po, o.vendorOrderNo].filter(Boolean).map((x) => x.replace(/\W/g, '').toLowerCase());
    const slipRef = (r.order_reference || '').replace(/\W/g, '').toLowerCase();
    const refMismatch = slipRef && refs.length && !refs.some((x) => slipRef.includes(x) || x.includes(slipRef));

    $('#scanOut').innerHTML = `
      <div style="margin-top:12px">
        <div class="callout ok"><b>Filled ${filled} of ${rows.length} line${rows.length === 1 ? '' : 's'} from the slip.</b> Highlighted quantities came from the scan — check them against the slip before saving.</div>
        ${refMismatch ? `<div class="callout warn"><b>Order number on slip:</b> ${esc(r.order_reference)} — doesn't look like this order (${esc([o.po, o.vendorOrderNo].filter(Boolean).join(' / '))}). Make sure this slip belongs here.</div>` : ''}
        ${lowItems.length ? `<div class="callout warn"><b>Low-confidence matches:</b><ul>${lowItems.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></div>` : ''}
        ${r.warnings.length ? `<div class="callout warn"><b>Check:</b><ul>${r.warnings.map((w) => `<li>${esc(w)}</li>`).join('')}</ul></div>` : ''}
        ${unmatched.length ? `<div class="callout info"><b>Items on the slip that didn't match an order line</b>
          ${unmatched.map((it, i) => `<div class="unmatched" data-u="${i}">
            <div>${esc(it.description)}${it.sku ? ` <span class="mono small">${esc(it.sku)}</span>` : ''}${it.note ? `<div class="small">${esc(it.note)}</div>` : ''}</div>
            <div class="right"><b>${qty(it.qty_shipped)}</b> ${esc(it.unit || '')}</div>
            <select><option value="">Assign to line…</option>${rows.map((x, ri) => `<option value="${ri}">${esc(x.description)}</option>`).join('')}</select>
            <button type="button" class="btn sm">Add</button>
          </div>`).join('')}
          <div class="small" style="margin-top:6px">Items not on the order can be added to the order later with "Edit order".</div>
        </div>` : ''}
      </div>`;
    $$('.unmatched').forEach((el) => {
      const it = unmatched[+el.dataset.u];
      el.querySelector('button').onclick = () => {
        const ri = el.querySelector('select').value;
        if (ri === '') return toast('Choose a line first', 'error');
        const row = rows[+ri];
        row.recv = String(parseNum(row.recv) + it.qty_shipped); row.filled = true;
        drawRows(); el.remove();
      };
    });
  }

  if ($('#delDelivery')) $('#delDelivery').onclick = async () => {
    if (!confirm('Delete this delivery? Quantities received will be removed from the order.')) return;
    try { await api('/api/data?action=deleteDelivery', { method: 'POST', body: { deliveryId, orderId: o.id } }); S.stale = true; toast('Delivery deleted'); location.hash = `#/order/${o.id}`; }
    catch (err) { toast(err.message, 'error'); }
  };

  $('#recvForm').onsubmit = async (e) => {
    e.preventDefault();
    const payloadLines = rows.filter((r) => r.recv !== '' && parseNum(r.recv) !== 0).map((r) => ({ orderLineId: r.id, item: r.description, qty: parseNum(r.recv), notes: r.note }));
    const pages = st.picker.pages;
    if (!payloadLines.length && !pages.length && !editing) return toast('Enter at least one quantity received', 'error');
    const overs = rows.filter((r) => r.recv !== '' && parseNum(r.recv) > r.open);
    if (overs.length && !confirm(`${overs.length} item(s) exceed the open quantity (over-delivery). Save anyway?`)) return;

    const btn = $('#saveRecv'); btn.disabled = true; btn.textContent = pages.length ? 'Saving & uploading slip…' : 'Saving…';
    const receivedBy = $('#receivedBy').value;
    store('mp_receivedBy', receivedBy);
    try {
      let uploadId;
      if (pages.length) {
        uploadId = st.read && st.read.version === st.picker.version
          ? st.read.uploadId
          : await uploadPages('stage', pages, '', (m) => (btn.textContent = m));
      }
      const res = await api('/api/data?action=saveDelivery', {
        method: 'POST',
        body: {
          orderId: o.id, deliveryId: deliveryId || undefined,
          date: $('#date').value, slipNo: $('#slipNo').value, receivedBy, notes: $('#dnotes').value,
          method: st.method, scanData: st.scan || undefined,
          lines: payloadLines, uploadId,
        },
      });
      S.stale = true;
      if (res.uploadWarning) toast(res.uploadWarning, 'error'); else toast('Delivery saved');
      location.hash = `#/order/${o.id}`;
    } catch (err) {
      toast(err.message, 'error'); btn.disabled = false; btn.textContent = editing ? 'Save changes' : 'Save delivery';
    }
  };
}

/* ================= Pages: pick, upload, read ================= */

/* Shrink photos so uploads are fast and under size limits. Returns {name, type, blob, url}. */
async function prepareFile(file) {
  if (file.type === 'application/pdf') {
    if (file.size > 4.9 * 1024 * 1024) throw new Error(`${file.name} is too large (max about 5 MB). Try photos of the pages instead.`);
    return { name: file.name, type: 'application/pdf', blob: file, url: '' };
  }
  if (!file.type.startsWith('image/') && !/\.(heic|heif)$/i.test(file.name || '')) throw new Error('Please choose photos or PDFs.');
  let img;
  try { img = await createImageBitmap(file, { imageOrientation: 'from-image' }); }
  catch {
    img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error("This photo format can't be read here. Try a JPG or PNG (on iPhone: Settings → Camera → Formats → Most Compatible).")); i.src = URL.createObjectURL(file); });
  }
  const max = 2200;
  const scale = Math.min(1, max / Math.max(img.width, img.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(img.width * scale); canvas.height = Math.round(img.height * scale);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  let quality = 0.85, blob;
  do { blob = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', quality)); quality -= 0.15; } while (blob.size > 3.5 * 1024 * 1024 && quality > 0.3);
  const name = (file.name || 'page').replace(/\.[^.]+$/, '') + '.jpg';
  return { name, type: 'image/jpeg', blob, url: URL.createObjectURL(blob) };
}

/**
 * A strip of page thumbnails with "+ Add page" and a Read button, so multi-page
 * documents (or several phone photos) are collected before anything is read.
 */
function pagePicker(root, { emptyLabel = 'Add photo / PDF', readLabel = (n) => `Read ${n} page${n === 1 ? '' : 's'}`, onRead, onChange } = {}) {
  const P = { pages: [], version: 0, isBusy: false };
  const draw = () => {
    const n = P.pages.length;
    root.innerHTML = `
      <div class="pages">
        ${P.pages.map((pg, i) => `<div class="page-tile">
          ${pg.url ? `<img src="${pg.url}" alt="">` : `<span class="pdf">PDF</span>`}
          <span class="pno">${i + 1}</span>
          <button type="button" class="pg-x" data-x="${i}" title="Remove page" ${P.isBusy ? 'disabled' : ''}>×</button>
          <span class="pname">${esc(pg.name)}</span>
        </div>`).join('')}
        <label class="page-add ${n ? '' : 'first'} ${P.isBusy ? 'disabled' : ''}">
          <span class="plus">+</span><span>${n ? 'Add page' : esc(emptyLabel)}</span>
          <input type="file" accept="image/*,application/pdf" multiple hidden>
        </label>
      </div>
      ${n && onRead ? `<div class="pages-actions"><button type="button" class="btn dark read-btn" ${P.isBusy ? 'disabled' : ''}>${esc(readLabel(n))}</button>
        <span class="small muted">${n === 1 ? 'More pages? Add them before reading.' : `${n} pages will be read together.`}</span></div>` : ''}`;
    root.querySelector('input[type=file]').onchange = (e) => { add([...e.target.files]); e.target.value = ''; };
    root.querySelectorAll('[data-x]').forEach((b) => (b.onclick = () => { P.pages.splice(+b.dataset.x, 1); changed(); }));
    const rb = root.querySelector('.read-btn'); if (rb) rb.onclick = () => onRead && onRead();
  };
  const changed = () => { P.version++; draw(); onChange && onChange(P); };
  async function add(files) {
    for (const f of files) {
      if (P.pages.length >= 10) { toast('Up to 10 pages at a time', 'error'); break; }
      try { P.pages.push(await prepareFile(f)); } catch (err) { toast(err.message, 'error'); }
    }
    changed();
  }
  root.addEventListener('dragover', (e) => { e.preventDefault(); root.classList.add('drag'); });
  root.addEventListener('dragleave', () => root.classList.remove('drag'));
  root.addEventListener('drop', (e) => { e.preventDefault(); root.classList.remove('drag'); if (!P.isBusy) add([...e.dataTransfer.files]); });
  P.busy = (b) => { P.isBusy = b; draw(); };
  draw();
  return P;
}

/** Stages pages on the server (one request per page). Returns the upload id. */
async function uploadPages(kind, pages, orderId, onProgress) {
  const { id } = await api('/api/ai?action=start', { method: 'POST', body: { kind, orderId } });
  for (let i = 0; i < pages.length; i++) {
    onProgress && onProgress(pages.length > 1 ? `Uploading page ${i + 1} of ${pages.length}…` : 'Uploading…');
    const res = await fetch(`/api/ai?action=file&id=${id}&name=${encodeURIComponent(pages[i].name)}`, {
      method: 'POST',
      headers: { 'content-type': pages[i].type, authorization: `Bearer ${S.token}` },
      body: pages[i].blob,
    });
    if (!res.ok) { const d = await res.json().catch(() => ({})); throw new Error(d.error || `Upload failed (${res.status})`); }
  }
  return id;
}

/** Uploads pages, starts the background read, and waits for the result. */
async function readPages(kind, pages, orderId, onProgress) {
  const uploadId = await uploadPages(kind, pages, orderId, onProgress);
  await api(`/api/ai?action=run&id=${uploadId}`, { method: 'POST', body: {} });
  const started = Date.now();
  let triedDirect = false;
  for (;;) {
    await new Promise((r) => setTimeout(r, 2000));
    const secs = Math.round((Date.now() - started) / 1000);
    const st = await api(`/api/ai?action=status&id=${uploadId}`);
    if (st.status === 'done') return { uploadId, result: st.result };
    if (st.status === 'error') throw new Error(st.error || 'Reading failed');
    // Background job never picked up (e.g. background functions unavailable): read directly instead.
    if (st.status === 'queued' && secs >= 15 && !triedDirect) {
      triedDirect = true;
      onProgress && onProgress('Reading…');
      const r = await api(`/api/ai?action=runNow&id=${uploadId}`, { method: 'POST', body: {} });
      if (r.status === 'done') return { uploadId, result: r.result };
      continue;
    }
    if (secs > 12 * 60) throw new Error('Reading is taking much longer than expected. Try again, or enter it manually.');
    const pg = pages.length > 1 ? `${pages.length} pages` : 'the document';
    onProgress && onProgress(`Reading ${pg}… ${secs}s${secs >= 20 ? ' — longer orders can take a minute or two' : ''}`);
  }
}

/* ================= Vendors ================= */

function renderVendors() {
  app.innerHTML = `
    <div class="page-head">
      <div class="grow"><h1>Vendors</h1><div class="sub">The Vendor # is the first part of every PO #. New vendors get the next number automatically.</div></div>
      ${isAdmin() ? '<div class="actions"><button class="btn primary" id="newVendor">+ New vendor</button></div>' : ''}
    </div>
    <div class="card">${S.vendors.length ? [...S.vendors].sort((a, b) => (a.vendorNo || 999) - (b.vendorNo || 999) || a.name.localeCompare(b.name)).map((v) => `
      <div class="vendor-row">
        <div class="vendor-name"><span class="vno ${v.vendorNo ? '' : 'none'}">${vno(v) || '—'}</span><div><b>${esc(v.name)}</b><div class="small muted">${esc(v.account ? `Acct ${v.account}` : v.vendorNo ? '' : 'No Vendor # — needed to build PO #s')}</div></div></div>
        <div class="hide-sm small">${esc(v.rep)}${v.phone ? `<div><a href="tel:${esc(v.phone)}">${esc(v.phone)}</a></div>` : ''}</div>
        <div class="hide-sm small">${v.email ? `<a href="mailto:${esc(v.email)}">${esc(v.email)}</a>` : ''}<div class="muted">${S.orders.filter((o) => o.vendorId === v.id).length} orders</div></div>
        <div>${isAdmin() ? `<button class="btn sm" data-edit="${v.id}">Edit</button>` : ''}</div>
      </div>`).join('') : `<div class="empty">No vendors yet.${isAdmin() ? ' Add your first one.' : ''}</div>`}
    </div>`;
  if ($('#newVendor')) $('#newVendor').onclick = () => vendorModal(null, () => renderVendors());
  $$('[data-edit]').forEach((b) => (b.onclick = () => vendorModal(vendorById(b.dataset.edit), () => renderVendors())));
}

function vendorModal(v, onSaved) {
  v = v || { name: '', vendorNo: '', rep: '', phone: '', email: '', account: '', notes: '' };
  const nextNo = Math.max(0, ...S.vendors.map((x) => x.vendorNo || 0)) + 1;
  const back = document.createElement('div');
  back.className = 'modal-back';
  back.innerHTML = `
    <form class="card modal" autocomplete="off">
      <div class="card-head"><h2 class="grow">${v.id ? 'Edit vendor' : 'New vendor'}</h2><button type="button" class="icon-btn" data-close>×</button></div>
      <div class="card-body grid c2">
        <label class="field"><span>Vendor name</span><input name="name" value="${esc(v.name)}" required></label>
        <label class="field"><span>Vendor #</span><input name="vendorNo" type="number" min="1" max="99" inputmode="numeric" value="${esc(v.vendorNo ?? '')}" placeholder="${v.id ? '' : `${String(nextNo).padStart(2, '0')} (next)`}"><span class="hint">${v.id ? 'Used in PO #s — changing it doesn\'t change existing POs.' : 'Leave blank to use the next number.'}</span></label>
        <label class="field"><span>Rep</span><input name="rep" value="${esc(v.rep)}"></label>
        <label class="field"><span>Phone</span><input name="phone" type="tel" value="${esc(v.phone)}"></label>
        <label class="field"><span>Email</span><input name="email" type="email" value="${esc(v.email)}"></label>
        <label class="field"><span>Account #</span><input name="account" value="${esc(v.account)}"></label>
        <label class="field span-2"><span>Notes</span><textarea name="notes" rows="2">${esc(v.notes)}</textarea></label>
      </div>
      <div class="form-foot"><div class="grow"></div><button type="button" class="btn ghost" data-close>Cancel</button><button class="btn primary" type="submit">Save vendor</button></div>
    </form>`;
  document.body.appendChild(back);
  const form = back.querySelector('form');
  const close = () => back.remove();
  back.addEventListener('click', (e) => { if (e.target === back || e.target.closest('[data-close]')) close(); });
  form.name.focus();
  form.onsubmit = async (e) => {
    e.preventDefault();
    const btn = form.querySelector('[type=submit]'); btn.disabled = true;
    const fd = new FormData(form);
    try {
      const { vendor } = await api('/api/data?action=saveVendor', { method: 'POST', body: { vendor: { id: v.id, name: fd.get('name'), vendorNo: fd.get('vendorNo'), rep: fd.get('rep'), phone: fd.get('phone'), email: fd.get('email'), account: fd.get('account'), notes: fd.get('notes') } } });
      const i = S.vendors.findIndex((x) => x.id === vendor.id);
      if (i >= 0) S.vendors[i] = vendor; else S.vendors.push(vendor);
      S.vendors.sort((a, b) => a.name.localeCompare(b.name));
      S.stale = true;
      toast('Vendor saved');
      close(); onSaved && onSaved(vendor);
    } catch (err) { toast(err.message, 'error'); btn.disabled = false; }
  };
}

/* ================= Boot ================= */

(function boot() {
  const s = store('mp_session');
  if (s?.token) { S.token = s.token; S.role = s.role; }
  render();
})();
