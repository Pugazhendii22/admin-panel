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
import {
  catalogFirebaseConfig,
  secondHandFirebaseConfig,
  webPushVapidKey,
} from "./firebase-config.js";

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js";
import {
  getMessaging,
  getToken,
  onMessage,
  isSupported as messagingSupported,
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-messaging.js";
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
  arrayUnion,
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
  // Terminal, and set by the seller refusing a revised amount rather than by
  // staff — but listed so an admin can see and correct it.
  { value: "declined", label: "Offer declined" },
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
    // Before the jobs, so the first render already has the questions. The
    // admin-only DOM it would otherwise draw into is gone by now, and every
    // write in there is null-guarded, so this only fills the array.
    loadChecklist().then(() => {
      if (inspectorOrders) renderInspectorJobs(inspectorOrders);
    });
    startInspectorListener(user.uid);
    startWebPush(user.uid, "inspectors");
    return;
  }

  loadModelsForSelectedBrand();
  startOrdersListener();
  loadSecondHandListings();
  loadInspectors();
  startWebPush(user.uid, "admins");
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

    // Read when it is first looked at, not on sign-in: these are eight reads
    // the catalog screen has no use for.
    if (btn.dataset.tab === "tab-pricing" && !pricingDocs) loadPricingRules();
    if (btn.dataset.tab === "tab-checklist" && !checklistQuestions) {
      loadChecklist();
    }
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

// How many orders the live listener holds.
//
// A snapshot listener is billed for every document it first delivers, and then
// for each one that changes — so the window is the running cost of leaving the
// panel open. 50 is about two screens of scrolling, which is as far as anyone
// looks when the point is "what needs doing now"; older orders are reached
// through search, which queries instead of listening.
const ORDERS_WINDOW = 50;

function startOrdersListener() {
  stopOrdersListener();
  const q = query(
    collection(db, "orders"),
    orderBy("createdAt", "desc"),
    limit(ORDERS_WINDOW)
  );
  ordersUnsub = onSnapshot(
    q,
    (snap) => {
      lastOrders = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      renderOrders(lastOrders);
    },
    (err) => {
      showOrdersError(err);
    }
  );
}

// Searching reaches past the live window without widening it.
//
// One-off reads, not a second listener: an admin looking up a three-month-old
// order wants it once, and a listener would keep charging for it all day. The
// results are merged into what is already on screen and the listener is left
// alone.
let searchedOrders = [];

async function searchOlderOrders(term) {
  const cleaned = term.trim();
  if (cleaned.length < 3) {
    searchedOrders = [];
    renderOrders(lastOrders);
    return;
  }

  const host = el("orders-tbody");
  host.innerHTML = `<tr><td colspan="7" class="empty">Searching earlier orders…</td></tr>`;

  try {
    // Matched on the reference, because that is what a caller reads out. An
    // exact match on an indexed field is one document read, where scanning for
    // a model name would be the whole collection.
    const upper = cleaned.toUpperCase();
    const withPrefix = upper.startsWith("FM-") ? upper : `FM-${upper}`;

    const snap = await getDocs(
      query(collection(db, "orders"), where("reference", "==", withPrefix), limit(5))
    );
    searchedOrders = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  } catch (err) {
    searchedOrders = [];
    showOrdersError(err);
    return;
  }
  renderOrders(lastOrders);
}

function showOrdersError(err) {
  // Said in terms of what to do, not what threw. "Missing or insufficient
  // permissions" means the signed-in account is not an admin, which is worth
  // saying plainly rather than making somebody read a Firestore error.
  const permissions = /permission|insufficient/i.test(err.message || "");
  el("orders-tbody").innerHTML = `
    <tr><td colspan="7" class="empty empty--error">
      ${permissions
        ? "This account cannot read orders. It may no longer be on the admin list."
        : `Could not load orders: ${escapeHtml(err.message)}`}
    </td></tr>`;
}
function stopOrdersListener() {
  if (ordersUnsub) {
    ordersUnsub();
    ordersUnsub = null;
  }
}

function renderOrders(orders) {
  const filter = el("orders-search").value.trim().toLowerCase();

  // Anything found by reference beyond the live window, shown alongside what
  // is already loaded rather than replacing it, and de-duplicated so an order
  // inside the window is not listed twice.
  const known = new Set(orders.map((o) => o.id));
  const pool = [...orders, ...searchedOrders.filter((o) => !known.has(o.id))];

  const filtered = filter
    ? pool.filter((o) =>
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
    // Says which of the two situations it is, and what to do about the one
    // that has an answer. A bare "no results" leaves an admin wondering
    // whether the order is missing or merely older than the window.
    tbody.innerHTML = filter
      ? `<tr><td colspan="7" class="empty">
           Nothing in the latest ${ORDERS_WINDOW} orders matches “${escapeHtml(filter)}”.
           <div class="cell-sub">Enter the full reference (FM-XXXXXX) to search earlier orders.</div>
         </td></tr>`
      : `<tr><td colspan="7" class="empty">
           No orders yet.
           <div class="cell-sub">They appear here the moment somebody places one.</div>
         </td></tr>`;
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

// The sheet is read as steps rather than one long scroll: the quote, what
// the seller said, what the phone measured, where the order stands, and
// where to collect it. Which step is showing lives here because the sheet's
// markup is rebuilt each time an order is opened.
let orderStep = 0;

function applyOrderStep() {
  const panels = [...orderModal.querySelectorAll("[data-od-panel]")];
  if (panels.length === 0) return;
  orderStep = Math.min(Math.max(orderStep, 0), panels.length - 1);

  panels.forEach((panel, i) => {
    panel.hidden = i !== orderStep;
  });
  orderModal.querySelectorAll("[data-od-step]").forEach((tab) => {
    const on = Number(tab.dataset.odStep) === orderStep;
    tab.classList.toggle("is-current", on);
    tab.setAttribute("aria-selected", String(on));
    // Keeps the current step in view when the row of steps is wider than
    // the phone.
    if (on) tab.scrollIntoView({ block: "nearest", inline: "center" });
  });

  const prev = el("order-modal-prev");
  const next = el("order-modal-next");
  prev.disabled = orderStep === 0;
  const last = orderStep === panels.length - 1;
  next.textContent = last
    ? "Done"
    : `Next: ${orderModal.querySelector(`[data-od-step="${orderStep + 1}"]`)?.dataset.label || ""}`;
  el("order-detail-list").scrollTop = 0;
}

el("order-modal-prev").addEventListener("click", () => {
  orderStep -= 1;
  applyOrderStep();
});
el("order-modal-next").addEventListener("click", () => {
  const count = orderModal.querySelectorAll("[data-od-panel]").length;
  if (orderStep >= count - 1) return orderModal.close();
  orderStep += 1;
  applyOrderStep();
});
el("order-detail-list").addEventListener("click", (e) => {
  const tab = e.target.closest("[data-od-step]");
  if (!tab) return;
  orderStep = Number(tab.dataset.odStep);
  applyOrderStep();
});

// Laid out as a receipt rather than a field dump: an order document carries a
// nested `quote` (the grading wizard's deduction breakdown) and six loose
// address fields, which as raw JSON are unreadable on a phone. Every key
// rendered specially is listed in HANDLED so that any field the app adds later
// still shows up in the catch-all block instead of vanishing.
const HANDLED = new Set([
  "id", "modelName", "brand", "storage", "imageUrl", "modelDocId",
  "basePrice", "finalPayout", "quote", "quoteValidUntil",
  "status", "createdAt", "updatedAt", "userId", "reference",
  "inspectorId", "inspectorName", "inspection", "sellerResponse",
  "addressLabel", "addressFullText", "addressLatitude", "addressLongitude",
  // Rendered as the pickup briefing and the self-check section below. Before
  // that they arrived here as a wall of JSON under "Other fields", which is
  // where an agent was expected to notice that the checkup had run on a
  // different phone.
  "checkup", "checkupProvenance", "checkupDevice",
  "deviceReachable", "provisionalQuote",
  // The grading the quote does not record, because it cost nothing. Rendered
  // as the declaration section; absent on orders older than it.
  "declared",
  "customerName", "customerPhone",
]);

function showOrderDetails(order) {
  const row = (label, value) =>
    `<div class="detail-row"><span class="k">${escapeHtml(label)}</span><span class="v">${escapeHtml(String(value))}</span></div>`;
  const heading = (text) => `<div class="detail-heading">${escapeHtml(text)}</div>`;

  // The device sits above the steps and stays put; everything after it is
  // filed under a step. `step()` is safe to call twice with one label, since
  // two blocks that are each optional can share a step and either may be the
  // first to need it.
  const head = [];
  const steps = [];
  let out = head;
  const step = (label) => {
    let found = steps.find((s) => s.label === label);
    if (!found) {
      found = { label, items: [] };
      steps.push(found);
    }
    out = found.items;
  };

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
  step("Quote");
  if (order.basePrice != null) out.push(row("Base price", money(order.basePrice)));

  // `quote.lines` is what the grading wizard writes: one entry per deduction
  // it actually applied (it does not record the questions that cost nothing),
  // so every line here is worth showing.
  const lines = Array.isArray(order.quote?.lines) ? order.quote.lines : [];
  // The phone's own capacity reading, shown against the band the seller
  // graded themselves — the one line on this sheet an inspector is there to
  // check. Null on every order placed before the app started sending it.
  const battery = batteryReading(order);
  for (const d of lines) {
    const sub = [d.category, d.percent != null ? `${d.percent}%` : null].filter(Boolean).join(" · ");
    out.push(`
      <div class="detail-row detail-row--deduction">
        <span class="k">
          ${escapeHtml(d.choice || "Deduction")}
          ${sub ? `<em>${escapeHtml(sub)}</em>` : ""}
          ${battery && isBatteryLine(d) ? batteryBandEm(battery, d.choice) : ""}
        </span>
        <span class="v detail-minus">−${escapeHtml(money(d.amount))}</span>
      </div>
    `);
  }

  // A band worth nothing is written as no line at all, so there is nothing
  // above for the reading to sit under. It still belongs on the sheet.
  if (battery && !lines.some(isBatteryLine)) {
    out.push(`
      <div class="detail-row detail-row--deduction">
        <span class="k">
          Battery health
          <em>Seller's band took nothing off</em>
          ${batteryBandEm(battery, null)}
        </span>
        <span class="v">—</span>
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

  // --- what the seller claimed was fine ---
  // Under the deductions on purpose: the two halves of the same claim, and
  // the only one of them that cost nothing is the one with something left to
  // check.
  const declared = declaredBlock(order);
  if (declared) {
    step("Seller said");
    out.push(declared);
  }

  // --- before pickup ---
  const briefing = briefingBlock(order);
  if (briefing) {
    step("Phone tests");
    out.push(heading("Before pickup"));
    out.push(briefing);
  }

  // --- what the phone said about itself ---
  const selfCheck = checkupBlock(order);
  if (selfCheck) {
    step("Phone tests");
    out.push(heading("Phone self-check"));
    out.push(selfCheck);
  }

  // --- status ---
  step("Status");
  // First, because it is what the caller on the phone will have quoted.
  if (order.reference) out.push(row("Reference", order.reference));
  if (order.customerName) out.push(row("Seller", order.customerName));
  if (order.customerPhone) out.push(row("Phone", order.customerPhone));
  if (order.inspectorName) out.push(row("Inspector", order.inspectorName));
  if (order.sellerResponse) {
    out.push(row(
      "Seller answered",
      order.sellerResponse.decision === "declined" ? "Declined" : "Accepted"
    ));
  }
  if (order.inspection) {
    const c = Number(order.inspection.confirmedPayout);
    const q = Number(order.finalPayout);
    out.push(row(
      Number.isFinite(c) && c !== q ? "Settled at (adjusted)" : "Settled at",
      Number.isFinite(c) ? money(c) : "—"
    ));
    if (order.inspection.reason) out.push(row("Reason", order.inspection.reason));
    // What the agent actually looked at. The count matters as much as the
    // faults: "two faults of three looked at" and "two faults of fourteen"
    // are different visits, and only one of them settles a dispute.
    const checks = order.inspection.checks;
    if (checks && typeof checks === "object" && !Array.isArray(checks)) {
      const verdicts = Object.keys(checks).filter(
        (k) => checks[k] === "pass" || checks[k] === "fail"
      );
      const faults = verdicts.filter((k) => checks[k] === "fail");
      if (verdicts.length) {
        out.push(row(
          "Agent checks",
          `${faults.length} fault${faults.length === 1 ? "" : "s"} of ${verdicts.length} looked at`
        ));
      }
      if (faults.length) {
        out.push(row("Faults found", faults.map(checkLabel).join(", ")));
      }
    }
  }
  out.push(row("Stage", ORDER_STAGES.find((s) => s.value === order.status)?.label || order.status || "placed"));
  if (order.createdAt) out.push(row("Placed", formatDate(order.createdAt)));
  if (order.updatedAt) out.push(row("Last updated", formatDate(order.updatedAt)));
  if (order.quoteValidUntil) out.push(row("Quote valid until", formatDate(order.quoteValidUntil)));
  // Each check the agent recorded, not just the count above. The same
  // record the inspector's own screen shows once a finding is filed.
  if (order.inspection) out.push(recordedChecksBlock(order));

  // --- pickup ---
  step("Pickup");
  if (order.addressFullText || order.addressLabel) {
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

  el("order-detail-list").innerHTML = `
    ${head.join("")}
    <div class="od__tabs" role="tablist" aria-label="Order sections">
      ${steps
        .map(
          (s, i) => `
        <button type="button" class="od__tab button-sm" role="tab"
                data-od-step="${i}" data-label="${escapeHtml(s.label)}">
          <span class="od__n">${i + 1}</span>${escapeHtml(s.label)}
        </button>`
        )
        .join("")}
    </div>
    ${steps
      .map(
        (s, i) => `
      <section class="od__panel" role="tabpanel" data-od-panel="${i}" hidden>
        ${s.items.join("")}
      </section>`
      )
      .join("")}`;

  // Open, all of them: a step that is nothing but headings to tap is the
  // long card again with extra taps.
  orderModal.querySelectorAll("details.job-detail").forEach((d) => {
    d.open = true;
  });
  orderStep = 0;
  orderModal.showModal();
  applyOrderStep();
}

let orderSearchTimer = null;

el("orders-search").addEventListener("input", () => {
  // Filtering what is already loaded costs nothing, so it happens on every
  // keystroke.
  renderOrders(lastOrders);

  const term = el("orders-search").value.trim();

  // Reaching past the live window does cost a read, so it waits until typing
  // stops and only when the text looks like a full reference. Firing per
  // keystroke would bill six reads to type one code.
  clearTimeout(orderSearchTimer);
  if (!/^(FM-)?[0-9A-Za-z]{6}$/.test(term)) {
    if (searchedOrders.length > 0) {
      searchedOrders = [];
      renderOrders(lastOrders);
    }
    return;
  }
  orderSearchTimer = setTimeout(() => searchOlderOrders(term), 500);
});

// ---------------------------------------------------------------------------
// Pricing rules — what each fault takes off
//
// `deduction_rules` is the one collection in this database that moves money
// with nobody from the shop present: the app reads it live, so a percentage
// saved here is the percentage the next seller is quoted, with no release.
// Until now it could only be edited in the Firebase console, which meant the
// people who actually set prices could not, and whoever could was hand-editing
// JSON arrays beside a running quote engine.
//
// So nothing here is clever. No autosave — a save is a button, pressed on
// purpose. Every percentage is shown as money too, because a shop owner prices
// in rupees and "11%" of a phone is not a number anyone holds in their head.
// And the documents the app does not read are listed apart from the ones that
// cost money, rather than mixed in looking equally live.
// ---------------------------------------------------------------------------

// The documents the Flutter app reads, in the order a seller meets them.
//
// `used` is the sentence shown under each title. It is the answer to the only
// question that matters when you are about to change a number: where does this
// land? Anything in the collection that is not listed here is still loaded and
// still editable — it is just not allowed to claim a place in the sell flow it
// does not have.
const RULE_DOCS = [
  {
    id: "device_questions",
    title: "Questions asked first",
    kind: "questions",
    used:
      "Asked before the grading steps. The costly answer becomes a " +
      "“Functionality fault” line on the seller's quote.",
  },
  {
    id: "screen_condition",
    title: "Screen condition",
    kind: "options",
    used: "Step 1 of the sell wizard. One choice, one deduction.",
  },
  {
    id: "body_condition",
    title: "Body & frame",
    kind: "options",
    used: "Step 2 of the sell wizard.",
  },
  {
    id: "battery_health",
    title: "Battery health",
    kind: "options",
    used:
      "Step 3. When the phone's own checkup measured a capacity, the band " +
      "containing it is pre-selected — matched by the numbers in the label, " +
      "so keep a range in the wording. The seller keeps the last word.",
  },
  {
    id: "accessories",
    title: "Accessories",
    kind: "options",
    used: "Step 4 of the sell wizard.",
  },
  {
    id: "warranty_status",
    title: "Warranty left",
    kind: "options",
    used:
      "How much manufacturer warranty the phone has left. Add whatever " +
      "bands suit — “1-2 months”, “2-3 months”, “Out of warranty” — and " +
      "the wizard shows them in this order. The step only appears once " +
      "there is at least one band here, so leaving this empty keeps the " +
      "sell flow at five steps.",
  },
  {
    id: "lock_status",
    title: "Lock status",
    kind: "options",
    used: "The last step of the sell wizard, beside the payout.",
  },
  {
    id: "scrap_values",
    title: "Scrap prices — phones that will not switch on",
    kind: "scrap",
    used:
      "A flat amount, not a percentage, paid for a handset that does not " +
      "power on. It replaces the grading steps entirely: the seller is " +
      "shown this figure and nothing further is deducted from it, so it is " +
      "the payout, margin included. Most specific row wins — brand and " +
      "series, then the brand on its own, then a row with both left blank " +
      "as the catch-all. With no row that covers a phone, the sell flow " +
      "falls back to grading it the old way.",
  },
  {
    id: "checkup_results",
    title: "Auto-check findings",
    kind: "checkup",
    used:
      "What a failed hardware test takes off, when the seller ran the " +
      "automatic checkup. Only a FAIL ever deducts — a test that reported " +
      "nothing is not a fault, which is most of them on an iPhone.",
  },
];

// The tests the checkup runs, so a rule can be attached to one by name rather
// than by remembering its key. Typed entry still works: the list is a
// datalist, not a dropdown, so a test added after this panel was last touched
// can be priced without waiting for an edit here.
const CHECKUP_TESTS = [
  ["battery", "Battery"],
  ["camera", "Camera"],
  ["flashlight", "Flashlight"],
  ["display", "Display"],
  ["multitouch", "Multi-touch"],
  ["buttons", "Side buttons"],
  ["speaker", "Loudspeaker"],
  ["earpiece", "Earpiece"],
  ["microphone", "Microphone"],
  ["proximity", "Proximity sensor"],
  ["vibration", "Vibration motor"],
  ["wifi", "Wi-Fi"],
  ["bluetooth", "Bluetooth"],
  ["biometric", "Biometric"],
  ["network", "Mobile network"],
  ["internet", "Internet"],
  ["internet_stability", "Connection stability"],
  ["location", "Location (GPS)"],
  ["gyroscope", "Gyroscope"],
  ["cpu_throttle", "Processor under load"],
];

// A first draft of `checkup_results`: every test the app runs, with the price
// the shop already charges for the same fault wherever a question covers it,
// and a conservative guess where nothing does.
//
// These are a starting point to argue with, not researched prices — which is
// why the button fills the form and stops, leaving the numbers on screen to
// be changed and the Save to be pressed on purpose. Twenty rows typed by hand
// is how a shop ends up with the feature switched off instead.
//
// `same_as` is the important column, not the percentage: it is what stops a
// phone being charged twice for one fault. The three audio tests deliberately
// share one, so a handset failing all three is charged once, at the highest.
const CHECKUP_SUGGESTIONS = [
  ["battery", "Battery below healthy capacity", 10, "Battery health"],
  ["display", "Screen faulty (dead pixels, burn-in)", 12, "Screen condition"],
  ["multitouch", "Touch screen not responding everywhere", 30, "Touch Screen Not Working"],
  ["camera", "Camera faulty", 10, "Camera (Front/Rear) Issue"],
  ["speaker", "Loudspeaker faulty", 7, "Speaker / Mic Issue"],
  ["earpiece", "Earpiece faulty", 7, "Speaker / Mic Issue"],
  ["microphone", "Microphone faulty", 7, "Speaker / Mic Issue"],
  ["buttons", "Side buttons not working", 8, "Buttons Not Working"],
  ["biometric", "Fingerprint or face unlock not working", 10, "Fingerprint / Face ID"],
  ["network", "Mobile network fault", 18, "Network / SIM Issue"],
  ["cpu_throttle", "Processor throttling under load", 12, ""],
  ["wifi", "Wi-Fi fault", 6, ""],
  ["internet", "Cannot reach the internet", 6, ""],
  ["location", "GPS fault", 5, ""],
  ["bluetooth", "Bluetooth fault", 4, ""],
  ["proximity", "Proximity sensor fault", 4, ""],
  ["gyroscope", "Gyroscope fault", 4, ""],
  ["internet_stability", "Unstable connection", 4, ""],
  ["flashlight", "Flashlight fault", 3, ""],
  ["vibration", "Vibration motor fault", 3, ""],
];

// Loaded documents, in display order. Null until the tab is first opened —
// these are eight reads and the panel opens on the catalog.
let pricingDocs = null;
let pricingLoading = false;

// What a percentage is worth, for the preview column. A number to think in,
// not a figure that goes anywhere near a real quote.
function pricingBase() {
  const raw = Number(el("pricing-base")?.value);
  return Number.isFinite(raw) && raw > 0 ? Math.round(raw) : 0;
}

function pricingDoc(id) {
  return (pricingDocs || []).find((d) => d.id === id);
}

// What shape are this document's options in?
//
// Guessed from the options themselves for a document this panel has never
// heard of, because a custom category created in the console should still open
// in the right editor rather than in the wrong one.
function guessKind(options) {
  const first = options.find((o) => o && typeof o === "object") || {};
  if ("question" in first) return "questions";
  // Checked before `key`: a scrap row carries rupees and no percentage at
  // all, so opening it in the percentage editor would show every amount as
  // a deduction and silently clamp ₹1,500 to 100 on the next save.
  if ("amount" in first) return "scrap";
  if ("key" in first && !("icon_url" in first)) return "checkup";
  return "options";
}

// Every field this panel knows how to edit, per kind. Anything else on an
// option is carried through a save untouched: a field added from the console
// or by a later version of the app must not be quietly dropped by an editor
// that predates it.
const EDITED_FIELDS = {
  options: ["label", "percent", "icon_url"],
  questions: ["question", "help", "label", "percent", "deduct_on", "gates"],
  checkup: ["key", "label", "percent", "same_as"],
  scrap: ["brand", "series", "amount"],
};

async function loadPricingRules() {
  const host = el("pricing-list");
  if (!host || pricingLoading) return;
  pricingLoading = true;
  host.innerHTML = `<p class="empty">Loading pricing rules…</p>`;

  try {
    const snap = await getDocs(collection(db, "deduction_rules"));
    const found = new Map();
    snap.forEach((d) => found.set(d.id, d.data() || {}));

    const docs = [];
    const take = (id, known) => {
      const data = found.get(id);
      const raw = Array.isArray(data?.options) ? data.options : [];
      const options = raw.map((o) => ({ ...(o && typeof o === "object" ? o : {}) }));
      found.delete(id);
      docs.push({
        id,
        title: known?.title || data?.title || id,
        kind: known?.kind || data?.kind || guessKind(options),
        used: known?.used || "",
        inApp: Boolean(known),
        missing: !data,
        options,
        dirty: false,
      });
    };

    for (const known of RULE_DOCS) take(known.id, known);
    // Whatever else is in the collection, in a stable order.
    for (const id of [...found.keys()].sort()) take(id, null);

    pricingDocs = docs;
    renderPricing();
  } catch (e) {
    host.innerHTML = `<p class="empty empty--error">
      Could not load pricing rules: ${escapeHtml(e.message)}
    </p>`;
  } finally {
    pricingLoading = false;
  }
}

function renderPricing() {
  const host = el("pricing-list");
  if (!host || !pricingDocs) return;

  const live = pricingDocs.filter((d) => d.inApp);
  const rest = pricingDocs.filter((d) => !d.inApp);

  host.innerHTML =
    live.map(ruleCard).join("") +
    (rest.length
      ? `<div class="rule-divider">
           <h3>Not read by the app</h3>
           <p class="cell-sub">
             These documents exist in <code>deduction_rules</code> but nothing in
             the app asks for them, so editing one changes no quote today. They
             are listed because deleting things quietly is worse than showing
             them — and a new category lives here until the sell wizard is
             taught to show it.
           </p>
         </div>` + rest.map(ruleCard).join("")
      : "");

  renderPricingDatalists();
}

function ruleCard(d) {
  const base = pricingBase();
  const worst = d.options.reduce((most, o) => Math.max(most, percentOf(o)), 0);

  return `
    <section class="card rule-card" data-rule="${escapeHtml(d.id)}">
      <div class="rule-head">
        <div>
          <h3>${escapeHtml(d.title)}
            ${d.dirty ? `<span class="badge badge--warning">unsaved</span>` : ""}
          </h3>
          <p class="cell-sub">
            <code>deduction_rules/${escapeHtml(d.id)}</code>
            ${d.missing ? ` · <strong>not created yet</strong>` : ""}
          </p>
          ${d.used ? `<p class="rule-used">${d.used}</p>` : ""}
        </div>
        <div class="rule-head__actions">
          ${d.kind === "checkup"
            ? `<button class="btn btn--small btn--ghost" data-act="seed" type="button"
                       title="Fill in every test the app runs, for you to price">
                 Fill in the tests
               </button>`
            : ""}
          <button class="btn btn--small btn--ghost" data-act="add" type="button">+ Option</button>
          <button class="btn btn--small btn--primary" data-act="save" type="button"
                  ${d.dirty ? "" : "disabled"}>Save</button>
        </div>
      </div>

      ${d.options.length === 0
        ? `<p class="empty">No options yet. “+ Option” adds the first one.</p>`
        : `<div class="rule-rows">${d.options
            .map((o, i) => optionRow(d, o, i, base))
            .join("")}</div>`}

      ${worst > 0
        ? `<p class="rule-worst ${worst > 90 ? "rule-worst--over" : ""}">
             Worst case here: <strong>${worst}%</strong>${
               base ? ` — ${money(Math.round((base * worst) / 100))} off ${money(base)}` : ""
             }.
             ${worst > 90
               ? "Over 90% on one choice alone. The payout never drops below 10% of the base price, so anything past that is invisible to the seller and only makes the quote harder to explain."
               : ""}
           </p>`
        : ""}
    </section>`;
}

// One editable option. The percentage carries its money value beside it,
// recalculated as it is typed.
function optionRow(d, o, i, base) {
  const pct = percentOf(o);
  const asMoney = base ? money(Math.round((base * pct) / 100)) : "—";
  const move = `
    <div class="rule-row__move">
      <button class="btn btn--tiny" data-act="up" data-index="${i}" type="button"
              ${i === 0 ? "disabled" : ""} title="Move up">↑</button>
      <button class="btn btn--tiny" data-act="down" data-index="${i}" type="button"
              ${i === d.options.length - 1 ? "disabled" : ""} title="Move down">↓</button>
      <button class="btn btn--tiny btn--danger" data-act="delete" data-index="${i}"
              type="button" title="Remove this option">✕</button>
    </div>`;

  const percentField = `
    <label class="field field--tight">
      <span>Takes off</span>
      <div class="rule-pct">
        <input type="number" min="0" max="100" step="1" inputmode="numeric"
               data-index="${i}" data-field="percent" value="${pct}" />
        <span class="rule-pct__money" data-money-for="${i}">${escapeHtml(asMoney)}</span>
      </div>
    </label>`;

  if (d.kind === "scrap") {
    // Rupees, so no percentage field and no money preview — the number in
    // the box already is the money. Brand and series are datalists rather
    // than selects: the series is worked out from the model name by
    // `deriveSeries`, so the list is a convenience, and a brand added to the
    // catalogue after this panel last loaded must still be priceable.
    const amount = amountOf(o);
    const brand = String(o.brand || "");
    const series = String(o.series || "");

    return `
      <div class="rule-row rule-row--wide">
        <div class="rule-row__fields">
          <label class="field field--tight field--grow">
            <span>Brand</span>
            <input type="text" data-index="${i}" data-field="brand"
                   list="scrap-brands" value="${escapeHtml(brand)}"
                   placeholder="Any brand" />
          </label>
          <label class="field field--tight field--grow">
            <span>Series</span>
            <input type="text" data-index="${i}" data-field="series"
                   list="scrap-series" value="${escapeHtml(series)}"
                   placeholder="${brand ? "Whole brand" : "Any series"}" />
          </label>
          <label class="field field--tight">
            <span>We pay</span>
            <div class="rule-pct">
              <input type="number" min="0" step="50" inputmode="numeric"
                     data-index="${i}" data-field="amount" value="${amount}" />
              <span class="rule-pct__money">${escapeHtml(money(amount))}</span>
            </div>
          </label>
          <p class="cell-sub rule-scrap__scope">${escapeHtml(scrapScope(o))}</p>
        </div>
        ${move}
      </div>`;
  }

  if (d.kind === "questions") {
    return `
      <div class="rule-row rule-row--wide">
        <div class="rule-row__fields">
          <label class="field field--tight field--grow">
            <span>Question the seller is asked</span>
            <input type="text" data-index="${i}" data-field="question"
                   value="${escapeHtml(o.question || "")}"
                   placeholder="e.g. Is the fingerprint sensor working?" />
          </label>
          <label class="field field--tight field--grow">
            <span>Smaller line underneath</span>
            <input type="text" data-index="${i}" data-field="help"
                   value="${escapeHtml(o.help || "")}"
                   placeholder="How to check it" />
          </label>
          <label class="field field--tight field--grow">
            <span>Name on the quote</span>
            <input type="text" data-index="${i}" data-field="label"
                   value="${escapeHtml(o.label || "")}"
                   placeholder="e.g. Fingerprint Not Working" />
          </label>
          ${percentField}
          <label class="field field--tight">
            <span>Costly answer</span>
            <select data-index="${i}" data-field="deduct_on">
              <option value="no" ${deductOn(o) === "no" ? "selected" : ""}>“No” costs</option>
              <option value="yes" ${deductOn(o) === "yes" ? "selected" : ""}>“Yes” costs</option>
            </select>
          </label>
          <label class="field field--tight">
            <span>Stops the rest</span>
            <select data-index="${i}" data-field="gates">
              <option value="" ${gatesOf(o) ? "" : "selected"}>No</option>
              <option value="powers_on" ${gatesOf(o) ? "selected" : ""}>Phone won't switch on</option>
            </select>
          </label>
        </div>
        ${move}
      </div>`;
  }

  if (d.kind === "checkup") {
    return `
      <div class="rule-row rule-row--wide">
        <div class="rule-row__fields">
          <label class="field field--tight">
            <span>Test</span>
            <input type="text" list="checkup-test-keys" autocomplete="off"
                   data-index="${i}" data-field="key"
                   value="${escapeHtml(o.key || "")}" placeholder="e.g. speaker" />
          </label>
          <label class="field field--tight field--grow">
            <span>Name on the quote</span>
            <input type="text" data-index="${i}" data-field="label"
                   value="${escapeHtml(o.label || "")}"
                   placeholder="e.g. Loudspeaker failed its own test" />
          </label>
          ${percentField}
          <label class="field field--tight field--grow">
            <span>Already charged as</span>
            <input type="text" list="rule-fault-names" autocomplete="off"
                   data-index="${i}" data-field="same_as"
                   value="${escapeHtml(o.same_as || "")}"
                   placeholder="Leave blank if nothing else covers it" />
          </label>
        </div>
        ${move}
      </div>`;
  }

  return `
    <div class="rule-row">
      <div class="rule-row__fields">
        <label class="field field--tight field--grow">
          <span>What the seller picks</span>
          <input type="text" data-index="${i}" data-field="label"
                 value="${escapeHtml(o.label || "")}"
                 placeholder="e.g. Visible Scratches" />
        </label>
        ${percentField}
        <label class="field field--tight field--grow">
          <span>Icon URL <em>(optional)</em></span>
          <input type="url" inputmode="url" autocapitalize="none" autocorrect="off"
                 data-index="${i}" data-field="icon_url"
                 value="${escapeHtml(o.icon_url || "")}" placeholder="https://…" />
        </label>
      </div>
      ${move}
    </div>`;
}

function percentOf(o) {
  const raw = o?.percent;
  const n = typeof raw === "number" ? raw : Number(raw);
  return Number.isFinite(n) ? Math.round(n) : 0;
}

function deductOn(o) {
  return String(o?.deduct_on || "no").toLowerCase() === "yes" ? "yes" : "no";
}

function amountOf(o) {
  const raw = o?.amount;
  const n = typeof raw === "number" ? raw : Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
}

// Says in words which phones a scrap row covers, because "blank means all"
// is the sort of rule that reads as an empty field left by mistake.
function scrapScope(o) {
  const brand = String(o?.brand || "").trim();
  const series = String(o?.series || "").trim();
  if (!brand && !series) return "Every phone with no more specific row below.";
  if (brand && !series) return `Every ${brand} without its own series row.`;
  if (!brand && series) {
    return `Any brand's “${series}” — set a brand too unless that is meant.`;
  }
  return `${brand} · ${series}.`;
}

// Only one gate is understood by the app — see `DeviceQuestion.fromMap`, which
// treats anything it does not recognise as gating nothing.
function gatesOf(o) {
  return String(o?.gates || "").trim().toLowerCase() === "powers_on";
}

// The fault names already in use, offered when linking an auto-check rule to
// the question that charges for the same thing. Built from what is loaded, so
// it follows a rename on the next reload rather than going stale in code.
function faultNameOptions() {
  const names = new Set();
  for (const d of pricingDocs || []) {
    if (d.kind === "checkup") continue;
    if (d.kind === "questions") {
      for (const o of d.options) if (o.label) names.add(String(o.label));
    } else if (d.inApp) {
      names.add(d.title);
    }
  }
  return [...names].sort();
}

// --- editing ---------------------------------------------------------------

const pricingHost = el("pricing-list");

// Typing edits state and leaves the DOM alone: re-rendering on a keystroke
// would take the cursor out of the field being typed into. Only structural
// changes — add, delete, move, save — redraw.
pricingHost?.addEventListener("input", (e) => {
  const input = e.target.closest("[data-field]");
  if (!input) return;
  const card = input.closest("[data-rule]");
  const d = pricingDoc(card?.dataset.rule);
  if (!d) return;

  const i = Number(input.dataset.index);
  const option = d.options[i];
  if (!option) return;

  const field = input.dataset.field;
  if (field === "percent") {
    const n = Math.round(Number(input.value));
    option.percent = Number.isFinite(n) ? Math.min(100, Math.max(0, n)) : 0;
    const label = card.querySelector(`[data-money-for="${i}"]`);
    const base = pricingBase();
    if (label) {
      label.textContent = base
        ? money(Math.round((base * option.percent) / 100))
        : "—";
    }
  } else if (field === "amount") {
    const n = Math.round(Number(input.value));
    option.amount = Number.isFinite(n) && n > 0 ? n : 0;
    const label = input.parentElement?.querySelector(".rule-pct__money");
    if (label) label.textContent = money(option.amount);
  } else {
    option[field] = input.value;
    if (field === "brand" || field === "series") {
      // The scope sentence is the only thing saying which phones a row
      // covers, so it has to follow the typing rather than wait for a save.
      const scope = input
        .closest(".rule-row")
        ?.querySelector(".rule-scrap__scope");
      if (scope) scope.textContent = scrapScope(option);
    }
  }

  markDirty(d, card);
});

pricingHost?.addEventListener("change", (e) => {
  const select = e.target.closest("select[data-field]");
  if (!select) return;
  const card = select.closest("[data-rule]");
  const d = pricingDoc(card?.dataset.rule);
  if (!d) return;
  const option = d.options[Number(select.dataset.index)];
  if (!option) return;
  option[select.dataset.field] = select.value;
  markDirty(d, card);
});

function markDirty(d, card) {
  if (d.dirty) return;
  d.dirty = true;
  const save = card.querySelector('[data-act="save"]');
  if (save) save.disabled = false;
  const title = card.querySelector(".rule-head h3");
  if (title && !title.querySelector(".badge")) {
    title.insertAdjacentHTML("beforeend", ` <span class="badge badge--warning">unsaved</span>`);
  }
}

pricingHost?.addEventListener("click", async (e) => {
  const btn = e.target.closest("[data-act]");
  if (!btn) return;
  const card = btn.closest("[data-rule]");
  const d = pricingDoc(card?.dataset.rule);
  if (!d) return;

  const i = Number(btn.dataset.index);

  switch (btn.dataset.act) {
    case "add":
      d.options.push(blankOption(d.kind));
      d.dirty = true;
      renderPricing();
      break;

    case "seed": {
      // Only the tests that are missing, so pressing it twice cannot
      // duplicate a row and a price already set by hand is never overwritten.
      const have = new Set(
        d.options.map((o) => String(o.key || "").trim().toLowerCase())
      );
      const missing = CHECKUP_SUGGESTIONS.filter(([key]) => !have.has(key));
      if (missing.length === 0) {
        toast("Every test the app runs is already listed here.", "info");
        return;
      }
      for (const [key, label, percent, same_as] of missing) {
        d.options.push({ key, label, percent, ...(same_as ? { same_as } : {}) });
      }
      d.dirty = true;
      renderPricing();
      toast(
        `${missing.length} test${missing.length === 1 ? "" : "s"} filled in. ` +
          "Change the figures, then Save — nothing is written until you do.",
        "info"
      );
      break;
    }

    case "delete": {
      const name = d.options[i]?.label || d.options[i]?.question || "this option";
      // A deduction is money. Removing one silently because a thumb landed on
      // the wrong row is not a mistake anybody would notice until a seller is
      // quoted too much.
      if (!confirm(`Remove “${name}” from ${d.title}?\n\nNothing is written until you press Save.`)) return;
      d.options.splice(i, 1);
      d.dirty = true;
      renderPricing();
      break;
    }

    case "up":
    case "down": {
      const to = btn.dataset.act === "up" ? i - 1 : i + 1;
      if (to < 0 || to >= d.options.length) return;
      [d.options[i], d.options[to]] = [d.options[to], d.options[i]];
      d.dirty = true;
      renderPricing();
      break;
    }

    case "save":
      await savePricingDoc(d, btn);
      break;
  }
});

function blankOption(kind) {
  if (kind === "questions") {
    return { question: "", help: "", label: "", percent: 0, deduct_on: "no" };
  }
  if (kind === "checkup") return { key: "", label: "", percent: 0, same_as: "" };
  if (kind === "scrap") return { brand: "", series: "", amount: 0 };
  return { label: "", percent: 0, icon_url: "" };
}

// What actually gets written: the fields this editor owns, cleaned, plus every
// field it does not recognise, untouched.
function optionForSave(option, kind) {
  const known = EDITED_FIELDS[kind] || EDITED_FIELDS.options;
  const out = {};
  for (const [key, value] of Object.entries(option)) {
    if (!known.includes(key)) out[key] = value;
  }

  for (const key of known) {
    if (key === "percent") {
      // Clamped on the way out as well as on the way in. The number typed
      // here is already held to 0-100, but a document edited in the console
      // can hold anything, and a negative deduction — one that pays a seller
      // extra for a fault — is not a thing this app can price.
      out.percent = Math.min(100, Math.max(0, percentOf(option)));
    } else if (key === "deduct_on") {
      out.deduct_on = deductOn(option);
    } else if (key === "gates") {
      // Written only when it gates, so an ordinary question keeps the shape it
      // has had since before gating existed.
      const gate = String(option.gates || "").trim();
      if (gate) out.gates = gate;
    } else if (key === "amount") {
      // No upper bound: this is rupees, not a percentage. Negative is
      // refused rather than clamped silently to nothing, because a scrap
      // price of zero and a typo are different mistakes.
      out.amount = amountOf(option);
    } else if (key === "brand") {
      // Lower-cased to match the brand document ids the app looks up with.
      out.brand = String(option.brand || "").trim().toLowerCase();
    } else if (key === "icon_url") {
      out.icon_url = String(option.icon_url || "").trim();
    } else {
      const value = String(option[key] ?? "").trim();
      if (value || key === "label") out[key] = value;
    }
  }
  return out;
}

async function savePricingDoc(d, btn) {
  // The app reads `label` to name a choice and `question` to ask one. A blank
  // one renders as an empty card nobody can pick, so it is caught here rather
  // than in front of a seller.
  const blanks = d.options.filter((o) =>
    d.kind === "questions"
      ? !String(o.question || "").trim() || !String(o.label || "").trim()
      : d.kind === "checkup"
      ? !String(o.key || "").trim() || !String(o.label || "").trim()
      // A scrap row names no choice and needs no label: brand and series are
      // both allowed to be blank, which is how the catch-all is written. The
      // amount is what has to be there, and zero is a real answer — a shop
      // that will take the phone away for nothing — so only a row with no
      // usable number at all is refused.
      : d.kind === "scrap"
      ? !Number.isFinite(Number(o.amount))
      : !String(o.label || "").trim()
  );
  if (blanks.length) {
    toast(
      d.kind === "checkup"
        ? "Every auto-check rule needs a test and a name on the quote."
        : d.kind === "questions"
        ? "Every question needs its wording and a name for the quote."
        : d.kind === "scrap"
        ? "Every scrap row needs an amount in rupees."
        : "Every option needs a label.",
      "error"
    );
    return;
  }

  btn.disabled = true;
  const previous = btn.textContent;
  btn.textContent = "Saving…";
  try {
    await setDoc(
      doc(db, "deduction_rules", d.id),
      { options: d.options.map((o) => optionForSave(o, d.kind)) },
      // Merge, so a top-level field this panel never shows — a title, a note,
      // anything a later version adds — survives a save made from here.
      { merge: true }
    );
    d.dirty = false;
    d.missing = false;
    toast(`${d.title} saved — the app quotes from it immediately.`, "success");
    renderPricing();
  } catch (err) {
    toast("Could not save: " + err.message, "error");
    btn.disabled = false;
    btn.textContent = previous;
  }
}

// --- a new category --------------------------------------------------------

const ruleModal = el("rule-modal");

el("pricing-new")?.addEventListener("click", () => {
  el("rule-form").reset();
  ruleModal.showModal();
});
el("rule-modal-cancel")?.addEventListener("click", () => ruleModal.close());

el("rule-form")?.addEventListener("submit", async (e) => {
  e.preventDefault();

  // A Firestore document id, and the key the app would read it by. Spaces and
  // slashes in an id are the kind of thing that works until the day something
  // builds a path out of it.
  const id = el("rule-form-id").value.trim().toLowerCase().replace(/[^a-z0-9_]+/g, "_");
  const title = el("rule-form-title").value.trim();
  const kind = el("rule-form-kind").value;

  if (!id) {
    toast("A category needs an id.", "error");
    return;
  }
  if (pricingDoc(id)) {
    toast(`“${id}” already exists — scroll down and edit it.`, "error");
    return;
  }

  pricingDocs.push({
    id,
    title: title || id,
    kind,
    used: "",
    inApp: false,
    missing: true,
    options: [blankOption(kind)],
    dirty: true,
  });
  ruleModal.close();
  renderPricing();
  toast("Category added below. Fill it in and press Save to write it.", "info");
});

el("pricing-base")?.addEventListener("input", () => {
  if (pricingDocs) renderPricing();
});
el("pricing-refresh")?.addEventListener("click", () => {
  const unsaved = (pricingDocs || []).some((d) => d.dirty);
  if (unsaved && !confirm("Reload and lose the changes you have not saved?")) return;
  pricingDocs = null;
  loadPricingRules();
});

// The datalists the rows point at. Written once the rules are loaded, since
// one of them is built out of the rules themselves.
function renderPricingDatalists() {
  const tests = el("checkup-test-keys");
  if (tests && !tests.childElementCount) {
    tests.innerHTML = CHECKUP_TESTS.map(
      ([key, name]) => `<option value="${escapeHtml(key)}">${escapeHtml(name)}</option>`
    ).join("");
  }
  const faults = el("rule-fault-names");
  if (faults) {
    faults.innerHTML = faultNameOptions()
      .map((name) => `<option value="${escapeHtml(name)}"></option>`)
      .join("");
  }

  const brands = el("scrap-brands");
  if (brands && !brands.childElementCount) {
    brands.innerHTML = KNOWN_BRANDS.map(
      (name) =>
        `<option value="${escapeHtml(name.toLowerCase())}">${escapeHtml(name)}</option>`
    ).join("");
  }

  const seriesList = el("scrap-series");
  if (seriesList) {
    seriesList.innerHTML = scrapSeriesOptions()
      .map((name) => `<option value="${escapeHtml(name)}"></option>`)
      .join("");
  }
}

// Series names to offer on a scrap row.
//
// Derived from whichever brand the Catalog tab has open, because loading
// every brand's models to fill a datalist would be thousands of reads for a
// convenience. Series already written into scrap rows are included too, so
// the list does not shrink to nothing on a fresh sign-in and leave earlier
// rows looking like typos. The field stays free text either way — the only
// thing that has to match is what `deriveSeries()` produces from the model
// name, and typing it by hand is always allowed.
function scrapSeriesOptions() {
  const names = new Set();
  const brandId = currentBrandId();
  for (const m of allModels || []) {
    const series = deriveSeries(m.model, brandId);
    if (series) names.add(series);
  }
  for (const d of pricingDocs || []) {
    if (d.kind !== "scrap") continue;
    for (const o of d.options) {
      const series = String(o.series || "").trim();
      if (series) names.add(series);
    }
  }
  return [...names].sort();
}

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
// Inspection checklist — what the agent is asked at the door
//
// Lives in `inspection_checklist/default`, not in `deduction_rules`. That
// collection is world-readable, because the mobile app browses the catalogue
// before anyone signs in, and these questions have no business being part of
// the shop window. It also moves no money: the answers are a record of what
// the agent found, and they still type the confirmed amount themselves with
// a reason. Keeping the two apart is what stops a future reader treating a
// checklist answer as a deduction.
//
// On every question the FIRST answer is the clean one — "No scratch", "No
// defect". The job card totals everything below it as something found. That
// convention is why the editor numbers the rows and labels row one, rather
// than carrying a per-answer "is this a fault" flag that nobody would keep
// correct.
// ---------------------------------------------------------------------------

const CHECKLIST_DOC = "default";

/// An answer is `{ label, percent }`.
///
/// It was a bare string first, and a checklist saved then still is one, so
/// both are read. Normalised on the way in rather than at every use, so the
/// rest of this file only ever sees the object.
function optLabel(o) {
  return typeof o === "string" ? o : String(o?.label ?? "");
}

function optPercent(o) {
  if (typeof o === "string") return 0;
  const n = Number(o?.percent);
  return Number.isFinite(n) && n > 0 ? Math.min(100, Math.round(n)) : 0;
}

function normaliseOption(o) {
  return { label: optLabel(o), percent: optPercent(o) };
}

let checklistQuestions = null;
let checklistDirty = false;
let checklistLoading = false;

/// A starting point, taken from what the shop already grades by hand.
///
/// Every percentage starts at zero. The wording is a reasonable guess at what
/// a shop asks; what each answer is worth is not something anybody but the
/// owner can know, and seeding a plausible-looking number would be a price
/// nobody set.
///
/// Offered rather than written on first load: an empty checklist is a
/// deliberate state (the agent keeps the old pass/fail list until there is
/// something here), and silently seeding would take that choice away.
const STANDARD_CHECKLIST = [
  {
    id: "screen_cracks",
    group: "Screen condition",
    question: "Are there any cracks on the screen?",
    hint: "Check the glass against the light, edge to edge",
    options: [
      { label: "No cracks", percent: 0 },
      { label: "Hairline crack under 1cm", percent: 0 },
      { label: "Crack under 3cm, touch working", percent: 0 },
      { label: "Multiple cracks or touch not working", percent: 0 },
    ]
  },
  {
    id: "screen_spots",
    group: "Screen condition",
    question: "Are there any visible spots?",
    hint: "Dead pixels / spots on screen",
    options: [
      { label: "No spots", percent: 0 },
      { label: "Upto 3 white spots of 2mm / 1 white spot of 3mm", percent: 0 },
      { label: "More than 3 white spots / white patches", percent: 0 },
      { label: "Coloured spots or patches (black, yellow, blue, green, red)", percent: 0 },
    ]
  },
  {
    id: "screen_lines",
    group: "Screen condition",
    question: "Are there any visible lines?",
    hint: "Visible lines on screen",
    options: ["No lines on screen", "Lines on screen"],
  },
  {
    id: "screen_discolour",
    group: "Screen condition",
    question: "Is the screen discoloured?",
    hint: "Select the screen discolouration",
    options: [
      { label: "No discolouration", percent: 0 },
      { label: "Light yellow/blue/pink/green along the edges", percent: 0 },
      { label: "Dark yellow/blue/pink/green along the edges", percent: 0 },
      { label: "Screen fading — colour or background imprint on the full screen", percent: 0 },
    ]
  },
  {
    id: "body_scratches",
    group: "Device physical condition",
    question: "Are there any scratches on the phone body?",
    hint: "Side, back, top and bottom panels",
    options: [
      { label: "No scratch", percent: 0 },
      { label: "Upto 5 scratches of less than 1cm", percent: 0 },
      { label: "Upto 15 scratches of 1cm / upto 5 scratches of 3cm", percent: 0 },
      { label: "More than 15 scratches of 1cm / more than 5 of 3cm, or cover mark", percent: 0 },
      { label: "Minor paint peel-off or bubble", percent: 0 },
      { label: "Major paint peel-off or bubble", percent: 0 },
    ]
  },
  {
    id: "body_dents",
    group: "Device physical condition",
    question: "Are there any dents on the phone body?",
    hint: "Anything you can feel with a thumb",
    options: [
      { label: "No dents", percent: 0 },
      { label: "1-2 dents", percent: 0 },
      { label: "More than 2 dents, or a minor crack under 1cm on the body", percent: 0 },
    ]
  },
  {
    id: "body_panel",
    group: "Device physical condition",
    question: "What condition is the panel in?",
    hint: "Phone side / back panel condition",
    options: [
      { label: "No defect", percent: 0 },
      { label: "Loose panel or visible pasting", percent: 0 },
      { label: "Missing panel", percent: 0 },
      { label: "Cracked and broken panel", percent: 0 },
      { label: "Glass back panel damaged", percent: 0 },
    ]
  },
  {
    id: "body_bent",
    group: "Device physical condition",
    question: "Is the phone bent?",
    hint: "Sight down the long edge",
    options: ["Not bent", "Slightly bent", "Visibly bent or twisted"],
  },
];

function checklistCard(q, i, total) {
  const rows = (q.options || [])
    .map(
      (opt, j) => `
      <div class="ck-opt">
        <span class="ck-opt__n${j === 0 ? " ck-opt__n--clean" : ""}">${j + 1}</span>
        <input type="text" class="ck-opt__text" data-q="${i}" data-opt="${j}"
               value="${escapeHtml(optLabel(opt))}"
               placeholder="${j === 0 ? "The clean answer — e.g. No scratch" : "What the agent found"}" />
        <span class="ck-opt__pct">
          <input type="number" min="0" max="100" step="1" inputmode="numeric"
                 class="ck-opt__pctinput" data-q="${i}" data-pct="${j}"
                 value="${optPercent(opt)}"
                 ${j === 0 ? 'disabled title="The clean answer takes nothing off"' : 'title="Taken off the quoted payout"'} />
          <span>%</span>
        </span>
        <button class="btn btn--tiny" type="button" data-ck="opt-up" data-q="${i}" data-opt="${j}"
                ${j === 0 ? "disabled" : ""} title="Move up">↑</button>
        <button class="btn btn--tiny" type="button" data-ck="opt-down" data-q="${i}" data-opt="${j}"
                ${j === (q.options.length - 1) ? "disabled" : ""} title="Move down">↓</button>
        <button class="btn btn--tiny btn--danger" type="button" data-ck="opt-del" data-q="${i}" data-opt="${j}"
                title="Remove this answer">✕</button>
      </div>`
    )
    .join("");

  return `
    <section class="card ck-card" data-ck-q="${i}">
      <div class="rule-head">
        <div class="ck-head__fields">
          <label class="field field--tight field--grow">
            <span>Question the agent is asked</span>
            <input type="text" data-ck-field="question" data-q="${i}"
                   value="${escapeHtml(String(q.question || ""))}"
                   placeholder="e.g. Are there any dents on the phone body?" />
          </label>
          <label class="field field--tight field--grow">
            <span>Smaller line underneath</span>
            <input type="text" data-ck-field="hint" data-q="${i}"
                   value="${escapeHtml(String(q.hint || ""))}"
                   placeholder="Where to look" />
          </label>
          <label class="field field--tight">
            <span>Section</span>
            <input type="text" data-ck-field="group" data-q="${i}"
                   list="ck-groups" value="${escapeHtml(String(q.group || ""))}"
                   placeholder="e.g. Screen condition" />
          </label>
        </div>
        <div class="rule-head__actions">
          <button class="btn btn--tiny" type="button" data-ck="q-up" data-q="${i}"
                  ${i === 0 ? "disabled" : ""} title="Move question up">↑</button>
          <button class="btn btn--tiny" type="button" data-ck="q-down" data-q="${i}"
                  ${i === total - 1 ? "disabled" : ""} title="Move question down">↓</button>
          <button class="btn btn--tiny btn--danger" type="button" data-ck="q-del" data-q="${i}"
                  title="Remove this question">✕</button>
        </div>
      </div>
      <p class="cell-sub"><code>${escapeHtml(String(q.id || "(no id)"))}</code> ·
        answer 1 is the clean one</p>
      <div class="ck-opts">${rows || `<p class="empty">No answers yet.</p>`}</div>
      <button class="btn btn--small btn--ghost" type="button" data-ck="opt-add" data-q="${i}">+ Answer</button>
    </section>`;
}

function renderChecklist() {
  const host = el("checklist-list");
  if (!host) return;

  if (!checklistQuestions) {
    host.innerHTML = `<p class="empty">Loading…</p>`;
    return;
  }

  if (checklistQuestions.length === 0) {
    host.innerHTML = `<p class="empty">
      No questions yet.
      <span class="cell-sub">
        Until there is at least one, the agent's job card keeps the old
        pass/fail list — so an empty checklist breaks nothing.
        “Fill in the standard checklist” gives you a set to edit.
      </span>
    </p>`;
  } else {
    host.innerHTML = checklistQuestions
      .map((q, i) => checklistCard(q, i, checklistQuestions.length))
      .join("");
  }

  const groups = el("ck-groups");
  if (groups) {
    const names = [...new Set(checklistQuestions.map((q) => String(q.group || "").trim()).filter(Boolean))];
    groups.innerHTML = names.map((n) => `<option value="${escapeHtml(n)}"></option>`).join("");
  }

  const save = el("checklist-save");
  if (save) {
    save.disabled = !checklistDirty;
    // Restored here, not in the save handler. This button lives in the
    // toolbar and survives a render, where the pricing cards' Save buttons
    // are rebuilt with their card and come back labelled correctly for
    // free — which is why that editor never needed this and this one did.
    save.textContent = "Save";
  }
}

function markChecklistDirty() {
  checklistDirty = true;
  const save = el("checklist-save");
  if (save) save.disabled = false;
}

async function loadChecklist() {
  if (checklistLoading) return;
  checklistLoading = true;
  try {
    const snap = await getDoc(doc(db, "inspection_checklist", CHECKLIST_DOC));
    const raw = snap.exists() ? snap.data()?.questions : [];
    checklistQuestions = Array.isArray(raw)
      ? raw.map((q) => ({
          id: String(q?.id || ""),
          group: String(q?.group || ""),
          question: String(q?.question || ""),
          hint: String(q?.hint || ""),
          options: Array.isArray(q?.options) ? q.options.map(normaliseOption) : [],
        }))
      : [];
    checklistDirty = false;
    renderChecklist();
  } catch (e) {
    const host = el("checklist-list");
    if (host) {
      host.innerHTML = `<p class="empty empty--error">Could not load the checklist: ${escapeHtml(e.message)}</p>`;
    }
  } finally {
    checklistLoading = false;
  }
}

/// A stable key for a question, derived from its wording.
///
/// The answers are filed on the order against this id, so a question that is
/// reworded keeps its history only if the id does not move with it. Generated
/// once, when the question is created, and never recomputed.
function checklistId(question, taken) {
  const base =
    String(question || "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 40) || "question";
  let id = base;
  let n = 2;
  while (taken.has(id)) id = `${base}_${n++}`;
  taken.add(id);
  return id;
}

el("checklist-refresh")?.addEventListener("click", () => {
  checklistQuestions = null;
  renderChecklist();
  loadChecklist();
});

el("checklist-add")?.addEventListener("click", () => {
  if (!checklistQuestions) return;
  const taken = new Set(checklistQuestions.map((q) => q.id).filter(Boolean));
  checklistQuestions.push({
    id: checklistId(`question ${checklistQuestions.length + 1}`, taken),
    group: checklistQuestions.at(-1)?.group || "",
    question: "",
    hint: "",
    options: [
      { label: "", percent: 0 },
      { label: "", percent: 0 },
    ],
  });
  markChecklistDirty();
  renderChecklist();
});

el("checklist-seed")?.addEventListener("click", () => {
  if (!checklistQuestions) return;
  const have = new Set(checklistQuestions.map((q) => q.id));
  // Adds what is missing rather than replacing: a shop that has already
  // reworded half of these should not lose that by pressing the button.
  let added = 0;
  for (const q of STANDARD_CHECKLIST) {
    if (have.has(q.id)) continue;
    checklistQuestions.push({ ...q, options: q.options.map(normaliseOption) });
    added++;
  }
  if (added === 0) {
    toast("Every standard question is already here.", "success");
    return;
  }
  markChecklistDirty();
  renderChecklist();
  toast(`Added ${added} question${added === 1 ? "" : "s"} — edit, then Save.`, "success");
});

el("checklist-list")?.addEventListener("input", (e) => {
  const input = e.target.closest("[data-q]");
  if (!input || !checklistQuestions) return;
  const q = checklistQuestions[Number(input.dataset.q)];
  if (!q) return;

  if (input.dataset.ckField) {
    q[input.dataset.ckField] = input.value;
    // An id is minted the first time a question is actually named, so a
    // blank row added and then filled in gets a key that means something.
    if (input.dataset.ckField === "question" && !String(q.id || "").trim()) {
      const taken = new Set(checklistQuestions.map((x) => x.id).filter(Boolean));
      q.id = checklistId(input.value, taken);
    }
  } else if (input.dataset.opt !== undefined) {
    const o = q.options[Number(input.dataset.opt)];
    o.label = input.value;
  } else if (input.dataset.pct !== undefined) {
    const n = Math.round(Number(input.value));
    q.options[Number(input.dataset.pct)].percent =
      Number.isFinite(n) && n > 0 ? Math.min(100, n) : 0;
  }
  markChecklistDirty();
});

el("checklist-list")?.addEventListener("click", (e) => {
  const btn = e.target.closest("[data-ck]");
  if (!btn || !checklistQuestions) return;
  const qi = Number(btn.dataset.q);
  const q = checklistQuestions[qi];
  if (!q) return;
  const oi = Number(btn.dataset.opt);

  const swap = (arr, a, b) => {
    if (a < 0 || b < 0 || a >= arr.length || b >= arr.length) return;
    [arr[a], arr[b]] = [arr[b], arr[a]];
  };

  switch (btn.dataset.ck) {
    case "opt-add":
      q.options.push({ label: "", percent: 0 });
      break;
    case "opt-del":
      q.options.splice(oi, 1);
      break;
    case "opt-up":
      swap(q.options, oi, oi - 1);
      break;
    case "opt-down":
      swap(q.options, oi, oi + 1);
      break;
    case "q-up":
      swap(checklistQuestions, qi, qi - 1);
      break;
    case "q-down":
      swap(checklistQuestions, qi, qi + 1);
      break;
    case "q-del":
      checklistQuestions.splice(qi, 1);
      break;
    default:
      return;
  }
  markChecklistDirty();
  renderChecklist();
});

el("checklist-save")?.addEventListener("click", async () => {
  if (!checklistQuestions) return;
  const btn = el("checklist-save");

  const cleaned = checklistQuestions.map((q) => ({
    id: String(q.id || "").trim(),
    group: String(q.group || "").trim(),
    question: String(q.question || "").trim(),
    hint: String(q.hint || "").trim(),
    options: (q.options || [])
      .map((o) => ({ label: optLabel(o).trim(), percent: optPercent(o) }))
      .filter((o) => o.label)
      .map((o, j) => (j === 0 ? { ...o, percent: 0 } : o)),
  }));

  const unnamed = cleaned.filter((q) => !q.question || !q.id);
  if (unnamed.length) {
    toast("Every question needs its wording.", "error");
    return;
  }
  // Two answers is the minimum that is a question at all: with one there is
  // nothing for the agent to decide, and the card would render a row they
  // cannot answer.
  const thin = cleaned.filter((q) => q.options.length < 2);
  if (thin.length) {
    toast("Every question needs at least two answers.", "error");
    return;
  }
  const ids = cleaned.map((q) => q.id);
  if (new Set(ids).size !== ids.length) {
    toast("Two questions share an id — rename one.", "error");
    return;
  }

  btn.disabled = true;
  const previous = btn.textContent;
  btn.textContent = "Saving…";
  try {
    await setDoc(
      doc(db, "inspection_checklist", CHECKLIST_DOC),
      { questions: cleaned },
      { merge: true }
    );
    checklistQuestions = cleaned;
    checklistDirty = false;
    btn.textContent = previous;
    toast("Checklist saved — agents see it on their next job.", "success");
    renderChecklist();
  } catch (err) {
    toast("Could not save: " + err.message, "error");
    btn.disabled = false;
    btn.textContent = previous;
  }
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
    // Only the inspector record. This used to also mirror name and email onto
    // `users/{uid}`, which the security rules correctly refuse: that document
    // belongs to the person it describes, and an admin is not them. The write
    // threw, the error was reported, and the list never refreshed — so a
    // colleague who HAD been created looked like a failure.
    //
    // Nothing needed it. Inspectors sign in to this panel, not the phone app,
    // and if one ever did the app writes its own user document on first
    // launch.
    await setDoc(doc(db, "inspectors", uid), {
      name,
      email,
      createdAt: serverTimestamp(),
      active: true,
    });
  } catch (err) {
    toast(
      "Account made, but saving their details failed: " + err.message,
      "error"
    );
    // Still refresh: the auth account exists either way, and showing whatever
    // did land beats leaving the admin guessing whether to try again.
    await loadInspectors();
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
  // Every order row builds its assignment dropdown from `inspectors`, so a
  // newly added colleague is invisible in those dropdowns until the table is
  // rebuilt. Without this the only way to assign to them was to sign out and
  // back in, which is how this was found.
  if (currentRole === "admin" && lastOrders.length > 0) {
    renderOrders(lastOrders);
  }
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

let inspectorOrders = null;

function startInspectorListener(uid) {
  const host = el("inspector-list");
  if (host) host.innerHTML = `<p class="empty">Loading your pickups…</p>`;
  const q = query(collection(db, "orders"), where("inspectorId", "==", uid));
  inspectorUnsub = onSnapshot(
    q,
    (snap) => {
      // Kept, so the checklist arriving after the first snapshot can redraw
      // the cards with the questions in them rather than wait for the next
      // change to an order.
      inspectorOrders = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      renderInspectorJobs(inspectorOrders);
    },
    (err) => {
      const host = el("inspector-list");
      if (!host) return;
      // An inspector has no way to interpret a Firestore error and no console
      // to look in, so it says what it means for them.
      const permissions = /permission|insufficient/i.test(err.message || "");
      host.innerHTML = `<p class="empty empty--error">
        ${permissions
          ? "Your account cannot load pickups. Ask an admin to check you are still listed as an inspector."
          : `Could not load your pickups: ${escapeHtml(err.message)}`}
      </p>`;
    }
  );
}

// A maps link, or nothing.
//
// The coordinates come out of Firestore, which means a client wrote them, so
// they are not trusted to be numbers however reliably the app sends them. A
// string carrying a quote would otherwise close the href and inject markup
// into this page — every other field in the card is escaped, and these were
// the two that were not.
//
// Validated rather than escaped: a latitude that is not a finite number in
// range is not a coordinate at all, and linking to it would be meaningless
// even if it were safe.
function mapLink(lat, lng) {
  // Rejected before Number(), which turns null and "" into 0 — a valid
  // coordinate, in the Gulf of Guinea, and not where the pickup is.
  if (lat === null || lat === undefined || lat === "") return "";
  if (lng === null || lng === undefined || lng === "") return "";
  const y = Number(lat);
  const x = Number(lng);
  if (!Number.isFinite(y) || !Number.isFinite(x)) return "";
  if (y < -90 || y > 90 || x < -180 || x > 180) return "";
  const q = encodeURIComponent(`${y},${x}`);
  // Directions rather than a plain pin: this opens the Maps app on a phone
  // with the route already drawn from wherever the inspector is standing, so
  // the distance and drive time are on screen without them typing anything.
  // `travelmode=driving` because they are going by road with a phone to
  // collect.
  return `<a class="btn btn--small btn--primary" target="_blank" rel="noopener"
             href="https://www.google.com/maps/dir/?api=1&destination=${q}&travelmode=driving">Directions</a>`;
}

// What the seller said was wrong with the phone, and what it cost them.
//
// This is the whole point of the inspector's visit: they are checking these
// specific claims against the handset in their hand. Without it they arrive
// knowing only the model and the price, and have to ring the office to find
// out what was declared.
// Where to go, who to ask for, and when it was placed.
//
// Every field here is already on the order document, so the whole block costs
// nothing to render. The customer's name is copied onto the order at checkout
// for exactly that reason — looking it up from `users/{uid}` would be one read
// per job, every time this screen opened.
// A tel: link, because the usual reason a pickup fails is nobody answering the
// door and the inspector having no way to ring ahead.
//
// Stripped to digits and a leading plus before it goes in the href: the number
// came from a user profile, so it is not trusted to be a number, and anything
// else in an href is an injection waiting to happen.
function callLink(phone) {
  if (!phone) return "";
  const digits = String(phone).replace(/[^\d+]/g, "");
  if (digits.length < 6) return "";
  return `<a class="btn btn--small" href="tel:${encodeURIComponent(digits)}">Call</a>`;
}

function pickupBlock(order) {
  const rows = [];

  const who = [order.customerName, order.customerPhone]
    .filter(Boolean)
    .map((v) => escapeHtml(String(v)));
  if (who.length) {
    rows.push(`<div class="job-card__who">${who.join(" · ")}</div>`);
  }

  if (order.addressFullText || order.addressLabel) {
    const label = order.addressLabel
      ? `<strong>${escapeHtml(String(order.addressLabel))}</strong> · `
      : "";
    rows.push(
      `<div class="job-card__address">${label}${escapeHtml(String(order.addressFullText || ""))}</div>`
    );
  }

  if (order.createdAt) {
    rows.push(`<div class="cell-sub">Placed ${escapeHtml(formatDate(order.createdAt))}</div>`);
  }

  return rows.join("");
}

// --- What the phone measured -----------------------------------------------
//
// Each entry in an order's `checkup` array may carry a `data` map of what the
// test actually measured, beside the sentence in `detail` that a person reads.
// Most entries carry none, and an order placed before the app started sending
// it carries none at all — so everything here returns an empty list rather
// than an empty container. An older order has to render exactly as it did.
//
// None of it touches a figure. The checkup is evidence for the inspector, not
// an input to the quote.

// `capacityHealth` is what a test page happens to call a variable; it is not
// something to read off a doorstep. The keys we know about are spelled out in
// words, in this order. Keys nobody has written yet are still shown, with
// their name unpicked as best we can — the next test page to land will add
// some, and a measurement shown awkwardly beats one silently dropped.
const MEASURED_LABELS = {
  capacityHealth: ["Capacity", (v) => `${tidyNumber(v)}% of original`],
  cycleCount: ["Charge cycles", (v) => tidyNumber(v)],
  healthFlag: ["Condition", (v) => measuredWords(v)],
  temperatureCelsius: ["Temperature", (v) => `${tidyNumber(v)} °C`],
  peakTemperatureCelsius: ["Peak temperature", (v) => `${tidyNumber(v)} °C`],
  sustainedRatio: [
    "Sustained speed",
    // A ratio, not a percentage, so it is the one figure here that has to be
    // multiplied — and the only one that would print "NaN%" if a test ever
    // put something other than a number in it.
    (v) => (Number.isFinite(Number(v)) ? `${Math.round(Number(v) * 100)}% of peak` : String(v)),
  ],
  seconds: ["Measured over", (v) => `${tidyNumber(v)}s`],
  thermalStatus: ["Thermal status", (v) => measuredWords(v)],
  thermalHeadroom: ["Thermal headroom", (v) => tidyNumber(v)],
  biometric: ["Sensor", (v) => measuredWords(v)],
};

// The platform's own vocabulary, as the app words it (see `_flagWords` in
// `checkup/battery_test_page.dart`). An unknown flag is shown as it came.
const MEASURED_WORDS = {
  good: "good",
  overheat: "overheating",
  dead: "dead",
  over_voltage: "over voltage",
  cold: "too cold to judge",
  failure: "failed",
};

function measuredWords(value) {
  const raw = String(value);
  return MEASURED_WORDS[raw] || raw.replace(/_/g, " ");
}

// Enough precision to be the measurement it is, and no more: 72, 38.27, 0.97,
// never 38.266666666666666 — and never rounded so hard that a figure under 1
// becomes 1.
function tidyNumber(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return String(value);
  return String(Math.round(n * 100) / 100);
}

// `capacityHealth` -> `Capacity health`, for a key this panel has never seen.
function unpickKey(key) {
  const words = String(key)
    .replace(/[_-]+/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

// `[label, value]` pairs for one entry's `data`, known keys first.
//
// Only numbers, strings and booleans — the same three kinds the app filters
// its map down to before writing it, so anything else here arrived from
// somewhere this panel does not know about and is left out rather than
// stringified into the inspector's face.
function measuredValues(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) return [];

  const known = Object.keys(MEASURED_LABELS).filter((k) => k in data);
  const rest = Object.keys(data).filter((k) => !(k in MEASURED_LABELS));

  const out = [];
  for (const key of [...known, ...rest]) {
    const value = data[key];
    if (typeof value === "boolean") {
      out.push([MEASURED_LABELS[key]?.[0] || unpickKey(key), value ? "yes" : "no"]);
      continue;
    }
    if (typeof value === "number" && !Number.isFinite(value)) continue;
    if (typeof value !== "number" && typeof value !== "string") continue;
    if (value === "") continue;

    const spec = MEASURED_LABELS[key];
    out.push([
      spec ? spec[0] : unpickKey(key),
      String(spec ? spec[1](value) : typeof value === "number" ? tidyNumber(value) : value),
    ]);
  }
  return out;
}

// The measured figures as one line under a test's own row. Empty string when
// the test measured nothing, so the row keeps the shape it has always had.
function measuredLine(data) {
  const values = measuredValues(data);
  if (values.length === 0) return "";
  return `<span class="cell-sub job-detail__measured">${values
    .map(([label, value]) => `${escapeHtml(label)} <strong>${escapeHtml(value)}</strong>`)
    .join(" · ")}</span>`;
}

// --- The battery figure, against the band the seller chose ------------------
//
// The seller grades their own battery in the sell wizard and that band is
// worth up to 35% of the quote. Checking that grading is what the inspector
// has come to do, and until the app started sending `data` they had the
// phone's reading only as prose. The two belong side by side.

// The capacity reading off an order, or null. Never an estimate: the app
// deliberately refuses to turn a cycle count into a health percentage (see
// `estimatedHealthFromCycles` in `shared/services/battery_band.dart`, which
// exists only to record why), so neither does this.
function batteryReading(order) {
  const results = Array.isArray(order.checkup) ? order.checkup : [];
  for (const r of results) {
    const health = r?.data?.capacityHealth;
    if (typeof health !== "number" || !Number.isFinite(health) || health <= 0) continue;
    const cycles = r.data.cycleCount;
    return {
      health: Math.round(health),
      cycles:
        typeof cycles === "number" && Number.isFinite(cycles) && cycles > 0
          ? Math.round(cycles)
          : null,
    };
  }
  return null;
}

function isBatteryLine(line) {
  return /batter/i.test(String(line?.category || ""));
}

// Does the band label the seller picked cover a measured figure?
//
// Ported from `batteryBandFor` in the app's `shared/services/battery_band.dart`
// and matching by reading the numbers out of the label, for the same reason:
// the bands live in `deduction_rules` and staff reword and reorder them, so an
// index would break silently. Returns null when the label has no numbers to
// compare against, which is not a disagreement.
function bandCovers(health, label) {
  const numbers = (String(label || "").match(/\d+/g) || []).map(Number);
  if (numbers.length === 0) return null;

  const lower = String(label).toLowerCase();
  if (lower.includes("below") || lower.includes("under")) return health < numbers[0];
  if (numbers.length >= 2) {
    return health >= Math.min(...numbers) && health <= Math.max(...numbers);
  }
  return health >= numbers[0];
}

// The reading, worded for the band standing next to it.
//
// Display only — nothing here recalculates a payout. It says so when the
// measurement falls outside the band the seller chose, because that
// disagreement is the whole reason the figure is on the order; a band with no
// numbers in it, or no band at all, is not a disagreement and is not
// coloured.
function batteryAgainstBand(reading, choice) {
  const measured =
    `Phone measured ${reading.health}% of original capacity` +
    (reading.cycles ? ` after ${reading.cycles} charge cycles` : "");
  const off = choice == null ? false : bandCovers(reading.health, choice) === false;
  return { text: off ? `${measured} — outside the band chosen` : measured, off };
}

function batteryBandSub(reading, choice) {
  const { text, off } = batteryAgainstBand(reading, choice);
  return `<span class="cell-sub job-detail__measured${
    off ? " job-detail__measured--off" : ""
  }">${escapeHtml(text)}</span>`;
}

function batteryBandEm(reading, choice) {
  const { text, off } = batteryAgainstBand(reading, choice);
  return `<em class="detail-measured${off ? " detail-measured--off" : ""}">${escapeHtml(
    text
  )}</em>`;
}

// --- Before you knock ------------------------------------------------------
//
// The order document has been carrying things nobody could see: which phone
// the self-check actually ran on, whether the handset switches on at all,
// whether the quote has lapsed. All of it decides what an agent does at the
// door, and all of it was landing in a JSON dump at the bottom of a sheet.
//
// Each note appears only when there is something to say. An order that says
// none of these things renders exactly as it did — the usual rule here, and
// the reason this returns "" rather than an empty box.

// How a provenance reads to the person holding the phone.
//
// `unverified` is the honest default and the status quo: most Android
// handsets report a sales code where a model name should be and can never be
// matched by string. It is not a suspicion and must not be dressed as one —
// only `otherDevice` is a mismatch anybody established.
const PROVENANCE_NOTES = {
  onDevice: {
    tone: "good",
    text: "The self-check ran on this phone.",
    sub: "Its results describe the handset you are collecting.",
  },
  otherDevice: {
    tone: "warn",
    text: "The self-check ran on a different phone.",
    sub:
      "The seller went ahead knowing that. Those results describe the other " +
      "handset — check this one yourself.",
  },
  unverified: {
    tone: "plain",
    text: "The self-check could not be tied to this phone.",
    sub:
      "Normal: most Android handsets report a sales code instead of a model " +
      "name. It is not a sign of anything — just unproven either way.",
  },
};

function briefingNotes(order) {
  const notes = [];

  // Loudest, and first: nothing about this phone could be measured by
  // anybody, and the agent should know that before travelling.
  if (order.deviceReachable === false) {
    notes.push({
      tone: "warn",
      text: "The seller says this phone will not switch on.",
      sub:
        order.provisionalQuote
          ? "The quote is provisional — it was never more than an estimate, " +
            "and settling it is the whole job at the door."
          : "Nothing could be measured before pickup.",
    });
  }

  const ran = Array.isArray(order.checkup) && order.checkup.length > 0;
  if (ran) {
    const note = PROVENANCE_NOTES[order.checkupProvenance] || PROVENANCE_NOTES.unverified;
    const device = order.checkupDevice;
    const named = device
      ? [device.brand || device.manufacturer, device.model]
          .filter(Boolean)
          .join(" ")
      : "";
    const os = device ? [device.os, device.osVersion].filter(Boolean).join(" ") : "";
    notes.push({
      ...note,
      sub: [note.sub, named || os ? `Handset read as ${[named, os].filter(Boolean).join(" · ")}.` : ""]
        .filter(Boolean)
        .join(" "),
    });
  } else if (order.deviceReachable !== false) {
    notes.push({
      tone: "plain",
      text: "The seller skipped the self-check.",
      sub: "Nothing was measured before pickup — everything here is what they declared.",
    });
  }

  // A quote nobody is bound by any more. Worth knowing before the figure is
  // read out at somebody's door rather than after.
  const lapsed = lapsedAt(order.quoteValidUntil);
  if (lapsed) {
    notes.push({
      tone: "warn",
      // Escaped once, by the renderer below.
      text: `This quote lapsed on ${formatDate(order.quoteValidUntil)}.`,
      sub: "Confirm the figure before collecting.",
    });
  }

  if (order.quote?.floored) {
    notes.push({
      tone: "plain",
      text: "The payout hit the minimum floor.",
      sub:
        "Deductions came to more than 90% of the base price, so the lines " +
        "below deliberately do not add up to the figure paid.",
    });
  }

  return notes;
}

function lapsedAt(ts) {
  const date = ts?.toDate ? ts.toDate() : ts instanceof Date ? ts : null;
  return date && date.getTime() < Date.now();
}

function briefingBlock(order) {
  const notes = briefingNotes(order);
  if (notes.length === 0) return "";

  return notes
    .map(
      (n) => `
      <div class="job-note job-note--${n.tone}">
        <strong>${escapeHtml(n.text)}</strong>
        ${n.sub ? `<span class="cell-sub">${escapeHtml(n.sub)}</span>` : ""}
      </div>`
    )
    .join("");
}

function conditionBlock(order) {
  const lines = Array.isArray(order.quote?.lines) ? order.quote.lines : [];
  const battery = batteryReading(order);
  if (lines.length === 0 && !battery) return "";

  // Only the deductions. A line worth nothing was answered in the phone's
  // favour and is not something to go and verify.
  const faults = lines.filter((l) => Number(l.amount) > 0);

  return `
    <details class="job-detail" open>
      <summary>Seller declared${faults.length ? ` — ${faults.length} to check` : " — nothing wrong"}</summary>
      ${lines
        .map(
          (l) => `
        <div class="job-detail__row ${Number(l.amount) > 0 ? "job-detail__row--fault" : ""}">
          <span class="job-detail__what">
            ${escapeHtml(String(l.category || ""))}
            <span class="cell-sub">${escapeHtml(String(l.choice || ""))}</span>
            ${battery && isBatteryLine(l) ? batteryBandSub(battery, l.choice) : ""}
          </span>
          <span class="job-detail__cost">${
            Number(l.amount) > 0 ? "-" + money(Number(l.amount)) : "—"
          }</span>
        </div>`
        )
        .join("")}
      ${battery && !lines.some(isBatteryLine)
        ? `<div class="job-detail__row">
             <span class="job-detail__what">
               Battery health
               <span class="cell-sub">Seller's band took nothing off</span>
               ${batteryBandSub(battery, null)}
             </span>
             <span class="job-detail__cost">—</span>
           </div>`
        : ""}
      ${order.quote?.basePrice
        ? `<div class="job-detail__row job-detail__row--total">
             <span>Base ${money(Number(order.quote.basePrice))}</span>
             <span>${money(Number(order.quote.finalPayout))}</span>
           </div>`
        : ""}
    </details>`;
}

// What the seller said was fine, which is the half of the claim nothing else
// here records.
//
// `quote.lines` — and so conditionBlock above — carries deductions only: a
// flawless screen writes no line, and a question answered the harmless way
// writes nothing at all. So an order could say the screen cost nothing only
// by saying nothing about the screen, and the agent at the door could not
// tell "the seller claimed perfect" from "nobody asked". The app writes
// `declared` beside the quote for exactly that. It is absent on every order
// placed before it existed, and both of its keys are optional.
//
// The claims that cost nothing are the rows, because they are the ones with
// nowhere else to appear and something to go and verify. What was charged for
// is already priced above, so it sits behind a line here rather than being
// listed twice.
function declaredBlock(order) {
  const selections = Array.isArray(order.declared?.selections)
    ? order.declared.selections
    : [];
  const answers = Array.isArray(order.declared?.answers)
    ? order.declared.answers
    : [];
  if (selections.length === 0 && answers.length === 0) return "";

  // `isFault` is read off the order rather than worked out from `answeredYes`:
  // whether an answer was the costly one depends on how the question was
  // phrased, and "has this had water damage? — yes" is the good answer to
  // nobody.
  const free = selections.filter((s) => !(Number(s.percent) > 0));
  const clean = answers.filter((a) => !a.isFault);
  const charged = [
    ...selections.filter((s) => Number(s.percent) > 0).map((s) => s.category),
    ...answers.filter((a) => a.isFault).map((a) => a.label || a.question),
  ]
    .map((t) => String(t || "").trim())
    .filter(Boolean);

  // Each row reads as a question and its answer. A graded step is the step
  // and the option picked; a yes/no question is the question itself and the
  // answer given. Not the fault label: "Phone does not power on — Yes" reads
  // as the opposite of what the seller said.
  //
  // `source: 'checkup'` marks an answer the phone measured on itself, in
  // which case the seller was never asked. Absent on every older order.
  const rows = [
    ...free.map((s) => ({
      what: s.category,
      said: s.choice || "—",
      measured: false,
    })),
    ...clean.map((a) => ({
      what: a.question || a.label,
      said: a.answeredYes ? "Yes" : "No",
      measured: a.source === "checkup",
    })),
  ];
  const measuredCount = rows.filter((r) => r.measured).length;

  return `
    <details class="job-detail">
      <summary>${
        measuredCount ? "Said fine or checked by phone" : "Seller said fine"
      } — ${rows.length ? `${rows.length} to verify` : "nothing"}</summary>
      ${rows
        .map(
          (r) => `
        <div class="job-detail__row">
          <span class="job-detail__what">
            ${escapeHtml(String(r.what || ""))}
            <span class="cell-sub">${
              r.measured ? "Checked by the phone" : "Seller's answer"
            }</span>
          </span>
          <span class="job-detail__cost">${escapeHtml(String(r.said))}</span>
        </div>`
        )
        .join("")}
      ${charged.length
        ? `<div class="cell-sub job-detail__passed">
             Already on the quote: ${charged.map(escapeHtml).join(", ")} —
             priced above, and not a claim anyone has to go and check.
           </div>`
        : ""}
    </details>`;
}

// What the phone said about itself, when the seller ran the automatic check.
//
// Failures first and open by default; passes collapsed behind a count. An
// inspector needs to know what to look at, not read twenty green ticks.
function checkupBlock(order) {
  const results = Array.isArray(order.checkup) ? order.checkup : [];
  if (results.length === 0) return "";

  const failed = results.filter((r) => r.status === "fail");
  const skipped = results.filter((r) => r.status === "skipped");
  const passed = results.filter((r) => r.status === "pass");

  // A test that passed and measured something gets a row of its own. The
  // figures are the reason this array is worth reading at the door — the
  // battery's capacity usually arrives on a pass — while the ticks that
  // measured nothing stay behind the count, which is the point of the split.
  const measured = passed.filter((r) => measuredValues(r.data).length > 0);
  const quiet = passed.filter((r) => measuredValues(r.data).length === 0);

  // Tests the handset would not answer. Named, because an agent who cannot
  // see them has no way to tell a test that passed from one that never ran —
  // but kept well away from the failures, since reporting nothing is not a
  // fault and was never charged for.
  const silent = results.filter((r) => r.status === "notAvailable");

  return `
    <details class="job-detail" ${failed.length ? "open" : ""}>
      <summary>
        Phone self-check —
        ${failed.length} failed, ${passed.length} passed${
          skipped.length ? `, ${skipped.length} skipped` : ""
        }
      </summary>
      ${[...failed, ...skipped, ...measured]
        .map(
          (r) => `
        <div class="job-detail__row ${r.status === "fail" ? "job-detail__row--fault" : ""}">
          <span class="job-detail__what">
            ${escapeHtml(String(r.title || r.key || ""))}
            ${r.detail ? `<span class="cell-sub">${escapeHtml(String(r.detail))}</span>` : ""}
            ${measuredLine(r.data)}
          </span>
          <span class="job-detail__cost">${
            r.status === "fail" ? "FAIL" : r.status === "skipped" ? "skipped" : "pass"
          }</span>
        </div>`
        )
        .join("")}
      ${quiet.length
        ? `<div class="cell-sub job-detail__passed">Passed: ${quiet
            .map((r) => escapeHtml(String(r.title || r.key || "")))
            .join(", ")}</div>`
        : ""}
      ${silent.length
        ? `<div class="cell-sub job-detail__passed">
             Not reported by this phone: ${silent
               .map((r) => escapeHtml(String(r.title || r.key || "")))
               .join(", ")}
             <span class="cell-sub">
               The handset would not answer these. On an iPhone that is most
               of them — it is not a fault and nothing was deducted for it.
             </span>
           </div>`
        : ""}
    </details>`;
}

// --- What the agent found, item by item -------------------------------------
//
// The seller grades their own phone in the app, and until now an agent arrived
// with that list and a single free-text box: whatever they noticed went into
// `reason`, or nowhere. A disagreement afterwards came down to one sentence
// typed in a doorway.
//
// These are the defects a buyback agent is actually sent to look for, each
// answered Pass or Fail. They ride along with the finding, so they carry the
// agent's own id and a server timestamp like everything else recorded there.
//
// Nothing here moves a figure. The amount stays a number the agent types
// deliberately — a checklist that silently repriced the phone would be exactly
// the quiet deduction this whole record exists to prevent. What the faults do
// is explain the number.

// Where a declared fault was, when the wording says so. "Crack" on its own
// belongs to no row: the screen and the body both crack, and guessing wrong
// puts an orange note against a defect the seller never claimed.
const CHECK_SCREEN = /screen|écran|ecran|display|glass|vitre|lcd/i;
const CHECK_BODY = /body|back|rear|frame|chassis|châssis|dos|coque|housing/i;

// Severity words, for the two rows that are the same defect twice. A plain
// "discoloration" suggests neither — it gets the note and the agent picks.
const CHECK_MINOR = /minor|light|slight|small|léger|leger|petit|faible/i;
const CHECK_MAJOR = /major|heavy|severe|deep|large|important|grave|fort/i;

// French as well as English in every pattern: the categories come out of
// `deduction_rules`, which staff write, and a mapping that silently never
// matches would look exactly like a seller who declared nothing.
const CONDITION_CHECKS = [
  // The screen first. It is most of the phone's value and the thing the agent
  // is standing there holding up to the light.
  {
    id: "screen_crack",
    group: "Screen",
    label: "Crack on screen",
    hint: "Any crack in the glass, however fine",
    where: CHECK_SCREEN,
    what: /crack|shatter|fissur|bris|cass/i,
  },
  {
    id: "screen_discolour_minor",
    group: "Screen",
    label: "Minor discoloration",
    hint: "A patch or tint that does not spread across the panel",
    where: CHECK_SCREEN,
    what: /discolo|décolor|decolor|tint|tache|yellow|shadow/i,
    severity: "minor",
  },
  {
    id: "screen_discolour_major",
    group: "Screen",
    label: "Major discoloration",
    hint: "Spreading stain, bleeding backlight, dead area",
    where: CHECK_SCREEN,
    what: /discolo|décolor|decolor|bleed|dead pixel|burn|stain/i,
    severity: "major",
  },
  {
    id: "screen_lifting",
    group: "Screen",
    label: "Screen coming out",
    hint: "Panel lifting from the frame anywhere along the edge",
    where: CHECK_SCREEN,
    what: /lift|coming out|detach|separat|décoll|decoll|gap/i,
  },

  // Then the body, roughly in the order a phone gets turned over in the hand.
  {
    id: "body_dents",
    group: "Body",
    label: "Dents",
    hint: "Anything you can feel with a thumb",
    what: /dent|bosse|ding/i,
  },
  {
    id: "body_scratches",
    group: "Body",
    label: "Scratches",
    hint: "Ten or more light ones, or a single deep one",
    what: /scratch|rayure|scuff|éraflure|eraflure/i,
  },
  {
    id: "body_paint_peel",
    group: "Body",
    label: "Paint peel",
    what: /peel|paint|peinture|écaill|ecaill/i,
  },
  {
    id: "body_rust",
    group: "Body",
    label: "Rust",
    hint: "Usually around the ports and the SIM tray",
    what: /rust|rouille|corros/i,
  },
  {
    id: "body_bent",
    group: "Body",
    label: "Body bent",
    hint: "Lay it face down on a flat surface and press a corner",
    what: /bent|bend|warp|tordu|plié|plie|voilé|voile/i,
  },
  {
    id: "body_crack",
    group: "Body",
    label: "Crack on body",
    where: CHECK_BODY,
    what: /crack|shatter|fissur|bris|cass/i,
  },
  {
    id: "missing_parts",
    group: "Body",
    label: "Missing parts",
    hint: "SIM tray, back cover, camera glass, a button",
    what: /missing|manquant|absent|lost|perdu/i,
  },

  // Signs of a panel that has been off the phone before. None of them is
  // visible with the screen lit, which is why they are a separate look.
  {
    id: "screen_bubbles",
    group: "Screen fitting",
    label: "Air bubbles under the screen",
    where: CHECK_SCREEN,
    what: /bubble|bulle/i,
  },
  {
    id: "screen_dust",
    group: "Screen fitting",
    label: "Dust under the screen",
    where: CHECK_SCREEN,
    what: /dust|poussi/i,
  },
  {
    id: "screen_colour_mismatch",
    group: "Screen fitting",
    label: "Mismatched screen colour",
    hint: "Whites or blacks that do not match the original panel",
    where: CHECK_SCREEN,
    what: /mismatch|replaced|remplac|aftermarket|non-?genuine|not original|copie/i,
  },
];

// The seller's own account of the phone, as one searchable line per claim.
//
// Three shapes say it: `quote.lines` (the deductions the wizard priced),
// `declared.selections` (every graded step, including the ones that cost
// nothing) and `declared.answers` (the yes/no questions). The first two
// overlap, which costs nothing here — a claim matched twice is still the same
// claim. An order placed before `declared` existed carries only the first, and
// one with none of them simply gets no suggestions.
function declaredClaims(order) {
  const claims = [];
  // `said` names the claim as a fault ("Battery Not Charging"), for the
  // notes on a charged item. `fine` reads it as the question and its answer,
  // for the clean ones — a fault name beside "fine" reads backwards.
  const push = (text, isFault, said, { fine, measured = false } = {}) => {
    const t = String(text || "").trim();
    if (t) {
      const name = String(said || t).trim();
      claims.push({ text: t, isFault, said: name, fine: fine || name, measured });
    }
  };

  for (const l of Array.isArray(order.quote?.lines) ? order.quote.lines : []) {
    push(`${l.category || ""} ${l.choice || ""}`, Number(l.amount) > 0, l.choice || l.category);
  }
  for (const s of Array.isArray(order.declared?.selections) ? order.declared.selections : []) {
    push(`${s.category || ""} ${s.choice || ""}`, Number(s.percent) > 0, s.choice || s.category);
  }
  for (const a of Array.isArray(order.declared?.answers) ? order.declared.answers : []) {
    // `isFault` rather than `answeredYes`: whether an answer was the costly one
    // depends on how the question was phrased, and "has this had water damage?
    // — yes" is the good answer to nobody.
    push(`${a.label || ""} ${a.question || ""}`, !!a.isFault, a.label || a.question, {
      fine: a.question
        ? `${a.question} ${a.answeredYes ? "Yes" : "No"}`
        : a.label,
      measured: a.source === "checkup",
    });
  }
  return claims;
}

// What the seller already said about one check, if anything.
//
// A suggestion is never an answer. It is shown beside the row and the buttons
// stay empty until somebody taps one, because the whole value of this list is
// that an agent looked — a prefilled verdict would record fourteen findings
// for a phone nobody turned over.
function checkSuggestion(check, claims) {
  const matches = claims.filter(
    (c) => check.what.test(c.text) && (!check.where || check.where.test(c.text))
  );
  if (matches.length === 0) return null;

  // A fault outranks a clean claim: if any wording matches and was charged
  // for, that is the one worth going to look at.
  const fault = matches.find((c) => c.isFault);
  if (!fault) {
    const m = matches[0];
    return {
      answer: "pass",
      note: m.measured
        ? `Phone checked fine: ${m.fine}`
        : `Seller said fine: ${m.fine}`,
    };
  }

  // The same defect listed twice at two severities. Without a word saying
  // which, neither row is the seller's claim, so the note goes on both and the
  // person holding the phone decides.
  if (check.severity) {
    const minor = CHECK_MINOR.test(fault.text);
    const major = CHECK_MAJOR.test(fault.text);
    if (!minor && !major) return { answer: null, note: `Seller declared: ${fault.said}` };
    if (check.severity === "minor" && !minor) return null;
    if (check.severity === "major" && !major) return null;
  }
  return { answer: "fail", note: `Seller declared: ${fault.said}` };
}

// The agent's answers, per order, kept outside the DOM.
//
// The job list re-renders on every snapshot — a status change made in the
// office redraws this card — and a checklist that lost half its answers
// because somebody touched the record would be worse than no checklist.
const checkAnswers = new Map();

function answersFor(orderId) {
  let answers = checkAnswers.get(orderId);
  if (!answers) {
    answers = {};
    checkAnswers.set(orderId, answers);
  }
  return answers;
}

function checkTally(answers) {
  const values = CONDITION_CHECKS.map((c) => answers[c.id]);
  const failed = values.filter((v) => v === "fail").length;
  const passed = values.filter((v) => v === "pass").length;
  return { failed, passed, left: CONDITION_CHECKS.length - failed - passed };
}

function checkSummaryText(t) {
  return `Agent checks — ${t.failed} fault${t.failed === 1 ? "" : "s"}, ` +
    `${t.passed} fine, ${t.left} not looked at`;
}

/// The name of a configured question, for a card rendering a filed answer.
function checklistLabel(id) {
  const q = (checklistQuestions || []).find((x) => x.id === id);
  return q?.question || unpickKey(id);
}

// The name of a recorded check, for a verdict written by a version of this
// panel that knew a check this one does not. Shown unpicked rather than
// dropped, the same way an unknown measurement is.
function checkLabel(id) {
  return CONDITION_CHECKS.find((c) => c.id === id)?.label || unpickKey(id);
}

/// The configured questions, or null to fall back to the pass/fail list.
///
/// Null rather than an empty array on purpose: a shop that has not filled the
/// checklist in keeps the fourteen built-in checks, so this ships without
/// taking the agent's existing list away on the day it lands.
function activeChecklist() {
  const qs = (checklistQuestions || []).filter(
    (q) => String(q.question || "").trim() && (q.options || []).length >= 2
  );
  return qs.length ? qs : null;
}

/// Whether an answer counts as something found.
///
/// The first answer on a question is the clean one by convention — "No
/// scratch", "No defect" — which is stated in the editor and numbered in it.
/// A flag per answer would be one more thing to keep correct and would say
/// nothing the ordering does not.
function isFinding(question, answer) {
  if (!answer) return false;
  return answer !== optLabel((question.options || [])[0]);
}

/// What the picked answers come to, as a percentage of the quoted payout.
///
/// Off the quote, not off `base_price`: the agent is adjusting the figure
/// the seller accepted, and the sell wizard has already taken the seller's
/// own declared condition off the base. Measuring against the base here
/// would deduct twice for the same phone.
function findingsTotal(questions, answers) {
  let percent = 0;
  const lines = [];
  for (const q of questions) {
    const picked = answers[q.id];
    if (!isFinding(q, picked)) continue;
    const opt = (q.options || []).find((o) => optLabel(o) === picked);
    const pct = optPercent(opt);
    lines.push({ question: q.question, answer: picked, percent: pct });
    percent += pct;
  }
  return { percent: Math.min(100, percent), lines };
}

/// The amount those findings suggest, or null when they suggest nothing.
function suggestedAmount(order, questions, answers) {
  const quoted = Number(order.finalPayout) || 0;
  const { percent } = findingsTotal(questions, answers);
  if (!quoted || percent <= 0) return null;
  return { percent, amount: Math.max(0, Math.round(quoted * (1 - percent / 100))) };
}

function suggestionHtml(order, questions, answers) {
  const s = suggestedAmount(order, questions, answers);
  if (!s) return "";
  const quoted = Number(order.finalPayout) || 0;
  return `
    <div class="ck-suggest">
      <span>
        Found <strong>${s.percent}%</strong> off the quoted ${money(quoted)} —
        <strong>${money(s.amount)}</strong>
      </span>
      <button type="button" class="btn btn--small btn--ghost"
              data-ck-use="${escapeHtml(order.id)}|${s.amount}">Use this</button>
    </div>`;
}

function gradedTally(questions, answers) {
  let found = 0;
  let clean = 0;
  for (const q of questions) {
    const a = answers[q.id];
    if (!a) continue;
    if (isFinding(q, a)) found++;
    else clean++;
  }
  return { failed: found, passed: clean, left: questions.length - found - clean };
}

function gradedChecksBlock(order, questions) {
  const answers = answersFor(order.id);
  let group = "";

  const rows = questions
    .map((q) => {
      const chosen = answers[q.id];
      let head = "";
      const g = String(q.group || "").trim();
      if (g && g !== group) {
        group = g;
        head = `<div class="check-group">${escapeHtml(g)}</div>`;
      }

      const opts = (q.options || [])
        .map((opt, j) => {
          const label = optLabel(opt);
          const pct = optPercent(opt);
          return `
          <button type="button"
                  class="ck-pick${chosen === label ? " is-on" : ""}${j === 0 ? " ck-pick--clean" : ""}"
                  aria-pressed="${chosen === label}"
                  data-ck-pick="${escapeHtml(order.id)}|${escapeHtml(q.id)}|${escapeHtml(String(j))}">
            ${escapeHtml(label)}
            ${pct > 0 ? `<span class="ck-pick__pct">\u2212${pct}%</span>` : ""}
          </button>`;
        })
        .join("");

      return `
        ${head}
        <div class="ck-row${isFinding(q, chosen) ? " ck-row--fault" : ""}"
             data-ck-row="${escapeHtml(order.id)}|${escapeHtml(q.id)}">
          <div class="ck-row__q">
            ${escapeHtml(String(q.question))}
            ${q.hint ? `<span class="cell-sub">${escapeHtml(String(q.hint))}</span>` : ""}
          </div>
          <div class="ck-row__opts">${opts}</div>
        </div>`;
    })
    .join("");

  const tally = gradedTally(questions, answers);
  return `
    <details class="job-detail job-detail--checks"${tally.failed ? " open" : ""}>
      <summary data-check-tally="${escapeHtml(order.id)}">${escapeHtml(checkSummaryText(tally))}</summary>
      <div class="cell-sub job-detail__passed">
        Pick what you found on each question. The first answer is the clean
        one. None of this changes the amount — it is saved with the figure you
        confirm, as the record of what the phone was.
      </div>
      ${rows}
      <div data-ck-suggest="${escapeHtml(order.id)}">${suggestionHtml(order, questions, answers)}</div>
    </details>`;
}

function checksBlock(order) {
  // Once a finding is filed the list is a record, not a form.
  if (order.inspection) return recordedChecksBlock(order);

  const questions = activeChecklist();
  if (questions) return gradedChecksBlock(order, questions);

  const claims = declaredClaims(order);
  const answers = answersFor(order.id);

  let group = "";
  const rows = CONDITION_CHECKS.map((check) => {
    const suggestion = checkSuggestion(check, claims);
    const answer = answers[check.id];
    let head = "";
    if (check.group !== group) {
      group = check.group;
      head = `<div class="check-group">${escapeHtml(group)}</div>`;
    }
    const button = (value, label) => `
      <button type="button"
              class="check__btn check__btn--${value}${answer === value ? " is-on" : ""}${
                !answer && suggestion?.answer === value ? " is-suggested" : ""
              }"
              aria-pressed="${answer === value}"
              data-check-set="${escapeHtml(order.id)}|${check.id}|${value}">${label}</button>`;

    return `
      ${head}
      <div class="check${answer === "fail" ? " check--fault" : ""}"
           data-check-row="${escapeHtml(order.id)}|${check.id}">
        <span class="check__what">
          ${escapeHtml(check.label)}
          ${check.hint ? `<span class="cell-sub">${escapeHtml(check.hint)}</span>` : ""}
          ${suggestion ? `<span class="check__declared">${escapeHtml(suggestion.note)}</span>` : ""}
        </span>
        <span class="check__answer">${button("pass", "Pass")}${button("fail", "Fail")}</span>
      </div>`;
  }).join("");

  const tally = checkTally(answers);
  return `
    <details class="job-detail job-detail--checks"${tally.failed ? " open" : ""}>
      <summary data-check-tally="${escapeHtml(order.id)}">${escapeHtml(checkSummaryText(tally))}</summary>
      <div class="cell-sub job-detail__passed">
        Fail means you found the defect. An outlined answer is the seller's own
        claim, not an answer — tap it to agree. The list is saved with the
        amount when you confirm.
      </div>
      ${rows}
    </details>`;
}

// The same list after the fact, for a card whose finding is already filed.
//
// Only the checks that were answered: a row nobody looked at is not a pass,
// and a list padded out to fourteen would say the phone was gone over when it
// was not. A verdict under an id this panel no longer knows is still shown.
function recordedChecksBlock(order) {
  const checks = order.inspection?.checks;
  if (!checks || typeof checks !== "object" || Array.isArray(checks)) return "";

  // Both shapes, because an order filed before the checklist existed holds
  // "pass"/"fail" and one filed after holds the answer the agent picked.
  // Neither is rewritten, so the record keeps saying what was actually
  // recorded at the time.
  const configured = checklistQuestions || [];
  const rows = Object.keys(checks)
    .map((id) => {
      const value = checks[id];
      if (typeof value !== "string" || !value) return null;

      if (value === "pass" || value === "fail") {
        const legacy = CONDITION_CHECKS.find((c) => c.id === id);
        return {
          id,
          group: legacy?.group || "",
          what: checkLabel(id),
          said: value === "fail" ? "FAIL" : "pass",
          fault: value === "fail",
        };
      }

      const q = configured.find((x) => x.id === id);
      return {
        id,
        group: q?.group || "",
        what: checklistLabel(id),
        said: value,
        // Without the question we cannot tell its clean answer from its
        // worst, so it is shown plainly rather than guessed at.
        fault: q ? isFinding(q, value) : false,
      };
    })
    .filter(Boolean);

  if (rows.length === 0) return "";

  // Configured order first, so the record reads the way the form did.
  const rank = (id) => {
    const i = configured.findIndex((q) => q.id === id);
    if (i !== -1) return i;
    const j = CONDITION_CHECKS.findIndex((c) => c.id === id);
    return j !== -1 ? configured.length + j : Number.MAX_SAFE_INTEGER;
  };
  rows.sort((a, b) => rank(a.id) - rank(b.id));

  const failed = rows.filter((r) => r.fault);
  return `
    <details class="job-detail"${failed.length ? " open" : ""}>
      <summary>
        Agent checks — ${failed.length} fault${failed.length === 1 ? "" : "s"}
        of ${rows.length} looked at
      </summary>
      ${rows
        .map(
          (r) => `
        <div class="job-detail__row ${r.fault ? "job-detail__row--fault" : ""}">
          <span class="job-detail__what">
            ${escapeHtml(r.what)}
            ${r.group ? `<span class="cell-sub">${escapeHtml(r.group)}</span>` : ""}
          </span>
          <span class="job-detail__cost">${escapeHtml(r.said)}</span>
        </div>`
        )
        .join("")}
    </details>`;
}

// The faults found, repeated under the reason box. The agent tapped them a
// moment ago; the sentence they have to type for a lower amount should not
// also be a feat of memory.
function faultHint(orderId) {
  const answers = checkAnswers.get(orderId) || {};
  const questions = activeChecklist();

  const names = questions
    ? findingsTotal(questions, answers).lines.map(
        (l) => `${l.question} — ${l.answer}${l.percent ? ` (${l.percent}%)` : ""}`
      )
    : CONDITION_CHECKS.filter((c) => answers[c.id] === "fail").map((c) => c.label);

  if (names.length === 0) return "";
  return `Faults you marked: ${names.map(escapeHtml).join(", ")}`;
}

// Only ids and verdicts this panel knows, because the rules cannot check the
// inside of the map — Firestore has no way to iterate one — and an agent's
// browser is the one place a stray key could come from.
function answeredChecks(orderId) {
  const answers = checkAnswers.get(orderId) || {};
  const out = {};

  const questions = activeChecklist();
  if (questions) {
    // Only answers that are actually one of this question's options. The
    // rules cannot look inside the map — Firestore cannot iterate one — so
    // an agent's browser is the only place a stray value could come from.
    for (const q of questions) {
      const a = answers[q.id];
      if (a && (q.options || []).some((o) => optLabel(o) === a)) out[q.id] = a;
    }
    return out;
  }

  for (const check of CONDITION_CHECKS) {
    if (answers[check.id] === "pass" || answers[check.id] === "fail") {
      out[check.id] = answers[check.id];
    }
  }
  return out;
}

function wireChecks(host, orders = []) {
  const questions = activeChecklist();

  // Drops the suggested figure into the amount box. A button rather than an
  // automatic fill: the agent is the one who has the phone in their hand,
  // and a number that changes itself under them is how a figure gets sent
  // that nobody chose. The reason box is prefilled from the findings for
  // the same reason the amount is not — it still has to be read.
  host.querySelectorAll("[data-ck-use]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const parts = String(btn.dataset.ckUse).split("|");
      const amount = Number(parts.pop());
      const orderId = parts.join("|");

      const input = host.querySelector(`[data-amount="${CSS.escape(orderId)}"]`);
      if (!input) return;
      input.value = String(amount);
      input.dispatchEvent(new Event("input", { bubbles: true }));

      const reason = host.querySelector(`[data-reason="${CSS.escape(orderId)}"]`);
      if (reason && !reason.value.trim()) {
        const found = findingsTotal(questions || [], answersFor(orderId)).lines;
        reason.value = found.map((l) => `${l.answer} (${l.percent}%)`).join("; ");
      }
    });
  });

  host.querySelectorAll("[data-ck-pick]").forEach((btn) => {
    btn.addEventListener("click", () => {
      // Split from the right, same reason as the pass/fail rows: the order
      // id is whatever is left, so an id carrying the separator cannot move
      // an answer onto another row.
      const parts = String(btn.dataset.ckPick).split("|");
      const index = Number(parts.pop());
      const questionId = parts.pop();
      const orderId = parts.join("|");

      const question = (questions || []).find((q) => q.id === questionId);
      if (!question) return;
      const value = (question.options || [])[index];
      if (value === undefined) return;

      const answers = answersFor(orderId);
      // Tapping the answer already showing clears it, so an agent who
      // mis-taps in a doorway can put the row back to unanswered rather than
      // leave a finding they did not mean.
      if (answers[questionId] === value) delete answers[questionId];
      else answers[questionId] = value;

      const row = btn.closest("[data-ck-row]");
      row.querySelectorAll("[data-ck-pick]").forEach((other) => {
        const on = other === btn && answers[questionId] === value;
        other.classList.toggle("is-on", on);
        other.setAttribute("aria-pressed", String(on));
      });
      row.classList.toggle("ck-row--fault", isFinding(question, answers[questionId]));

      const tally = host.querySelector(`[data-check-tally="${CSS.escape(orderId)}"]`);
      if (tally) {
        tally.textContent = checkSummaryText(gradedTally(questions, answers));
      }
      const faults = host.querySelector(`[data-check-faults="${CSS.escape(orderId)}"]`);
      if (faults) faults.innerHTML = faultHint(orderId);

      const slot = host.querySelector(`[data-ck-suggest="${CSS.escape(orderId)}"]`);
      const order = orders.find((o) => o.id === orderId);
      if (slot && order) {
        slot.innerHTML = suggestionHtml(order, questions, answers);
        // Re-rendered markup carries no listeners, so the new button is
        // wired where it is created rather than relying on the pass above.
        const use = slot.querySelector("[data-ck-use]");
        if (use) {
          use.addEventListener("click", () => {
            const amount = Number(String(use.dataset.ckUse).split("|").pop());
            const input = host.querySelector(`[data-amount="${CSS.escape(orderId)}"]`);
            if (!input) return;
            input.value = String(amount);
            input.dispatchEvent(new Event("input", { bubbles: true }));
            const reason = host.querySelector(`[data-reason="${CSS.escape(orderId)}"]`);
            if (reason && !reason.value.trim()) {
              reason.value = findingsTotal(questions, answers)
                .lines.map((l) => `${l.answer} (${l.percent}%)`)
                .join("; ");
            }
          });
        }
      }
    });
  });

  host.querySelectorAll("[data-check-set]").forEach((btn) => {
    btn.addEventListener("click", () => {
      // Split from the right: the order id is whatever is left, so an id
      // carrying the separator cannot shift the verdict onto another row.
      const parts = String(btn.dataset.checkSet).split("|");
      const value = parts.pop();
      const checkId = parts.pop();
      const orderId = parts.join("|");
      const answers = answersFor(orderId);

      // Tapping the answer already showing clears it. An agent who mis-taps in
      // a doorway should be able to put the row back to unanswered rather than
      // leave behind a verdict they did not mean.
      if (answers[checkId] === value) delete answers[checkId];
      else answers[checkId] = value;

      const row = btn.closest("[data-check-row]");
      row.querySelectorAll("[data-check-set]").forEach((other) => {
        const on = !!answers[checkId] && other.dataset.checkSet.endsWith(`|${answers[checkId]}`);
        other.classList.toggle("is-on", on);
        // The seller's claim stops being worth showing the moment somebody
        // answers the row themselves.
        other.classList.remove("is-suggested");
        other.setAttribute("aria-pressed", String(on));
      });
      row.classList.toggle("check--fault", answers[checkId] === "fail");

      const tally = host.querySelector(`[data-check-tally="${CSS.escape(orderId)}"]`);
      if (tally) tally.textContent = checkSummaryText(checkTally(answers));
      const faults = host.querySelector(`[data-check-faults="${CSS.escape(orderId)}"]`);
      if (faults) faults.innerHTML = faultHint(orderId);
    });
  });
}

// Confirming what the phone is actually worth, at the door.
//
// The app tells sellers "the final amount is confirmed when the agent inspects
// the phone at pickup". Until now nothing could record that, so the promise had
// no mechanism behind it and an inspector could only move the status along.
//
// The quote is never edited. A finding sits beside it, carrying who said so and
// when, so the two figures disagree in the open rather than one silently
// replacing the other — which is the difference between a dispute and a
// rewrite.
function inspectionBlock(order) {
  const quoted = Number(order.finalPayout) || 0;
  const done = order.inspection;

  if (done) {
    const confirmed = Number(done.confirmedPayout) || 0;
    const changed = confirmed !== quoted;
    const answer = order.sellerResponse?.decision;
    // Loudest thing on the card when it exists: the inspector is deciding
    // whether to put the phone in the bag.
    const verdict =
      answer === "declined"
        ? `<div class="inspection__verdict inspection__verdict--no">Seller declined — do not collect</div>`
        : answer === "accepted"
        ? `<div class="inspection__verdict">Seller accepted</div>`
        : changed
        ? `<div class="cell-sub">Waiting for the seller to accept…</div>`
        : "";
    return `
      <div class="inspection inspection--done">
        <div class="inspection__head">
          ${changed ? "Adjusted" : "Confirmed"} at <strong>${money(confirmed)}</strong>
          ${changed ? `<span class="cell-sub">quoted ${money(quoted)}</span>` : ""}
        </div>
        ${done.reason ? `<div class="cell-sub">${escapeHtml(String(done.reason))}</div>` : ""}
        ${verdict}
      </div>`;
  }

  return `
    <div class="inspection" data-inspect="${escapeHtml(order.id)}">
      <div class="inspection__head">Confirm the amount</div>
      <div class="inspection__row">
        <input class="inspection__amount" type="number" min="0" step="1"
               inputmode="numeric" value="${quoted}"
               data-amount="${escapeHtml(order.id)}" />
        <button class="btn btn--small btn--primary"
                data-confirm="${escapeHtml(order.id)}">Confirm</button>
      </div>
      <input class="inspection__reason" type="text" maxlength="200"
             placeholder="Reason — required if you change the amount"
             data-reason="${escapeHtml(order.id)}" hidden />
      <div class="cell-sub inspection__faults"
           data-check-faults="${escapeHtml(order.id)}">${faultHint(order.id)}</div>
      <div class="cell-sub">Quoted ${money(quoted)}. Change it only if the phone is not as described.</div>
    </div>`;
}

function wireInspection(host, orders) {
  host.querySelectorAll("[data-amount]").forEach((input) => {
    const id = input.dataset.amount;
    const order = orders.find((o) => o.id === id);
    const reason = host.querySelector(`[data-reason="${CSS.escape(id)}"]`);
    // The reason box appears the moment the number stops matching the quote,
    // rather than being a permanently visible field nobody fills in.
    input.addEventListener("input", () => {
      const changed = Number(input.value) !== (Number(order?.finalPayout) || 0);
      reason.hidden = !changed;
    });
  });

  host.querySelectorAll("[data-confirm]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const id = btn.dataset.confirm;
      const order = orders.find((o) => o.id === id);
      const quoted = Number(order?.finalPayout) || 0;
      const amount = Number(
        host.querySelector(`[data-amount="${CSS.escape(id)}"]`)?.value
      );
      const reason = (
        host.querySelector(`[data-reason="${CSS.escape(id)}"]`)?.value || ""
      ).trim();

      if (!Number.isFinite(amount) || amount < 0) {
        toast("Enter the amount you are paying.", "error");
        return;
      }
      // Mirrors the rule rather than trusting it to be hit: a refusal from
      // Firestore reaches the inspector as an unexplained failure, and they
      // are standing in somebody's doorway.
      if (amount !== quoted && reason.length < 10) {
        toast("Say why the amount is different — a few words is enough.", "error");
        return;
      }
      if (
        amount !== quoted &&
        !confirm(
          `Pay ${money(amount)} instead of the quoted ${money(quoted)}?\n\n` +
            `The seller is told the new amount and your reason.`
        )
      ) {
        return;
      }

      btn.disabled = true;
      try {
        // One write, not two: the checklist is part of the finding, and a
        // second update would need its own trip past rules that require the
        // payout and the timestamp to be in the same document.
        const checks = answeredChecks(id);
        await updateDoc(doc(db, "orders", id), {
          inspection: {
            confirmedPayout: amount,
            quotedPayout: quoted,
            inspectorId: auth.currentUser.uid,
            at: serverTimestamp(),
            ...(reason ? { reason } : {}),
            ...(Object.keys(checks).length ? { checks } : {}),
          },
          status: "inspection",
          updatedAt: serverTimestamp(),
        });
        // Filed, so the card becomes a record on the next snapshot and the
        // working copy has nothing left to protect.
        checkAnswers.delete(id);
        toast("Recorded", "success");
      } catch (err) {
        toast("Could not record that: " + err.message, "error");
      } finally {
        btn.disabled = false;
      }
    });
  });
}

// ---------------------------------------------------------------------------
// The inspector's screen: a list of pickups, and one pickup as four steps
// ---------------------------------------------------------------------------
//
// Everything an agent needs used to sit in one long card: the address, what
// the seller said, the phone's own tests, fourteen questions and the amount
// box, all at once. It is read standing in a doorway with one hand, so it is
// now a short list, and a tapped pickup opens as four steps in the order the
// visit actually happens: get there, read what was claimed, check the phone,
// confirm the money.
//
// Only the layout is new. Every block below is the same function that built
// the old card, carrying the same data attributes, so `wireChecks` and
// `wireInspection` find their buttons and inputs exactly as before.

const JOB_STEPS = [
  { label: "Pickup", title: "Go to the pickup" },
  { label: "Review", title: "What the seller told us" },
  { label: "Check", title: "Check the phone" },
  { label: "Confirm", title: "Confirm the amount" },
];

// View state, kept outside the DOM because every Firestore snapshot redraws
// the whole list: without it an agent halfway down the questions would be
// thrown back to the first step each time anything on the order changed.
let jobOpenId = null;
const jobStep = new Map(); // order id -> step index
const jobQuestion = new Map(); // order id -> question index on the Check step
const jobShowAll = new Set(); // order ids showing every question at once

// Drawn rather than pulled from an icon font: five glyphs do not justify a
// network dependency on a screen that has to open on a bad connection.
const ICONS = {
  back: `<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path d="M15 5l-7 7 7 7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  next: `<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path d="M9 5l7 7-7 7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  check: `<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
};

function stageLabel(o) {
  return ORDER_STAGES.find((s) => s.value === o.status)?.label || o.status || "placed";
}

function stageBadge(o) {
  return `<span class="badge badge--${o.status === "paid" ? "success" : "warning"}">${escapeHtml(stageLabel(o))}</span>`;
}

// One row of the list. Only what decides which job to open: the phone, the
// money, where it is, and how far along it is.
function jobListCard(o) {
  const done = !!o.inspection;
  return `
    <article class="job">
      <div class="job__top">
        <span class="mono caption-4">${escapeHtml(o.reference || o.id.slice(0, 8))}</span>
        ${stageBadge(o)}
      </div>
      <div class="job__main">
        <div class="job__device">
          <div class="title-2">${escapeHtml(o.modelName || "Device")}</div>
          <div class="caption-2">${escapeHtml([o.brand, o.storage].filter(Boolean).join(" · "))}</div>
        </div>
        <div class="job__payout">${money(o.finalPayout)}</div>
      </div>
      ${o.addressFullText
        ? `<div class="job__address caption-2">${escapeHtml(String(o.addressFullText))}</div>`
        : ""}
      <button type="button" class="btn-flow btn-flow--primary" data-job-open="${escapeHtml(o.id)}">
        ${done ? "View pickup" : "Start pickup"} ${ICONS.next}
      </button>
    </article>`;
}

function jobStepper(step) {
  return `
    <ol class="stepper" aria-label="Steps">
      ${JOB_STEPS.map(
        (s, i) => `
        <li class="stepper__item">
          <button type="button" class="stepper__btn" data-job-step="${i}"
                  ${i === step ? 'aria-current="step"' : ""}>
            <span class="stepper__dot">${i + 1}</span>
            <span class="stepper__label caption-3">${s.label}</span>
          </button>
        </li>`
      ).join("")}
    </ol>`;
}

// A panel that came out empty still says so. A blank step reads as a page
// that failed to load, and an agent has no way to tell the difference.
function panelBody(html, emptyText) {
  return html.trim() ? html : `<p class="flow__empty body-6">${escapeHtml(emptyText)}</p>`;
}

function jobFlow(o) {
  const id = escapeHtml(o.id);
  const links = `${mapLink(o.addressLatitude, o.addressLongitude)}${callLink(o.customerPhone)}`;

  const panels = [
    // 1 — get there
    `${briefingBlock(o)}
     <div class="flow__card">${panelBody(pickupBlock(o), "No address on this order.")}</div>
     ${links ? `<div class="flow__links">${links}</div>` : ""}
     <label class="flow__field">
       <span class="caption-3">Stage</span>
       <select class="status-select" data-job-id="${id}">
         ${ORDER_STAGES.map(
           (s) => `<option value="${s.value}" ${s.value === (o.status || "placed") ? "selected" : ""}>${s.label}</option>`
         ).join("")}
       </select>
     </label>`,

    // 2 — read what was claimed, and what the phone said about itself
    panelBody(
      `${conditionBlock(o)}${declaredBlock(o)}${checkupBlock(o)}`,
      "The seller declared nothing and ran no self check on this order."
    ),

    // 3 — check the phone, one question at a time
    `<div class="qnav" data-qnav hidden></div>
     ${panelBody(checksBlock(o), "No checks were recorded for this pickup.")}
     <div class="qfoot" data-qfoot hidden></div>`,

    // 4 — the money. The findings total is moved in here after render, so
    // the figure it suggests sits beside the box it fills.
    `<div data-pay-slot></div>
     ${inspectionBlock(o)}`,
  ];

  return `
    <div class="flow" data-flow="${id}">
      <div class="flow__top">
        <button type="button" class="flow__back button-sm" data-job-close>
          ${ICONS.back} All pickups
        </button>
        ${stageBadge(o)}
      </div>

      <div class="flow__device">
        <div>
          <div class="title-1">${escapeHtml(o.modelName || "Device")}</div>
          <div class="caption-2">${escapeHtml(
            [o.brand, o.storage, o.reference || o.id.slice(0, 8)].filter(Boolean).join(" · ")
          )}</div>
        </div>
        <div class="flow__payout">${money(o.finalPayout)}</div>
      </div>

      ${jobStepper(jobStep.get(o.id) || 0)}

      ${panels
        .map(
          (html, i) => `
        <section class="flow__panel" data-panel="${i}" hidden>
          <h3 class="flow__title heading-6">${JOB_STEPS[i].title}</h3>
          ${html}
        </section>`
        )
        .join("")}

      <div class="flow__bar">
        <button type="button" class="btn-flow" data-job-prev>${ICONS.back} Back</button>
        <button type="button" class="btn-flow btn-flow--primary" data-job-next></button>
      </div>
    </div>`;
}

// The questions on the Check step, in order. Both shapes of row: the
// configured checklist's (`data-ck-row`) and the built-in pass/fail list's
// (`data-check-row`).
function questionRows(flow) {
  return [...flow.querySelectorAll('[data-panel="2"] [data-ck-row], [data-panel="2"] [data-check-row]')];
}

const isAnswered = (row) => !!row.querySelector(".is-on");

// The group heading a row sits under, read back off the markup so the
// stepper needs no second copy of the checklist.
function groupOf(row) {
  for (let n = row.previousElementSibling; n; n = n.previousElementSibling) {
    if (n.classList.contains("check-group")) return n.textContent.trim();
  }
  return "";
}

// Shows one question, or all of them, and says how far through the list the
// agent is. Called after every answer, so the count keeps up without a
// redraw of the card.
function applyQuestionView(flow) {
  const id = flow.dataset.flow;
  const nav = flow.querySelector("[data-qnav]");
  const foot = flow.querySelector("[data-qfoot]");
  const rows = questionRows(flow);
  if (!nav || !foot) return;

  // A filed pickup has a record here, not questions. Nothing to step through.
  if (rows.length === 0) {
    nav.hidden = true;
    foot.hidden = true;
    return;
  }

  const all = jobShowAll.has(id);
  if (!jobQuestion.has(id)) {
    // Opens on the first one still unanswered, so coming back to a pickup
    // carries on where it was left.
    const first = rows.findIndex((r) => !isAnswered(r));
    jobQuestion.set(id, first === -1 ? rows.length - 1 : first);
  }
  const at = Math.min(Math.max(jobQuestion.get(id), 0), rows.length - 1);
  jobQuestion.set(id, at);

  rows.forEach((row, i) => {
    row.hidden = !all && i !== at;
  });
  flow.querySelectorAll('[data-panel="2"] .check-group').forEach((g) => {
    g.hidden = !all;
  });

  const answered = rows.filter(isAnswered).length;
  const group = groupOf(rows[at]);
  // The running count of faults, which the answer buttons' own listeners
  // keep current on the checklist's summary line. Read from there rather
  // than counted again, so the two can never disagree. One question at a
  // time hides that line and the note under it — they pushed the question
  // off the first screen — and the count is shown here instead.
  const tally = flow.querySelector("[data-check-tally]")?.textContent.trim() || "";
  flow.classList.toggle("is-single", !all);
  nav.hidden = false;
  nav.innerHTML = `
    <div class="qnav__row">
      <span class="caption-3">${
        all ? `${rows.length} questions` : `Question ${at + 1} of ${rows.length}`
      }</span>
      <button type="button" class="qnav__toggle button-xsm" data-q-all>
        ${all ? "One at a time" : "Show all"}
      </button>
    </div>
    <div class="qnav__track" role="progressbar" aria-valuemin="0"
         aria-valuemax="${rows.length}" aria-valuenow="${answered}">
      <div class="qnav__fill" style="transform: scaleX(${answered / rows.length})"></div>
    </div>
    <div class="qnav__row">
      <span class="caption-5">${escapeHtml(tally || `${answered} of ${rows.length} answered`)}</span>
      ${!all && group ? `<span class="qnav__group caption-3">${escapeHtml(group)}</span>` : ""}
    </div>`;

  foot.hidden = all;
  const last = at === rows.length - 1;
  foot.innerHTML = `
    <button type="button" class="btn-flow" data-q-prev ${at === 0 ? "disabled" : ""}>
      ${ICONS.back} Previous
    </button>
    <button type="button" class="btn-flow${last ? " btn-flow--primary" : ""}" data-q-next>
      ${last ? "Go to confirm" : isAnswered(rows[at]) ? "Next question" : "Skip question"} ${ICONS.next}
    </button>`;
}

// Puts the open pickup on its current step: which panel shows, which steps
// read as done, and what the bar at the bottom offers.
function applyJobView(host) {
  const flow = host.querySelector("[data-flow]");
  if (!flow) return;
  const step = jobStep.get(flow.dataset.flow) || 0;

  flow.querySelectorAll("[data-panel]").forEach((panel) => {
    panel.hidden = Number(panel.dataset.panel) !== step;
  });
  flow.querySelectorAll("[data-job-step]").forEach((btn) => {
    const i = Number(btn.dataset.jobStep);
    btn.classList.toggle("is-current", i === step);
    btn.classList.toggle("is-done", i < step);
    if (i === step) btn.setAttribute("aria-current", "step");
    else btn.removeAttribute("aria-current");
    const dot = btn.querySelector(".stepper__dot");
    if (dot) dot.innerHTML = i < step ? ICONS.check : String(i + 1);
  });

  const prev = flow.querySelector("[data-job-prev]");
  const next = flow.querySelector("[data-job-next]");
  if (prev) prev.disabled = step === 0;
  if (next) {
    // The last step ends in Confirm, which is its own button beside the
    // amount. A second "next" under it would be a button that goes nowhere.
    next.hidden = step === JOB_STEPS.length - 1;
    if (!next.hidden) next.innerHTML = `Next: ${JOB_STEPS[step + 1].label} ${ICONS.next}`;
  }

  applyQuestionView(flow);
}

function setJobStep(host, step) {
  const flow = host.querySelector("[data-flow]");
  if (!flow) return;
  jobStep.set(flow.dataset.flow, Math.min(Math.max(step, 0), JOB_STEPS.length - 1));
  applyJobView(host);
  // A new step starts at its top, not wherever the last one was scrolled to.
  flow.scrollIntoView({ block: "start" });
}

// One listener on the list for everything the new layout adds. Delegated
// because the list's markup is replaced on every snapshot; the listeners the
// old card set per button (answers, the amount, the stage) are still set per
// render by `wireChecks`, `wireInspection` and the loop below.
function wireJobFlow(host) {
  if (host.dataset.flowWired) return;
  host.dataset.flowWired = "1";

  host.addEventListener("click", (e) => {
    const hit = (sel) => e.target.closest(sel);
    const flow = host.querySelector("[data-flow]");
    const id = flow?.dataset.flow;

    const open = hit("[data-job-open]");
    if (open) {
      jobOpenId = open.dataset.jobOpen;
      renderInspectorJobs(inspectorOrders);
      window.scrollTo({ top: 0 });
      return;
    }
    if (hit("[data-job-close]")) {
      jobOpenId = null;
      renderInspectorJobs(inspectorOrders);
      window.scrollTo({ top: 0 });
      return;
    }
    if (!flow) return;

    const stepBtn = hit("[data-job-step]");
    if (stepBtn) return setJobStep(host, Number(stepBtn.dataset.jobStep));
    if (hit("[data-job-prev]")) return setJobStep(host, (jobStep.get(id) || 0) - 1);
    if (hit("[data-job-next]")) return setJobStep(host, (jobStep.get(id) || 0) + 1);

    if (hit("[data-q-all]")) {
      if (jobShowAll.has(id)) jobShowAll.delete(id);
      else jobShowAll.add(id);
      return applyQuestionView(flow);
    }
    if (hit("[data-q-prev]")) {
      jobQuestion.set(id, (jobQuestion.get(id) || 0) - 1);
      return applyQuestionView(flow);
    }
    if (hit("[data-q-next]")) {
      const rows = questionRows(flow);
      const at = jobQuestion.get(id) || 0;
      if (at >= rows.length - 1) return setJobStep(host, 3);
      jobQuestion.set(id, at + 1);
      return applyQuestionView(flow);
    }

    // An answer. The button's own listener has already recorded it by the
    // time the click reaches here, so this only moves the view on: a beat
    // later, so the agent sees their answer land before the next question
    // replaces it.
    const answer = hit("[data-ck-pick], [data-check-set]");
    if (answer) {
      const row = answer.closest("[data-ck-row], [data-check-row]");
      applyQuestionView(flow);
      if (jobShowAll.has(id) || !row || !isAnswered(row)) return;
      const rows = questionRows(flow);
      const at = rows.indexOf(row);
      if (at === -1 || at >= rows.length - 1) return;
      setTimeout(() => {
        // Still the same question, and still answered: a second tap that
        // cleared it, or a tap on Previous, must not be overridden.
        if (jobQuestion.get(id) !== at || !isAnswered(row)) return;
        jobQuestion.set(id, at + 1);
        applyQuestionView(flow);
      }, 320);
    }
  });
}

function renderInspectorJobs(orders) {
  const host = el("inspector-list");
  if (!host) return;
  wireJobFlow(host);

  // An open pickup that is no longer in the list was reassigned or removed;
  // fall back to the list rather than show a card for nothing.
  const open = jobOpenId ? orders.find((o) => o.id === jobOpenId) : null;
  if (!open) jobOpenId = null;
  el("tab-inspector")?.classList.toggle("is-flow", !!open);

  if (orders.length === 0) {
    // Says it is working, not broken. "Nothing here" on a blank screen reads
    // as a failure to someone waiting for work.
    host.innerHTML = `<p class="empty">
      Nothing assigned to you right now.
      <span class="cell-sub">New pickups appear here on their own — you do not need to refresh.</span>
    </p>`;
    return;
  }

  // Soonest-placed first: the oldest job is the one keeping someone waiting.
  orders.sort((a, b) => (a.createdAt?.seconds || 0) - (b.createdAt?.seconds || 0));

  host.innerHTML = open ? jobFlow(open) : orders.map(jobListCard).join("");

  if (open) {
    // Every section starts open. They were collapsed to keep one long card
    // short; a step that shows nothing but headings to tap defeats the step.
    host.querySelectorAll("details.job-detail").forEach((d) => {
      d.open = true;
    });
    // The findings total belongs beside the amount it suggests. Moved, not
    // re-rendered, so `wireChecks` still finds it by its data attribute.
    const suggest = host.querySelector("[data-ck-suggest]");
    const slot = host.querySelector("[data-pay-slot]");
    if (suggest && slot) slot.appendChild(suggest);
  }

  wireInspection(host, orders);
  wireChecks(host, orders);
  applyJobView(host);

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


// ---------------------------------------------------------------------------
// Web push — so staff hear about work without watching the screen
// ---------------------------------------------------------------------------

// Registers this browser to receive pushes, against the signed-in person's
// own staff document.
//
// `collectionName` is "admins" or "inspectors": the token has to live beside
// whoever it belongs to, because the functions look them up by role. Tokens
// are an array for the same reason the phone app keeps one — a person has a
// laptop and a phone, and a single field means whichever opened the panel
// last silently takes the notifications from the other.
async function startWebPush(uid, collectionName) {
  try {
    if (!(await messagingSupported())) return;

    if (!webPushVapidKey || webPushVapidKey.startsWith("REPLACE_")) {
      // Said out loud rather than swallowed: without the key nothing arrives,
      // and a silent failure here looks exactly like "no orders yet".
      console.warn(
        "Web push is off: set webPushVapidKey in firebase-config.js " +
          "(Firebase console -> Cloud Messaging -> Web Push certificates)."
      );
      return;
    }

    // Asked for only after sign-in, when there is something to notify about.
    // A permission prompt on a login screen is the one people refuse.
    const permission = await Notification.requestPermission();
    if (permission !== "granted") return;

    const registration = await navigator.serviceWorker.register(
      "firebase-messaging-sw.js"
    );
    const messaging = getMessaging(catalogApp);
    const token = await getToken(messaging, {
      vapidKey: webPushVapidKey,
      serviceWorkerRegistration: registration,
    });
    if (!token) return;

    await updateDoc(doc(db, collectionName, uid), {
      fcmTokens: arrayUnion(token),
    });

    // A push landing while the panel is open does not raise a notification on
    // its own, so it is shown as a toast instead — the same information,
    // without a system banner over the screen someone is already looking at.
    onMessage(messaging, (payload) => {
      const { title, body } = payload.notification || {};
      toast([title, body].filter(Boolean).join(" — "), "success");
      // Nothing is re-fetched here on purpose. The orders table is already on
      // a live snapshot, so a new order arrives through that listener for
      // free; re-reading the inspector collection on every push would have
      // billed a whole collection read per notification for a list that had
      // not changed.
    });
  } catch (err) {
    // Blocked notifications, no HTTPS, a browser without push. None of it is
    // worth interrupting the person over: the panel works without pushes.
    console.warn("Web push unavailable:", err?.message || err);
  }
}
