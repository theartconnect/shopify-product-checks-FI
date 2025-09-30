require('dotenv').config();
const axios = require('axios');

const env = (globalThis && globalThis.process && globalThis.process.env) ? globalThis.process.env : {};

const SHOPIFY_STORE_DOMAIN = env.SHOPIFY_STORE_DOMAIN;
const SHOPIFY_ADMIN_ACCESS_TOKEN = env.SHOPIFY_ADMIN_ACCESS_TOKEN;
const SHOPIFY_API_VERSION = env.SHOPIFY_API_VERSION || '2025-07';
const SLACK_BOT_TOKEN = env.SLACK_BOT_TOKEN;
const SLACK_CHANNEL_ID = env.SLACK_CHANNEL_ID;
const SUCCESS_SLACK_CHANNEL_ID = env.SUCCESS_SLACK_CHANNEL_ID || null;
const DRY_RUN = env.DRY_RUN || 'true';
const IS_DRY_RUN = String(DRY_RUN).toLowerCase() === 'true';
const LOG_EVERY_CALL = String(env.SHOPIFY_LOG_GRAPHQL_COSTS || 'false').toLowerCase() === 'true';

const MAKE_WEBHOOK_URL = 'https://hook.eu2.make.com/tescg3fg0hnlnyst64e6wpiafuhr52fo';
const UNIT_PRICE_WEBHOOK_URL = 'https://hook.eu2.make.com/teqrpwmekmddfium11jm3ks5ahw41jkw';
const SKU_MAKE_URL = 'https://hook.eu2.make.com/1f5zs1xu49pgay2ytei5k2v2tbfw774k';

const COSMETIC_COLLECTION_HANDLE = 'cosmetic-supplies-missing-metafield';
const COSMETIC_COLLECTION_FRIENDLY = 'Cosmetic Supplies Missing Metafield';

// Metafield list values
const LABEL_NEW_PRODUCT_CHECKS = 'New Product Checks';
const LABEL_TITLE_UPDATED      = 'Title Updated';
const LABEL_PRICE_UPDATED      = 'Price Updated';
const LABEL_HSN_UPDATED        = 'HSN Updated';
const LABEL_TAX_UPDATED        = 'Tax Updated';

if (!SHOPIFY_STORE_DOMAIN || !SHOPIFY_ADMIN_ACCESS_TOKEN) {
  console.error('Missing SHOPIFY_STORE_DOMAIN or SHOPIFY_ADMIN_ACCESS_TOKEN in .env');
  if (globalThis.process && globalThis.process.exit) globalThis.process.exit(1);
}
if (!SLACK_BOT_TOKEN || !SLACK_CHANNEL_ID) {
  console.error('Missing SLACK_BOT_TOKEN or SLACK_CHANNEL_ID in .env');
  if (globalThis.process && globalThis.process.exit) globalThis.process.exit(1);
}

const SHOPIFY_GRAPHQL_URL = `https://${SHOPIFY_STORE_DOMAIN}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- API usage stats ----
const apiStats = { calls: 0, requested: 0, actual: 0, last: null };

async function shopifyGraphQL(query, variables = {}) {
  while (true) {
    try {
      const res = await axios.post(
        SHOPIFY_GRAPHQL_URL,
        { query, variables },
        {
          headers: {
            'X-Shopify-Access-Token': SHOPIFY_ADMIN_ACCESS_TOKEN,
            'Content-Type': 'application/json',
          },
          timeout: 60000,
        }
      );

      const cost = res?.data?.extensions?.cost;
      if (cost) {
        apiStats.calls += 1;
        apiStats.requested += Number(cost.requestedQueryCost || 0);
        apiStats.actual += Number(cost.actualQueryCost || 0);
        apiStats.last = cost.throttleStatus || apiStats.last;

        if (LOG_EVERY_CALL) {
          const ts = cost.throttleStatus || {};
          console.log(`[Shopify GQL] requested=${cost.requestedQueryCost} actual=${cost.actualQueryCost} avail=${ts.currentlyAvailable}/${ts.maximumAvailable} restore=${ts.restoreRate}/s`);
        }
      }

      if (res.data && res.data.errors) {
        const throttled = res.data.errors.find(e => (e.extensions || {}).code === 'THROTTLED');
        if (throttled) { await sleep(1500); continue; }
        throw new Error(JSON.stringify(res.data.errors));
      }
      return res.data.data;
    } catch (err) {
      if (err.response && err.response.status === 429) { await sleep(2000); continue; }
      throw err;
    }
  }
}

/* =========================
   Slack helpers
========================= */
async function slackPostToChannel(text, channelId) {
  const prefix = IS_DRY_RUN ? '[DRY RUN] ' : '';
  const body = `${prefix}${text}\n----------`;
  await axios.post(
    'https://slack.com/api/chat.postMessage',
    { channel: channelId, text: body },
    { headers: { Authorization: `Bearer ${SLACK_BOT_TOKEN}`, 'Content-Type': 'application/json' } }
  );
}
async function slackPostSuccess(text) {
  const channel = SUCCESS_SLACK_CHANNEL_ID || SLACK_CHANNEL_ID;
  await slackPostToChannel(text, channel);
}
async function slackPostFailure(text) {
  await slackPostToChannel(text, SLACK_CHANNEL_ID);
}

/* =========================
   GraphQL constants
========================= */
const PRODUCTS_PAGE_QUERY = `
  query ProductsPage($after: String) {
    products(first: 50, after: $after, query: "metafield:custom.product_changes:*") {
      pageInfo { hasNextPage endCursor }
      nodes {
        id
        title
        status
        vendor
        descriptionHtml
        images(first: 250) { edges { node { id altText } } }
        collections(first: 100) {
          pageInfo { hasNextPage endCursor }
          nodes { title handle }
        }
        options { name linkedMetafield { namespace key } }
        variants(first: 250) {
          pageInfo { hasNextPage endCursor }
          nodes {
            id
            title
            sku
            price
            selectedOptions { name value }
            inventoryItem { id harmonizedSystemCode countryCodeOfOrigin }
          }
        }
        metafieldChanges: metafield(namespace: "custom", key: "product_changes") { value }
        metafieldTax: metafield(namespace: "custom", key: "indian_tax_rate") { value }
        metafieldPreOrder: metafield(namespace: "custom", key: "new_pre_order_setting") { value }
        metafieldOrigin: metafield(namespace: "my_fields", key: "country_of_origin") { value }
        metafieldCosmetics: metafield(namespace: "custom", key: "cosmetic_supplies") {
          references(first: 1) {
            nodes {
              __typename
              ... on Metaobject { id }
            }
          }
        }
        metafieldMainItemConfirm: metafield(namespace: "custom", key: "main_item_confirmation_status") { value }
      }
    }
  }
`;

const VARIANTS_PAGE_QUERY = `
  query ProductVariants($id: ID!, $after: String) {
    product(id: $id) {
      title
      options { name linkedMetafield { namespace key } }
      variants(first: 250, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id
          title
          sku
          price
          selectedOptions { name value }
          inventoryItem { id harmonizedSystemCode countryCodeOfOrigin }
        }
      }
    }
  }
`;

const COLLECTIONS_PAGE_QUERY = `
  query ProductCollections($id: ID!, $after: String) {
    product(id: $id) {
      collections(first: 100, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes { title handle }
      }
    }
  }
`;

const FIND_COLLECTION_BY_HANDLE = `
  query FindCollectionByHandle($q: String!) {
    collections(first: 1, query: $q) {
      nodes { id title handle }
    }
  }
`;

const PRODUCT_VARIANTS_BY_SKU_QUERY = `
  query ProductVariantsBySku($q: String!) {
    productVariants(first: 20, query: $q) {
      nodes {
        id
        title
        sku
        price
        selectedOptions { name value }
        product {
          id
          title
          options { name linkedMetafield { namespace key } }
        }
      }
    }
  }
`;

const METAOBJECT_BY_HANDLE = `
  query MetaobjectByHandle($type: String!, $handle: String!) {
    metaobjectByHandle(handle: { type: $type, handle: $handle }) {
      id
      type
      fields { key value }
    }
  }
`;

const PRODUCT_TAX_QUERY = `
  query ProductTax($id: ID!) {
    product(id: $id) {
      metafield(namespace: "custom", key: "indian_tax_rate") { value }
    }
  }
`;

const PRODUCT_MAIN_STATUS_QUERY = `
  query ProductMainStatus($id: ID!) {
    product(id: $id) {
      id
      metafield(namespace: "custom", key: "main_item_confirmation_status") { value }
    }
  }
`;

const UPDATE_PRODUCT_STATUS = `
  mutation UpdateProductStatus($id: ID!, $status: ProductStatus!) {
    productUpdate(input: { id: $id, status: $status }) {
      product { id status }
      userErrors { field message }
    }
  }
`;

const SET_METAFIELDS = `
  mutation SetMetafields($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) {
      metafields { id }
      userErrors { field message }
    }
  }
`;

const INVENTORY_ITEM_UPDATE = `
  mutation UpdateInventoryItem($id: ID!, $input: InventoryItemInput!) {
    inventoryItemUpdate(id: $id, input: $input) {
      inventoryItem { id countryCodeOfOrigin }
      userErrors { field message }
    }
  }
`;

const LOCATIONS_QUERY = `
  query Locations($after: String) {
    locations(first: 100, after: $after) {
      pageInfo { hasNextPage endCursor }
      nodes { id }
    }
  }
`;

/* Correct signature — single 'input' object */
const INVENTORY_SET_ON_HAND = `
  mutation SetOnHand($input: InventorySetOnHandQuantitiesInput!) {
    inventorySetOnHandQuantities(input: $input) {
      userErrors { field message }
    }
  }
`;

/* Collections (for cosmetic note) */
const COLLECTION_ADD_PRODUCTS = `
  mutation CollectionAddProducts($id: ID!, $productIds: [ID!]!) {
    collectionAddProducts(id: $id, productIds: $productIds) {
      collection { id }
      userErrors { field message }
    }
  }
`;

/* NEW: publications + publish */
const PUBLICATIONS_QUERY = `
  query Publications($after: String) {
    publications(first: 100, after: $after) {
      pageInfo { hasNextPage endCursor }
      nodes { id name }
    }
  }
`;

/* Market publications (to find the MarketCatalog titled "India") */
const PUBLICATIONS_MARKETS_QUERY = `
  query MarketPubs($after: String) {
    publications(first: 50, after: $after, catalogType: MARKET) {
      nodes {
        id
        catalog {
          __typename
          ... on MarketCatalog {
            title
          }
        }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

const PUBLISHABLE_PUBLISH = `
  mutation PublishToChannel($id: ID!, $input: [PublicationInput!]!) {
    publishablePublish(id: $id, input: $input) {
      userErrors { field message }
    }
  }
`;

/* NEW: Update product image alt text */
const PRODUCT_IMAGE_UPDATE = `
  mutation ProductImageUpdate($productId: ID!, $imageId: ID!, $altText: String) {
    productImageUpdate(productId: $productId, image: { id: $imageId, altText: $altText }) {
      image { id altText }
      userErrors { field message }
    }
  }
`;

/* =========================
   Helpers
========================= */
const GLOSSARY_TERMS = [
  'g', 'gm', 'gms', 'gram', 'grams',
  'kg', 'kgs', 'kilogram', 'kilograms',
  'ml', 'millilitre', 'millilitres', 'millilizer', 'milliliter', 'milliliters',
  'l', 'ltr', 'litre', 'litres', 'liter', 'liters',
  'piece', 'pieces', 'pc', 'pcs',
  'roll', 'rolls', 'sheet', 'sheets',
  'pack', 'packs', 'pack-of', 'pack of', 'packof'
];

function parseListFromMetafield(mf) {
  if (!mf || mf.value == null) return [];
  const v = String(mf.value).trim();
  try { const parsed = JSON.parse(v); return Array.isArray(parsed) ? parsed : []; }
  catch { return []; }
}
function parseStringFromMetafield(mf) { return (!mf || mf.value == null) ? '' : String(mf.value).trim(); }
function parseTaxPercent(raw) { const m = raw ? String(raw).match(/^([0-9]+(?:\.[0-9]+)?)%/) : null; return m ? m[1] : null; }
function parseBooleanFromMetafield(mf) {
  if (!mf || mf.value == null) return null;
  const v = String(mf.value).trim().toLowerCase();
  if (v === 'true') return true;
  if (v === 'false') return false;
  return null;
}

function containsGlossaryTerm(text) {
  if (!text) return null;
  const s = String(text).toLowerCase();
  if (/\bpack(?:[- ]?of)?\b/.test(s) || /\bpackof\b/.test(s) || /\bpacks?\b/.test(s)) return 'pack';
  const SHORT_UNITS = ['g','gm','gms','kg','kgs','ml','l','ltr'];
  for (const u of SHORT_UNITS) {
    const re = new RegExp(`(?:^|\\W)(?:\\d+\\s*${u}|${u}\\s*\\d+)(?:\\W|$)`, 'i');
    if (re.test(s)) return u;
  }
  const LONG_TERMS = GLOSSARY_TERMS.filter(t => !SHORT_UNITS.includes(t));
  for (const term of LONG_TERMS) {
    const re = new RegExp(`\\b${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
    if (re.test(s)) return term;
  }
  return null;
}

function stripHtmlToText(html) {
  if (!html) return '';
  const noTags = String(html).replace(/<[^>]*>/g, ' ');
  return noTags.replace(/&nbsp;/gi, ' ').replace(/\s+/g, ' ').trim();
}

async function getAllVariants(productId, initial) {
  const nodes = [...(initial?.nodes || [])];
  let has = initial?.pageInfo?.hasNextPage;
  let cursor = initial?.pageInfo?.endCursor || null;
  while (has) {
    const data = await shopifyGraphQL(VARIANTS_PAGE_QUERY, { id: productId, after: cursor });
    const page = data.product.variants;
    nodes.push(...page.nodes);
    has = page.pageInfo.hasNextPage;
    cursor = page.pageInfo.endCursor;
  }
  return nodes;
}
async function getAllCollections(productId, initial) {
  const nodes = [...(initial?.nodes || [])];
  let has = initial?.pageInfo?.hasNextPage;
  let cursor = initial?.pageInfo?.endCursor || null;
  while (has) {
    const data = await shopifyGraphQL(COLLECTIONS_PAGE_QUERY, { id: productId, after: cursor });
    const page = data.product.collections;
    nodes.push(...page.nodes);
    has = page.pageInfo.hasNextPage;
    cursor = page.pageInfo.endCursor;
  }
  return nodes;
}

/* NEW: images helper (simple because we already fetched up to 250 images) */
async function getAllImages(productId, initial) {
  const nodes = [...(initial?.edges?.map(e => e.node) || [])];
  return nodes;
}

/* NEW: update image alt text */
async function updateProductImageAlt(productId, imageId, altText) {
  const data = await shopifyGraphQL(PRODUCT_IMAGE_UPDATE, {
    productId,
    imageId,
    altText
  });
  const errs = data?.productImageUpdate?.userErrors || [];
  if (errs.length) throw new Error(`productImageUpdate: ${JSON.stringify(errs)}`);
}

async function setProductStatusActive(productId) {
  const data = await shopifyGraphQL(UPDATE_PRODUCT_STATUS, { id: productId, status: 'ACTIVE' });
  const errs = data.productUpdate.userErrors || [];
  if (errs.length) throw new Error(`productUpdate: ${JSON.stringify(errs)}`);
}
async function setProductStatusDraft(productId) {
  const data = await shopifyGraphQL(UPDATE_PRODUCT_STATUS, { id: productId, status: 'DRAFT' });
  const errs = data.productUpdate.userErrors || [];
  if (errs.length) throw new Error(`productUpdate: ${JSON.stringify(errs)}`);
}
async function setProductChangesList(productId, newListJSON) {
  const metafields = [{
    ownerId: productId,
    namespace: 'custom',
    key: 'product_changes',
    type: 'list.single_line_text_field',
    value: newListJSON,
  }];
  const data = await shopifyGraphQL(SET_METAFIELDS, { metafields });
  const errs = data.metafieldsSet.userErrors || [];
  if (errs.length) throw new Error(`metafieldsSet: ${JSON.stringify(errs)}`);
}
async function updateInventoryItemCountry(id, countryCode) {
  const data = await shopifyGraphQL(INVENTORY_ITEM_UPDATE, { id, input: { countryCodeOfOrigin: countryCode } });
  const errs = data.inventoryItemUpdate.userErrors || [];
  if (errs.length) throw new Error(`inventoryItemUpdate: ${JSON.stringify(errs)}`);
}

async function ensureAddedToCollectionByHandle(productId, handle) {
  const data = await shopifyGraphQL(FIND_COLLECTION_BY_HANDLE, { q: `handle:${handle}` });
  const col = data.collections?.nodes?.[0];
  if (!col) return { ok: false, note: `Collection '${handle}' not found.` };
  if (IS_DRY_RUN) return { ok: true, note: `Would add to '${col.title}' (DRY RUN).` };
  const res = await shopifyGraphQL(COLLECTION_ADD_PRODUCTS, { id: col.id, productIds: [productId] });
  const errs = res.collectionAddProducts?.userErrors || [];
  if (errs.length) return { ok: false, note: `Failed to add to '${col.title}': ${errs.map(e => e.message).join('; ')}` };
  return { ok: true, note: `Added to '${col.title}'.` };
}

function variantLabel(v) {
  const parts = (v.selectedOptions || []).map(so => `${so.name}: ${so.value}`);
  return parts.join(', ') || v.id;
}

const skuExistCache = new Map();
async function skuExistsCaseInsensitive(sku) {
  const key = String(sku || '').toLowerCase();
  if (!key) return false;
  if (skuExistCache.has(key)) return skuExistCache.get(key);
  const data = await shopifyGraphQL(PRODUCT_VARIANTS_BY_SKU_QUERY, { q: `sku:"${sku}"` });
  let found = false;
  for (const v of (data.productVariants.nodes || [])) {
    if (String(v.sku || '').toLowerCase() === key) { found = true; break; }
  }
  skuExistCache.set(key, found);
  return found;
}

async function hasDuplicateSkuStorewide(sku, currentVariantId) {
  if (!sku) return false;
  const data = await shopifyGraphQL(PRODUCT_VARIANTS_BY_SKU_QUERY, { q: `sku:"${sku}"` });
  const nodes = data.productVariants?.nodes || [];
  let dup = false;
  for (const n of nodes) {
    if (String(n.sku || '').toLowerCase() === String(sku).toLowerCase() && n.id !== currentVariantId) {
      dup = true; break;
    }
  }
  return dup;
}

function expectedMainSkuParts(sku) {
  const m = String(sku || '').match(/^(.+)-(\d+)([A-Za-z]*)$/);
  if (!m) return null;
  const base = m[1];
  const digits = m[2];
  const tail = m[3] || '';
  const candidate = `${base}-0${tail}`;
  const groupKey = `${base}${tail}`.toLowerCase();
  return { base, digits: Number(digits), tail, candidate, groupKey };
}

/* Publications helpers */
async function getAllPublicationIds() {
  let after = null;
  const ids = [];
  while (true) {
    const data = await shopifyGraphQL(PUBLICATIONS_QUERY, { after });
    const page = data?.publications;
    ids.push(...(page?.nodes || []).map(n => n.id));
    if (!page?.pageInfo?.hasNextPage) break;
    after = page.pageInfo.endCursor;
  }
  return ids;
}
async function publishProductToAllPublications(productId) {
  if (IS_DRY_RUN) return;
  const pubIds = await getAllPublicationIds();
  for (const publicationId of pubIds) {
    try {
      const res = await shopifyGraphQL(PUBLISHABLE_PUBLISH, {
        id: productId,
        input: [{ publicationId }],
      });
      const errs = res?.publishablePublish?.userErrors || [];
      if (errs.length) {
        const msg = errs.map(e => e.message).join('; ');
        if (!/already/i.test(msg)) console.warn(`publishablePublish warning: ${msg}`);
      }
    } catch (e) {
      console.warn('publishablePublish error:', e?.response?.data || e.message || e);
    }
  }
}

/* Cache for India market publication */
const indiaMarketPublicationCache = { ready: false, id: null };

/* Find the Publication backing the MarketCatalog titled "India" */
async function getIndiaMarketPublicationId() {
  if (indiaMarketPublicationCache.ready) return indiaMarketPublicationCache.id;

  let after = null;
  while (true) {
    const data = await shopifyGraphQL(PUBLICATIONS_MARKETS_QUERY, { after });
    const pubs = data?.publications?.nodes || [];
    const hit = pubs.find(n => {
      const mc = n.catalog && n.catalog.__typename === 'MarketCatalog' ? n.catalog : null;
      return mc && (mc.title || '').trim().toLowerCase() === 'india';
    });
    if (hit) {
      indiaMarketPublicationCache.id = hit.id;  // publication id
      indiaMarketPublicationCache.ready = true;
      return hit.id;
    }
    const pi = data?.publications?.pageInfo;
    if (!pi?.hasNextPage) break;
    after = pi.endCursor;
  }
  indiaMarketPublicationCache.ready = true;
  indiaMarketPublicationCache.id = null;
  return null;
}

/* Publish the product to the "India" Market publication */
async function ensureProductInIndiaCatalog(productId) {
  const publicationId = await getIndiaMarketPublicationId();
  if (!publicationId) return;
  if (IS_DRY_RUN) return;
  try {
    const res = await shopifyGraphQL(PUBLISHABLE_PUBLISH, {
      id: productId,
      input: [{ publicationId }],
    });
    const errs = res?.publishablePublish?.userErrors || [];
    if (errs.length) {
      const msg = errs.map(e => e.message).join('; ');
      if (!/already/i.test(msg)) console.warn(`publishablePublish (India) warning: ${msg}`);
    }
  } catch (e) {
    console.warn('publishablePublish (India) error:', e?.response?.data || e.message || e);
  }
}

/* =========================
   Failure lines + table
========================= */
function buildFailureLines({
  hasIndianTax,
  percentStr,
  isCollectionAssigned,
  linkCheckFailed,
  isImageEmpty,
  isPreorderEmpty,
  isProductCooEmpty,
  isDescriptionEmpty,
  duplicateSkus,
  taxMismatchWithMain,
  missingMainGroups
}) {
  const lines = [];
  if (!hasIndianTax && !isCollectionAssigned) {
    lines.push('Indian tax rate is empty.');
    lines.push('Tax collection not assigned.');
  } else {
    if (!hasIndianTax) lines.push('Indian tax rate is empty.');
    if (hasIndianTax && !isCollectionAssigned) {
      lines.push(percentStr
        ? `Assign product to collection: Shopify (India | Tax Rate ${percentStr}%).`
        : 'Assign product to the appropriate Shopify (India | Tax Rate …%) collection.');
    }
  }
  if (taxMismatchWithMain) {
    lines.push('Mismatch in tax between composite and main product.');
  }
  if (linkCheckFailed) {
    lines.push('None of the variant options which require bundling are linked to the "Variant Quantities" metaobject.');
  }
  if (duplicateSkus && duplicateSkus.size) {
    lines.push(`Duplicate SKUs found: ${[...duplicateSkus].join(', ')}`);
  }
  if (Array.isArray(missingMainGroups) && missingMainGroups.length) {
    for (const g of missingMainGroups) {
      lines.push(`Main item missing for pattern '${g.groupKey}': expected '${g.expected}'.`);
    }
  }
  if (isPreorderEmpty) lines.push('Pre-order setting is empty.');
  if (isProductCooEmpty) lines.push('Country of origin metafield is empty.');
  if (isDescriptionEmpty) lines.push('Product description is empty.');
  if (isImageEmpty) lines.push('No product images.');
  return lines;
}
function formatNumbered(lines) { return lines.map((s, i) => `${i + 1}. ${s}`).join('\n'); }

function buildVariantIssueTable(rows, mfCountry) {
  if (!rows.length) return '';
  const emph = (v) => {
    const out = (v && String(v).trim()) ? String(v) : 'N/A';
    return (out === 'N/A' || out === 'No' || out === 'Fill in') ? `* ${out} *` : out;
  };
  const hdr = ['Variant', 'SKU', 'Main Item Exists', 'HS Code', 'Country of Origin (MF)'];
  const data = rows.map(r => [
    emph(r.label),
    emph(r.sku),
    emph(r.mainExists),
    emph(r.hs),
    emph(mfCountry)
  ]);
  const widths = hdr.map((h, i) => Math.max(h.length, ...data.map(d => (d[i] || '').length)));
  const sep = '   ';
  const line = (cols) => cols.map((c, i) => String(c).padEnd(widths[i])).join(sep);
  const hr = widths.map(w => '-'.repeat(w)).join(sep);
  const body = [line(hdr), hr, ...data.map(d => line(d))].join('\n');
  return '```\n' + body + '\n```';
}

/* =========================
   Caches & fetchers
========================= */
const metaobjectCache = new Map(); // handle -> fields
const productTaxCache = new Map();  // productId -> tax string
const locationIdsCache = { ready: false, ids: [] };

async function getVariantOptionsMeta(handle) {
  const key = `variant_options:${handle}`;
  if (metaobjectCache.has(key)) return metaobjectCache.get(key);
  const data = await shopifyGraphQL(METAOBJECT_BY_HANDLE, { type: 'variant_options', handle });
  const mo = data?.metaobjectByHandle;
  const fields = mo?.fields || [];
  const map = {};
  for (const f of fields) map[f.key] = f.value;
  const out = {
    variant_base_unit: map['base_unit'] || null,
    variant_reference_unit: map['reference_unit'] || null,
    variant_numeric_quantity: map['numeric_value'] || null,
  };
  metaobjectCache.set(key, out);
  return out;
}
function linkedOptionName(productNode) {
  const opt = (productNode?.options || []).find(
    o => o?.linkedMetafield?.namespace === 'custom' && o?.linkedMetafield?.key === 'variant_quantities'
  );
  return opt ? opt.name : null;
}
function selectedValueForLinkedOption(variantNode, linkedName) {
  if (!linkedName) return null;
  const hit = (variantNode?.selectedOptions || []).find(so => so.name === linkedName);
  return hit ? String(hit.value).trim() : null;
}
function handleFromOptionValue(value) {
  return String(value).trim().toLowerCase().replace(/\s+/g, '-');
}
function computeVariantTitle(productTitle, variantNode) {
  const vt = variantNode?.title ? String(variantNode.title).trim() : '';
  return vt ? `${productTitle} — ${vt}` : productTitle;
}
async function getVariantNodeByExactSku(sku) {
  const data = await shopifyGraphQL(PRODUCT_VARIANTS_BY_SKU_QUERY, { q: `sku:"${sku}"` });
  const nodes = data?.productVariants?.nodes || [];
  return nodes.find(n => String(n.sku || '').toLowerCase() === String(sku).toLowerCase()) || null;
}
async function getProductTax(productId) {
  if (productTaxCache.has(productId)) return productTaxCache.get(productId);
  const data = await shopifyGraphQL(PRODUCT_TAX_QUERY, { id: productId });
  const val = data?.product?.metafield?.value ? String(data.product.metafield.value).trim() : '';
  productTaxCache.set(productId, val);
  return val;
}
async function getAllLocationIds() {
  if (locationIdsCache.ready) return locationIdsCache.ids;
  let after = null, ids = [];
  while (true) {
    const data = await shopifyGraphQL(LOCATIONS_QUERY, { after });
    const page = data.locations;
    ids.push(...(page.nodes || []).map(n => n.id));
    if (!page.pageInfo.hasNextPage) break;
    after = page.pageInfo.endCursor;
  }
  locationIdsCache.ready = true;
  locationIdsCache.ids = ids;
  return ids;
}

/* Use single input object and set quantities per (item,location) to 0 */
async function setOnHandZeroForItems(inventoryItemIds) {
  if (IS_DRY_RUN) return;

  const locations = await getAllLocationIds();
  if (!locations.length || !inventoryItemIds.length) return;

  const pairs = [];
  for (const invId of inventoryItemIds) {
    for (const locId of locations) {
      pairs.push({ inventoryItemId: invId, locationId: locId });
    }
  }

  const CHUNK = 200;
  for (let i = 0; i < pairs.length; i += CHUNK) {
    const slice = pairs.slice(i, i + CHUNK);
    const input = {
      reason: 'correction',
      referenceDocumentUri: `gid://fi-app/AutoZero/${Date.now()}`,
      setQuantities: slice.map(p => ({
        inventoryItemId: p.inventoryItemId,
        locationId: p.locationId,
        quantity: 0,
      })),
    };
    const res = await shopifyGraphQL(INVENTORY_SET_ON_HAND, { input });
    const errs = res?.inventorySetOnHandQuantities?.userErrors || [];
    if (errs.length) {
      console.warn('inventorySetOnHandQuantities userErrors:', JSON.stringify(errs));
    }
  }
}

/* =========================
   Metafield helpers: main_item_confirmation_status
========================= */
async function getMainItemConfirmationStatus(productId) {
  const data = await shopifyGraphQL(PRODUCT_MAIN_STATUS_QUERY, { id: productId });
  const mf = data?.product?.metafield || null;
  return parseBooleanFromMetafield(mf); // null | true | false
}
async function setMainItemConfirmationStatus(productId, value /* boolean */) {
  const metafields = [{
    ownerId: productId,
    namespace: 'custom',
    key: 'main_item_confirmation_status',
    type: 'boolean',
    value: value ? 'true' : 'false',
  }];
  const data = await shopifyGraphQL(SET_METAFIELDS, { metafields });
  const errs = data?.metafieldsSet?.userErrors || [];
  if (errs.length) throw new Error(`metafieldsSet(main_item_confirmation_status): ${JSON.stringify(errs)}`);
}

/* =========================
   NEW: HSN helpers
========================= */
function getUniqueHsnFromVariants(variants = []) {
  const hsSet = new Set();
  for (const v of variants) {
    const hs = v?.inventoryItem?.harmonizedSystemCode
      ? String(v.inventoryItem.harmonizedSystemCode).trim()
      : '';
    if (hs) hsSet.add(hs);
  }
  return hsSet.size === 1 ? [...hsSet][0] : null;
}

/* =========================
   Webhook callers
========================= */
async function callMakeWebhook(payload) {
  try {
    const res = await axios.post(MAKE_WEBHOOK_URL, payload, { timeout: 30000 });
    return { ok: res.status === 200, status: res.status };
  } catch (e) {
    const status = e?.response?.status || null;
    return { ok: false, status };
  }
}
async function callUnitPriceWebhook(productId) {
  try {
    const res = await axios.post(UNIT_PRICE_WEBHOOK_URL, { store: 'FI' }, {
      headers: { store: 'FI', productid: productId },
      timeout: 30000
    });
    return { ok: res.status === 200, status: res.status };
  } catch (e) {
    const status = e?.response?.status || null;
    return { ok: false, status };
  }
}
async function callSkuArrayWebhook(payloadObject) {
  try {
    const res = await axios.post(SKU_MAKE_URL, payloadObject, {
      headers: { 'Content-Type': 'application/json' },
      timeout: 30000
    });
    return { ok: res.status === 200, status: res.status };
  } catch (e) {
    const status = e?.response?.status || null;
    return { ok: false, status };
  }
}

/* =========================
   TAX ID mapping (percentage -> Zoho tax id)
========================= */
function taxIdForPercentStr(percentStr) {
  const n = Number(percentStr);
  if (!isFinite(n)) return '';
  const key = n.toFixed(2); // normalize (e.g., "5" -> "5.00", "0.25" -> "0.25")
  const map = {
    '0.00':  '514287000000012267',
    '0.25':  '514287000014475600',
    '5.00':  '514287000000074409',
    '12.00': '514287000000074605',
    '18.00': '514287000000074413',
  };
  return map[key] || '';
}

/* =========================
   Runner
========================= */
async function run() {
  let after = null;
  let processed = 0, matchedAny = 0, passed = 0, failed = 0;

  while (true) {
    const data = await shopifyGraphQL(PRODUCTS_PAGE_QUERY, { after });
    const conn = data.products;

    for (const p of conn.nodes) {
      processed++;

      const productChanges = parseListFromMetafield(p.metafieldChanges);
      if (!productChanges.length) continue;
      matchedAny++;

      // Publish to India market publication on scan
      await ensureProductInIndiaCatalog(p.id);

      // Success/Failure message buckets for this product
      const successParts = [];
      const failureParts = [];

      // Process Title/Price/HSN/Tax updates (Make webhooks)
      try {
        if (productChanges.includes(LABEL_TITLE_UPDATED)) {
          const r = IS_DRY_RUN ? { ok: true, status: 200 } : await callMakeWebhook({ store: 'FI', title_modified: true, product_id: p.id });
          if (r.ok) {
            successParts.push('\n- Title update information sent.');
            if (!IS_DRY_RUN) {
              const newList = productChanges.filter(v => v !== LABEL_TITLE_UPDATED);
              await setProductChangesList(p.id, JSON.stringify(newList));
              productChanges.splice(0, productChanges.length, ...newList);
            }
          } else {
            failureParts.push(`\n- Title update failed${r.status ? ` (HTTP ${r.status})` : ''}.`);
          }
        }

        if (productChanges.includes(LABEL_PRICE_UPDATED)) {
          const r = IS_DRY_RUN ? { ok: true, status: 200 } : await callMakeWebhook({ store: 'FI', price_modified: true, product_id: p.id });
          if (r.ok) {
            successParts.push('\n- Price update information sent.');
            if (!IS_DRY_RUN) {
              const newList = productChanges.filter(v => v !== LABEL_PRICE_UPDATED);
              await setProductChangesList(p.id, JSON.stringify(newList));
              productChanges.splice(0, productChanges.length, ...newList);
            }
          } else {
            failureParts.push(`\n- Price update failed${r.status ? ` (HTTP ${r.status})` : ''}.`);
          }
        }

        if (productChanges.includes(LABEL_HSN_UPDATED)) {
          const hsSet = new Set();
          const vs4 = p?.variants?.nodes || [];
          for (const v of vs4) {
            const hs = v?.inventoryItem?.harmonizedSystemCode ? String(v.inventoryItem.harmonizedSystemCode).trim() : '';
            if (hs) hsSet.add(hs);
          }
          if (hsSet.size === 1) {
            const hsnValue = [...hsSet][0];
            const r = IS_DRY_RUN ? { ok: true, status: 200 } : await callMakeWebhook({ store: 'FI', hsn_modified: true, hsn_value: hsnValue, product_id: p.id });
            if (r.ok) {
              successParts.push('\n- HSN update information sent.');
              if (!IS_DRY_RUN) {
                const newList = productChanges.filter(v => v !== LABEL_HSN_UPDATED);
                await setProductChangesList(p.id, JSON.stringify(newList));
                productChanges.splice(0, productChanges.length, ...newList);
              }
            } else {
              failureParts.push(`\n- HSN update failed${r.status ? ` (HTTP ${r.status})` : ''}.`);
            }
          } else if (hsSet.size === 0) {
            failureParts.push('\n- HSN update not sent: HS code missing on all variants.');
          } else {
            failureParts.push('\n- HSN update not sent: variants have inconsistent HS codes.');
          }
        }

        if (productChanges.includes(LABEL_TAX_UPDATED)) {
          const taxRaw5 = parseStringFromMetafield(p.metafieldTax);
          let tax_percentage = '', tax_id = '';
          if (taxRaw5) {
            const m = taxRaw5.match(/^([0-9]+(?:\.[0-9]+)?)%/);
            if (m) {
              tax_percentage = m[1];
              tax_id = taxIdForPercentStr(tax_percentage); // <-- mapped from percent
            }
          }
          const r = IS_DRY_RUN ? { ok: true, status: 200 } : await callMakeWebhook({ store: 'FI', tax_modified: true, tax_percentage, tax_id, product_id: p.id });
          if (r.ok) {
            successParts.push('\n- Tax update information sent.');
            if (!IS_DRY_RUN) {
              const newList = productChanges.filter(v => v !== LABEL_TAX_UPDATED);
              await setProductChangesList(p.id, JSON.stringify(newList));
              productChanges.splice(0, productChanges.length, ...newList);
            }
          } else {
            failureParts.push(`\n- Tax update failed${r.status ? ` (HTTP ${r.status})` : ''}.`);
          }
        }
      } catch (e) {
        failureParts.push('\n- Webhook processing encountered an unexpected error.');
        console.error('Webhook block error:', e?.response?.data || e.message || e);
      }

      const hasNewProductChecks = productChanges.includes(LABEL_NEW_PRODUCT_CHECKS);

      if (!hasNewProductChecks && successParts.length === 0 && failureParts.length === 0) continue;

      // Base Slack header
      const header = `FI Store - Product "${p.title}"`;

      if (hasNewProductChecks) {
        // ---- New Product Checks
        const indianTaxRateRaw = parseStringFromMetafield(p.metafieldTax);
        const hasIndianTax = !!indianTaxRateRaw;
        const percentStr = parseTaxPercent(indianTaxRateRaw);

        const preorderSetting = parseStringFromMetafield(p.metafieldPreOrder);
        const isPreorderEmpty = !preorderSetting;

        const productCooMf = parseStringFromMetafield(p.metafieldOrigin);
        const isProductCooEmpty = !productCooMf;

        const descText = stripHtmlToText(p.descriptionHtml);
        const isDescriptionEmpty = !(descText && descText.length >= 10);

        const hasImage = (p.images && p.images.edges && p.images.edges.length > 0);
        const isImageEmpty = !hasImage;

        /* NEW: if images exist, set each image altText to the product title */
        if (hasImage) {
          try {
            const imgs = await getAllImages(p.id, p.images);
            const desiredAlt = String(p.title || '').trim();
            let changed = 0;

            for (const img of imgs) {
              const needsUpdate = (img.altText || '') !== desiredAlt;
              if (!needsUpdate) continue;

              if (IS_DRY_RUN) {
                changed += 1;
              } else {
                await updateProductImageAlt(p.id, img.id, desiredAlt);
                changed += 1;
              }
            }

            if (changed > 0) {
              successParts.push(`\n- ${IS_DRY_RUN ? 'Would set' : 'Set'} alt text on ${changed} image(s) to product name.`);
            } else {
              successParts.push('\n- Image alt text already matches product name.');
            }
          } catch (e) {
            failureParts.push('\n- Failed to update image alt text for one or more images.');
            console.warn('Alt text update error:', e?.response?.data || e.message || e);
          }
        }

        const allCollections = await getAllCollections(p.id, p.collections);
        const isCollectionAssigned = !!(percentStr && allCollections.some(c =>
          c.title && /shopify/i.test(c.title) && new RegExp(`Tax Rate\\s+${percentStr}%`, 'i').test(c.title)
        ));

        const allVariants = await getAllVariants(p.id, p.variants);

        // NEW: product-level HSN (only if unique across variants)
        const productHsn = getUniqueHsnFromVariants(allVariants);

        // Main-item classification (all patterned SKUs are -0)
        let foundPattern = false;
        let allZeroDigits = true;
        const groupMeta = new Map();
        for (const v of allVariants) {
          const parts = expectedMainSkuParts(v.sku || '');
          if (!parts) continue;
          foundPattern = true;
          if (parts.digits !== 0) allZeroDigits = false;
          const key = parts.groupKey;
          if (!groupMeta.has(key)) groupMeta.set(key, { base: parts.base, tail: parts.tail, expectedMain: parts.candidate, hasNonZero: false });
          if (parts.digits !== 0) groupMeta.get(key).hasNonZero = true;
        }
        const productIsMainItem = foundPattern && allZeroDigits;

        // Linked-metafield check (at least one unit-bearing option linked to custom.variant_quantities)
        let linkCheckFailed = false;
        const namesWithUnits = new Set();
        for (const v of allVariants) {
          for (const so of v.selectedOptions || []) {
            if (containsGlossaryTerm(so.value)) namesWithUnits.add(so.name);
          }
        }
        if (namesWithUnits.size > 0) {
          let anyLinked = false;
          for (const name of namesWithUnits) {
            const opt = (p.options || []).find(o => o.name === name);
            if (opt?.linkedMetafield?.namespace === 'custom' && opt?.linkedMetafield?.key === 'variant_quantities') {
              anyLinked = true; break;
            }
          }
          linkCheckFailed = !anyLinked;
        }

        // Cosmetic supplies: title has "cosmetic" AND vendor is "Formulators Inc"
        const titleHasCosmetic = /\bcosmetic\b/i.test(p.title || '');
        const vendorIsFormulatorsInc = String(p.vendor || '').trim().toLowerCase() === 'formulators inc';
        if (titleHasCosmetic && vendorIsFormulatorsInc) {
          const refs = p.metafieldCosmetics?.references?.nodes || [];
          if (refs.length === 0) {
            const res = await ensureAddedToCollectionByHandle(p.id, COSMETIC_COLLECTION_HANDLE);
            successParts.push(`\n- ${res.note || `Handled cosmetic supplies collection for '${COSMETIC_COLLECTION_FRIENDLY}'.`}`);
          }
        }

        // Zero stock across all locations
        const invIds = (allVariants || []).map(v => v.inventoryItem?.id).filter(Boolean);
        await setOnHandZeroForItems(invIds);

        // Per-variant validations + tax parity + SKU grouping
        const variantIssueRows = [];
        const duplicateSkus = new Set();
        let taxMismatchWithMain = false;

        const skuGroups = new Map(); // key: 'NONPATTERN' or base+tail
        const missingMainGroups = [];

        for (const v of allVariants) {
          const label = variantLabel(v);
          const sku = v.sku ? String(v.sku).trim() : '';
          const hs = v.inventoryItem?.harmonizedSystemCode ? String(v.inventoryItem.harmonizedSystemCode).trim() : '';

          if (sku) {
            const dup = await hasDuplicateSkuStorewide(sku, v.id);
            if (dup) duplicateSkus.add(sku);
          }

          let mainExists = 'N/A';
          const parts = expectedMainSkuParts(sku);

          if (parts) {
            const exists = await skuExistsCaseInsensitive(parts.candidate);
            mainExists = exists ? 'Yes' : 'No';

            const gkey = parts.groupKey;
            if (!skuGroups.has(gkey)) {
              skuGroups.set(gkey, { expectedMainSku: parts.candidate, mainNode: null, items: [], isNonPattern: false });
            }
            skuGroups.get(gkey).items.push({ variant: v, label });

            if (exists && !skuGroups.get(gkey).mainNode) {
              const mn = await getVariantNodeByExactSku(parts.candidate);
              skuGroups.get(gkey).mainNode = mn || null;
              try {
                if (mn?.product?.id) {
                  const mainTax = await getProductTax(mn.product.id);
                  if (String(mainTax) !== String(indianTaxRateRaw)) {
                    taxMismatchWithMain = true;
                  }
                }
              } catch {}
            }
          } else {
            const gkey = 'NONPATTERN';
            if (!skuGroups.has(gkey)) {
              skuGroups.set(gkey, { expectedMainSku: 'NA', mainNode: null, items: [], isNonPattern: true });
            }
            skuGroups.get(gkey).items.push({ variant: v, label });
          }

          let hasIssue = false;
          const skuCell = sku ? sku : 'Fill in';
          const hsCell = hs ? hs : 'Fill in';

          if (!hs) hasIssue = true;
          if (parts && mainExists === 'No') hasIssue = true;
          if (!sku && parts) hasIssue = true;

          if (hasIssue) {
            variantIssueRows.push({ label, sku: skuCell, hs: hsCell, mainExists });
          }
        }

        for (const [gkey, g] of skuGroups.entries()) {
          if (!g.isNonPattern && !g.mainNode) {
            missingMainGroups.push({ groupKey: gkey, expected: g.expectedMainSku });
          }
        }

        const isSkuMainItemOk = !variantIssueRows.some(r => r.mainExists === 'No' || r.sku === 'Fill in');
        const isHsOk = !variantIssueRows.some(r => r.hs === 'Fill in');

        const passesAll =
          hasIndianTax &&
          isCollectionAssigned &&
          !linkCheckFailed &&
          !isImageEmpty &&
          !isPreorderEmpty &&
          !isProductCooEmpty &&
          !isDescriptionEmpty &&
          isSkuMainItemOk &&
          isHsOk &&
          !taxMismatchWithMain &&
          !duplicateSkus.size;

        if (passesAll) {
          // Remove the New Product Checks label on success after side-effects succeed (below).
          const removeNPCLabel = async () => {
            if (!IS_DRY_RUN) {
              const newList = productChanges.filter(v => v !== LABEL_NEW_PRODUCT_CHECKS);
              await setProductChangesList(p.id, JSON.stringify(newList));
            }
          };

          if (productIsMainItem) {
            // --- MAIN ITEM path: main-only SKU webhook if status is strictly null
            const myMainStatus = parseBooleanFromMetafield(p.metafieldMainItemConfirm); // null | true | false
            if (myMainStatus === null) {
              // Build a single-item payload for the main item
              const mainVariant =
                allVariants.find(v => {
                  const parts = expectedMainSkuParts(v.sku || '');
                  return parts && parts.digits === 0;
                }) || allVariants[0];

              const linkedName = linkedOptionName(p);
              let variant_base_unit = null, variant_reference_unit = null, variant_numeric_quantity = null;
              if (linkedName) {
                const val = selectedValueForLinkedOption(mainVariant, linkedName);
                if (val) {
                  const handle = handleFromOptionValue(val);
                  const meta = await getVariantOptionsMeta(handle);
                  variant_base_unit = meta.variant_base_unit;
                  variant_reference_unit = meta.variant_reference_unit;
                  variant_numeric_quantity = meta.variant_numeric_quantity;
                }
              }

              const taxRaw = parseStringFromMetafield(p.metafieldTax);
              let tax_percentage = '', tax_id = '';
              if (taxRaw) {
                const m = taxRaw.match(/^([0-9]+(?:\.[0-9]+)?)%/);
                if (m) {
                  tax_percentage = m[1];
                  tax_id = taxIdForPercentStr(tax_percentage); // <-- mapped from percent
                }
              }

              const itemSku = String(mainVariant?.sku || '').trim();
              // Prefer the main variant's HS code; fall back to product-level unique HSN
              const mainVariantHsn = (mainVariant?.inventoryItem?.harmonizedSystemCode || '').trim();
              const hsn_value = mainVariantHsn || productHsn || null;

              const item = {
                sku: itemSku,
                is_main_item: true,
                rate: mainVariant?.price ?? null,
                variant_title: computeVariantTitle(p.title, mainVariant),
                variant_base_unit,
                variant_reference_unit,
                variant_numeric_quantity
              };

              const payload = {
                store: 'FI',
                product_id: p.id,
                tax_percentage,
                tax_id,
                hsn_value,
                items: [item],
                count: 1,
                skus: [itemSku],
                main_item_sku: itemSku || 'NA',
                main_item_only: true
              };

              if (IS_DRY_RUN) {
                successParts.push('\n- Would send main item-only SKU confirmation (main_item_only=true).');
              } else {
                const r = await callSkuArrayWebhook(payload);
                if (r.ok) {
                  successParts.push('\n- Sent main item-only SKU confirmation (main_item_only=true).');
                  try {
                    await setMainItemConfirmationStatus(p.id, true);
                    successParts.push('\n- Set main_item_confirmation_status = true on main item.');
                  } catch (e) {
                    failureParts.push('\n- Failed to set main_item_confirmation_status = true after webhook 200.');
                  }
                } else {
                  failureParts.push(`\n- Failed to send main item-only SKU confirmation (HTTP ${r.status || 'n/a'}).`);
                }
              }
            } else {
              successParts.push(`\n- main_item_confirmation_status already set (${myMainStatus}); main-only send skipped.`);
            }

            // Status handling & publish
            const prevStatus = p.status;
            if (!IS_DRY_RUN && prevStatus === 'DRAFT') {
              await setProductStatusActive(p.id);
              await publishProductToAllPublications(p.id);
              await ensureProductInIndiaCatalog(p.id);
              successParts.push('\n- Product set to ACTIVE after all checks passed.');
            } else if (prevStatus === 'ACTIVE') {
              await publishProductToAllPublications(p.id);
              successParts.push('\n- Product already ACTIVE; all checks passed.');
            } else {
              successParts.push(`\n- Checks passed; status unchanged (${prevStatus}).`);
            }

            await removeNPCLabel();
            passed++;
          } else {
            // --- COMPOSITE path
            const prevStatus = p.status;
            if (!IS_DRY_RUN && prevStatus === 'DRAFT') {
              await setProductStatusActive(p.id);
              await publishProductToAllPublications(p.id);
              await ensureProductInIndiaCatalog(p.id);
              successParts.push('\n- Product set to ACTIVE after all checks passed.');
            } else if (prevStatus === 'ACTIVE') {
              await publishProductToAllPublications(p.id);
              successParts.push('\n- Product already ACTIVE; all checks passed.');
            } else {
              successParts.push(`\n- Checks passed; status unchanged (${prevStatus}).`);
            }

            const anyOptionLinkedToVQ = (p.options || []).some(
              o => o?.linkedMetafield?.namespace === 'custom' && o?.linkedMetafield?.key === 'variant_quantities'
            );

            // Unit Price webhook (composite only)
            if (!IS_DRY_RUN) {
              if (anyOptionLinkedToVQ) {
                const up = await callUnitPriceWebhook(p.id);
                if (up.ok) {
                  successParts.push('\n- Data sent for Unit Price Update.');
                } else {
                  failureParts.push('\n- Error in sending data for Unit Price Update.');
                }
              } else {
                successParts.push('\n- Unit Price webhook skipped (no selected options linked to variant quantities metafield).');
              }
            } else {
              successParts.push('\n- Unit Price Update not sent (DRY RUN).');
            }

            // Tax breakdown for payloads
            const taxRaw = parseStringFromMetafield(p.metafieldTax);
            let tax_percentage = '', tax_id = '';
            if (taxRaw) {
              const m = taxRaw.match(/^([0-9]+(?:\.[0-9]+)?)%/);
              if (m) {
                tax_percentage = m[1];
                tax_id = taxIdForPercentStr(tax_percentage); // <-- mapped from percent
              }
            }

            // Send SKU payloads per group — ALWAYS include main item first if identified
            let allSkuGroupsOK = true;

            for (const [gkey, g] of skuGroups.entries()) {
              const items = [];

              // If there is an identified main item for this group, always include it first
              if (g.mainNode && g.mainNode.product && g.mainNode.product.id) {
                const mainProdId = g.mainNode.product.id;
                if (!IS_DRY_RUN) {
                  try {
                    const mainStatus = await getMainItemConfirmationStatus(mainProdId);
                    if (mainStatus === null) {
                      await setMainItemConfirmationStatus(mainProdId, false);
                    }
                  } catch {
                    failureParts.push(`\n- Failed to read/set main_item_confirmation_status on main item (product ${mainProdId}).`);
                  }
                }

                const node = g.mainNode;
                const productNode = node.product || {};
                const productTitle = String(productNode?.title || p.title || '').trim();
                const variant_title = computeVariantTitle(productTitle, node);
                const ln = linkedOptionName(productNode);
                let variant_base_unit = null, variant_reference_unit = null, variant_numeric_quantity = null;
                if (ln) {
                  const val = selectedValueForLinkedOption(node, ln);
                  if (val) {
                    const handle = handleFromOptionValue(val);
                    const meta = await getVariantOptionsMeta(handle);
                    variant_base_unit = meta.variant_base_unit;
                    variant_reference_unit = meta.variant_reference_unit;
                    variant_numeric_quantity = meta.variant_numeric_quantity;
                  }
                }
                const rate = node?.price ?? null;
                items.push({
                  sku: node.sku,
                  is_main_item: true,
                  rate,
                  variant_title,
                  variant_base_unit,
                  variant_reference_unit,
                  variant_numeric_quantity
                });
              }

              // Then add composite product's variants (skipping duplication of the main)
              for (const entry of g.items) {
                const v = entry.variant;
                if (!v.sku) continue;

                // Avoid duplicating a main variant that equals the g.mainNode
                if (!g.isNonPattern && g.mainNode && g.mainNode.product && g.mainNode.product.id === p.id) {
                  const partsV = expectedMainSkuParts(v.sku || '');
                  if (partsV && partsV.digits === 0) continue;
                  if (g.mainNode.sku && String(g.mainNode.sku).toLowerCase() === String(v.sku).toLowerCase()) continue;
                  if (g.mainNode.id && g.mainNode.id === v.id) continue;
                }

                const productTitle = p.title;
                const variant_title = computeVariantTitle(productTitle, v);
                const ln = linkedOptionName({ options: p.options });
                let variant_base_unit = null, variant_reference_unit = null, variant_numeric_quantity = null;
                if (ln) {
                  const val = selectedValueForLinkedOption(v, ln);
                  if (val) {
                    const handle = handleFromOptionValue(val);
                    const meta = await getVariantOptionsMeta(handle);
                    variant_base_unit = meta.variant_base_unit;
                    variant_reference_unit = meta.variant_reference_unit;
                    variant_numeric_quantity = meta.variant_numeric_quantity;
                  }
                }
                items.push({
                  sku: String(v.sku),
                  is_main_item: g.isNonPattern ? true : false,
                  rate: v?.price ?? null,
                  variant_title,
                  variant_base_unit,
                  variant_reference_unit,
                  variant_numeric_quantity
                });
              }

              const count = items.length;
              const skus = items.map(it => it.sku);
              const payload = {
                store: 'FI',
                product_id: p.id,
                tax_percentage,
                tax_id,
                hsn_value: productHsn, // unique product-level HSN if resolvable
                items,
                count,
                skus,
                main_item_sku: g.isNonPattern ? 'NA' : (g.mainNode ? g.mainNode.sku : g.expectedMainSku),
                main_item_only: false
              };

              if (IS_DRY_RUN) {
                successParts.push(`\n- Would send Zoho item confirmation for group '${gkey}' (main_item_only=false) with ${count} items (main first if present).`);
              } else {
                const r = await callSkuArrayWebhook(payload);
                if (!r.ok) {
                  allSkuGroupsOK = false;
                  failureParts.push(`\n- Error sending Zoho item confirmation for group '${gkey}'.`);
                }
              }
            }

            if (!IS_DRY_RUN) {
              if (allSkuGroupsOK) {
                successParts.push('\n- Data sent for Zoho item confirmation.');
                const newList = productChanges.filter(v => v !== LABEL_NEW_PRODUCT_CHECKS);
                await setProductChangesList(p.id, JSON.stringify(newList));
              } else {
                failureParts.push('\n- One or more Zoho item confirmation calls failed.');
              }
            } else {
              successParts.push('\n- New SKU webhook not sent (DRY RUN).');
            }

            passed++;
          }
        } else {
          // Fail path
          const lines = buildFailureLines({
            hasIndianTax,
            percentStr,
            isCollectionAssigned,
            linkCheckFailed,
            isImageEmpty,
            isPreorderEmpty,
            isProductCooEmpty,
            isDescriptionEmpty,
            duplicateSkus,
            taxMismatchWithMain,
            missingMainGroups
          });

          const allVariants2 = await getAllVariants(p.id, p.variants);
          const variantIssueRows2 = [];
          for (const v of allVariants2) {
            const label = variantLabel(v);
            const sku = v.sku ? String(v.sku).trim() : '';
            const hs = v.inventoryItem?.harmonizedSystemCode ? String(v.inventoryItem.harmonizedSystemCode).trim() : '';
            const parts = expectedMainSkuParts(sku);
            let mainExists = 'N/A';
            if (parts) {
              const exists = await skuExistsCaseInsensitive(parts.candidate);
              mainExists = exists ? 'Yes' : 'No';
            }
            let hasIssue = false;
            if (!hs) hasIssue = true;
            if (parts && mainExists === 'No') hasIssue = true;
            if (!sku && parts) hasIssue = true;
            if (hasIssue) {
              variantIssueRows2.push({ label, sku: sku || 'Fill in', hs: hs || 'Fill in', mainExists });
            }
          }

          const tableBlock = variantIssueRows2.length ? ('\n\n' + buildVariantIssueTable(variantIssueRows2, parseStringFromMetafield(p.metafieldOrigin))) : '';

          const wasActive = p.status === 'ACTIVE';
          if (!IS_DRY_RUN && p.status !== 'DRAFT') {
            await setProductStatusDraft(p.id);
          }
          const draftNote = wasActive ? `\n\nAction: Product has been set to DRAFT from ACTIVE.` : '';
          const headerFail = lines.length ? `failed checks:\n${formatNumbered(lines)}` : `failed checks:`;

          failureParts.push(`\n${headerFail}${tableBlock}${draftNote}`);
          failed++;
        }
      }

      // ---- Post Slack messages (split: successes vs failures)
      if (successParts.length) {
        await slackPostSuccess(`${header} ${successParts.join('')}`);
      }
      if (failureParts.length) {
        await slackPostFailure(`${header} ${failureParts.join('')}`);
      }
    }

    if (!conn.pageInfo.hasNextPage) break;
    after = conn.pageInfo.endCursor;
  }

  const last = apiStats.last || {};
  console.log(
    `Summary: scanned=${processed}; with_product_changes=${matchedAny}; passed=${passed}; failed=${failed}; mode=${IS_DRY_RUN ? 'DRY RUN' : 'LIVE'}`
  );
  console.log(
    `Shopify API usage: calls=${apiStats.calls}; requested_cost=${apiStats.requested}; actual_cost=${apiStats.actual}; ` +
    `last_available=${last.currentlyAvailable ?? 'n/a'}/${last.maximumAvailable ?? 'n/a'}; restore_rate=${last.restoreRate ?? 'n/a'}/s`
  );
}

run().catch(err => {
  console.error(err?.response?.data || err.message || err);
  if (globalThis.process && globalThis.process.exit) globalThis.process.exit(1);
});
