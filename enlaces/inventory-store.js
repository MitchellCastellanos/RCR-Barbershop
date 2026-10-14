// ============================================================
// Inventory data layer — separate from the product catalog.
//
// Collections:
//   inventory/{productId}  { productId, levels: { barberia, almacen },
//                            lowThreshold, updatedAt }   (staff read, admin write)
//   inventoryMovements/*   append-only log of every change to those levels
//
// `products/{id}.inStock` (boolean) is the only inventory fact the public
// storefront sees. It is kept in sync inside the same Firestore transaction
// that changes the levels, so quantities never leave the staff-only
// `inventory` collection.
//
// "barberia" is what is on the shop floor — the cash register sells from
// (and deducts) this one. "almacen" is back storage; it is never sold
// directly, it gets transferred to the barbería first.
// ============================================================

import { FIREBASE_ENABLED } from "./firebase-config.js";
import { getFirestore } from "./data-store.js";

export const LOCATIONS = ["barberia", "almacen"];
export const LOCATION_LABELS = { barberia: "Barbería", almacen: "Almacén" };

export const KIND_LABELS = {
  alta: "Alta inicial",
  compra: "Entrada",
  merma: "Salida / merma",
  traspaso: "Traspaso",
  venta: "Venta",
  cancelacion: "Cancelación de venta",
  conteo: "Conteo físico",
};

export const DEFAULT_LOW_THRESHOLD = 3;

function nowIso() {
  return new Date().toISOString();
}

// ---------- Pure helpers (used by the UI and the cash register) ----------

export function levelOf(inv, location) {
  return Math.max(0, Number(inv?.levels?.[location]) || 0);
}

export function totalOf(inv) {
  return levelOf(inv, "barberia") + levelOf(inv, "almacen");
}

/** "agotado" (nothing anywhere) | "sin-barberia" (only in almacén) | "bajo" | "ok" | "sin-inventario". */
export function stockStatus(inv) {
  if (!inv) return "sin-inventario";
  const shop = levelOf(inv, "barberia");
  if (totalOf(inv) <= 0) return "agotado";
  if (shop <= 0) return "sin-barberia";
  if (shop <= (Number(inv.lowThreshold) || 0)) return "bajo";
  return "ok";
}

export const STATUS_LABELS = {
  agotado: "Agotado",
  "sin-barberia": "Surtir barbería",
  bajo: "Bajo stock",
  ok: "OK",
  "sin-inventario": "Sin inventario",
};

/** Display label for a movement row (legacy rows without `kind` still read well). */
export function movementLabel(m) {
  if (m.kind && KIND_LABELS[m.kind]) return KIND_LABELS[m.kind];
  return m.type === "salida" ? "Salida" : "Entrada";
}

/** Signed change a movement made to its location's level. */
export function movementDelta(m) {
  if (m.type === "conteo") return Number(m.delta) || 0;
  return (m.type === "salida" ? -1 : 1) * (Number(m.quantity) || 0);
}

// ---------- Read ----------

/** Live inventory list (staff only). Calls onData([]) when disabled/denied. */
export async function subscribeInventory(onData) {
  if (!FIREBASE_ENABLED) {
    onData([]);
    return () => {};
  }
  try {
    const { db, collection, onSnapshot } = await getFirestore();
    return onSnapshot(
      collection(db, "inventory"),
      (snap) => onData(snap.docs.map((d) => d.data())),
      (err) => console.warn("[rcr] inventory subscription error:", err.message)
    );
  } catch (err) {
    console.warn("[rcr] inventory subscribe failed:", err.message);
    onData([]);
    return () => {};
  }
}

/** Live history of movements for one product, most recent first. */
export async function subscribeMovements(productId, onData, max = 25) {
  if (!FIREBASE_ENABLED) {
    onData([]);
    return () => {};
  }
  const { db, collection, query, where, orderBy, limit, onSnapshot } = await getFirestore();
  const q = query(
    collection(db, "inventoryMovements"),
    where("productId", "==", productId),
    orderBy("createdAt", "desc"),
    limit(max)
  );
  return onSnapshot(q, (snap) => onData(snap.docs.map((d) => d.data())), (err) =>
    console.warn("[rcr] movements subscription error:", err.message)
  );
}

/** Live history across all products (latest `max`), most recent first. */
export async function subscribeAllMovements(onData, max = 300) {
  if (!FIREBASE_ENABLED) {
    onData([]);
    return () => {};
  }
  const { db, collection, query, orderBy, limit, onSnapshot } = await getFirestore();
  const q = query(collection(db, "inventoryMovements"), orderBy("createdAt", "desc"), limit(max));
  return onSnapshot(q, (snap) => onData(snap.docs.map((d) => d.data())), (err) =>
    console.warn("[rcr] movements subscription error:", err.message)
  );
}

// ---------- Write (admin) ----------

function currentLevels(invSnap) {
  const l = invSnap.exists() ? invSnap.data().levels || {} : {};
  return { barberia: Number(l.barberia) || 0, almacen: Number(l.almacen) || 0 };
}

function inStockFlag(levels) {
  return levels.barberia + levels.almacen > 0;
}

/**
 * Runs one atomic inventory change. `apply(levels)` returns the new levels
 * and the movement rows to log (each: { location, type, kind, quantity,
 * delta?, reason }). Creates the inventory doc if the product has none yet,
 * and keeps products/{id}.inStock in sync.
 */
async function mutateInventory(productId, actor, apply) {
  if (!FIREBASE_ENABLED) throw new Error("Firebase no está habilitado.");
  const { db, doc, collection, runTransaction } = await getFirestore();
  const productRef = doc(db, "products", productId);
  const invRef = doc(db, "inventory", productId);
  let out;

  await runTransaction(db, async (tx) => {
    const [pSnap, invSnap] = await Promise.all([tx.get(productRef), tx.get(invRef)]);
    if (!pSnap.exists()) throw new Error("El producto ya no existe.");
    const before = currentLevels(invSnap);
    const { levels, movements, extra } = apply({ ...before }, invSnap.exists() ? invSnap.data() : null);

    const invData = {
      productId,
      levels,
      lowThreshold: extra?.lowThreshold ?? (invSnap.exists() ? invSnap.data().lowThreshold : DEFAULT_LOW_THRESHOLD),
      updatedAt: nowIso(),
    };
    if (invSnap.exists()) tx.update(invRef, invData);
    else tx.set(invRef, invData);

    const flag = inStockFlag(levels);
    if (pSnap.data().inStock !== flag) tx.update(productRef, { inStock: flag, updatedAt: nowIso() });

    (movements || []).forEach((m) => {
      const ref = doc(collection(db, "inventoryMovements"));
      tx.set(ref, {
        id: ref.id,
        productId,
        productName: pSnap.data().name || "",
        type: m.type,
        kind: m.kind,
        location: m.location,
        quantity: m.quantity,
        ...(m.type === "conteo" ? { delta: m.delta } : {}),
        stockAfter: levels[m.location],
        reason: m.reason || "",
        byUid: actor?.uid || null,
        byName: actor?.name || "",
        createdAt: nowIso(),
      });
    });
    out = levels;
  });

  return out;
}

function checkLocation(location) {
  if (!LOCATIONS.includes(location)) throw new Error("Ubicación inválida.");
}

function checkQty(quantity) {
  const qty = Math.abs(Number(quantity) || 0);
  if (qty <= 0) throw new Error("La cantidad debe ser mayor a cero.");
  return qty;
}

/**
 * Creates the inventory record for a brand-new product (alta inicial).
 * `initial`: { barberia, almacen, lowThreshold }.
 */
export async function initInventory(productId, initial, actor = null) {
  const shop = Math.max(0, Number(initial?.barberia) || 0);
  const wh = Math.max(0, Number(initial?.almacen) || 0);
  const lowThreshold = Math.max(0, Number(initial?.lowThreshold) || 0);
  return mutateInventory(productId, actor, () => ({
    levels: { barberia: shop, almacen: wh },
    extra: { lowThreshold },
    movements: [
      { location: "barberia", type: "entrada", kind: "alta", quantity: shop, reason: "Alta inicial" },
      { location: "almacen", type: "entrada", kind: "alta", quantity: wh, reason: "Alta inicial" },
    ].filter((m) => m.quantity > 0),
  }));
}

/**
 * Entrada (type "entrada", kind "compra") or salida/merma (type "salida",
 * kind "merma") at one location. Returns the new level at that location.
 */
export async function adjustStock(productId, { type, quantity, reason, location = "barberia" }, actor = null) {
  const qty = checkQty(quantity);
  checkLocation(location);
  if (type !== "entrada" && type !== "salida") throw new Error("Tipo de movimiento inválido.");
  const levels = await mutateInventory(productId, actor, (levels) => {
    const next = type === "salida" ? levels[location] - qty : levels[location] + qty;
    if (next < 0) {
      throw new Error(`No hay suficiente inventario en ${LOCATION_LABELS[location]} (quedan ${levels[location]}).`);
    }
    levels[location] = next;
    return {
      levels,
      movements: [{ location, type, kind: type === "salida" ? "merma" : "compra", quantity: qty, reason }],
    };
  });
  return levels[location];
}

/**
 * Moves stock to the other location in one transaction (e.g. almacén →
 * barbería to restock the shelves). Logs a salida at the origin and an
 * entrada at the destination. Returns the new levels.
 */
export async function transferStock(productId, { from, quantity, reason }, actor = null) {
  const qty = checkQty(quantity);
  checkLocation(from);
  const to = from === "almacen" ? "barberia" : "almacen";
  return mutateInventory(productId, actor, (levels) => {
    if (levels[from] < qty) {
      throw new Error(`No hay suficiente inventario en ${LOCATION_LABELS[from]} (quedan ${levels[from]}).`);
    }
    levels[from] -= qty;
    levels[to] += qty;
    return {
      levels,
      movements: [
        { location: from, type: "salida", kind: "traspaso", quantity: qty, reason: reason || `Traspaso a ${LOCATION_LABELS[to]}` },
        { location: to, type: "entrada", kind: "traspaso", quantity: qty, reason: reason || `Traspaso desde ${LOCATION_LABELS[from]}` },
      ],
    };
  });
}

/**
 * Physical count: sets the level at `location` to what was actually
 * counted and logs the difference. Returns { before, after }.
 */
export async function countStock(productId, { location, counted, reason }, actor = null) {
  checkLocation(location);
  const target = Number(counted);
  if (!Number.isFinite(target) || target < 0 || !Number.isInteger(target)) {
    throw new Error("Captura la cantidad contada (entero, cero o más).");
  }
  let before = 0;
  const levels = await mutateInventory(productId, actor, (levels) => {
    before = levels[location];
    levels[location] = target;
    const delta = target - before;
    return {
      levels,
      movements: [{
        location, type: "conteo", kind: "conteo", quantity: Math.abs(delta), delta,
        reason: reason || `Conteo físico (sistema: ${before}, contado: ${target})`,
      }],
    };
  });
  return { before, after: levels[location] };
}

/** Sets the low-stock alert level (applies to the barbería). */
export async function setLowThreshold(productId, value, actor = null) {
  const n = Math.max(0, Number(value) || 0);
  await mutateInventory(productId, actor, (levels) => ({ levels, extra: { lowThreshold: n }, movements: [] }));
  return n;
}

/** Removes a product's inventory record (the movement log is kept). */
export async function deleteInventory(productId) {
  if (!FIREBASE_ENABLED) throw new Error("Firebase no está habilitado.");
  const { db, doc, deleteDoc } = await getFirestore();
  await deleteDoc(doc(db, "inventory", productId));
}

/**
 * One-time move of the old per-product numbers (products.stock /
 * products.warehouseStock / products.lowStockThreshold) into `inventory`,
 * for every product that has no inventory record yet. The legacy fields are
 * left in place. Returns how many products were migrated.
 */
export async function migrateLegacyInventory(products, inventoryById) {
  if (!FIREBASE_ENABLED) throw new Error("Firebase no está habilitado.");
  const { db, doc, writeBatch } = await getFirestore();
  const pending = products.filter((p) => !inventoryById.has(p.id));
  for (let i = 0; i < pending.length; i += 200) {
    const batch = writeBatch(db);
    pending.slice(i, i + 200).forEach((p) => {
      const levels = {
        barberia: Math.max(0, Number(p.stock) || 0),
        almacen: Math.max(0, Number(p.warehouseStock) || 0),
      };
      batch.set(doc(db, "inventory", p.id), {
        productId: p.id,
        levels,
        lowThreshold: p.lowStockThreshold != null ? Math.max(0, Number(p.lowStockThreshold) || 0) : DEFAULT_LOW_THRESHOLD,
        updatedAt: nowIso(),
      });
      batch.update(doc(db, "products", p.id), { inStock: inStockFlag(levels) });
    });
    await batch.commit();
  }
  return pending.length;
}
