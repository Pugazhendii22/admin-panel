// French Mobiles — Admin Panel
//
// Plain JS, no build step, no framework. Deliberately unrelated to the
// Flutter project's tooling: nothing here touches pubspec.yaml or the Dart
// build, so this can be edited and opened in a browser without ever running
// `flutter` anything.
//
// Talks to BOTH Firebase projects this app actually uses — see the long
// comment at the top of firebase-config.js for how that was discovered and
// why there are two. Each has its own dedicated Web app registration (not
// copy-pasted from the Android app's config), so both are independently
// revocable/rotatable without touching the mobile app.
import { catalogFirebaseConfig, secondHandFirebaseConfig } from "./firebase-config.js";

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js";
import {
  getAuth,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  onAuthStateChanged,
  signOut,
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";
import {
  getFirestore,
  collection,
  doc,
  getDoc,
  getDocs,
  setDoc,
  where,
  addDoc,
  updateDoc,
  deleteDoc,
  deleteField,
  writeBatch,
  query,
  orderBy,
  limit,
  onSnapshot,
  serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";

// The primary project: brands/models/variants, orders, users. Everything
// this panel authenticates against and writes to.
const catalogApp = initializeApp(catalogFirebaseConfig, "catalog");
const auth = getAuth(catalogApp);
const db = getFirestore(catalogApp);

// A second, separate Firebase project — see the long comment in
// firebase-config.js for why this exists. Read-only here: writing to it
// securely would need a *second* admin sign-in scoped to this project's own
// Auth (an ID token from one Firebase project's Auth is not valid against a
// different project's Firestore rules), and nothing that was actually asked
// for — editing base price, models, variants, order status — lives here
// anyway. This is wired up purely so second-hand listings aren't invisible
// to the admin.
const secondHandApp = initializeApp(secondHandFirebaseConfig, "secondHand");

// A third connection to the SAME project as `catalog`, used only to create
// staff accounts.
//
// createUserWithEmailAndPassword signs the new user in on whatever auth
// instance it is given — so calling it on the admin's own connection would
// silently swap the admin's session for the inspector's, mid-task. A separate
// app has a separate session to throw away.
const staffApp = initializeApp(catalogFirebaseConfig, "staffMaker");
const staffAuth = getAuth(staffApp);
const secondHandDb = getFirestore(secondHandApp);

// ---------------------------------------------------------------------------
// Brand list — must match lib/models/brand_model.dart's `name` fields
// exactly (lowercased), because Sell → Brand list in the app is driven by
// that hardcoded Dart list, not by Firestore. A model written under a brand
// id that isn't one of these is still reachable through the app's search
// (which reads every brand via a collectionGroup query), just not through
// browsing by brand. The custom-id option makes that trade-off explicit
// rather than silent.
// ---------------------------------------------------------------------------
const KNOWN_BRANDS = [
  "Samsung", "Motorola", "Oppo", "Apple",
  "OnePlus", "Xiaomi", "Vivo", "Realme", "Google",
  "Asus", "BlackBerry", "Honor", "HTC", "Huawei", "Infinix", "iQOO",
  "Lava", "Lenovo", "LG", "Meizu", "Micromax", "Nokia", "Nothing",
  "Panasonic", "Poco", "Sony", "Tecno", "ZTE",
];

// Order status values — must match exactly what
// lib/models/order_status.dart's OrderStage.fromStatus() switches on.
// Anything else is read by the app as "placed" (its documented fallback for
// an unrecognised status), so a typo here wouldn't error — it would just
// silently show the wrong stage in the app.
const ORDER_STAGES = [
  { value: "placed", label: "Order placed" },
  { value: "agent_assigned", label: "Agent assigned" },
  { value: "inspection", label: "Under inspection" },
  { value: "paid", label: "Completed & paid" },
];

const el = (id) => document.getElementById(id);
const money = (n) => "₹" + (Number(n) || 0).toLocaleString("en-IN");
const escapeHtml = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));

function toast(message, kind = "info") {
  const host = el("toast-host");
  const node = document.createElement("div");
  node.className = `toast toast--${kind}`;
  node.textContent = message;
  host.appendChild(node);
  requestAnimationFrame(() => node.classList.add("toast--in"));
  setTimeout(() => {
    node.classList.remove("toast--in");
    setTimeout(() => node.remove(), 200);
  }, 4000);
}

function formatDate(ts) {
  if (!ts) return "—";
  // A Firestore Timestamp read straight from the server has .toDate(); the
  // same value pulled back out of the cache is plain JSON ({seconds, ...}),
  // because JSON.stringify drops the methods.
  const d = ts.toDate ? ts.toDate() : ts.seconds != null ? new Date(ts.seconds * 1000) : new Date(ts);
  return d.toLocaleDateString("en-IN", {
    day: "numeric", month: "short", year: "numeric",
  });
}

// ---------------------------------------------------------------------------
// Cache
//
// The catalogue is read-heavy and barely changes: opening a brand costs one
// query for its models plus one per model for its variants, so Oppo's 155
// models cost 156 reads — every reload, for data that is usually identical.
//
// So catalogue reads go through localStorage first. Writes made in this panel
// update the cached copy in place (and deletes remove it), which means the
// table stays correct after an edit without re-reading anything. Orders are
// deliberately NOT cached: that tab is a live onSnapshot listener and being
// up to the second is the whole point of it.
//
// The cache is per browser. Another admin's edits, or a change made in the
// Flutter app, will not appear until the entry expires or Refresh is pressed
// — that is the trade being made for the read savings.
// ---------------------------------------------------------------------------
const CACHE_PREFIX = "fm-admin-v1:";
const CACHE_TTL_MS = 12 * 60 * 60 * 1000;

function cacheGet(key) {
  try {
    const raw = localStorage.getItem(CACHE_PREFIX + key);
    if (!raw) return null;
    const entry = JSON.parse(raw);
    if (!entry || typeof entry.at !== "number") return null;
    if (Date.now() - entry.at > CACHE_TTL_MS) {
      localStorage.removeItem(CACHE_PREFIX + key);
      return null;
    }
    return entry.data;
  } catch {
    // Private browsing, blocked storage, or corrupt JSON. Uncached is fine.
    return null;
  }
}

function cacheSet(key, data) {
  try {
    localStorage.setItem(CACHE_PREFIX + key, JSON.stringify({ at: Date.now(), data }));
  } catch {
    // Almost always the 5MB quota. Drop everything rather than keep a
    // half-written cache that would serve some brands and not others.
    cacheClear();
  }
}

function cacheRemove(key) {
  try {
    localStorage.removeItem(CACHE_PREFIX + key);
  } catch {}
}

function cacheClear() {
  try {
    for (const k of Object.keys(localStorage)) {
      if (k.startsWith(CACHE_PREFIX)) localStorage.removeItem(k);
    }
  } catch {}
}

const modelsKey = (brandId) => `models:${brandId}`;
const variantsKey = (brandId, modelId) => `variants:${brandId}:${modelId}`;

const STORAGE_OPTIONS_KEY = "storageOptions";

// Every storage string the catalog already uses, e.g. "128GB 8GB RAM".
//
// Typed free-hand, the same configuration gets entered a dozen ways — "128GB
// 8GB", "128 GB 8GB RAM", "8/128" — and the app then shows them as different
// variants of the same phone. Offering what already exists makes the
// consistent spelling the easy one to pick.
//
// Built from variant lists that were loaded anyway and from every save, so it
// costs no extra reads: browsing the catalog is what fills it.
function knownStorageOptions() {
  const out = new Set();
  try {
    const saved = cacheGet(STORAGE_OPTIONS_KEY);
    if (Array.isArray(saved)) for (const v of saved) out.add(v);
  } catch {}
  // Anything cached this session, including models not visited before.
  try {
    for (const k of Object.keys(localStorage)) {
      if (!k.startsWith(CACHE_PREFIX + "variants:")) continue;
      const entry = JSON.parse(localStorage.getItem(k));
      const list = entry && entry.value;
      if (!Array.isArray(list)) continue;
      for (const v of list) {
        if (v && typeof v.storage === "string" && v.storage.trim()) {
          out.add(v.storage.trim());
        }
      }
    }
  } catch {}
  return [...out].sort(compareStorage);
}

// The configurations this phone actually shipped in, off its own spec sheet.
//
// `specs.internal_storage_note` holds them as one comma-separated string —
// "64GB 4GB RAM, 128GB 4GB RAM, 256GB 4GB RAM" — which is exactly the list an
// admin was otherwise retyping by hand for every model. It is already loaded
// with the model document, so reading it costs nothing.
//
// Returns [] when the field is missing or unparseable, which is common enough
// on older imports that it must stay ordinary rather than an error.
function specVariants(model) {
  const note = model?.specs?.internal_storage_note;
  if (typeof note !== "string") return [];
  const seen = new Set();
  const out = [];
  for (const part of note.split(",")) {
    const value = part.trim().replace(/\s+/g, " ");
    // Guard against a note that is prose rather than a list.
    if (!value || value.length > 40 || !/\d/.test(value)) continue;
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out.sort(compareStorage);
}

function rememberStorageOptions(values) {
  const out = new Set(knownStorageOptions());
  for (const v of values) {
    if (typeof v === "string" && v.trim()) out.add(v.trim());
  }
  cacheSet(STORAGE_OPTIONS_KEY, [...out]);
}

// Smallest first, so the list reads like a spec sheet rather than
// alphabetically, where 256GB sorts before 64GB.
function compareStorage(a, b) {
  const size = (s) => {
    const m = String(s).match(/(\d+)\s*(TB|GB)/i);
    if (!m) return Number.MAX_SAFE_INTEGER;
    return Number(m[1]) * (m[2].toUpperCase() === "TB" ? 1024 : 1);
  };
  return size(a) - size(b) || String(a).localeCompare(String(b));
}

// Re-saves the in-memory model list for the current brand. Called after any
// model write so the next load reflects the edit without a round trip.
function saveModelsCache(brandId) {
  cacheSet(modelsKey(brandId), allModels);
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------
let ordersUnsub = null;
let currentRole = null;
let inspectorUnsub = null;
let inspectors = [];

onAuthStateChanged(auth, async (user) => {
  if (!user) {
    stopOrdersListener();
    showLogin();
    return;
  }

  // Signing in with Firebase Auth only proves *who* someone is, not that
  // they're allowed to touch the catalog or orders. The real gate has to be
  // Firestore security rules (an `admins/{uid}` allowlist doc, checked
  // server-side) — see README.md. This check is a UX courtesy on top of
  // that: without it, any authenticated-but-unlisted account would still see
  // the full admin UI and only discover they can't write when a save fails.
  let isAdmin = false;
  try {
    const adminDoc = await getDoc(doc(db, "admins", user.uid));
    isAdmin = adminDoc.exists();
  } catch (e) {
    // Most likely the rules already reject a non-admin reading /admins/{uid}
    // at all, which itself implies "no". Treat any failure as "not admin"
    // rather than letting a network hiccup show the CRUD screen.
    isAdmin = false;
  }

  // Not an admin? They may still be an inspector, who gets a much smaller
  // screen: the pickups assigned to them, and nothing else.
  let isInspector = false;
  if (!isAdmin) {
    try {
      const doc_ = await getDoc(doc(db, "inspectors", user.uid));
      isInspector = doc_.exists();
    } catch (e) {
      isInspector = false;
    }
  }

  if (!isAdmin && !isInspector) {
    el("login-error").textContent =
      "This account is signed in but is not on the admin or inspector list. " +
      "Ask an admin to add it, or sign in with an admin account.";
    el("login-error").hidden = false;
    await signOut(auth);
    return;
  }

  el("login-error").hidden = true;
  el("admin-email").textContent = user.email;
  currentRole = isAdmin ? "admin" : "inspector";
  showApp();

  if (isInspector) {
    // An inspector must not see the catalog, the pricing, or other people's
    // jobs, so the admin tabs are removed from the DOM rather than hidden —
    // a hidden tab is one devtools click from visible.
    document.body.classList.add("role-inspector");
    document
      .querySelectorAll('[data-admin-only="1"]')
      .forEach((n) => n.remove());
    const panel = el("tab-inspector");
    if (panel) panel.hidden = false;
    startInspectorListener(user.uid);
    return;
  }

  loadModelsForSelectedBrand();
  startOrdersListener();
  loadSecondHandListings();
  loadInspectors();
});

el("login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const email = el("login-email").value.trim();
  const password = el("login-password").value;
  const button = el("login-submit");
  button.disabled = true;
  button.textContent = "Signing in…";
  el("login-error").hidden = true;
  try {
    await signInWithEmailAndPassword(auth, email, password);
  } catch (err) {
    el("login-error").textContent = friendlyAuthError(err);
    el("login-error").hidden = false;
  } finally {
    button.disabled = false;
    button.textContent = "Sign in";
  }
});

el("sign-out").addEventListener("click", () => signOut(auth));

// Reveal toggle. Kept as a real <button type="button"> outside the <label> so
// tapping it never re-triggers the label's focus forwarding, and so a password
// manager still sees a plain autocomplete="current-password" input.
el("pwd-toggle").addEventListener("click", () => {
  const input = el("login-password");
  const show = input.type === "password";
  input.type = show ? "text" : "password";
  el("pwd-toggle").textContent = show ? "Hide" : "Show";
  el("pwd-toggle").setAttribute("aria-label", show ? "Hide password" : "Show password");
  input.focus();
});

function friendlyAuthError(err) {
  const code = err?.code || "";
  if (code.includes("invalid-credential") || code.includes("wrong-password") || code.includes("user-not-found")) {
    return "Incorrect email or password.";
  }
  if (code.includes("too-many-requests")) {
    return "Too many attempts. Wait a moment and try again.";
  }
  return "Could not sign in: " + (err?.message || "unknown error");
}

function showLogin() {
  el("login-screen").hidden = false;
  el("app-screen").hidden = true;
}

function showApp() {
  el("login-screen").hidden = true;
  el("app-screen").hidden = false;
}

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------
document.querySelectorAll(".tab-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tab-btn").forEach((b) => b.classList.remove("tab-btn--active"));
    document.querySelectorAll(".tab-panel").forEach((p) => p.hidden = true);
    btn.classList.add("tab-btn--active");
    el(btn.dataset.tab).hidden = false;
  });
});

// ---------------------------------------------------------------------------
// Catalog — brands, models, variants
// ---------------------------------------------------------------------------
const brandSelect = el("brand-select");
KNOWN_BRANDS.forEach((name) => {
  const opt = document.createElement("option");
  opt.value = name.toLowerCase();
  opt.textContent = name;
  brandSelect.appendChild(opt);
});
const customOpt = document.createElement("option");
customOpt.value = "__custom__";
customOpt.textContent = "Other / custom brand id…";
brandSelect.appendChild(customOpt);

brandSelect.addEventListener("change", () => {
  const custom = brandSelect.value === "__custom__";
  el("custom-brand-row").hidden = !custom;
  el("custom-brand-warning").hidden = !custom;
  if (!custom) loadModelsForSelectedBrand();
});
el("custom-brand-input").addEventListener("input", () => {
  if (el("custom-brand-input").value.trim()) loadModelsForSelectedBrand();
});

function currentBrandId() {
  if (brandSelect.value === "__custom__") {
    return el("custom-brand-input").value.trim().toLowerCase();
  }
  return brandSelect.value;
}

let expandedModelId = null;

// ---------------------------------------------------------------------------
// Series
//
// Model documents carry no `series` field — the catalogue was imported with
// just `model`, `release_year`, `image_url` and `specs`. So the series is
// derived from the name, which is consistently "<Brand> <Model>":
//
//   "Oppo A17"            -> A series
//   "Oppo Reno 8"         -> Reno series
//   "Motorola Edge (2022)"-> Edge series
//   "Samsung Galaxy S21"  -> S series
//
// Deriving it means the filter works on every existing model immediately with
// no migration. The trade-off is that a name that doesn't follow the pattern
// lands in "Other" rather than being wrong quietly.
// ---------------------------------------------------------------------------

// Words that name a whole line rather than a series, so "Galaxy S21" resolves
// to S and not to Galaxy (which every Samsung would share).
const FAMILY_WORDS = new Set(["galaxy", "moto", "redmi", "poco", "mi"]);

function deriveSeries(modelName, brandId) {
  let name = String(modelName || "").trim();
  if (!name) return "Other";

  const brand = String(brandId || "").toLowerCase();
  if (brand && name.toLowerCase().startsWith(brand + " ")) {
    name = name.slice(brand.length + 1).trim();
  }

  let tokens = name.split(/\s+/).filter(Boolean);
  if (tokens.length > 1 && FAMILY_WORDS.has(tokens[0].toLowerCase())) {
    tokens = tokens.slice(1);
  }
  if (!tokens.length) return "Other";

  // "A17", "S21", "G54" -> the leading letters are the series.
  const alphanumeric = tokens[0].match(/^([A-Za-z]{1,2})\d/);
  if (alphanumeric) return alphanumeric[1].toUpperCase() + " series";

  // "Edge", "Reno", "Find", "Defy" -> the word itself is the series. The
  // generation number and any "+" are dropped so "Reno10 Pro", "Reno8",
  // "Reno15c" land in one Reno series, and "Razr+" joins Razr.
  const word = tokens[0].replace(/[^A-Za-z0-9]/g, "").replace(/\d.*$/, "");
  return word ? word + " series" : "Other";
}

// Everything loaded for the current brand, before the series filter.
let allModels = [];

function populateSeriesFilter(brandId, models) {
  const select = el("series-select");
  const previous = select.value;

  const counts = new Map();
  for (const m of models) {
    const series = deriveSeries(m.model, brandId);
    counts.set(series, (counts.get(series) || 0) + 1);
  }

  const sorted = [...counts.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  select.innerHTML =
    `<option value="">All series (${models.length})</option>` +
    sorted
      .map(([series, n]) => `<option value="${escapeHtml(series)}">${escapeHtml(series)} (${n})</option>`)
      .join("");

  // Keep the chosen series when it still exists under the new brand.
  select.value = counts.has(previous) ? previous : "";
}

// A model is hidden only when the field is explicitly true. Missing or false
// both mean visible, which is what lets hiding work without backfilling a
// flag onto all 285 existing documents.
const isHidden = (model) => model.hidden === true;

function applySeriesFilter() {
  const brandId = currentBrandId();
  const wantedSeries = el("series-select").value;
  const visibility = el("visibility-select").value;

  let models = allModels;
  if (visibility === "visible") models = models.filter((m) => !isHidden(m));
  else if (visibility === "hidden") models = models.filter(isHidden);
  if (wantedSeries) models = models.filter((m) => deriveSeries(m.model, brandId) === wantedSeries);

  const tbody = el("models-tbody");
  if (models.length === 0) {
    const what = visibility === "hidden" ? "No hidden models" : "No models";
    tbody.innerHTML = `<tr><td colspan="5" class="empty">${what}${wantedSeries ? ` in ${escapeHtml(wantedSeries)}` : ""}.</td></tr>`;
    return;
  }
  renderModelsTable(brandId, models);
}

el("series-select").addEventListener("change", applySeriesFilter);
el("visibility-select").addEventListener("change", applySeriesFilter);

// Hiding is a single-field write, so the cached copy is patched in place
// rather than dropped — the list re-renders with no reads at all.
async function toggleHidden(brandId, model) {
  const nowHidden = !isHidden(model);
  try {
    await updateDoc(doc(db, "brands", brandId, "models", model.id), { hidden: nowHidden });

    const i = allModels.findIndex((m) => m.id === model.id);
    if (i !== -1) allModels[i] = { ...allModels[i], hidden: nowHidden };
    saveModelsCache(brandId);

    toast(
      nowHidden
        ? `"${model.model}" is now hidden from the app`
        : `"${model.model}" is visible in the app again`,
      "success"
    );
    applySeriesFilter();
  } catch (err) {
    toast("Could not change visibility: " + err.message, "error");
  }
}

async function loadModelsForSelectedBrand({ force = false } = {}) {
  const brandId = currentBrandId();
  const tbody = el("models-tbody");
  if (!brandId) {
    tbody.innerHTML = `<tr><td colspan="5" class="empty">Enter a brand id above.</td></tr>`;
    return;
  }
  expandedModelId = null;

  const show = (models) => {
    allModels = models;
    populateSeriesFilter(brandId, models);
    if (models.length === 0) {
      tbody.innerHTML = `<tr><td colspan="5" class="empty">No models yet under "${escapeHtml(brandId)}".</td></tr>`;
      return;
    }
    applySeriesFilter();
  };

  if (!force) {
    const cached = cacheGet(modelsKey(brandId));
    if (cached) {
      show(cached);
      setCacheNote(true);
      return;
    }
  }

  tbody.innerHTML = `<tr><td colspan="5" class="empty">Loading…</td></tr>`;
  try {
    const snap = await getDocs(collection(db, "brands", brandId, "models"));
    const models = snap.docs
      .map((d) => ({ id: d.id, ...d.data() }))
      .sort((a, b) => (a.model || "").localeCompare(b.model || ""));

    cacheSet(modelsKey(brandId), models);
    show(models);
    setCacheNote(false);
  } catch (e) {
    tbody.innerHTML = `<tr><td colspan="5" class="empty empty--error">Could not load models: ${escapeHtml(e.message)}</td></tr>`;
  }
}

function setCacheNote(fromCache) {
  const note = el("cache-note");
  note.textContent = fromCache ? "Showing saved copy" : "Just refreshed";
  note.classList.toggle("cache-note--stale", fromCache);
}

el("refresh-btn").addEventListener("click", async () => {
  const brandId = currentBrandId();
  // Variant caches are keyed per model, so clearing just the model list would
  // leave every price cell still reading its old cached variants.
  for (const m of allModels) cacheRemove(variantsKey(brandId, m.id));
  cacheRemove(modelsKey(brandId));
  await loadModelsForSelectedBrand({ force: true });
  toast("Reloaded from the database", "success");
});

// Held so a variant edit can refresh just that model's price cell, instead of
// reloading the whole table and collapsing the panel being worked in.
let currentModels = [];

function refreshVariantSummary(brandId, modelId) {
  const model = currentModels.find((m) => m.id === modelId);
  if (model) loadVariantSummary(brandId, model);
}

function renderModelsTable(brandId, models) {
  currentModels = models;
  const tbody = el("models-tbody");
  tbody.innerHTML = "";
  for (const m of models) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td class="cell-media">
        <div class="cell-thumb">
          ${m.image_url ? `<img src="${escapeHtml(m.image_url)}" alt="" onerror="this.style.display='none'">` : `<div class="thumb-placeholder">📱</div>`}
        </div>
      </td>
      <td class="cell-main">
        <div class="cell-title">${escapeHtml(m.model || "(unnamed)")}</div>
        <div class="cell-sub">
          <span class="series-tag">${escapeHtml(deriveSeries(m.model, brandId))}</span>
          ${isHidden(m) ? `<span class="hidden-tag">Hidden</span>` : ""}
          ${m.release_year ? escapeHtml(String(m.release_year)) : ""}
        </div>
      </td>
      <td class="cell-price" data-label="Headline price" data-model-id="${escapeHtml(m.id)}">…</td>
      <td class="variant-count" data-label="Variants" data-model-id="${escapeHtml(m.id)}">…</td>
      <td class="cell-actions">
        <button class="btn btn--small" data-action="variants" data-id="${escapeHtml(m.id)}">Variants</button>
        <button class="btn btn--small" data-action="edit-model" data-id="${escapeHtml(m.id)}">Edit</button>
        <button class="btn btn--small" data-action="toggle-hidden" data-id="${escapeHtml(m.id)}">${isHidden(m) ? "Unhide" : "Hide"}</button>
        <button class="btn btn--small btn--danger" data-action="delete-model" data-id="${escapeHtml(m.id)}">Delete</button>
      </td>
    `;
    tbody.appendChild(tr);

    const variantRow = document.createElement("tr");
    variantRow.className = "variant-row";
    variantRow.dataset.modelId = m.id;
    variantRow.hidden = true;
    variantRow.innerHTML = `<td colspan="5"><div class="variant-panel" id="variants-${escapeHtml(m.id)}"></div></td>`;
    tbody.appendChild(variantRow);

    loadVariantSummary(brandId, m);
  }

  tbody.querySelectorAll("[data-action]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const id = btn.dataset.id;
      const model = models.find((x) => x.id === id);
      if (btn.dataset.action === "variants") toggleVariants(brandId, id);
      if (btn.dataset.action === "edit-model") openModelForm(brandId, model);
      if (btn.dataset.action === "toggle-hidden") toggleHidden(brandId, model);
      if (btn.dataset.action === "delete-model") confirmDeleteModel(brandId, model);
    });
  });
}

// The price the app will actually show for a model is not simply its
// `base_price` field. brand_detail_page.dart reads that field first and, only
// when it is absent or 0, falls back to scanning the variants and using the
// highest one. So a model with no base_price is priced by its variants — which
// is how every imported model in this catalogue currently works.
//
// Showing the raw field here would print "₹0" for those and look broken, so
// this resolves the same way the app does and says which rule applied.
// Single door to the variants collection, so the cache can never be bypassed
// by accident — this is the query that multiplies by model count.
async function fetchVariants(brandId, modelId, { force = false } = {}) {
  if (!force) {
    const cached = cacheGet(variantsKey(brandId, modelId));
    if (cached) return cached;
  }
  const snap = await getDocs(collection(db, "brands", brandId, "models", modelId, "variants"));
  const variants = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  cacheSet(variantsKey(brandId, modelId), variants);
  rememberStorageOptions(variants.map((v) => v.storage));
  return variants;
}

async function loadVariantSummary(brandId, model) {
  const countEl = document.querySelector(`.variant-count[data-model-id="${model.id}"]`);
  const priceEl = document.querySelector(`.cell-price[data-model-id="${model.id}"]`);
  const declared = Number(model.base_price) || 0;

  try {
    const variants = await fetchVariants(brandId, model.id);
    if (countEl) countEl.textContent = variants.length;
    if (!priceEl) return;

    if (declared > 0) {
      priceEl.innerHTML = `<span>${money(declared)}<div class="cell-sub">fixed on model</div></span>`;
      return;
    }
    const highest = variants.reduce((max, v) => Math.max(max, Number(v.base_price) || 0), 0);
    priceEl.innerHTML = highest > 0
      ? `<span>${money(highest)}<div class="cell-sub">highest variant</div></span>`
      : `<span>—<div class="cell-sub">no price set</div></span>`;
  } catch {
    if (countEl) countEl.textContent = "—";
    if (priceEl) priceEl.textContent = declared > 0 ? money(declared) : "—";
  }
}

async function toggleVariants(brandId, modelId) {
  const row = document.querySelector(`.variant-row[data-model-id="${modelId}"]`);
  if (expandedModelId === modelId) {
    row.hidden = true;
    expandedModelId = null;
    return;
  }
  document.querySelectorAll(".variant-row").forEach((r) => (r.hidden = true));
  expandedModelId = modelId;
  row.hidden = false;
  await renderVariantPanel(brandId, modelId);
}

async function renderVariantPanel(brandId, modelId) {
  const host = el(`variants-${modelId}`);
  host.innerHTML = `<p class="empty">Loading variants…</p>`;
  const variants = await fetchVariants(brandId, modelId);

  host.innerHTML = `
    <div class="variant-list">
      ${variants.length === 0
        ? `<p class="empty">No variants yet.</p>`
        : variants.map((v) => `
          <div class="variant-item" data-variant-id="${escapeHtml(v.id)}">
            <span class="variant-storage">${escapeHtml(v.storage || "—")}</span>
            <span class="variant-price">${money(v.base_price)}</span>
            <button class="btn btn--tiny" data-vaction="edit" data-vid="${escapeHtml(v.id)}">Edit</button>
            <button class="btn btn--tiny btn--danger" data-vaction="delete" data-vid="${escapeHtml(v.id)}">Delete</button>
          </div>
        `).join("")}
    </div>
    ${suggestionBlock(brandId, modelId, variants)}
    <button class="btn btn--small btn--primary" data-add-variant="1">+ Add variant</button>
  `;

  wireSuggestions(brandId, modelId);

  host.querySelectorAll("[data-vaction]").forEach((btn) => {
    const vid = btn.dataset.vid;
    const variant = variants.find((x) => x.id === vid);
    btn.addEventListener("click", () => {
      if (btn.dataset.vaction === "edit") openVariantForm(brandId, modelId, variant);
      if (btn.dataset.vaction === "delete") deleteVariant(brandId, modelId, variant);
    });
  });

  host.querySelector("[data-add-variant]").addEventListener("click", () => {
    openVariantForm(brandId, modelId, null);
  });
}


// The variants this phone shipped with that have not been created yet.
//
// The whole point of the feature: the spec sheet already lists them, so the
// admin should be filling in prices rather than retyping configurations and
// introducing a new spelling of "128GB 8GB RAM" each time.
function missingSpecVariants(modelId, variants) {
  const model = allModels.find((m) => m.id === modelId);
  const have = new Set(
    variants.map((v) => (v.storage || "").trim().toLowerCase()).filter(Boolean)
  );
  return specVariants(model).filter((v) => !have.has(v.toLowerCase()));
}

function suggestionBlock(brandId, modelId, variants) {
  const missing = missingSpecVariants(modelId, variants);
  if (missing.length === 0) return "";

  return `
    <div class="spec-suggest">
      <div class="spec-suggest__head">
        <strong>From the spec sheet</strong>
        <span class="cell-sub">${missing.length} not added yet — set a price to add</span>
      </div>
      ${missing.map((v, i) => `
        <div class="spec-suggest__row" data-spec-row="${i}">
          <span class="spec-suggest__name">${escapeHtml(v)}</span>
          <input class="spec-suggest__price" type="number" min="0" step="1"
                 inputmode="numeric" placeholder="₹ price"
                 data-spec-price="${escapeHtml(v)}" />
          <button class="btn btn--tiny btn--primary" data-spec-add="${escapeHtml(v)}">Add</button>
        </div>
      `).join("")}
      ${missing.length > 1
        ? `<button class="btn btn--small" data-spec-add-all="1">Add all priced</button>`
        : ""}
    </div>
  `;
}

function wireSuggestions(brandId, modelId) {
  const host = el(`variants-${modelId}`);

  const priceFor = (storage) => {
    const input = host.querySelector(`[data-spec-price="${CSS.escape(storage)}"]`);
    const value = Number(input?.value);
    return Number.isFinite(value) && value > 0 ? value : null;
  };

  host.querySelectorAll("[data-spec-add]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const storage = btn.dataset.specAdd;
      const price = priceFor(storage);
      if (price === null) {
        toast(`Enter a price for ${storage} first.`, "error");
        return;
      }
      addSpecVariants(brandId, modelId, [{ storage, price }]);
    });
  });

  const addAll = host.querySelector("[data-spec-add-all]");
  if (addAll) {
    addAll.addEventListener("click", () => {
      // Only the rows actually given a price. Adding a variant at ₹0 would
      // quote a seller nothing for a working phone.
      const rows = [...host.querySelectorAll("[data-spec-price]")]
        .map((input) => ({
          storage: input.dataset.specPrice,
          price: priceFor(input.dataset.specPrice),
        }))
        .filter((r) => r.price !== null);

      if (rows.length === 0) {
        toast("Enter a price on at least one row first.", "error");
        return;
      }
      addSpecVariants(brandId, modelId, rows);
    });
  }
}

// Writes several variants at once, in a single batch.
//
// One batch rather than a loop of addDoc: adding four variants should either
// all land or none, so a failure halfway cannot leave a phone priced for two
// of its four configurations.
async function addSpecVariants(brandId, modelId, rows) {
  const path = collection(db, "brands", brandId, "models", modelId, "variants");
  try {
    const batch = writeBatch(db);
    const added = [];
    for (const { storage, price } of rows) {
      const ref = doc(path);
      batch.set(ref, { storage, base_price: price });
      added.push({ id: ref.id, storage, base_price: price });
    }
    await batch.commit();

    const cached = (await fetchVariants(brandId, modelId)).slice();
    cached.push(...added);
    cacheSet(variantsKey(brandId, modelId), cached);
    rememberStorageOptions(added.map((v) => v.storage));

    toast(
      added.length === 1
        ? `Added "${added[0].storage}"`
        : `Added ${added.length} variants`,
      "success"
    );
    await renderVariantPanel(brandId, modelId);
    refreshVariantSummary(brandId, modelId);
  } catch (err) {
    toast("Could not add variants: " + err.message, "error");
  }
}

// --- Add / edit variant modal ----------------------------------------------

const variantModal = el("variant-modal");
let variantCtx = { brandId: null, modelId: null, editingId: null };

function openVariantForm(brandId, modelId, variant) {
  variantCtx = { brandId, modelId, editingId: variant ? variant.id : null };
  el("variant-modal-title").textContent = variant ? "Edit variant" : "Add variant";
  el("variant-form-storage").value = variant?.storage || "";
  el("variant-form-price").value = variant?.base_price ?? "";
  fillStorageOptions(brandId, modelId);
  variantModal.showModal();
}

// Offers the spellings the catalog already uses, as a datalist and as chips.
//
// Configurations already on THIS model are left out of the chips: adding a
// second 128GB variant to the same phone is a mistake, not a shortcut, and
// offering it as a one-tap button invites it.
function fillStorageOptions(brandId, modelId) {
  const all = knownStorageOptions();
  const list = el("variant-storage-options");
  list.innerHTML = all
    .map((v) => `<option value="${escapeHtml(v)}"></option>`)
    .join("");

  const taken = new Set(
    (cacheGet(variantsKey(brandId, modelId)) || [])
      .map((v) => (v.storage || "").trim())
      .filter(Boolean)
  );
  // When editing, its own value is not "taken" — it is the one being changed.
  if (variantCtx.editingId) {
    const self = (cacheGet(variantsKey(brandId, modelId)) || [])
      .find((v) => v.id === variantCtx.editingId);
    if (self) taken.delete((self.storage || "").trim());
  }

  // This phone's own configurations first, then spellings used elsewhere in
  // the catalog. The spec sheet is the better answer when it has one.
  const model = allModels.find((m) => m.id === modelId);
  const own = specVariants(model);
  const ordered = [...own, ...all.filter((v) => !own.includes(v))];
  const picks = ordered.filter((v) => !taken.has(v)).slice(0, 8);
  const host = el("variant-storage-picks");
  host.hidden = picks.length === 0;
  host.innerHTML = picks
    .map((v) => `<button type="button" class="chip" data-pick="${escapeHtml(v)}">${escapeHtml(v)}</button>`)
    .join("");
  host.querySelectorAll("[data-pick]").forEach((btn) => {
    btn.addEventListener("click", () => {
      el("variant-form-storage").value = btn.dataset.pick;
      el("variant-form-price").focus();
    });
  });
}

el("variant-modal-cancel").addEventListener("click", () => variantModal.close());

el("variant-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const { brandId, modelId, editingId } = variantCtx;
  const storage = el("variant-form-storage").value.trim();
  const price = Number(el("variant-form-price").value);
  if (!storage || !Number.isFinite(price)) {
    toast("Storage and a numeric price are required.", "error");
    return;
  }

  // A second "128GB 8GB RAM" on the same phone is always a mistake, and it
  // shows up in the app as two identical options the seller must choose
  // between.
  const existing = cacheGet(variantsKey(brandId, modelId)) || [];
  const clash = existing.find(
    (v) => v.id !== editingId &&
      (v.storage || "").trim().toLowerCase() === storage.toLowerCase()
  );
  if (clash) {
    toast(`This model already has a "${clash.storage}" variant.`, "error");
    return;
  }

  rememberStorageOptions([storage]);

  const path = collection(db, "brands", brandId, "models", modelId, "variants");
  try {
    // The cached list is edited to match the write instead of being thrown
    // away, so saving a price costs one write and no reads.
    const cached = (await fetchVariants(brandId, modelId)).slice();
    if (editingId) {
      await updateDoc(doc(db, "brands", brandId, "models", modelId, "variants", editingId), {
        storage,
        base_price: price,
      });
      const i = cached.findIndex((v) => v.id === editingId);
      if (i !== -1) cached[i] = { ...cached[i], storage, base_price: price };
      toast("Variant updated", "success");
    } else {
      const ref = await addDoc(path, { storage, base_price: price });
      cached.push({ id: ref.id, storage, base_price: price });
      toast(`Added variant "${storage}"`, "success");
    }
    cacheSet(variantsKey(brandId, modelId), cached);

    variantModal.close();
    await renderVariantPanel(brandId, modelId);
    refreshVariantSummary(brandId, modelId);
  } catch (err) {
    toast("Could not save variant: " + err.message, "error");
  }
});

async function deleteVariant(brandId, modelId, variant) {
  if (!confirm(`Delete variant "${variant.storage}"? This cannot be undone.`)) return;
  try {
    await deleteDoc(doc(db, "brands", brandId, "models", modelId, "variants", variant.id));
    const cached = (await fetchVariants(brandId, modelId)).filter((v) => v.id !== variant.id);
    cacheSet(variantsKey(brandId, modelId), cached);

    toast("Variant deleted", "success");
    await renderVariantPanel(brandId, modelId);
    refreshVariantSummary(brandId, modelId);
  } catch (err) {
    toast("Could not delete variant: " + err.message, "error");
  }
}

// --- Add / edit model modal -------------------------------------------------

const modelModal = el("model-modal");
let modelModalBrandId = null;
let modelModalEditingId = null;

el("add-model-btn").addEventListener("click", () => {
  const brandId = currentBrandId();
  if (!brandId) {
    toast("Choose or enter a brand first.", "error");
    return;
  }
  openModelForm(brandId, null);
});

function openModelForm(brandId, model) {
  modelModalBrandId = brandId;
  modelModalEditingId = model ? model.id : null;
  el("model-modal-title").textContent = model ? "Edit model" : "Add model";
  el("model-form-name").value = model?.model || "";
  el("model-form-year").value = model?.release_year || "";
  el("model-form-price").value = model?.base_price ?? "";
  el("model-form-image").value = model?.image_url || "";
  modelModal.showModal();
}

el("model-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const name = el("model-form-name").value.trim();
  const year = el("model-form-year").value.trim();
  const priceRaw = el("model-form-price").value.trim();
  const imageUrl = el("model-form-image").value.trim();

  if (!name) {
    toast("Model name is required.", "error");
    return;
  }
  if (priceRaw !== "" && !Number.isFinite(Number(priceRaw))) {
    toast("Headline price must be a number, or left blank.", "error");
    return;
  }

  const payload = { model: name };

  // On an edit, a field cleared in the form is removed from the document
  // rather than left behind — otherwise clearing the headline price would
  // appear to work and the old override would keep driving the app's prices.
  // On a create there is nothing to remove, so blanks are simply omitted.
  const optional = {
    base_price: priceRaw === "" ? null : Number(priceRaw),
    release_year: year === "" ? null : Number(year) || year,
    image_url: imageUrl === "" ? null : imageUrl,
  };
  for (const [key, value] of Object.entries(optional)) {
    if (value !== null) payload[key] = value;
    else if (modelModalEditingId) payload[key] = deleteField();
  }

  // The cache can't hold deleteField() sentinels, so the same intent is
  // expressed as a plain object: present keys are set, absent ones are gone.
  const cacheFields = { model: name };
  for (const [key, value] of Object.entries(optional)) {
    if (value !== null) cacheFields[key] = value;
  }

  try {
    if (modelModalEditingId) {
      await updateDoc(doc(db, "brands", modelModalBrandId, "models", modelModalEditingId), payload);
      const i = allModels.findIndex((m) => m.id === modelModalEditingId);
      if (i !== -1) {
        // Drop every editable key first so a cleared field really disappears,
        // then re-apply. Untouched fields like `specs` survive.
        const kept = { ...allModels[i] };
        for (const key of Object.keys(optional)) delete kept[key];
        allModels[i] = { ...kept, ...cacheFields };
      }
      toast("Model updated", "success");
    } else {
      const ref = await addDoc(collection(db, "brands", modelModalBrandId, "models"), payload);
      allModels.push({ id: ref.id, ...cacheFields });
      allModels.sort((a, b) => (a.model || "").localeCompare(b.model || ""));
      cacheSet(variantsKey(modelModalBrandId, ref.id), []);
      toast("Model added", "success");
    }
    saveModelsCache(modelModalBrandId);

    modelModal.close();
    // Reads the cache that was just updated, so this re-render costs nothing.
    loadModelsForSelectedBrand();
  } catch (err) {
    toast("Could not save model: " + err.message, "error");
  }
});

el("model-modal-cancel").addEventListener("click", () => modelModal.close());

async function confirmDeleteModel(brandId, model) {
  const ok = confirm(
    `Delete "${model.model || "this model"}" and all of its variants?\n\n` +
    `This cannot be undone, and any orders that already reference it will keep ` +
    `their own copy of the price — this only removes it from the catalogue ` +
    `so it can no longer be selected.`
  );
  if (!ok) return;

  try {
    // Deliberately a live read, not the cache. Deleting a document does not
    // delete its subcollection, so a variant the cache didn't know about would
    // be orphaned under a model that no longer exists and be invisible from
    // then on. Deletes are rare; correctness is worth the one query.
    const variantsSnap = await getDocs(
      collection(db, "brands", brandId, "models", model.id, "variants")
    );
    const batch = writeBatch(db);
    variantsSnap.docs.forEach((d) => batch.delete(d.ref));
    batch.delete(doc(db, "brands", brandId, "models", model.id));
    await batch.commit();

    allModels = allModels.filter((m) => m.id !== model.id);
    cacheRemove(variantsKey(brandId, model.id));
    saveModelsCache(brandId);

    toast(`Deleted "${model.model}" and ${variantsSnap.size} variant(s)`, "success");
    loadModelsForSelectedBrand();
  } catch (err) {
    toast("Could not delete model: " + err.message, "error");
  }
}

// ---------------------------------------------------------------------------
// Orders
// ---------------------------------------------------------------------------
let lastOrders = [];

function startOrdersListener() {
  stopOrdersListener();
  const q = query(collection(db, "orders"), orderBy("createdAt", "desc"), limit(200));
  ordersUnsub = onSnapshot(
    q,
    (snap) => {
      lastOrders = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      renderOrders(lastOrders);
    },
    (err) => {
      el("orders-tbody").innerHTML =
        `<tr><td colspan="7" class="empty empty--error">Could not load orders: ${escapeHtml(err.message)}</td></tr>`;
    }
  );
}
function stopOrdersListener() {
  if (ordersUnsub) {
    ordersUnsub();
    ordersUnsub = null;
  }
}

function renderOrders(orders) {
  const filter = el("orders-search").value.trim().toLowerCase();
  const filtered = filter
    ? orders.filter((o) =>
        (o.modelName || "").toLowerCase().includes(filter) ||
        (o.brand || "").toLowerCase().includes(filter) ||
        // The code the seller reads out over the phone, with the "FM-"
        // optional so typing just the six characters finds it.
        (o.reference || "").toLowerCase().includes(filter) ||
        (o.reference || "").toLowerCase().replace("fm-", "").includes(filter) ||
        o.id.toLowerCase().includes(filter)
      )
    : orders;

  const tbody = el("orders-tbody");
  if (filtered.length === 0) {
    tbody.innerHTML = `<tr><td colspan="7" class="empty">No orders${filter ? " match that search" : " yet"}.</td></tr>`;
    return;
  }

  tbody.innerHTML = filtered.map((o) => `
    <tr>
      <td class="mono" data-label="Order">${escapeHtml(o.reference || o.id.slice(0, 8) + "…")}</td>
      <td class="cell-main--full">
        <div class="cell-title">${escapeHtml(o.modelName || "Device")}</div>
        <div class="cell-sub">${escapeHtml([o.brand, o.storage].filter(Boolean).join(" · "))}</div>
      </td>
      <td data-label="Payout">${money(o.finalPayout)}</td>
      <td class="cell-status-badge">
        <span class="badge badge--${o.status === "paid" ? "success" : "warning"}">
          ${escapeHtml(ORDER_STAGES.find((s) => s.value === o.status)?.label || o.status || "placed")}
        </span>
      </td>
      <td data-label="Placed">${formatDate(o.createdAt)}</td>
      <td data-label="Status">
        <select class="status-select" data-order-id="${escapeHtml(o.id)}">
          ${ORDER_STAGES.map((s) => `<option value="${s.value}" ${s.value === (o.status || "placed") ? "selected" : ""}>${s.label}</option>`).join("")}
        </select>
        <select class="assign-select" data-assign-order="${escapeHtml(o.id)}">
          <option value="">Unassigned</option>
          ${inspectors.map((i) => `<option value="${escapeHtml(i.id)}" ${i.id === o.inspectorId ? "selected" : ""}>${escapeHtml(i.name || i.email || i.id)}</option>`).join("")}
        </select>
      </td>
      <td class="cell-actions">
        <button class="btn btn--small" data-action="view-order" data-id="${escapeHtml(o.id)}">Details</button>
      </td>
    </tr>
  `).join("");

  tbody.querySelectorAll(".assign-select").forEach((sel) => {
    sel.addEventListener("change", async () => {
      sel.disabled = true;
      await assignInspector(sel.dataset.assignOrder, sel.value);
      sel.disabled = false;
    });
  });

  tbody.querySelectorAll(".status-select").forEach((sel) => {
    sel.addEventListener("change", async () => {
      const orderId = sel.dataset.orderId;
      const newStatus = sel.value;
      sel.disabled = true;
      try {
        await updateDoc(doc(db, "orders", orderId), {
          status: newStatus,
          updatedAt: serverTimestamp(),
        });
        toast("Order status updated", "success");
      } catch (err) {
        toast("Could not update status: " + err.message, "error");
      } finally {
        sel.disabled = false;
      }
    });
  });

  tbody.querySelectorAll('[data-action="view-order"]').forEach((btn) => {
    btn.addEventListener("click", () => {
      const order = filtered.find((o) => o.id === btn.dataset.id);
      if (order) showOrderDetails(order);
    });
  });
}

// --- Order details modal ----------------------------------------------------

const orderModal = el("order-modal");
el("order-modal-close").addEventListener("click", () => orderModal.close());

// Laid out as a receipt rather than a field dump: an order document carries a
// nested `quote` (the grading wizard's deduction breakdown) and six loose
// address fields, which as raw JSON are unreadable on a phone. Every key
// rendered specially is listed in HANDLED so that any field the app adds later
// still shows up in the catch-all block instead of vanishing.
const HANDLED = new Set([
  "id", "modelName", "brand", "storage", "imageUrl", "modelDocId",
  "basePrice", "finalPayout", "quote", "quoteValidUntil",
  "status", "createdAt", "updatedAt", "userId", "reference",
  "inspectorId", "inspectorName",
  "addressLabel", "addressFullText", "addressLatitude", "addressLongitude",
]);

function showOrderDetails(order) {
  const row = (label, value) =>
    `<div class="detail-row"><span class="k">${escapeHtml(label)}</span><span class="v">${escapeHtml(String(value))}</span></div>`;
  const heading = (text) => `<div class="detail-heading">${escapeHtml(text)}</div>`;

  const out = [];

  // --- device ---
  const subtitle = [order.brand, order.storage].filter(Boolean).join(" · ");
  out.push(`
    <div class="detail-device">
      <div class="cell-thumb">
        ${order.imageUrl
          ? `<img src="${escapeHtml(order.imageUrl)}" alt="" onerror="this.style.display='none'">`
          : `<div class="thumb-placeholder">📱</div>`}
      </div>
      <div>
        <div class="cell-title">${escapeHtml(order.modelName || "Device")}</div>
        ${subtitle ? `<div class="cell-sub">${escapeHtml(subtitle)}</div>` : ""}
      </div>
    </div>
  `);

  // --- payout ---
  out.push(heading("Payout"));
  if (order.basePrice != null) out.push(row("Base price", money(order.basePrice)));

  // `quote.lines` is what the grading wizard writes: one entry per deduction
  // it actually applied (it does not record the questions that cost nothing),
  // so every line here is worth showing.
  const lines = Array.isArray(order.quote?.lines) ? order.quote.lines : [];
  for (const d of lines) {
    const sub = [d.category, d.percent != null ? `${d.percent}%` : null].filter(Boolean).join(" · ");
    out.push(`
      <div class="detail-row detail-row--deduction">
        <span class="k">
          ${escapeHtml(d.choice || "Deduction")}
          ${sub ? `<em>${escapeHtml(sub)}</em>` : ""}
        </span>
        <span class="v detail-minus">−${escapeHtml(money(d.amount))}</span>
      </div>
    `);
  }

  if (order.finalPayout != null) {
    out.push(`
      <div class="detail-row detail-row--total">
        <span class="k">Final payout</span>
        <span class="v">${escapeHtml(money(order.finalPayout))}</span>
      </div>
    `);
  }
  if (order.quote?.floored) {
    out.push(`<p class="detail-note">Payout hit the minimum floor — deductions exceeded the device value.</p>`);
  }

  // --- status ---
  out.push(heading("Status"));
  // First, because it is what the caller on the phone will have quoted.
  if (order.reference) out.push(row("Reference", order.reference));
  if (order.inspectorName) out.push(row("Inspector", order.inspectorName));
  out.push(row("Stage", ORDER_STAGES.find((s) => s.value === order.status)?.label || order.status || "placed"));
  if (order.createdAt) out.push(row("Placed", formatDate(order.createdAt)));
  if (order.updatedAt) out.push(row("Last updated", formatDate(order.updatedAt)));
  if (order.quoteValidUntil) out.push(row("Quote valid until", formatDate(order.quoteValidUntil)));

  // --- pickup ---
  if (order.addressFullText || order.addressLabel) {
    out.push(heading("Pickup"));
    if (order.addressLabel) out.push(row("Label", order.addressLabel));
    if (order.addressFullText) {
      out.push(`<p class="detail-address">${escapeHtml(order.addressFullText)}</p>`);
    }
    if (order.addressLatitude != null && order.addressLongitude != null) {
      out.push(row("Coordinates", `${order.addressLatitude}, ${order.addressLongitude}`));
    }
  }

  // --- references ---
  out.push(heading("References"));
  out.push(row("Order id", order.id));
  if (order.modelDocId) out.push(row("Model doc id", order.modelDocId));
  if (order.userId) out.push(row("User id", order.userId));

  // --- anything the app started writing that this sheet doesn't know about ---
  const extras = Object.entries(order).filter(
    ([k, v]) => !HANDLED.has(k) && v !== undefined && v !== null && v !== ""
  );
  if (extras.length) {
    out.push(heading("Other fields"));
    for (const [key, value] of extras) {
      const shown = value?.toDate
        ? formatDate(value)
        : typeof value === "object"
        ? JSON.stringify(value)
        : value;
      out.push(row(key, shown));
    }
  }

  el("order-detail-list").innerHTML = out.join("");
  orderModal.showModal();
}

el("orders-search").addEventListener("input", () => {
  // Re-render from the live listener's last known set rather than a fresh
  // query — no network round trip needed just to filter what's on screen.
  renderOrders(lastOrders);
});

// ---------------------------------------------------------------------------
// Second-hand listings (read-only) — the "other" collection the mobile app
// reads through its default Firebase app handle (FirebaseFirestore.instance
// in home_repository.dart / wishlist_page.dart), as opposed to the catalog
// collections above. Same database either way; shown here mainly so nothing
// in the project is invisible to the admin panel. Read-only for now since
// editing it wasn't part of what was asked and its write shape hasn't been
// fully audited here.
// ---------------------------------------------------------------------------
async function loadSecondHandListings() {
  const tbody = el("listings-tbody");
  tbody.innerHTML = `<tr><td colspan="5" class="empty">Loading…</td></tr>`;
  try {
    let listings = cacheGet("listings");
    if (!listings) {
      const snap = await getDocs(query(collection(secondHandDb, "second_hand_mobiles"), limit(100)));
      listings = snap.docs.map((d) => d.data());
      cacheSet("listings", listings);
    }
    if (listings.length === 0) {
      tbody.innerHTML = `<tr><td colspan="5" class="empty">No listings found.</td></tr>`;
      return;
    }
    tbody.innerHTML = listings.map((v) => {
      const price = v.salePrice ?? v.price ?? 0;
      const original = v.originalPrice ?? v.mrp ?? v.basePrice ?? 0;
      return `
        <tr>
          <td class="cell-media">
            <div class="cell-thumb">
              ${v.photo1Url ? `<img src="${escapeHtml(v.photo1Url)}" alt="" onerror="this.style.display='none'">` : `<div class="thumb-placeholder">📱</div>`}
            </div>
          </td>
          <td class="cell-main">
            <div class="cell-title">${escapeHtml([v.brand, v.model].filter(Boolean).join(" ") || "(unnamed)")}</div>
            <div class="cell-sub">${escapeHtml(v.storage || "")}</div>
          </td>
          <td data-label="Condition">${escapeHtml(v.condition || v.grade || "—")}</td>
          <td data-label="Price">${money(price)}</td>
          <td data-label="Original">${original ? money(original) : "—"}</td>
        </tr>
      `;
    }).join("");
  } catch (e) {
    tbody.innerHTML = `<tr><td colspan="5" class="empty empty--error">Could not load listings: ${escapeHtml(e.message)}</td></tr>`;
  }
}

// ---------------------------------------------------------------------------
// PWA — installable to a phone's home screen.
//
// The service worker is registered but deliberately shallow: see sw.js for why
// it never touches Firestore's traffic. Registration failing is not fatal —
// the panel is a normal web page without it.
// ---------------------------------------------------------------------------
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("sw.js").catch(() => {
      // Most likely opened from file:// or over plain http on a non-localhost
      // host, where service workers are blocked. Nothing else depends on it.
    });
  });
}

// Chrome fires this instead of showing its own install UI; stashing the event
// is the only way to offer installation at a moment that makes sense.
let deferredInstall = null;
const installBtn = el("install-btn");

window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();
  deferredInstall = e;
  installBtn.hidden = false;
});

installBtn.addEventListener("click", async () => {
  if (!deferredInstall) return;
  installBtn.disabled = true;
  deferredInstall.prompt();
  await deferredInstall.userChoice;
  deferredInstall = null;
  installBtn.hidden = true;
  installBtn.disabled = false;
});

window.addEventListener("appinstalled", () => {
  deferredInstall = null;
  installBtn.hidden = true;
  toast("Installed — open it from your home screen.", "success");
});


// ---------------------------------------------------------------------------
// Staff — inspectors
// ---------------------------------------------------------------------------

// Creates a login for a pickup inspector.
//
// The password is chosen by the admin and handed over in person, which is the
// whole brief. Firebase never reveals it again, so the admin has to give it to
// the inspector at the moment of creation — the UI says so plainly rather than
// letting them discover it later.
async function createInspector(name, email, password) {
  let credential;
  try {
    // On `staffAuth`, never the admin's own connection: this call signs the
    // new user in, and doing that on `auth` would swap the admin's session.
    credential = await createUserWithEmailAndPassword(staffAuth, email, password);
  } catch (err) {
    const known = {
      "auth/email-already-in-use": "That email already has an account.",
      "auth/invalid-email": "That email address is not valid.",
      "auth/weak-password": "Password must be at least 6 characters.",
    };
    toast(known[err.code] || "Could not create the account.", "error");
    return false;
  }

  const uid = credential.user.uid;
  try {
    await setDoc(doc(db, "inspectors", uid), {
      name,
      email,
      createdAt: serverTimestamp(),
      active: true,
    });
    // Mirrored onto the user record so the phone app can tell staff from
    // sellers without a second read.
    await setDoc(doc(db, "users", uid), { name, email, role: "inspector" }, { merge: true });
  } catch (err) {
    toast(
      "Account made, but saving their details failed: " + err.message,
      "error"
    );
    return false;
  } finally {
    // The new user is signed in on the throwaway connection. Drop it, or the
    // next staff account is created while pretending to be this one.
    try { await signOut(staffAuth); } catch {}
  }

  toast(`Inspector "${name}" added`, "success");
  await loadInspectors();
  return true;
}

async function loadInspectors() {
  try {
    const snap = await getDocs(collection(db, "inspectors"));
    inspectors = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  } catch (e) {
    inspectors = [];
  }
  renderInspectors();
}

function renderInspectors() {
  const host = el("staff-list");
  if (!host) return;
  if (inspectors.length === 0) {
    host.innerHTML = `<p class="empty">No inspectors yet.</p>`;
    return;
  }
  host.innerHTML = inspectors
    .map(
      (i) => `
      <div class="staff-item">
        <div class="cell-main--full">
          <div class="cell-title">${escapeHtml(i.name || "Unnamed")}</div>
          <div class="cell-sub">${escapeHtml(i.email || "")}</div>
        </div>
        <span class="badge badge--${i.active === false ? "warning" : "success"}">
          ${i.active === false ? "Inactive" : "Active"}
        </span>
      </div>`
    )
    .join("");
}

// --- Assigning a pickup -----------------------------------------------------

async function assignInspector(orderId, inspectorId) {
  const chosen = inspectors.find((i) => i.id === inspectorId);
  try {
    await updateDoc(doc(db, "orders", orderId), {
      inspectorId: inspectorId || deleteField(),
      inspectorName: chosen ? chosen.name : deleteField(),
      updatedAt: serverTimestamp(),
    });
    toast(chosen ? `Assigned to ${chosen.name}` : "Assignment cleared", "success");
  } catch (err) {
    toast("Could not assign: " + err.message, "error");
  }
}

// --- The inspector's own screen ---------------------------------------------

function startInspectorListener(uid) {
  const q = query(collection(db, "orders"), where("inspectorId", "==", uid));
  inspectorUnsub = onSnapshot(
    q,
    (snap) => {
      const mine = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      renderInspectorJobs(mine);
    },
    (err) => {
      const host = el("inspector-list");
      if (host) {
        host.innerHTML = `<p class="empty">Could not load your pickups: ${escapeHtml(err.message)}</p>`;
      }
    }
  );
}

function renderInspectorJobs(orders) {
  const host = el("inspector-list");
  if (!host) return;
  if (orders.length === 0) {
    host.innerHTML = `<p class="empty">Nothing assigned to you right now.</p>`;
    return;
  }

  // Soonest-placed first: the oldest job is the one keeping someone waiting.
  orders.sort((a, b) => (a.createdAt?.seconds || 0) - (b.createdAt?.seconds || 0));

  host.innerHTML = orders
    .map(
      (o) => `
      <div class="job-card">
        <div class="job-card__head">
          <span class="mono">${escapeHtml(o.reference || o.id.slice(0, 8))}</span>
          <span class="badge badge--${o.status === "paid" ? "success" : "warning"}">
            ${escapeHtml(ORDER_STAGES.find((s) => s.value === o.status)?.label || o.status || "placed")}
          </span>
        </div>
        <div class="cell-title">${escapeHtml(o.modelName || "Device")}</div>
        <div class="cell-sub">${escapeHtml([o.brand, o.storage].filter(Boolean).join(" · "))}</div>
        <div class="job-card__payout">${money(o.finalPayout)}</div>
        ${o.addressFullText ? `<div class="cell-sub">${escapeHtml(o.addressFullText)}</div>` : ""}
        <div class="job-card__actions">
          <select class="status-select" data-job-id="${escapeHtml(o.id)}">
            ${ORDER_STAGES.map(
              (s) => `<option value="${s.value}" ${s.value === (o.status || "placed") ? "selected" : ""}>${s.label}</option>`
            ).join("")}
          </select>
          ${o.addressLatitude && o.addressLongitude
            ? `<a class="btn btn--small" target="_blank" rel="noopener"
                 href="https://www.google.com/maps/search/?api=1&query=${o.addressLatitude},${o.addressLongitude}">Map</a>`
            : ""}
        </div>
      </div>`
    )
    .join("");

  host.querySelectorAll("[data-job-id]").forEach((sel) => {
    sel.addEventListener("change", async () => {
      sel.disabled = true;
      try {
        await updateDoc(doc(db, "orders", sel.dataset.jobId), {
          status: sel.value,
          updatedAt: serverTimestamp(),
        });
        toast("Status updated", "success");
      } catch (err) {
        toast("Could not update: " + err.message, "error");
      } finally {
        sel.disabled = false;
      }
    });
  });
}

// --- Staff form wiring ------------------------------------------------------

const staffForm = el("staff-form");
if (staffForm) {
  staffForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const name = el("staff-name").value.trim();
    const email = el("staff-email").value.trim();
    const password = el("staff-password").value;
    if (!name || !email || password.length < 6) {
      toast("Name, email and a password of 6+ characters are required.", "error");
      return;
    }
    const btn = el("staff-submit");
    btn.disabled = true;
    const ok = await createInspector(name, email, password);
    btn.disabled = false;
    if (ok) staffForm.reset();
  });
}
