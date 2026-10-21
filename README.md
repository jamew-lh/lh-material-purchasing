# Material Purchasing Hub

Central hub for job site material orders. Search orders by job, vendor, PO # or vendor order #; see items, pricing, quantities ordered / delivered / remaining; record deliveries (with packing slip photos read automatically by AI); create and edit orders.

- **Front end:** `public/` (plain HTML/CSS/JS, no build step)
- **Back end:** Netlify Functions in `netlify/functions/` — they hold the secret keys and talk to Airtable and the Claude API
- **Data:** Airtable base **Material Purchasing** (Dispatch workspace). Jobs are read from the existing **Job Name List** base (active jobs only).

## Airtable structure

| Table | What it holds |
|---|---|
| Vendors | One row per vendor. Check **Requires PO** for vendors that need our PO number. |
| Orders | One row per order (PO). Status, totals and last delivery date calculate automatically. |
| Order Lines | Items on each order. Extended price, Qty Delivered, Qty Remaining and Line Status calculate automatically. |
| Deliveries | One row per delivery / packing slip, with the slip file attached. |
| Delivery Lines | What arrived on each delivery, linked to the order line it fills. |

> Don't rename fields or tables in the Material Purchasing base — the app looks them up by name.

## One-time setup

### 1. Airtable personal access token
1. Go to **airtable.com/create/tokens** → **Create token**.
2. Name it `Material Purchasing app`.
3. Scopes: `data.records:read` and `data.records:write`.
4. Access: add the **Material Purchasing** base and the **Job Name List** base.
5. Create and copy the token (starts with `pat…`).

### 2. Connect the GitHub repo to Netlify
1. Netlify → **Add new site → Import an existing project → GitHub** → choose this repo.
2. Leave build settings as detected (no build command; publish directory `public`; functions `netlify/functions` — all set by `netlify.toml`).
3. Deploy.

### 3. Environment variables (Netlify → Site configuration → Environment variables)

| Variable | Required | Value |
|---|---|---|
| `AIRTABLE_TOKEN` | yes | The `pat…` token from step 1 |
| `ADMIN_PASSWORD` | yes | Password for full access (create, edit, receive) |
| `VIEWER_PASSWORD` | yes | Password for view-only access |
| `SESSION_SECRET` | yes | Any long random string (40+ characters). Changing it signs everyone out. |
| `ANTHROPIC_API_KEY` | for slip scanning | Claude API key (see below). Without it, everything works except "Read slip automatically". |
| `PO_PREFIX` | optional | Defaults to `PO-` |
| `PO_START` | optional | First PO number, defaults to `1001` |
| `CLAUDE_MODEL` | optional | Defaults to `claude-sonnet-5-5` |

After adding or changing variables: **Deploys → Trigger deploy → Deploy site**.

### 4. Claude API key (packing slip scanning)
1. Go to **console.anthropic.com** and sign in or create an account (separate from a Claude.ai subscription).
2. **Billing:** add a payment method and buy a small amount of credit (e.g. $10). Each slip costs a few cents.
3. **API Keys → Create Key**, name it `Material Purchasing`, copy it (starts with `sk-ant-…`).
4. Add it in Netlify as `ANTHROPIC_API_KEY`, then redeploy.

## Using it

- **New order:** pick the vendor and job, enter the vendor's order # (and PO # if you have one), add items. For vendors marked *Requires PO*, the next PO # is assigned automatically when you save.
- **Receive delivery:** from an order, tap **Receive delivery**. Take a photo of the packing slip (or choose a PDF) and tap **Read slip automatically** — quantities, slip # and date are filled in and highlighted for you to check. Or enter quantities by hand / **Fill all remaining**. The slip file is saved with the delivery.
- **Partial shipments / backorders:** each delivery adds to *Delivered*; *Remaining* shows what's still owed.
- **Editing:** change quantities, prices or items any time. Items that already have deliveries can't be removed (set their quantity instead). Deliveries can be edited or deleted.
- **View-only users** can search and see everything but can't change anything.

## Limits worth knowing
- Slip photos are shrunk in the browser before upload; PDFs must be under ~4.4 MB.
- Slip reading must finish within Netlify's function time limit (about 30 seconds). Normally takes 10–20 seconds.
- Airtable attachment links expire after a couple of hours, so the app always fetches fresh ones when you open an order.
