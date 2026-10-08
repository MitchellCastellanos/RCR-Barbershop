// ============================================================
// Admin panel for RCR Barber Shop digital card.
// Auth: Firebase email/password.
// Data: single document at config/site in Firestore.
// Storage: gallery photos in Firebase Storage under /gallery/.
// ============================================================

import { FIREBASE_ENABLED } from "../enlaces/firebase-config.js";
import { fetchData, saveData, getAuth, getStorage } from "../enlaces/data-store.js";
import {
  subscribeProducts, createProduct, updateProduct, deleteProduct,
  adjustStock, subscribeMovements, uploadProductPhoto, deleteProductPhoto,
} from "../enlaces/products-store.js";
import { buildProductUrl, renderQrToCanvas } from "../enlaces/qr.js";
import { sellCart, voidTransaction, fetchTransactionsRange, paymentLines, PAYMENT_METHODS, DEFAULT_COMMISSION, fetchCommissionSettings, saveCommissionSettings, saleCommission } from "../enlaces/transactions-store.js";
import { scanCodeFromCamera, extractProductId } from "../enlaces/scan.js";
import {
  resolveMyProfile, subscribeUsers, createCashier, setUserActive,
  sendPasswordReset, withAdminAuthorization,
} from "../enlaces/users-store.js";

const $  = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));

// ---------- State ----------
let currentData = null;        // last persisted data (server snapshot)
let workingData = null;        // local edits (pre-save)
let dirty = false;
let authUser = null;
let myProfile = null;   // { uid, email, displayName, role, active }
let allUsers = [];      // admin only: every users/{uid} profile, for Usuarios tab + corte filter
let unsubUsers = null;
let corteCashierFilter = "all"; // "all" (admin) | a uid

// Products/inventory save immediately to their own Firestore collection —
// unlike services/gallery they don't go through the workingData/save-bar flow.
let products = [];
let unsubProducts = null;
let pendingPhotoFiles = [];    // File objects queued before a new product's first save
let stockMovementsUnsub = null;
let qrCurrentProduct = null;

// Caja (POS)
let posCart = [];
let posKind = "service";       // which picker list is showing: "service" | "product"
let posPaymentMethod = "efectivo"; // quick single-method selection (used when not split)
let commissionSettings = { ...DEFAULT_COMMISSION };
let posSplitMode = false;          // true once "Pago mixto" is active
let posPayments = [];              // split-mode payment lines: [{ id, method, amount, note }]
let posScanStop = null;        // stops the camera scan loop
let lastSale = null;           // last completed sale, for the optional receipt

// ============================================================
// Boot
// ============================================================
(async function boot() {
  if (!FIREBASE_ENABLED) {
    showLoginError("Firebase no está configurado. Edita firebase-config.js y pon FIREBASE_ENABLED = true.");
    return;
  }

  // Wire login form
  $("#loginForm").addEventListener("submit", onLoginSubmit);

  // Wait for auth state
  try {
    const { auth, onAuthStateChanged, signOut } = await getAuth();
    onAuthStateChanged(auth, async (user) => {
      authUser = user;
      if (!user) {
        myProfile = null;
        showLogin();
        return;
      }
      try {
        myProfile = await resolveMyProfile(user);
      } catch (err) {
        await signOut(auth);
        showLoginError("Error verificando tu cuenta: " + err.message);
        return;
      }
      if (!myProfile || myProfile.active === false) {
        await signOut(auth);
        showLoginError("Tu cuenta no tiene acceso asignado. Contacta al administrador.");
        return;
      }
      startApp();
    });
  } catch (err) {
    showLoginError("No se pudo conectar a Firebase: " + err.message);
  }
})();

// ============================================================
// Auth UI
// ============================================================
function showLogin() {
  $("#loginScreen").hidden = false;
  $("#app").hidden = true;
}

function showLoginError(msg) {
  const el = $("#loginError");
  el.textContent = msg;
  el.hidden = false;
}

async function onLoginSubmit(ev) {
  ev.preventDefault();
  $("#loginError").hidden = true;
  const btn = $("#loginBtn");
  btn.disabled = true;
  btn.innerHTML = `<i class="fas fa-spinner fa-spin"></i> Entrando…`;
  try {
    const { auth, signInWithEmailAndPassword } = await getAuth();
    await signInWithEmailAndPassword(
      auth,
      $("#loginEmail").value.trim(),
      $("#loginPassword").value
    );
    // onAuthStateChanged will trigger startApp
  } catch (err) {
    showLoginError(humanizeAuthError(err));
  } finally {
    btn.disabled = false;
    btn.innerHTML = `<i class="fas fa-sign-in-alt"></i> Entrar`;
  }
}

function humanizeAuthError(err) {
  const code = err.code || "";
  if (code.includes("invalid-credential") || code.includes("wrong-password") || code.includes("user-not-found"))
    return "Correo o contraseña incorrectos.";
  if (code.includes("too-many-requests"))
    return "Demasiados intentos. Espera unos minutos.";
  if (code.includes("network"))
    return "Sin conexión a internet.";
  if (code.includes("email-already-in-use"))
    return "Ya existe una cuenta con ese correo.";
  if (code.includes("weak-password"))
    return "La contraseña es muy débil (mínimo 6 caracteres).";
  if (code.includes("invalid-email"))
    return "Correo inválido.";
  return err.message || "No se pudo completar la operación.";
}

async function logout() {
  const { auth, signOut } = await getAuth();
  if (unsubUsers) { unsubUsers(); unsubUsers = null; }
  allUsers = [];
  await signOut(auth);
}

// ============================================================
// App
// ============================================================
async function startApp() {
  $("#loginScreen").hidden = true;
  $("#app").hidden = false;

  $("#logoutBtn").onclick = logout;
  $$(".tab").forEach(t => t.addEventListener("click", () => switchTab(t.dataset.tab)));
  $("#sidebarToggle").onclick = () => setSidebarOpen(!document.body.classList.contains("sidebar-open"));
  $("#sidebarBackdrop").onclick = () => setSidebarOpen(false);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && document.body.classList.contains("sidebar-open")) setSidebarOpen(false);
  });

  $("#addServiceBtn").onclick = () => openServiceModal(null);
  $("#serviceModalClose").onclick = closeServiceModal;
  $("#svcCancelBtn").onclick = closeServiceModal;
  $("#serviceForm").addEventListener("submit", onServiceFormSubmit);
  $("#svcDeleteBtn").onclick = onServiceDelete;
  $("#serviceModal").addEventListener("click", (e) => {
    if (e.target.id === "serviceModal") closeServiceModal();
  });

  $("#uploadInput").addEventListener("change", onUploadFiles);

  $("#addProductBtn").onclick = () => openProductModal(null);
  $("#productModalClose").onclick = closeProductModal;
  $("#prodCancelBtn").onclick = closeProductModal;
  $("#productForm").addEventListener("submit", onProductFormSubmit);
  $("#prodDeleteBtn").onclick = onProductDelete;
  $("#productModal").addEventListener("click", (e) => {
    if (e.target.id === "productModal") closeProductModal();
  });
  $("#prodPhotoInput").addEventListener("change", onProductPhotoFiles);

  $("#stockModalClose").onclick = closeStockModal;
  $("#stockCancelBtn").onclick = closeStockModal;
  $("#stockForm").addEventListener("submit", onStockFormSubmit);
  $("#stockModal").addEventListener("click", (e) => {
    if (e.target.id === "stockModal") closeStockModal();
  });

  $("#qrModalClose").onclick = closeQrModal;
  $("#qrModalCancelBtn").onclick = closeQrModal;
  $("#qrModal").addEventListener("click", (e) => {
    if (e.target.id === "qrModal") closeQrModal();
  });
  $("#qrPrintBtn").onclick = onPrintLabel;
  $("#qrCopyBtn").onclick = onCopyQr;
  $("#qrDownloadBtn").onclick = onDownloadQr;
  window.addEventListener("afterprint", () => {
    document.body.classList.remove("is-printing-label");
    document.body.classList.remove("is-printing-receipt");
    $("#printLabel").innerHTML = "";
    $("#printReceipt").innerHTML = "";
  });

  $$('[data-pos-view]').forEach((btn) => btn.addEventListener("click", () => switchPosView(btn.dataset.posView)));
  $$('[data-pos-kind]').forEach((btn) => btn.addEventListener("click", () => {
    posKind = btn.dataset.posKind;
    $$('[data-pos-kind]').forEach((b) => b.classList.toggle("is-active", b === btn));
    renderPosItemList();
  }));
  $$('[data-pos-payment]').forEach((btn) => btn.addEventListener("click", () => setQuickPaymentMethod(btn.dataset.posPayment)));
  $("#posSplitPaymentBtn").onclick = onToggleSplitPayment;
  $("#posCancelSplitBtn").onclick = onToggleSplitPayment;
  $("#posAddPaymentBtn").onclick = onAddPaymentLine;
  $("#posScanBtn").onclick = openPosScanModal;
  $("#posScanModalClose").onclick = closePosScanModal;
  $("#posScanModal").addEventListener("click", (e) => {
    if (e.target.id === "posScanModal") closePosScanModal();
  });
  $("#posChargeBtn").onclick = onCharge;
  $("#posReceiptSkipBtn").onclick = closeReceiptModal;
  $("#posReceiptPrintBtn").onclick = onPrintReceipt;
  $("#corteFrom").addEventListener("change", loadCorte);
  $("#corteTo").addEventListener("change", loadCorte);
  $("#commissionSaveBtn").onclick = onSaveCommission;
  $("#corteCashier").addEventListener("change", (e) => {
    corteCashierFilter = e.target.value;
    loadCorte();
  });

  $("#addCashierBtn").onclick = () => openCashierModal();
  $("#cashierModalClose").onclick = closeCashierModal;
  $("#cashierCancelBtn").onclick = closeCashierModal;
  $("#cashierForm").addEventListener("submit", onCashierFormSubmit);
  $("#cashierModal").addEventListener("click", (e) => {
    if (e.target.id === "cashierModal") closeCashierModal();
  });

  $("#adminAuthModalClose").onclick = closeAdminAuthModal;
  $("#adminAuthCancelBtn").onclick = closeAdminAuthModal;
  $("#adminAuthForm").addEventListener("submit", onAdminAuthSubmit);
  $("#adminAuthModal").addEventListener("click", (e) => {
    if (e.target.id === "adminAuthModal") closeAdminAuthModal();
  });

  $("#labelBulkPrintBtn").onclick = onPrintBulkLabels;
  $("#labelBulkShowPrice").addEventListener("change", renderLabelPreviews);

  initProducts();

  $("#saveBtn").onclick = onSaveAll;
  $("#discardBtn").onclick = onDiscardAll;

  $$('[data-link-key]').forEach(input => {
    input.addEventListener("input", () => {
      workingData.links[input.dataset.linkKey] = input.value;
      markDirty();
    });
  });
  $$('[data-business-key]').forEach(input => {
    input.addEventListener("input", () => {
      const k = input.dataset.businessKey;
      const val = input.type === "number" ? (input.value === "" ? "" : Number(input.value)) : input.value;
      workingData.business[k] = val;
      markDirty();
    });
  });

  window.addEventListener("beforeunload", (e) => {
    if (dirty) { e.preventDefault(); e.returnValue = ""; }
  });

  applyRoleUI();
  if (myProfile.role === "admin") initUsers();

  await loadData();
}

// ============================================================
// Roles / multi-user access
// ============================================================
function isAdminRole() {
  return myProfile?.role === "admin";
}

function applyRoleUI() {
  const admin = isAdminRole();
  document.body.classList.toggle("is-admin", admin);
  $$(".tab").forEach((t) => {
    const allowed = admin || t.dataset.tab === "caja";
    t.hidden = !allowed;
  });
  $$(".nav-group").forEach((g) => {
    g.hidden = !$$(".tab", g).some((t) => !t.hidden);
  });
  if (!admin) switchTab("caja");

  $("#userBadge").textContent = `${myProfile.displayName || myProfile.email} · ${admin ? "Administrador" : "Cajero"}`;

  // A cashier only ever sees their own corte — no filter, no "todos".
  $("#corteCashierField").hidden = !admin;
  if (!admin) corteCashierFilter = myProfile.uid;
}

async function initUsers() {
  unsubUsers = await subscribeUsers((list) => {
    allUsers = list.slice().sort((a, b) => String(a.displayName).localeCompare(String(b.displayName)));
    renderUsers();
    renderCorteCashierOptions();
  });
}

function renderUsers() {
  const list = $("#usersList");
  if (!list) return;
  list.innerHTML = "";
  allUsers.forEach((u) => {
    const li = document.createElement("li");
    li.className = "user-row" + (u.active === false ? " is-inactive" : "");
    const isSelf = u.uid === myProfile.uid;
    li.innerHTML = `
      <div class="user-row-main">
        <div class="user-row-name">
          ${escape(u.displayName || u.email)}
          <span class="chip ${u.role === "admin" ? "chip-admin" : ""}">${u.role === "admin" ? "Admin" : "Cajero"}</span>
          ${u.active === false ? `<span class="chip chip-off">inactivo</span>` : ""}
        </div>
        <div class="user-row-email">${escape(u.email)}</div>
      </div>
      <div class="user-row-actions">
        <button type="button" class="btn btn-ghost btn-sm" data-action="reset">Restablecer contraseña</button>
        ${u.role !== "admin" ? `<button type="button" class="btn btn-ghost btn-sm" data-action="toggle">${u.active === false ? "Activar" : "Desactivar"}</button>` : ""}
      </div>
    `;
    li.querySelector('[data-action="reset"]').onclick = () => onResetPassword(u);
    const toggleBtn = li.querySelector('[data-action="toggle"]');
    if (toggleBtn) toggleBtn.onclick = () => onToggleCashierActive(u);
    if (isSelf) li.classList.add("is-self");
    list.appendChild(li);
  });
}

function openCashierModal() {
  $("#cashierForm").reset();
  $("#cashierModal").hidden = false;
  setTimeout(() => $("#cashierName").focus(), 50);
}

function closeCashierModal() {
  $("#cashierModal").hidden = true;
}

async function onCashierFormSubmit(ev) {
  ev.preventDefault();
  const displayName = $("#cashierName").value.trim();
  const email = $("#cashierEmail").value.trim();
  const password = $("#cashierPassword").value;
  if (!displayName || !email || !password) { toast("Completa todos los campos.", "error"); return; }
  if (password.length < 6) { toast("La contraseña debe tener al menos 6 caracteres.", "error"); return; }

  const btn = $("#cashierSaveBtn");
  btn.disabled = true;
  btn.innerHTML = `<i class="fas fa-spinner fa-spin"></i> Creando…`;
  try {
    await createCashier({ email, password, displayName });
    toast(`Cuenta de cajero creada para ${displayName}.`, "success");
    closeCashierModal();
  } catch (err) {
    toast(humanizeAuthError(err), "error");
  } finally {
    btn.disabled = false;
    btn.innerHTML = `<i class="fas fa-check"></i> Crear cajero`;
  }
}

async function onToggleCashierActive(u) {
  const makeActive = u.active === false;
  if (!confirm(`¿${makeActive ? "Activar" : "Desactivar"} a "${u.displayName}"?`)) return;
  try {
    await setUserActive(u.uid, makeActive);
    toast(makeActive ? "Cuenta activada." : "Cuenta desactivada.", "success");
  } catch (err) {
    toast(err.message || "Error al actualizar la cuenta.", "error");
  }
}

async function onResetPassword(u) {
  if (!confirm(`¿Enviar correo de restablecimiento de contraseña a ${u.email}?`)) return;
  try {
    await sendPasswordReset(u.email);
    toast("Correo de restablecimiento enviado.", "success");
  } catch (err) {
    toast(err.message || "Error al enviar el correo.", "error");
  }
}

// ---------- Admin-authorized void (used when a cashier cancels a sale) ----------
let pendingVoidTxId = null;

function openAdminAuthModal(txId) {
  pendingVoidTxId = txId;
  $("#adminAuthForm").reset();
  $("#adminAuthError").hidden = true;
  $("#adminAuthModal").hidden = false;
  setTimeout(() => $("#adminAuthEmail").focus(), 50);
}

function closeAdminAuthModal() {
  $("#adminAuthModal").hidden = true;
  pendingVoidTxId = null;
}

async function onAdminAuthSubmit(ev) {
  ev.preventDefault();
  const txId = pendingVoidTxId;
  if (!txId) return;
  const email = $("#adminAuthEmail").value.trim();
  const password = $("#adminAuthPassword").value;

  const btn = $("#adminAuthSubmitBtn");
  btn.disabled = true;
  btn.innerHTML = `<i class="fas fa-spinner fa-spin"></i> Verificando…`;
  try {
    await withAdminAuthorization(email, password, (fsCtx, adminUser) =>
      voidTransaction(txId, fsCtx, adminUser.uid)
    );
    toast("Venta cancelada.", "success");
    closeAdminAuthModal();
    loadCorte();
  } catch (err) {
    $("#adminAuthError").textContent = err.message || "No se pudo autorizar la cancelación.";
    $("#adminAuthError").hidden = false;
  } finally {
    btn.disabled = false;
    btn.innerHTML = `<i class="fas fa-check"></i> Autorizar y cancelar`;
  }
}

async function loadData() {
  try {
    const { data, fromRemote } = await fetchData();
    currentData = data;
    workingData = deepClone(data);
    renderAll();
    dirty = false;
    refreshSaveBar();

    // First-time seed: if Firestore has no document yet, write the
    // current defaults so the live page reads from Firestore from now on.
    // Only admin can write config/site — a cashier just keeps the defaults.
    if (!fromRemote && isAdminRole()) {
      try {
        await saveData(currentData);
        toast("Datos iniciales sembrados en Firebase. ¡Edita lo que necesites!", "success");
      } catch (err) {
        // Likely a permissions issue — show a friendly hint.
        toast("No pude sembrar los datos: " + err.message, "error");
      }
    }
  } catch (err) {
    toast("Error cargando datos: " + err.message, "error");
  }
}

function setSidebarOpen(open) {
  document.body.classList.toggle("sidebar-open", open);
  const backdrop = $("#sidebarBackdrop");
  if (backdrop) backdrop.hidden = !open;
  const toggle = $("#sidebarToggle");
  if (toggle) {
    toggle.setAttribute("aria-expanded", open ? "true" : "false");
    toggle.setAttribute("aria-label", open ? "Cerrar menú" : "Abrir menú");
  }
}

function switchTab(name) {
  $$(".tab").forEach(t => {
    const on = t.dataset.tab === name;
    t.classList.toggle("is-active", on);
    if (on && t.dataset.title) {
      const titleEl = $("#topbarTitle");
      if (titleEl) titleEl.textContent = t.dataset.title;
    }
  });
  $$(".panel").forEach(p => p.hidden = p.id !== `panel-${name}`);
  setSidebarOpen(false);
}

// ============================================================
// Render
// ============================================================
function renderAll() {
  renderServices();
  renderGallery();
  renderHours();
  renderLinks();
  renderBusiness();
  renderPosItemList();
}

function renderServices() {
  const list = $("#servicesList");
  list.innerHTML = "";
  const services = (workingData.services || []).slice().sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  services.forEach((s, idx) => {
    const li = document.createElement("li");
    li.className = "service-row" + (s.active === false ? " is-inactive" : "");
    li.draggable = true;
    li.dataset.id = s.id;
    li.innerHTML = `
      <span class="grip" title="Arrastra para reordenar"><i class="fas fa-grip-vertical"></i></span>
      <div class="service-row-main">
        <div class="service-row-name">
          ${escape(s.name || "(sin nombre)")}
          ${s.active === false ? `<span class="chip chip-off">oculto</span>` : ""}
        </div>
        ${s.description ? `<div class="service-row-desc">${escape(s.description)}</div>` : ""}
        ${s.note ? `<div class="service-row-note"><i class="fas fa-circle-info"></i> ${escape(s.note)}</div>` : ""}
      </div>
      <div class="service-row-price">${formatPrice(s.price)}</div>
      <button class="icon-btn" data-action="edit" title="Editar"><i class="fas fa-pen"></i></button>
    `;
    li.querySelector('[data-action="edit"]').onclick = () => openServiceModal(s.id);
    addDragHandlers(li, services, idx);
    list.appendChild(li);
  });
}

function renderGallery() {
  const list = $("#galleryList");
  list.innerHTML = "";
  const items = (workingData.gallery || []).slice().sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  if (items.length === 0) {
    list.innerHTML = `<li class="empty"><i class="far fa-images"></i> Aún no hay fotos. Sube algunas con el botón de arriba.</li>`;
    return;
  }
  items.forEach((g, idx) => {
    const li = document.createElement("li");
    li.className = "gallery-row";
    li.draggable = true;
    li.dataset.id = g.id;
    li.innerHTML = `
      <span class="grip"><i class="fas fa-grip-vertical"></i></span>
      <div class="gallery-thumb"><img src="${escapeAttr(g.url)}" alt="" loading="lazy" /></div>
      <input type="text" class="gallery-alt" placeholder="Descripción (opcional)" value="${escapeAttr(g.alt || "")}" />
      <button class="icon-btn icon-btn-danger" data-action="delete" title="Eliminar"><i class="fas fa-trash"></i></button>
    `;
    li.querySelector(".gallery-alt").addEventListener("input", (e) => {
      g.alt = e.target.value;
      markDirty();
    });
    li.querySelector('[data-action="delete"]').onclick = () => onDeletePhoto(g);
    addDragHandlers(li, items, idx);
    list.appendChild(li);
  });
}

function renderHours() {
  const list = $("#hoursList");
  list.innerHTML = "";
  const dayNames = ["Domingo","Lunes","Martes","Miércoles","Jueves","Viernes","Sábado"];
  // Show in week order: Mon → Sun
  [1,2,3,4,5,6,0].forEach(d => {
    const h = workingData.hours[d] || { open: "", close: "", closed: false };
    const li = document.createElement("li");
    li.className = "hours-row" + (h.closed ? " is-closed" : "");
    li.innerHTML = `
      <span class="hours-day">${dayNames[d]}</span>
      <label class="check">
        <input type="checkbox" ${h.closed ? "checked" : ""} data-h-key="closed" />
        <span>Cerrado</span>
      </label>
      <input type="time" value="${escapeAttr(h.open || "")}"  data-h-key="open"  ${h.closed ? "disabled" : ""}/>
      <span class="dash">–</span>
      <input type="time" value="${escapeAttr(h.close || "")}" data-h-key="close" ${h.closed ? "disabled" : ""}/>
    `;
    li.querySelectorAll("input").forEach(inp => {
      inp.addEventListener("change", () => {
        const key = inp.dataset.hKey;
        if (!workingData.hours[d]) workingData.hours[d] = { open: "", close: "", closed: false };
        if (key === "closed") {
          workingData.hours[d].closed = inp.checked;
          renderHours();
        } else {
          workingData.hours[d][key] = inp.value;
        }
        markDirty();
      });
    });
    list.appendChild(li);
  });
}

function renderLinks() {
  $$('[data-link-key]').forEach(input => {
    const k = input.dataset.linkKey;
    input.value = workingData.links[k] ?? "";
  });
}

function renderBusiness() {
  $$('[data-business-key]').forEach(input => {
    const k = input.dataset.businessKey;
    const v = workingData.business[k] ?? "";
    input.value = v === null ? "" : v;
  });
}

// ============================================================
// Service editor
// ============================================================
function openServiceModal(id) {
  const isNew = !id;
  const svc = isNew
    ? { id: makeId(), name: "", description: "", price: "", note: "", active: true, order: (workingData.services?.length ?? 0) }
    : workingData.services.find(s => s.id === id);
  if (!svc) return;

  $("#serviceModalTitle").textContent = isNew ? "Nuevo servicio" : "Editar servicio";
  $("#svcId").value = svc.id;
  $("#svcName").value = svc.name || "";
  $("#svcPrice").value = svc.price ?? "";
  $("#svcDesc").value = svc.description || "";
  $("#svcNote").value = svc.note || "";
  $("#svcActive").value = svc.active === false ? "false" : "true";
  $("#svcDeleteBtn").hidden = isNew;

  $("#serviceModal").hidden = false;
  setTimeout(() => $("#svcName").focus(), 50);
}

function closeServiceModal() {
  $("#serviceModal").hidden = true;
  $("#serviceForm").reset();
}

function onServiceFormSubmit(ev) {
  ev.preventDefault();
  const id = $("#svcId").value;
  const data = {
    id,
    name: $("#svcName").value.trim(),
    price: $("#svcPrice").value === "" ? "" : Number($("#svcPrice").value),
    description: $("#svcDesc").value.trim(),
    note: $("#svcNote").value.trim(),
    active: $("#svcActive").value === "true",
  };
  if (!data.name) {
    toast("El nombre es obligatorio.", "error");
    return;
  }

  const idx = (workingData.services || []).findIndex(s => s.id === id);
  if (idx === -1) {
    workingData.services = workingData.services || [];
    data.order = workingData.services.length;
    workingData.services.push(data);
  } else {
    workingData.services[idx] = { ...workingData.services[idx], ...data };
  }
  markDirty();
  closeServiceModal();
  renderServices();
}

function onServiceDelete() {
  const id = $("#svcId").value;
  const svc = (workingData.services || []).find(s => s.id === id);
  if (!svc) return;
  if (!confirm(`¿Eliminar "${svc.name}"? Esta acción no se puede deshacer (hasta que guardes).`)) return;
  workingData.services = workingData.services.filter(s => s.id !== id);
  reorder(workingData.services);
  markDirty();
  closeServiceModal();
  renderServices();
}

// ============================================================
// Products + inventory
// ============================================================
async function initProducts() {
  unsubProducts = await subscribeProducts((list) => {
    products = list.slice().sort((a, b) =>
      (a.order ?? 0) - (b.order ?? 0) || String(a.name).localeCompare(String(b.name))
    );
    renderProducts();
    renderPosItemList();
    renderLabelPickList();
  });
}

function renderProducts() {
  const list = $("#productsList");
  list.innerHTML = "";
  if (products.length === 0) {
    list.innerHTML = `<li class="empty" style="grid-column:1/-1;"><i class="fas fa-box-open"></i> Aún no hay productos. Agrega el primero con el botón de arriba.</li>`;
    return;
  }
  products.forEach((p) => {
    const li = document.createElement("li");
    li.className = "product-card" + (p.active === false ? " is-inactive" : "");
    const photo = p.photos && p.photos[0] ? p.photos[0].url : null;
    const stock = Number(p.stock) || 0;
    const low = stock <= (Number(p.lowStockThreshold) || 0);
    li.innerHTML = `
      <div class="product-thumb">
        ${photo ? `<img src="${escapeAttr(photo)}" alt="" loading="lazy" />` : `<i class="fas fa-box"></i>`}
      </div>
      <div class="product-body">
        <div class="product-name">${escape(p.name || "(sin nombre)")}</div>
        ${p.category ? `<div class="product-category">${escape(p.category)}</div>` : ""}
        <div class="product-meta">
          <span class="product-price">${formatPrice(p.price)}</span>
          <span class="stock-chip ${low ? "is-low" : ""}">${stock <= 0 ? "Agotado" : `${stock} ${escape(p.unit || "pza")}`}</span>
        </div>
        <div class="product-actions">
          <button class="icon-btn" data-action="edit" title="Editar"><i class="fas fa-pen"></i></button>
          <button class="icon-btn" data-action="stock" title="Inventario"><i class="fas fa-boxes-stacked"></i></button>
          <button class="icon-btn" data-action="qr" title="Etiqueta QR"><i class="fas fa-qrcode"></i></button>
        </div>
      </div>
    `;
    li.querySelector('[data-action="edit"]').onclick = () => openProductModal(p.id);
    li.querySelector('[data-action="stock"]').onclick = () => openStockModal(p.id);
    li.querySelector('[data-action="qr"]').onclick = () => openQrModal(p.id);
    list.appendChild(li);
  });
}

// ---------- Product editor ----------
function openProductModal(id) {
  const isNew = !id;
  const p = isNew ? null : products.find((x) => x.id === id);
  if (!isNew && !p) return;

  pendingPhotoFiles = [];
  $("#productModalTitle").textContent = isNew ? "Nuevo producto" : "Editar producto";
  $("#prodId").value = isNew ? "" : p.id;
  $("#prodName").value = p?.name || "";
  $("#prodCategory").value = p?.category || "";
  $("#prodUnit").value = p?.unit || "pieza";
  $("#prodPrice").value = p?.price ?? "";
  $("#prodCost").value = p?.cost ?? "";
  $("#prodLowStock").value = p?.lowStockThreshold ?? 3;
  $("#prodActive").value = p?.active === false ? "false" : "true";
  $("#prodDesc").value = p?.description || "";
  $("#prodBrand").value = p?.brand || "";
  $("#prodSize").value = p?.size || "";
  $("#prodHighlights").value = (p?.highlights || []).join("\n");
  $("#prodUsage").value = p?.usage || "";
  $("#prodDeleteBtn").hidden = isNew;

  $("#prodInitialStockField").hidden = !isNew;
  $("#prodInitialStock").value = 0;

  const stockInfo = $("#prodStockInfo");
  stockInfo.hidden = isNew;
  if (!isNew) {
    stockInfo.innerHTML = `<p class="field-hint"><i class="fas fa-circle-info"></i> Inventario actual: <b>${Number(p.stock) || 0} ${escape(p.unit || "pza")}</b>. Para agregar o retirar existencias usa el botón <i class="fas fa-boxes-stacked"></i> "Inventario" desde la lista de productos.</p>`;
  }

  renderProductPhotos(p);

  $("#productModal").hidden = false;
  setTimeout(() => $("#prodName").focus(), 50);
}

function closeProductModal() {
  $("#productModal").hidden = true;
  $("#productForm").reset();
  pendingPhotoFiles = [];
}

function renderProductPhotos(p) {
  const list = $("#prodPhotosList");
  list.innerHTML = "";
  (p?.photos || []).forEach((photo) => {
    const li = document.createElement("li");
    li.className = "product-photo-thumb";
    li.innerHTML = `<img src="${escapeAttr(photo.url)}" alt="" /><button type="button" class="icon-btn icon-btn-danger" title="Eliminar"><i class="fas fa-times"></i></button>`;
    li.querySelector("button").onclick = () => onDeleteExistingPhoto(p.id, photo);
    list.appendChild(li);
  });
  pendingPhotoFiles.forEach((file, idx) => {
    const li = document.createElement("li");
    li.className = "product-photo-thumb is-pending";
    const url = URL.createObjectURL(file);
    li.innerHTML = `<img src="${url}" alt="" /><button type="button" class="icon-btn icon-btn-danger" title="Quitar"><i class="fas fa-times"></i></button>`;
    li.querySelector("button").onclick = () => {
      pendingPhotoFiles.splice(idx, 1);
      renderProductPhotos(p);
    };
    list.appendChild(li);
  });
}

async function onProductPhotoFiles(ev) {
  const files = Array.from(ev.target.files || []).filter((f) => f.type.startsWith("image/"));
  ev.target.value = "";
  if (files.length === 0) return;

  const id = $("#prodId").value;
  if (!id) {
    pendingPhotoFiles.push(...files);
    renderProductPhotos(null);
    return;
  }

  const p = products.find((x) => x.id === id);
  toast(`Subiendo ${files.length} foto${files.length === 1 ? "" : "s"}…`);
  try {
    const uploaded = [];
    for (const file of files) uploaded.push(await uploadProductPhoto(id, file));
    const photos = [...(p.photos || []), ...uploaded];
    await updateProduct(id, { photos });
    toast("Foto(s) agregada(s).", "success");
    renderProductPhotos({ ...p, photos });
  } catch (err) {
    toast("Error subiendo foto: " + err.message, "error");
  }
}

async function onDeleteExistingPhoto(productId, photo) {
  if (!confirm("¿Eliminar esta foto?")) return;
  try {
    if (photo.path) await deleteProductPhoto(photo.path);
    const p = products.find((x) => x.id === productId);
    const photos = (p.photos || []).filter((ph) => ph.id !== photo.id);
    await updateProduct(productId, { photos });
    toast("Foto eliminada.", "success");
    renderProductPhotos({ ...p, photos });
  } catch (err) {
    toast("Error eliminando foto: " + err.message, "error");
  }
}

async function onProductFormSubmit(ev) {
  ev.preventDefault();
  const id = $("#prodId").value;
  const name = $("#prodName").value.trim();
  if (!name) { toast("El nombre es obligatorio.", "error"); return; }
  const priceVal = $("#prodPrice").value;
  if (priceVal === "") { toast("El precio es obligatorio.", "error"); return; }

  const payload = {
    name,
    category: $("#prodCategory").value.trim(),
    unit: $("#prodUnit").value.trim() || "pieza",
    price: Number(priceVal),
    cost: $("#prodCost").value === "" ? "" : Number($("#prodCost").value),
    lowStockThreshold: Number($("#prodLowStock").value) || 0,
    active: $("#prodActive").value === "true",
    description: $("#prodDesc").value.trim(),
    brand: $("#prodBrand").value.trim(),
    size: $("#prodSize").value.trim(),
    highlights: $("#prodHighlights").value.split("\n").map((s) => s.trim()).filter(Boolean),
    usage: $("#prodUsage").value.trim(),
  };

  const btn = $("#prodSaveBtn");
  btn.disabled = true;
  btn.innerHTML = `<i class="fas fa-spinner fa-spin"></i> Guardando…`;
  try {
    if (id) {
      await updateProduct(id, payload);
      toast("Producto actualizado.", "success");
    } else {
      payload.initialStock = Number($("#prodInitialStock").value) || 0;
      payload.order = products.length;
      const created = await createProduct(payload);
      if (pendingPhotoFiles.length > 0) {
        const uploaded = [];
        for (const file of pendingPhotoFiles) uploaded.push(await uploadProductPhoto(created.id, file));
        await updateProduct(created.id, { photos: uploaded });
      }
      toast("Producto creado.", "success");
    }
    closeProductModal();
  } catch (err) {
    toast("Error guardando producto: " + err.message, "error");
  } finally {
    btn.disabled = false;
    btn.innerHTML = `<i class="fas fa-check"></i> Guardar producto`;
  }
}

async function onProductDelete() {
  const id = $("#prodId").value;
  const p = products.find((x) => x.id === id);
  if (!p) return;
  if (!confirm(`¿Eliminar "${p.name}"? Esta acción no se puede deshacer.`)) return;
  try {
    for (const photo of p.photos || []) {
      if (photo.path) { try { await deleteProductPhoto(photo.path); } catch (_) { /* best effort */ } }
    }
    await deleteProduct(id);
    toast("Producto eliminado.", "success");
    closeProductModal();
  } catch (err) {
    toast("Error eliminando producto: " + err.message, "error");
  }
}

// ---------- Inventory ----------
function openStockModal(productId) {
  const p = products.find((x) => x.id === productId);
  if (!p) return;

  $("#stockProductId").value = productId;
  $("#stockModalTitle").textContent = `Inventario · ${p.name}`;
  $("#stockCurrentInfo").innerHTML = `<p class="field-hint">Existencia actual: <b>${Number(p.stock) || 0} ${escape(p.unit || "pza")}</b></p>`;
  $("#stockType").value = "entrada";
  $("#stockQty").value = "";
  $("#stockReason").value = "";
  $("#stockModal").hidden = false;

  renderStockHistory([]);
  subscribeMovements(productId, renderStockHistory).then((unsub) => {
    if (stockMovementsUnsub) stockMovementsUnsub();
    stockMovementsUnsub = unsub;
  });

  setTimeout(() => $("#stockQty").focus(), 50);
}

function closeStockModal() {
  $("#stockModal").hidden = true;
  $("#stockForm").reset();
  if (stockMovementsUnsub) { stockMovementsUnsub(); stockMovementsUnsub = null; }
}

function renderStockHistory(rows) {
  const el = $("#stockHistory");
  if (!rows.length) {
    el.innerHTML = `<p class="field-hint">Sin movimientos registrados aún.</p>`;
    return;
  }
  el.innerHTML = rows.map((r) => `
    <div class="stock-history-row">
      <span class="stock-history-type is-${r.type === "salida" ? "salida" : "entrada"}">
        ${r.type === "salida" ? "−" : "+"}${r.quantity}
      </span>
      <span>${escape(r.reason || "—")}</span>
      <span>${new Date(r.createdAt).toLocaleDateString("es-MX", { timeZone: SHOP_TZ, day: "2-digit", month: "short" })}</span>
    </div>
  `).join("");
}

async function onStockFormSubmit(ev) {
  ev.preventDefault();
  const productId = $("#stockProductId").value;
  const type = $("#stockType").value;
  const qty = Number($("#stockQty").value);
  const reason = $("#stockReason").value.trim();
  if (!qty || qty <= 0) { toast("Ingresa una cantidad válida.", "error"); return; }

  const btn = $("#stockSubmitBtn");
  btn.disabled = true;
  btn.innerHTML = `<i class="fas fa-spinner fa-spin"></i> Guardando…`;
  try {
    const p = products.find((x) => x.id === productId);
    const stockAfter = await adjustStock(productId, { type, quantity: qty, reason });
    toast(type === "salida" ? "Salida registrada." : "Entrada registrada.", "success");
    $("#stockQty").value = "";
    $("#stockReason").value = "";
    $("#stockCurrentInfo").innerHTML = `<p class="field-hint">Existencia actual: <b>${stockAfter} ${escape(p?.unit || "pza")}</b></p>`;
  } catch (err) {
    toast(err.message || "Error registrando el movimiento.", "error");
  } finally {
    btn.disabled = false;
    btn.innerHTML = `<i class="fas fa-check"></i> Registrar`;
  }
}

// ---------- QR labels ----------
async function openQrModal(productId) {
  const p = products.find((x) => x.id === productId);
  if (!p) return;
  qrCurrentProduct = p;
  $("#qrLabelName").textContent = p.name;
  $("#qrLabelPrice").textContent = formatPrice(p.price);
  $("#qrModal").hidden = false;
  try {
    await renderQrToCanvas($("#qrCanvas"), buildProductUrl(p.id), { size: 256 });
  } catch (err) {
    toast("No se pudo generar el código QR: " + err.message, "error");
  }
}

function closeQrModal() {
  $("#qrModal").hidden = true;
  qrCurrentProduct = null;
}

// ---------- Copy / download QR (for the client's own label designs) ----------
async function canvasToClipboard(canvas) {
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
  if (!blob) throw new Error("No se pudo generar la imagen.");
  if (!navigator.clipboard || typeof window.ClipboardItem === "undefined") {
    throw new Error("Tu navegador no soporta copiar imágenes. Usa \"Descargar\" en su lugar.");
  }
  await navigator.clipboard.write([new window.ClipboardItem({ "image/png": blob })]);
}

function downloadCanvas(canvas, filename) {
  const link = document.createElement("a");
  link.href = canvas.toDataURL("image/png");
  link.download = filename;
  link.click();
}

function slugify(s) {
  return String(s || "producto")
    .toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "") || "producto";
}

async function onCopyQr() {
  try {
    await canvasToClipboard($("#qrCanvas"));
    toast("QR copiado. Ya lo puedes pegar en Word, Canva, etc.", "success");
  } catch (err) {
    toast(err.message || "No se pudo copiar el QR.", "error");
  }
}

function onDownloadQr() {
  if (!qrCurrentProduct) return;
  downloadCanvas($("#qrCanvas"), `qr-${slugify(qrCurrentProduct.name)}.png`);
}

async function onPrintLabel() {
  if (!qrCurrentProduct) return;
  const sizeCm = $("#qrSize").value;
  const showPrice = $("#qrShowPrice").checked;
  const dataUrl = $("#qrCanvas").toDataURL("image/png");

  $("#printLabel").innerHTML = `
    <div class="print-label-item" style="width:${sizeCm}cm;height:${sizeCm}cm;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:1.5mm;padding:1mm;box-sizing:border-box;font-family:sans-serif;">
      <img src="${dataUrl}" style="width:80%;height:auto;" />
      <div style="font-size:2.2mm;font-weight:700;text-align:center;line-height:1.1;">${escape(qrCurrentProduct.name)}</div>
      ${showPrice ? `<div style="font-size:2mm;">${escape(formatPrice(qrCurrentProduct.price))}</div>` : ""}
    </div>
  `;
  document.body.classList.add("is-printing-label");
  window.print();
}

// ============================================================
// Etiquetas QR (bulk)
// ============================================================
function renderLabelPickList() {
  const list = $("#labelPickList");
  if (!list) return;
  const active = products.filter((p) => p.active !== false);
  if (active.length === 0) {
    list.innerHTML = `<li class="empty">Aún no hay productos.</li>`;
    renderLabelPreviews();
    return;
  }
  list.innerHTML = active.map((p) => `
    <li class="label-pick-row">
      <input type="checkbox" data-label-pick="${p.id}" />
      <span>${escape(p.name)} <span class="field-hint">${formatPrice(p.price)}</span></span>
      <input type="number" min="1" step="1" value="1" data-label-qty="${p.id}" title="Copias" />
    </li>
  `).join("");
  list.querySelectorAll('[data-label-pick]').forEach((cb) => {
    cb.addEventListener("change", renderLabelPreviews);
  });
  renderLabelPreviews();
}

// Live preview of each selected product's QR label — same look and
// copy/download controls as the single-product modal, just repeated.
async function renderLabelPreviews() {
  const container = $("#labelBulkPreviews");
  if (!container) return;
  const checked = $$('[data-label-pick]').filter((cb) => cb.checked);
  if (checked.length === 0) {
    container.innerHTML = "";
    return;
  }
  const showPrice = $("#labelBulkShowPrice").checked;
  const picked = checked
    .map((cb) => products.find((p) => p.id === cb.dataset.labelPick))
    .filter(Boolean);

  container.innerHTML = picked.map((p) => `
    <div class="label-bulk-preview-item">
      <canvas data-bulk-canvas="${p.id}" width="150" height="150"></canvas>
      <div class="qr-label-name">${escape(p.name)}</div>
      ${showPrice ? `<div class="qr-label-price">${formatPrice(p.price)}</div>` : ""}
      <div class="qr-export-row">
        <button type="button" class="btn btn-ghost" data-bulk-copy="${p.id}"><i class="fas fa-copy"></i> Copiar</button>
        <button type="button" class="btn btn-ghost" data-bulk-download="${p.id}"><i class="fas fa-download"></i> Descargar</button>
      </div>
    </div>
  `).join("");

  for (const p of picked) {
    const canvas = container.querySelector(`canvas[data-bulk-canvas="${p.id}"]`);
    if (!canvas) continue;
    try {
      await renderQrToCanvas(canvas, buildProductUrl(p.id), { size: 150 });
    } catch (err) {
      toast(`No se pudo generar el QR de "${p.name}": ` + err.message, "error");
    }
  }

  container.querySelectorAll('[data-bulk-copy]').forEach((btn) => {
    const p = picked.find((x) => x.id === btn.dataset.bulkCopy);
    btn.onclick = async () => {
      try {
        await canvasToClipboard(container.querySelector(`canvas[data-bulk-canvas="${p.id}"]`));
        toast("QR copiado. Ya lo puedes pegar en Word, Canva, etc.", "success");
      } catch (err) {
        toast(err.message || "No se pudo copiar el QR.", "error");
      }
    };
  });
  container.querySelectorAll('[data-bulk-download]').forEach((btn) => {
    const p = picked.find((x) => x.id === btn.dataset.bulkDownload);
    btn.onclick = () => {
      downloadCanvas(container.querySelector(`canvas[data-bulk-canvas="${p.id}"]`), `qr-${slugify(p.name)}.png`);
    };
  });
}

async function onPrintBulkLabels() {
  const checked = $$('[data-label-pick]').filter((cb) => cb.checked);
  if (checked.length === 0) { toast("Selecciona al menos un producto.", "error"); return; }

  const sizeCm = $("#labelBulkSize").value;
  const showPrice = $("#labelBulkShowPrice").checked;

  const items = [];
  for (const cb of checked) {
    const id = cb.dataset.labelPick;
    const p = products.find((x) => x.id === id);
    if (!p) continue;
    const qtyInput = document.querySelector(`[data-label-qty="${id}"]`);
    const qty = Math.max(1, Number(qtyInput?.value) || 1);
    for (let i = 0; i < qty; i++) items.push(p);
  }

  const btn = $("#labelBulkPrintBtn");
  btn.disabled = true;
  btn.innerHTML = `<i class="fas fa-spinner fa-spin"></i> Generando…`;
  try {
    const labelsHtml = [];
    for (const p of items) {
      const canvas = document.createElement("canvas");
      await renderQrToCanvas(canvas, buildProductUrl(p.id), { size: 200 });
      const dataUrl = canvas.toDataURL("image/png");
      labelsHtml.push(`
        <div class="print-label-item" style="width:${sizeCm}cm;height:${sizeCm}cm;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:1.5mm;padding:1mm;box-sizing:border-box;font-family:sans-serif;">
          <img src="${dataUrl}" style="width:80%;height:auto;" />
          <div style="font-size:2.2mm;font-weight:700;text-align:center;line-height:1.1;">${escape(p.name)}</div>
          ${showPrice ? `<div style="font-size:2mm;">${escape(formatPrice(p.price))}</div>` : ""}
        </div>
      `);
    }
    $("#printLabel").innerHTML = labelsHtml.join("");
    document.body.classList.add("is-printing-label");
    window.print();
  } catch (err) {
    toast("Error generando etiquetas: " + err.message, "error");
  } finally {
    btn.disabled = false;
    btn.innerHTML = `<i class="fas fa-print"></i> Imprimir seleccionadas`;
  }
}

// ============================================================
// Caja (POS)
// ============================================================
function switchPosView(view) {
  $$('[data-pos-view]').forEach((b) => b.classList.toggle("is-active", b.dataset.posView === view));
  $("#posVenderView").hidden = view !== "vender";
  $("#posCorteView").hidden = view !== "corte";
  if (view === "corte") loadCorte();
}

function renderPosItemList() {
  const list = $("#posItemList");
  if (!list) return;
  list.innerHTML = "";

  if (posKind === "service") {
    const services = (workingData?.services || [])
      .filter((s) => s.active !== false)
      .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    if (services.length === 0) {
      list.innerHTML = `<li class="empty">Sin servicios activos.</li>`;
      return;
    }
    services.forEach((s) => {
      const li = document.createElement("li");
      li.className = "pos-item-row";
      li.innerHTML = `
        <div>
          <div class="pos-item-name">${escape(s.name)}</div>
          ${s.description ? `<div class="pos-item-sub">${escape(s.description)}</div>` : ""}
        </div>
        <div class="pos-item-price">${formatPrice(s.price)}</div>
      `;
      li.onclick = () => addToCart({ kind: "service", refId: s.id, name: s.name, unitPrice: Number(s.price) || 0 });
      list.appendChild(li);
    });
  } else {
    const active = products.filter((p) => p.active !== false);
    if (active.length === 0) {
      list.innerHTML = `<li class="empty">Aún no hay productos.</li>`;
      return;
    }
    active.forEach((p) => {
      const stock = Number(p.stock) || 0;
      const disabled = stock <= 0;
      const li = document.createElement("li");
      li.className = "pos-item-row" + (disabled ? " is-disabled" : "");
      li.innerHTML = `
        <div>
          <div class="pos-item-name">${escape(p.name)}</div>
          <div class="pos-item-sub">${disabled ? "Agotado" : `${stock} ${escape(p.unit || "pza")} disponibles`}</div>
        </div>
        <div class="pos-item-price">${formatPrice(p.price)}</div>
      `;
      if (!disabled) {
        li.onclick = () => addToCart({ kind: "product", refId: p.id, name: p.name, unitPrice: Number(p.price) || 0, maxQty: stock });
      }
      list.appendChild(li);
    });
  }
}

function addToCart(item) {
  const existing = posCart.find((i) => i.kind === item.kind && i.refId === item.refId);
  if (existing) {
    if (item.kind === "product" && item.maxQty != null && existing.qty + 1 > item.maxQty) {
      toast("No hay más inventario disponible de este producto.", "error");
      return;
    }
    existing.qty += 1;
  } else {
    posCart.push({ ...item, qty: 1 });
  }
  renderPosCart();
}

function changeQty(idx, delta) {
  const item = posCart[idx];
  if (!item) return;
  const newQty = item.qty + delta;
  if (newQty <= 0) {
    posCart.splice(idx, 1);
    renderPosCart();
    return;
  }
  if (item.kind === "product" && item.maxQty != null && newQty > item.maxQty) {
    toast("No hay más inventario disponible.", "error");
    return;
  }
  item.qty = newQty;
  renderPosCart();
}

function cartTotal() {
  return posCart.reduce((sum, i) => sum + i.unitPrice * i.qty, 0);
}
function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

function renderPosCart() {
  const list = $("#posCartList");
  if (posCart.length === 0) {
    list.innerHTML = `<li class="pos-cart-empty">Agrega servicios o productos a la venta.</li>`;
  } else {
    list.innerHTML = "";
    posCart.forEach((item, idx) => {
      const li = document.createElement("li");
      li.className = "pos-cart-row";
      li.innerHTML = `
        <div>
          <div class="pos-cart-row-name">${escape(item.name)}</div>
          <div class="pos-cart-row-sub">${formatPrice(item.unitPrice)} c/u</div>
        </div>
        <div class="pos-qty">
          <button type="button" data-action="dec">−</button>
          <span>${item.qty}</span>
          <button type="button" data-action="inc">+</button>
        </div>
        <button type="button" class="icon-btn icon-btn-danger" data-action="remove"><i class="fas fa-times"></i></button>
      `;
      li.querySelector('[data-action="dec"]').onclick = () => changeQty(idx, -1);
      li.querySelector('[data-action="inc"]').onclick = () => changeQty(idx, 1);
      li.querySelector('[data-action="remove"]').onclick = () => { posCart.splice(idx, 1); renderPosCart(); };
      list.appendChild(li);
    });
  }
  $("#posTotal").textContent = formatPrice(cartTotal());
  updatePaymentRemaining();
}

// ---------- Payment (single method or split across cash/multiple cards) ----------
const METHOD_LABELS = { efectivo: "Efectivo", tarjeta: "Tarjeta", transferencia: "Transferencia" };
function methodLabel(m) { return METHOD_LABELS[m] || "Efectivo"; }

function setQuickPaymentMethod(method) {
  posSplitMode = false;
  posPaymentMethod = method;
  posPayments = [];
  renderPosPayments();
}

function onToggleSplitPayment() {
  if (posSplitMode) {
    posSplitMode = false;
    posPayments = [];
  } else {
    posSplitMode = true;
    posPayments = [{ id: makeId(), method: posPaymentMethod, amount: round2(cartTotal()), note: "" }];
  }
  renderPosPayments();
}

function onAddPaymentLine() {
  const remaining = round2(cartTotal() - posPayments.reduce((s, p) => s + (Number(p.amount) || 0), 0));
  const lastMethod = posPayments[posPayments.length - 1]?.method || "efectivo";
  posPayments.push({
    id: makeId(),
    method: PAYMENT_METHODS[(PAYMENT_METHODS.indexOf(lastMethod) + 1) % PAYMENT_METHODS.length],
    amount: Math.max(0, remaining),
    note: "",
  });
  renderPosPayments();
}

function onRemovePaymentLine(id) {
  posPayments = posPayments.filter((p) => p.id !== id);
  if (posPayments.length === 0) posSplitMode = false;
  renderPosPayments();
}

function paymentsRemaining() {
  const sum = posSplitMode
    ? posPayments.reduce((s, p) => s + (Number(p.amount) || 0), 0)
    : cartTotal();
  return round2(cartTotal() - sum);
}

function renderPosPayments() {
  $$('[data-pos-payment]').forEach((b) => b.classList.toggle("is-active", !posSplitMode && b.dataset.posPayment === posPaymentMethod));
  $("#posSplitPaymentBtn").classList.toggle("is-active", posSplitMode);

  const linesEl = $("#posPaymentLines");
  const splitActions = $("#posSplitActions");
  const remainingEl = $("#posPaymentRemaining");

  if (!posSplitMode) {
    linesEl.hidden = true;
    linesEl.innerHTML = "";
    splitActions.hidden = true;
    remainingEl.hidden = true;
    $("#posChargeBtn").disabled = false;
    return;
  }

  linesEl.hidden = false;
  splitActions.hidden = false;
  remainingEl.hidden = false;

  linesEl.innerHTML = posPayments.map((p) => `
    <li class="pos-payment-line" data-id="${p.id}">
      <select data-field="method">
        ${PAYMENT_METHODS.map((m) => `<option value="${m}" ${p.method === m ? "selected" : ""}>${methodLabel(m)}</option>`).join("")}
      </select>
      <input type="number" min="0" step="0.01" data-field="amount" value="${p.amount}" />
      <input type="text" data-field="note" placeholder="Ref. (opcional)" maxlength="20" value="${escapeAttr(p.note || "")}" />
      <button type="button" class="icon-btn icon-btn-danger" data-action="remove" title="Quitar"><i class="fas fa-times"></i></button>
    </li>
  `).join("");

  linesEl.querySelectorAll(".pos-payment-line").forEach((li) => {
    const id = li.dataset.id;
    const line = posPayments.find((p) => p.id === id);
    li.querySelector('[data-field="method"]').addEventListener("change", (e) => { line.method = e.target.value; });
    li.querySelector('[data-field="amount"]').addEventListener("input", (e) => {
      line.amount = e.target.value === "" ? 0 : Number(e.target.value);
      updatePaymentRemaining();
    });
    li.querySelector('[data-field="note"]').addEventListener("input", (e) => { line.note = e.target.value; });
    li.querySelector('[data-action="remove"]').onclick = () => onRemovePaymentLine(id);
  });

  updatePaymentRemaining();
}

function updatePaymentRemaining() {
  if (!posSplitMode) return;
  const remainingEl = $("#posPaymentRemaining");
  const remaining = paymentsRemaining();
  const balanced = Math.abs(remaining) < 0.01;
  remainingEl.textContent = balanced ? "Pagos completos" : `Restante: ${formatPrice(remaining)}`;
  remainingEl.classList.toggle("is-balanced", balanced);
  remainingEl.classList.toggle("is-off", !balanced);
  $("#posChargeBtn").disabled = !balanced || posPayments.length === 0;
}

function currentPayments() {
  if (!posSplitMode) return [{ method: posPaymentMethod, amount: round2(cartTotal()), note: "" }];
  return posPayments.map((p) => ({ method: p.method, amount: round2(p.amount), note: (p.note || "").trim() }));
}

function summarizePayments(payments) {
  if (payments.length === 1) return methodLabel(payments[0].method);
  return payments.map((p) => `${methodLabel(p.method)} ${formatPrice(p.amount)}`).join(" + ");
}

async function onCharge() {
  if (posCart.length === 0) { toast("Agrega al menos un artículo.", "error"); return; }
  const payments = currentPayments();
  if (posSplitMode) {
    if (payments.some((p) => p.amount <= 0)) { toast("Cada pago debe ser mayor a cero.", "error"); return; }
    const remaining = paymentsRemaining();
    if (Math.abs(remaining) >= 0.01) { toast(`Los pagos no cuadran con el total (restante ${formatPrice(remaining)}).`, "error"); return; }
  }

  const btn = $("#posChargeBtn");
  btn.disabled = true;
  btn.innerHTML = `<i class="fas fa-spinner fa-spin"></i> Cobrando…`;
  try {
    const items = posCart.map((i) => ({ kind: i.kind, refId: i.refId, name: i.name, unitPrice: i.unitPrice, qty: i.qty }));
    const cashier = { uid: myProfile.uid, name: myProfile.displayName || myProfile.email };
    const sale = await sellCart(items, payments, cashier);
    lastSale = { ...sale, items, payments, createdAt: new Date().toISOString() };
    posCart = [];
    posSplitMode = false;
    posPayments = [];
    renderPosCart();
    renderPosPayments();
    $("#posReceiptSummary").textContent =
      `Total cobrado: ${formatPrice(sale.total)} (${summarizePayments(payments)}). ¿Quieres imprimir un recibo?`;
    $("#posReceiptModal").hidden = false;
    toast("Venta registrada.", "success");
  } catch (err) {
    toast(err.message || "Error al cobrar.", "error");
  } finally {
    btn.disabled = false;
    btn.innerHTML = `<i class="fas fa-cash-register"></i> Cobrar`;
  }
}

function closeReceiptModal() {
  $("#posReceiptModal").hidden = true;
}

function onPrintReceipt() {
  closeReceiptModal();
  if (lastSale) printReceipt(lastSale);
}

function printReceipt(sale) {
  const rows = (sale.items || []).map((i) => `
    <div style="display:flex;justify-content:space-between;font-size:3mm;margin-bottom:1mm;">
      <span>${i.qty} × ${escape(i.name)}</span>
      <span>${formatPrice(i.unitPrice * i.qty)}</span>
    </div>
  `).join("");
  $("#printReceipt").innerHTML = `
    <div style="width:72mm;font-family:monospace;padding:4mm;">
      <div style="text-align:center;font-weight:700;font-size:4mm;margin-bottom:2mm;">RCR Barber Shop</div>
      <div style="text-align:center;font-size:2.6mm;margin-bottom:3mm;">${new Date(sale.createdAt).toLocaleString("es-MX", { timeZone: SHOP_TZ })}</div>
      <hr />
      ${rows}
      <hr />
      <div style="display:flex;justify-content:space-between;font-weight:700;font-size:3.4mm;margin-top:2mm;">
        <span>Total</span><span>${formatPrice(sale.total)}</span>
      </div>
      ${paymentLines(sale).map((p) => `
        <div style="display:flex;justify-content:space-between;font-size:2.8mm;margin-top:1mm;">
          <span>${methodLabel(p.method)}${p.note ? ` (${escape(p.note)})` : ""}</span>
          <span>${formatPrice(p.amount)}</span>
        </div>
      `).join("")}
    </div>
  `;
  document.body.classList.add("is-printing-receipt");
  window.print();
}

async function openPosScanModal() {
  $("#posScanModal").hidden = false;
  $("#posScanHint").textContent = "Apunta la cámara al código QR del producto.";
  posScanStop = await scanCodeFromCamera($("#posScanVideo"), onScanResult, onScanError);
}

function closePosScanModal() {
  $("#posScanModal").hidden = true;
  if (posScanStop) { posScanStop(); posScanStop = null; }
}

function onScanResult(text) {
  const id = extractProductId(text);
  const p = products.find((x) => x.id === id);
  closePosScanModal();
  if (!p) { toast("No se encontró ese producto.", "error"); return; }
  const stock = Number(p.stock) || 0;
  if (stock <= 0) { toast(`"${p.name}" está agotado.`, "error"); return; }
  addToCart({ kind: "product", refId: p.id, name: p.name, unitPrice: Number(p.price) || 0, maxQty: stock });
  toast(`"${p.name}" agregado a la venta.`, "success");
}

function onScanError(err) {
  $("#posScanHint").textContent = "No se pudo acceder a la cámara: " + err.message;
}

// ---------- Corte de caja ----------
// Todo el "día" de la caja se calcula en hora de México, no en UTC ni en la
// zona del navegador: una venta a las 6 pm+ en CDMX ya es el día siguiente en UTC.
const SHOP_TZ = "America/Mexico_City";
const tzFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: SHOP_TZ, hourCycle: "h23",
  year: "numeric", month: "numeric", day: "numeric",
  hour: "numeric", minute: "numeric", second: "numeric",
});

// Instante UTC (ms) de la medianoche de y-m-d en hora de México (m 1-12, d puede desbordar)
function shopMidnightMs(y, m, d) {
  const wall = Date.UTC(y, m - 1, d);
  let guess = wall;
  for (let i = 0; i < 2; i++) {
    const p = {};
    tzFormatter.formatToParts(new Date(guess)).forEach((x) => { if (x.type !== "literal") p[x.type] = Number(x.value); });
    guess = wall - (Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - guess);
  }
  return guess;
}

function todayIso() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: SHOP_TZ }).format(new Date());
}

// "YYYY-MM-DD" -> { startIso, endIso } cubriendo ese día completo en hora de México
function shopDayRange(fromYmd, toYmd) {
  const [fy, fm, fd] = fromYmd.split("-").map(Number);
  const [ty, tm, td] = toYmd.split("-").map(Number);
  return {
    startIso: new Date(shopMidnightMs(fy, fm, fd)).toISOString(),
    endIso: new Date(shopMidnightMs(ty, tm, td + 1) - 1).toISOString(),
  };
}

let lastCorteRows = [];

function renderCorteCashierOptions() {
  const sel = $("#corteCashier");
  if (!sel || !isAdminRole()) return;
  const current = sel.value || "all";
  sel.innerHTML = `<option value="all">Todos (corte total)</option>` +
    allUsers.map((u) => `<option value="${u.uid}">${escape(u.displayName || u.email)}</option>`).join("");
  sel.value = allUsers.some((u) => u.uid === current) || current === "all" ? current : "all";
  corteCashierFilter = sel.value;
}

async function loadCorte() {
  const fromEl = $("#corteFrom");
  const toEl = $("#corteTo");
  if (!fromEl.value) fromEl.value = todayIso();
  if (!toEl.value) toEl.value = todayIso();

  const { startIso, endIso } = shopDayRange(fromEl.value, toEl.value);

  $("#corteList").innerHTML = `<p class="field-hint">Cargando…</p>`;
  try {
    commissionSettings = await fetchCommissionSettings();
    renderCommissionSettings();
    // Cashiers must query filtered by their own uid — firestore.rules can
    // only allow a "list" query it can prove is scoped to their own sales
    // (see fetchTransactionsRange). Admin fetches everyone's.
    const cashierUid = isAdminRole() ? null : myProfile.uid;
    lastCorteRows = await fetchTransactionsRange(startIso, endIso, cashierUid);
    renderCorte();
  } catch (err) {
    $("#corteList").innerHTML = `<p class="field-hint">Error: ${escape(err.message)}</p>`;
  }
}

function renderCommissionSettings() {
  const box = $("#commissionSettings");
  box.hidden = !isAdminRole();
  if (!isAdminRole()) return;
  $("#commissionPercent").value = commissionSettings.servicePercent;
  $("#commissionProduct").value = commissionSettings.productAmount;
}

async function onSaveCommission() {
  const btn = $("#commissionSaveBtn");
  btn.disabled = true;
  try {
    commissionSettings = await saveCommissionSettings({
      servicePercent: $("#commissionPercent").value,
      productAmount: $("#commissionProduct").value,
    });
    renderCommissionSettings();
    renderCorte();
    toast("Comisión guardada.", "success");
  } catch (err) {
    toast(err.message || "No se pudo guardar la comisión.", "error");
  } finally {
    btn.disabled = false;
  }
}

function paymentBadge(r) {
  if (r.paymentMethod === "mixto") return "Mixto";
  return methodLabel(r.paymentMethod);
}

function renderCorte() {
  const admin = isAdminRole();
  const rows = admin && corteCashierFilter !== "all"
    ? lastCorteRows.filter((r) => r.cashierUid === corteCashierFilter)
    : lastCorteRows;

  const valid = rows.filter((r) => !r.voided);
  let efectivo = 0, tarjeta = 0, transferencia = 0;
  valid.forEach((r) => {
    paymentLines(r).forEach((p) => {
      const amt = Number(p.amount) || 0;
      if (p.method === "tarjeta") tarjeta += amt;
      else if (p.method === "transferencia") transferencia += amt;
      else efectivo += amt;
    });
  });

  let commissionTotal = 0;
  const byCashier = new Map();
  valid.forEach((r) => {
    const c = saleCommission(r, commissionSettings);
    commissionTotal += c;
    byCashier.set(r.cashierName || "—", (byCashier.get(r.cashierName || "—") || 0) + c);
  });
  commissionTotal = Math.round(commissionTotal * 100) / 100;
  const breakdownEl = $("#corteCommissionBreakdown");
  const showBreakdown = admin && corteCashierFilter === "all" && byCashier.size > 0;
  breakdownEl.hidden = !showBreakdown;
  if (showBreakdown) {
    breakdownEl.textContent = "Comisión por cajero: " +
      [...byCashier].map(([n, v]) => `${n} ${formatPrice(Math.round(v * 100) / 100)}`).join(" · ");
  }

  $("#corteTotals").innerHTML = `
    <div class="pos-report-tile"><div class="pos-report-tile-label">Efectivo</div><div class="pos-report-tile-value">${formatPrice(efectivo)}</div></div>
    <div class="pos-report-tile"><div class="pos-report-tile-label">Tarjeta</div><div class="pos-report-tile-value">${formatPrice(tarjeta)}</div></div>
    <div class="pos-report-tile"><div class="pos-report-tile-label">Transferencia</div><div class="pos-report-tile-value">${formatPrice(transferencia)}</div></div>
    <div class="pos-report-tile"><div class="pos-report-tile-label">Total</div><div class="pos-report-tile-value">${formatPrice(efectivo + tarjeta + transferencia)}</div></div>
    <div class="pos-report-tile"><div class="pos-report-tile-label">${admin && corteCashierFilter === "all" ? "Comisiones (todos)" : "Comisión"}</div><div class="pos-report-tile-value">${formatPrice(commissionTotal)}</div></div>
    <div class="pos-report-tile"><div class="pos-report-tile-label">Ventas</div><div class="pos-report-tile-value">${valid.length}</div></div>
  `;

  const list = $("#corteList");
  if (rows.length === 0) {
    list.innerHTML = `<p class="field-hint">Sin ventas en este rango.</p>`;
    return;
  }
  list.innerHTML = rows.map((r) => `
    <div class="tx-row ${admin ? "has-cashier" : ""} ${r.voided ? "is-voided" : ""}">
      <span class="tx-row-time">${new Date(r.createdAt).toLocaleString("es-MX", { timeZone: SHOP_TZ, day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })}</span>
      <span class="tx-row-items">${escape((r.items || []).map((i) => `${i.qty}× ${i.name}`).join(", "))}${r.voided ? " (cancelada)" : ""}<br><small style="opacity:.65">${escape(paymentLines(r).map((p) => `${methodLabel(p.method)} ${formatPrice(p.amount)}${p.note ? ` (${p.note})` : ""}`).join(" + "))}</small></span>
      ${admin ? `<span class="tx-row-cashier">${escape(r.cashierName || "—")}</span>` : ""}
      <span class="tx-row-method" title="${escapeAttr(paymentLines(r).map((p) => `${methodLabel(p.method)}: ${formatPrice(p.amount)}`).join(" · "))}">${paymentBadge(r)}</span>
      <span class="tx-row-total">${formatPrice(r.total)}</span>
      <button type="button" class="icon-btn" data-action="print" data-tx-id="${r.id}" title="Imprimir recibo"><i class="fas fa-print"></i></button>
      ${r.voided ? "" : `<button type="button" class="icon-btn icon-btn-danger" data-action="void" data-tx-id="${r.id}" title="Cancelar venta"><i class="fas fa-ban"></i></button>`}
    </div>
  `).join("");
  list.querySelectorAll('[data-action="print"]').forEach((btn) => {
    btn.onclick = () => {
      const tx = rows.find((r) => r.id === btn.dataset.txId);
      if (tx) printReceipt(tx);
    };
  });
  list.querySelectorAll('[data-action="void"]').forEach((btn) => {
    btn.onclick = () => onVoidTransaction(btn.dataset.txId);
  });
}

async function onVoidTransaction(id) {
  if (!confirm("¿Cancelar esta venta? Se devolverá el inventario de los productos incluidos.")) return;

  if (!isAdminRole()) {
    // Cashiers can't void on their own — an admin has to authorize it live.
    openAdminAuthModal(id);
    return;
  }
  try {
    await voidTransaction(id, null, myProfile.uid);
    toast("Venta cancelada.", "success");
    loadCorte();
  } catch (err) {
    toast(err.message || "Error al cancelar.", "error");
  }
}

// ============================================================
// Gallery upload + delete
// ============================================================
async function onUploadFiles(ev) {
  const files = Array.from(ev.target.files || []);
  ev.target.value = "";
  if (files.length === 0) return;

  const progress = $("#uploadProgress");
  progress.hidden = false;
  progress.textContent = `Subiendo 0/${files.length}…`;

  try {
    const { storage, ref, uploadBytes, getDownloadURL } = await getStorage();
    workingData.gallery = workingData.gallery || [];
    let done = 0;
    for (const file of files) {
      if (!file.type.startsWith("image/")) {
        toast(`"${file.name}" no es una imagen, se omitió.`, "error");
        done++; progress.textContent = `Subiendo ${done}/${files.length}…`;
        continue;
      }
      const id = makeId();
      const ext = (file.name.split(".").pop() || "jpg").toLowerCase();
      const path = `gallery/${id}.${ext}`;
      const r = ref(storage, path);
      await uploadBytes(r, file, { contentType: file.type });
      const url = await getDownloadURL(r);
      workingData.gallery.push({
        id, url, alt: "", order: workingData.gallery.length,
        path,
        uploadedAt: new Date().toISOString(),
      });
      done++; progress.textContent = `Subiendo ${done}/${files.length}…`;
    }
    progress.hidden = true;
    renderGallery();
    markDirty();
    toast(`${done} foto${done === 1 ? "" : "s"} agregada${done === 1 ? "" : "s"}. Recuerda guardar.`, "success");
  } catch (err) {
    progress.hidden = true;
    toast("Error subiendo imágenes: " + err.message, "error");
  }
}

async function onDeletePhoto(g) {
  if (!confirm("¿Eliminar esta foto? Se borrará de Firebase Storage cuando guardes.")) return;
  // Remove from working data; the storage delete happens on save.
  workingData.gallery = workingData.gallery.filter(x => x.id !== g.id);
  reorder(workingData.gallery);
  if (!workingData._pendingDeletions) workingData._pendingDeletions = [];
  if (g.path) workingData._pendingDeletions.push(g.path);
  markDirty();
  renderGallery();
}

// ============================================================
// Save / discard
// ============================================================
async function onSaveAll() {
  const btn = $("#saveBtn");
  btn.disabled = true;
  btn.innerHTML = `<i class="fas fa-spinner fa-spin"></i> Guardando…`;

  try {
    // Strip private fields before saving.
    const pendingDeletions = workingData._pendingDeletions || [];
    const cleaned = deepClone(workingData);
    delete cleaned._pendingDeletions;

    // Make sure orders are normalized.
    reorder(cleaned.services);
    reorder(cleaned.gallery);

    await saveData(cleaned);

    // Best-effort delete of removed storage objects (after Firestore commit).
    if (pendingDeletions.length > 0) {
      try {
        const { storage, ref, deleteObject } = await getStorage();
        for (const path of pendingDeletions) {
          try { await deleteObject(ref(storage, path)); } catch (e) { /* ignore */ }
        }
      } catch (_) { /* ignore */ }
    }

    currentData = deepClone(cleaned);
    workingData = deepClone(cleaned);
    dirty = false;
    refreshSaveBar();
    toast("Cambios guardados.", "success");
  } catch (err) {
    toast("Error al guardar: " + err.message, "error");
  } finally {
    btn.disabled = false;
    btn.innerHTML = `<i class="fas fa-cloud-upload-alt"></i> Guardar cambios`;
  }
}

function onDiscardAll() {
  if (!confirm("¿Descartar todos los cambios sin guardar?")) return;
  workingData = deepClone(currentData);
  dirty = false;
  refreshSaveBar();
  renderAll();
  toast("Cambios descartados.", "");
}

function markDirty() {
  dirty = true;
  refreshSaveBar();
}

function refreshSaveBar() {
  $("#saveBar").hidden = !dirty;
}

// ============================================================
// Drag & drop reorder
// ============================================================
let dragRow = null;

function addDragHandlers(li, list, index) {
  li.addEventListener("dragstart", (e) => {
    dragRow = { li, list, index };
    li.classList.add("dragging");
    e.dataTransfer.effectAllowed = "move";
  });
  li.addEventListener("dragend", () => {
    if (dragRow) dragRow.li.classList.remove("dragging");
    dragRow = null;
    $$(".drop-target").forEach(el => el.classList.remove("drop-target"));
  });
  li.addEventListener("dragover", (e) => {
    e.preventDefault();
    if (!dragRow || dragRow.list !== list) return;
    li.classList.add("drop-target");
  });
  li.addEventListener("dragleave", () => li.classList.remove("drop-target"));
  li.addEventListener("drop", (e) => {
    e.preventDefault();
    if (!dragRow || dragRow.list !== list) return;
    const from = dragRow.index;
    const to = index;
    if (from === to) return;
    const [moved] = list.splice(from, 1);
    list.splice(to, 0, moved);
    reorder(list);
    // Mutate the working data too — for services, that means workingData.services.
    if (list === currentDragOwnedList(list)) {
      // already mutated since list points to the array reference
    }
    markDirty();
    // Re-render the right one
    if (list === workingData.services) renderServices();
    else if (list === workingData.gallery) renderGallery();
  });
}
function currentDragOwnedList(list) { return list; }

function reorder(list) {
  if (!Array.isArray(list)) return;
  list.forEach((item, i) => { if (item) item.order = i; });
}

// ============================================================
// Toast
// ============================================================
let toastTimer = null;
function toast(msg, kind = "") {
  const t = $("#toast");
  t.className = "toast" + (kind ? ` toast-${kind}` : "");
  $("#toastText").textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 3500);
}

// ============================================================
// Utils
// ============================================================
function deepClone(obj) {
  return obj == null ? obj : JSON.parse(JSON.stringify(obj));
}
function makeId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}
function formatPrice(p) {
  if (p === "" || p == null) return "—";
  const n = Number(p);
  if (Number.isNaN(n)) return String(p);
  return `$${n.toLocaleString("es-MX", { maximumFractionDigits: 0 })}`;
}
function escape(s) {
  return String(s ?? "").replace(/[&<>"']/g, c => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}
function escapeAttr(s) { return escape(s); }
