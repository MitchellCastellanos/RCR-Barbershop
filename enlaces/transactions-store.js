// ============================================================
// Cash register (Caja) data layer.
// Collection: `transactions`, admin-only (never exposed publicly).
// A sale is one Firestore transaction that deducts the barbería level in
// `inventory`, keeps the public products/{id}.inStock flag in sync, and
// appends inventory movements + the sale record, so it either fully
// commits or fully fails — never a partial sale with stock silently out
// of sync. (Almacén stock is never sold directly.)
// ============================================================

import { FIREBASE_ENABLED } from "./firebase-config.js";
import { getFirestore } from "./data-store.js";

function makeId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function nowIso() {
  return new Date().toISOString();
}

export const PAYMENT_METHODS = ["efectivo", "tarjeta", "transferencia"];

function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

/** Normalizes a transaction's payment breakdown, for both new (payments[])
 *  and legacy (single paymentMethod + total) rows. */
export function paymentLines(tx) {
  if (Array.isArray(tx.payments) && tx.payments.length > 0) return tx.payments;
  return [{ method: tx.paymentMethod || "efectivo", amount: tx.total, note: "" }];
}

/**
 * cartItems: [{ kind: "service"|"product", refId, name, unitPrice, qty }]
 * payments: [{ method: "efectivo"|"tarjeta"|"transferencia", amount, note? }] — one or more
 * lines that must add up to the cart total (e.g. split cash/card, or
 * several card swipes). A single line behaves exactly like the old
 * single-method flow.
 * cashier: { uid, name } — whoever is signed in and ringing up the sale;
 * firestore.rules requires cashierUid to match the caller's own auth uid.
 */
export async function sellCart(cartItems, payments, cashier, notes = "") {
  if (!FIREBASE_ENABLED) throw new Error("Firebase no está habilitado.");
  if (!cartItems || cartItems.length === 0) throw new Error("El carrito está vacío.");
  if (!cashier || !cashier.uid) throw new Error("No se pudo identificar al cajero.");
  if (!payments || payments.length === 0) throw new Error("Agrega al menos un método de pago.");

  const { db, doc, collection, runTransaction } = await getFirestore();
  const txId = makeId();
  const txRef = doc(db, "transactions", txId);
  const productItems = cartItems.filter((i) => i.kind === "product");

  const total = cartItems.reduce((sum, i) => sum + Number(i.unitPrice) * Number(i.qty), 0);

  const cleanPayments = payments.map((p) => ({
    method: PAYMENT_METHODS.includes(p.method) ? p.method : "efectivo",
    amount: round2(p.amount),
    note: (p.note || "").trim(),
  }));
  if (cleanPayments.some((p) => p.amount <= 0)) {
    throw new Error("Cada pago debe ser mayor a cero.");
  }
  const paymentsTotal = round2(cleanPayments.reduce((s, p) => s + p.amount, 0));
  if (Math.abs(paymentsTotal - round2(total)) > 0.01) {
    throw new Error(`Los pagos (${paymentsTotal}) no coinciden con el total de la venta (${round2(total)}).`);
  }
  const distinctMethods = new Set(cleanPayments.map((p) => p.method));
  const paymentMethod = distinctMethods.size > 1 ? "mixto" : cleanPayments[0].method;

  await runTransaction(db, async (tx) => {
    // 1. Read + validate barbería stock for every product line first
    //    (Firestore transactions require all reads before any writes).
    const productRefs = productItems.map((i) => doc(db, "products", i.refId));
    const invRefs = productItems.map((i) => doc(db, "inventory", i.refId));
    const [productSnaps, invSnaps] = await Promise.all([
      Promise.all(productRefs.map((ref) => tx.get(ref))),
      Promise.all(invRefs.map((ref) => tx.get(ref))),
    ]);

    const wanted = new Map(); // same product on two cart lines → validate the sum
    productItems.forEach((i) => wanted.set(i.refId, (wanted.get(i.refId) || 0) + Number(i.qty)));

    productItems.forEach((item, idx) => {
      if (!productSnaps[idx].exists()) throw new Error(`"${item.name}" ya no existe.`);
      const shop = invSnaps[idx].exists() ? Number(invSnaps[idx].data().levels?.barberia) || 0 : 0;
      if (shop < wanted.get(item.refId)) {
        throw new Error(`No hay suficiente inventario de "${item.name}" en la barbería (quedan ${shop}).`);
      }
    });

    // 2. Write inventory deductions + movement log entries.
    const done = new Set();
    productItems.forEach((item, idx) => {
      if (done.has(item.refId)) return;
      done.add(item.refId);
      const qty = wanted.get(item.refId);
      const levels = invSnaps[idx].data().levels || {};
      const shopAfter = (Number(levels.barberia) || 0) - qty;
      const warehouse = Number(levels.almacen) || 0;
      tx.update(invRefs[idx], {
        levels: { barberia: shopAfter, almacen: warehouse },
        updatedAt: nowIso(),
      });
      if (shopAfter + warehouse <= 0) {
        // Only ever flips to "agotado" here — rules let a cashier do nothing else to a product.
        tx.update(productRefs[idx], { inStock: false, updatedAt: nowIso() });
      }
      const movementRef = doc(collection(db, "inventoryMovements"));
      tx.set(movementRef, {
        id: movementRef.id,
        productId: item.refId,
        productName: item.name,
        type: "salida",
        kind: "venta",
        location: "barberia",
        quantity: qty,
        stockAfter: shopAfter,
        reason: "Venta",
        relatedTransactionId: txId,
        byUid: cashier.uid,
        byName: cashier.name || "",
        createdAt: nowIso(),
      });
    });

    // 3. Write the sale itself.
    tx.set(txRef, {
      id: txId,
      items: cartItems.map((i) => ({
        kind: i.kind,
        refId: i.refId,
        name: i.name,
        unitPrice: Number(i.unitPrice),
        qty: Number(i.qty),
        subtotal: Number(i.unitPrice) * Number(i.qty),
      })),
      payments: cleanPayments,
      paymentMethod,
      total,
      notes: notes || "",
      cashierUid: cashier.uid,
      cashierName: cashier.name || "",
      voided: false,
      voidedAt: null,
      voidedBy: null,
      createdAt: nowIso(),
    });
  });

  return { id: txId, total, payments: cleanPayments };
}

/** A sale to another barbería (provider sale) rather than a client at the counter. */
export const isWholesale = (tx) => tx?.channel === "mayoreo";

/**
 * Wholesale ("venta a barberías", admin only). Product lines only, priced at
 * the wholesale price; stock comes out of `location` (almacén by default) in
 * the same Firestore transaction. Stored in `transactions` with
 * channel: "mayoreo" so voiding and reports keep working, but it never earns
 * a commission and stays out of the corte de caja.
 * lines: [{ refId, name, unitPrice, qty }]
 * opts: { customer, location, paymentMethod, notes }
 */
export async function sellWholesale(lines, opts, cashier) {
  if (!FIREBASE_ENABLED) throw new Error("Firebase no está habilitado.");
  if (!lines || lines.length === 0) throw new Error("Agrega al menos un producto.");
  if (!cashier || !cashier.uid) throw new Error("No se pudo identificar al usuario.");
  const customer = (opts?.customer || "").trim();
  if (!customer) throw new Error("Escribe el nombre de la barbería.");
  const location = opts?.location === "barberia" ? "barberia" : "almacen";
  const other = location === "almacen" ? "barberia" : "almacen";
  const method = PAYMENT_METHODS.includes(opts?.paymentMethod) ? opts.paymentMethod : "efectivo";
  const items = lines.map((i) => ({
    kind: "product",
    refId: i.refId,
    name: i.name,
    unitPrice: Number(i.unitPrice),
    qty: Number(i.qty),
    subtotal: Number(i.unitPrice) * Number(i.qty),
  }));
  if (items.some((i) => !(i.qty > 0) || !(i.unitPrice >= 0))) throw new Error("Revisa cantidades y precios.");
  const total = round2(items.reduce((s, i) => s + i.subtotal, 0));

  const { db, doc, collection, runTransaction } = await getFirestore();
  const txId = makeId();

  await runTransaction(db, async (tx) => {
    const wanted = new Map();
    items.forEach((i) => wanted.set(i.refId, (wanted.get(i.refId) || 0) + i.qty));
    const ids = [...wanted.keys()];
    const productRefs = ids.map((id) => doc(db, "products", id));
    const invRefs = ids.map((id) => doc(db, "inventory", id));
    const [productSnaps, invSnaps] = await Promise.all([
      Promise.all(productRefs.map((r) => tx.get(r))),
      Promise.all(invRefs.map((r) => tx.get(r))),
    ]);

    ids.forEach((id, idx) => {
      const name = items.find((i) => i.refId === id).name;
      if (!productSnaps[idx].exists()) throw new Error(`"${name}" ya no existe.`);
      const have = invSnaps[idx].exists() ? Number(invSnaps[idx].data().levels?.[location]) || 0 : 0;
      if (have < wanted.get(id)) {
        throw new Error(`No hay suficiente inventario de "${name}" en ${location === "almacen" ? "el almacén" : "la barbería"} (quedan ${have}).`);
      }
    });

    ids.forEach((id, idx) => {
      const qty = wanted.get(id);
      const levels = invSnaps[idx].data().levels || {};
      const after = (Number(levels[location]) || 0) - qty;
      const otherLevel = Number(levels[other]) || 0;
      tx.update(invRefs[idx], { levels: { [location]: after, [other]: otherLevel }, updatedAt: nowIso() });
      if (after + otherLevel <= 0) tx.update(productRefs[idx], { inStock: false, updatedAt: nowIso() });
      const movementRef = doc(collection(db, "inventoryMovements"));
      tx.set(movementRef, {
        id: movementRef.id,
        productId: id,
        productName: items.find((i) => i.refId === id).name,
        type: "salida",
        kind: "mayoreo",
        location,
        quantity: qty,
        stockAfter: after,
        reason: `Venta a ${customer}`,
        relatedTransactionId: txId,
        byUid: cashier.uid,
        byName: cashier.name || "",
        createdAt: nowIso(),
      });
    });

    tx.set(doc(db, "transactions", txId), {
      id: txId,
      channel: "mayoreo",
      customer,
      inventoryLocation: location,
      items,
      payments: [{ method, amount: total, note: "" }],
      paymentMethod: method,
      total,
      notes: (opts?.notes || "").trim(),
      cashierUid: cashier.uid,
      cashierName: cashier.name || "",
      voided: false,
      voidedAt: null,
      voidedBy: null,
      createdAt: nowIso(),
    });
  });

  return { id: txId, total };
}

/**
 * Returns a sale's product lines to the barbería inventory and marks it voided.
 * Voiding is admin-only per firestore.rules, so `fsCtx` — if provided —
 * should come from an admin-authorized session (see users-store.js
 * withAdminAuthorization) when the caller signed in is a cashier.
 * Defaults to the primary (currently signed-in) session's Firestore.
 */
export async function voidTransaction(transactionId, fsCtx = null, voidedByUid = null) {
  if (!FIREBASE_ENABLED) throw new Error("Firebase no está habilitado.");
  const { db, doc, collection, runTransaction } = fsCtx || (await getFirestore());
  const txRef = doc(db, "transactions", transactionId);

  await runTransaction(db, async (tx) => {
    const txSnap = await tx.get(txRef);
    if (!txSnap.exists()) throw new Error("La venta ya no existe.");
    const saleData = txSnap.data();
    if (saleData.voided) throw new Error("Esta venta ya estaba cancelada.");
    // Retail sales deduct the barbería; wholesale ones record where they came from.
    const loc = saleData.inventoryLocation === "almacen" ? "almacen" : "barberia";
    const other = loc === "almacen" ? "barberia" : "almacen";

    // Merge repeated lines of the same product so each inventory doc is touched once.
    const qtyByProduct = new Map();
    const nameByProduct = new Map();
    (saleData.items || []).filter((i) => i.kind === "product").forEach((i) => {
      qtyByProduct.set(i.refId, (qtyByProduct.get(i.refId) || 0) + Number(i.qty));
      nameByProduct.set(i.refId, i.name);
    });
    const ids = Array.from(qtyByProduct.keys());
    const productRefs = ids.map((id) => doc(db, "products", id));
    const invRefs = ids.map((id) => doc(db, "inventory", id));
    const [productSnaps, invSnaps] = await Promise.all([
      Promise.all(productRefs.map((ref) => tx.get(ref))),
      Promise.all(invRefs.map((ref) => tx.get(ref))),
    ]);

    ids.forEach((id, idx) => {
      if (!productSnaps[idx].exists()) return; // product deleted since — nothing to restock
      const qty = qtyByProduct.get(id);
      const levels = invSnaps[idx].exists() ? invSnaps[idx].data().levels || {} : {};
      const locAfter = (Number(levels[loc]) || 0) + qty;
      const otherLevel = Number(levels[other]) || 0;
      const invData = { productId: id, levels: { [loc]: locAfter, [other]: otherLevel }, updatedAt: nowIso() };
      if (invSnaps[idx].exists()) tx.update(invRefs[idx], invData);
      else tx.set(invRefs[idx], { ...invData, lowThreshold: 3 });
      if (productSnaps[idx].data().inStock !== true) tx.update(productRefs[idx], { inStock: true, updatedAt: nowIso() });
      const movementRef = doc(collection(db, "inventoryMovements"));
      tx.set(movementRef, {
        id: movementRef.id,
        productId: id,
        productName: nameByProduct.get(id),
        type: "entrada",
        kind: "cancelacion",
        location: loc,
        quantity: qty,
        stockAfter: locAfter,
        reason: "Cancelación de venta",
        relatedTransactionId: transactionId,
        byUid: voidedByUid || null,
        createdAt: nowIso(),
      });
    });

    tx.update(txRef, { voided: true, voidedAt: nowIso(), voidedBy: voidedByUid });
  });
}

/**
 * Fixes how a sale was paid (e.g. rung up as cash but it was card) without
 * cancelling it, so stock, totals and commission stay as they were and only
 * the payment breakdown changes. Admin-only per firestore.rules — pass the
 * admin-authorized `fsCtx` when a cashier is signed in. The previous
 * breakdown is kept in `previousPayments` for audit.
 */
export async function updateTransactionPayments(transactionId, payments, fsCtx = null, editedByUid = null) {
  if (!FIREBASE_ENABLED) throw new Error("Firebase no está habilitado.");
  const { db, doc, runTransaction } = fsCtx || (await getFirestore());
  const txRef = doc(db, "transactions", transactionId);
  await runTransaction(db, async (tx) => {
    const snap = await tx.get(txRef);
    if (!snap.exists()) throw new Error("La venta ya no existe.");
    const sale = snap.data();
    if (sale.voided) throw new Error("Esta venta está cancelada.");
    const clean = (payments || []).map((p) => ({
      method: PAYMENT_METHODS.includes(p.method) ? p.method : "efectivo",
      amount: round2(p.amount),
      note: (p.note || "").trim(),
    }));
    if (clean.length === 0 || clean.some((p) => p.amount <= 0)) throw new Error("Cada pago debe ser mayor a cero.");
    const sum = round2(clean.reduce((s, p) => s + p.amount, 0));
    if (Math.abs(sum - round2(sale.total)) > 0.01) {
      throw new Error(`Los pagos (${sum}) no coinciden con el total de la venta (${round2(sale.total)}).`);
    }
    const methods = new Set(clean.map((p) => p.method));
    tx.update(txRef, {
      payments: clean,
      paymentMethod: methods.size > 1 ? "mixto" : clean[0].method,
      previousPayments: paymentLines(sale),
      editedAt: nowIso(),
      editedBy: editedByUid,
    });
  });
}

/**
 * One-shot fetch of transactions between two ISO timestamps (inclusive),
 * most recent first.
 *
 * `cashierUid`: pass the caller's own uid when they are a cashier. Firestore
 * list rules must be able to prove from the *query itself* — not just from
 * evaluating the rule per returned document — that every possible result is
 * one the caller may read; a date-range-only query can't offer that proof
 * for the "only your own sales" rule, so a cashier's request would be
 * rejected outright without this filter. It's an equality-only query (no
 * composite index needed) — the date range is then applied client-side over
 * that single cashier's (small) result set. Admins omit this and get the
 * full range query across everyone, which the "isAdmin()" rule allows
 * unconditionally.
 */
export async function fetchTransactionsRange(startIso, endIso, cashierUid = null) {
  if (!FIREBASE_ENABLED) return [];
  const { db, collection, query, where, orderBy, getDocs } = await getFirestore();

  if (cashierUid) {
    // No orderBy here: equality + orderBy on another field needs a composite
    // index. Sorting client-side keeps this an index-free equality query.
    const q = query(collection(db, "transactions"), where("cashierUid", "==", cashierUid));
    const snap = await getDocs(q);
    return snap.docs
      .map((d) => d.data())
      .filter((r) => r.createdAt >= startIso && r.createdAt <= endIso)
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  }

  const q = query(
    collection(db, "transactions"),
    where("createdAt", ">=", startIso),
    where("createdAt", "<=", endIso),
    orderBy("createdAt", "desc")
  );
  const snap = await getDocs(q);
  return snap.docs.map((d) => d.data());
}

// ------------------------------------------------------------
// Cashier commission settings (config/commission). Readable by any
// signed-in user (cashiers see their own cut), writable by admin only.
// ------------------------------------------------------------
export const DEFAULT_COMMISSION = { servicePercent: 50, productAmount: 20 };

function cleanCommission(c) {
  const pct = Number(c?.servicePercent);
  const amt = Number(c?.productAmount);
  return {
    servicePercent: Number.isFinite(pct) && pct >= 0 && pct <= 100 ? pct : DEFAULT_COMMISSION.servicePercent,
    productAmount: Number.isFinite(amt) && amt >= 0 ? amt : DEFAULT_COMMISSION.productAmount,
  };
}

export async function fetchCommissionSettings() {
  if (!FIREBASE_ENABLED) return { ...DEFAULT_COMMISSION };
  try {
    const { db, doc, getDoc } = await getFirestore();
    const snap = await getDoc(doc(db, "config", "commission"));
    return snap.exists() ? cleanCommission(snap.data()) : { ...DEFAULT_COMMISSION };
  } catch (_) {
    return { ...DEFAULT_COMMISSION };
  }
}

export async function saveCommissionSettings(settings) {
  if (!FIREBASE_ENABLED) throw new Error("Firebase no está habilitado.");
  const clean = cleanCommission(settings);
  const { db, doc, setDoc } = await getFirestore();
  await setDoc(doc(db, "config", "commission"), { ...clean, updatedAt: nowIso() });
  return clean;
}

/** Commission earned on one sale: percent of service lines + flat amount per product unit. */
export function saleCommission(tx, settings) {
  let services = 0, productUnits = 0;
  (tx.items || []).forEach((i) => {
    if (i.kind === "product") productUnits += Number(i.qty) || 0;
    else services += (Number(i.unitPrice) || 0) * (Number(i.qty) || 0);
  });
  return round2(services * settings.servicePercent / 100 + productUnits * settings.productAmount);
}
