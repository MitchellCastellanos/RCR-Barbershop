// ============================================================
// Products + inventory data layer.
// Collections: `products` (public read, admin write) and
// `inventoryMovements` (admin-only), separate from the single
// config/site document because both grow unbounded over time.
// ============================================================

import { FIREBASE_ENABLED } from "./firebase-config.js";
import { getFirestore } from "./data-store.js";
import { getStorage } from "./data-store.js";

function makeId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function nowIso() {
  return new Date().toISOString();
}

// Two stock locations per product:
//   "barberia" -> `stock` field (what is on the shop floor; the cash register
//                 sells from and deducts this one — kept as `stock` so every
//                 existing sale/void/storefront path keeps working untouched)
//   "almacen"  -> `warehouseStock` field (back storage; never sold directly,
//                 it must be transferred to the barbería first)
export const LOCATIONS = ["barberia", "almacen"];
export const LOCATION_LABELS = { barberia: "Barbería", almacen: "Almacén" };

export function stockField(location) {
  return location === "almacen" ? "warehouseStock" : "stock";
}

// ---------- Products: read ----------

/**
 * Subscribes to the live products list. Calls onData(products) immediately
 * (empty array if Firebase is disabled) and again on every change.
 * Returns an unsubscribe function.
 */
export async function subscribeProducts(onData) {
  if (!FIREBASE_ENABLED) {
    onData([]);
    return () => {};
  }
  try {
    const { db, collection, onSnapshot } = await getFirestore();
    return onSnapshot(
      collection(db, "products"),
      (snap) => {
        const products = snap.docs.map((d) => d.data());
        onData(products);
      },
      (err) => console.warn("[rcr] products subscription error:", err.message)
    );
  } catch (err) {
    console.warn("[rcr] products subscribe failed:", err.message);
    onData([]);
    return () => {};
  }
}

/** One-shot fetch of a single product by id. Returns null if not found. */
export async function fetchProduct(id) {
  if (!FIREBASE_ENABLED || !id) return null;
  try {
    const { db, doc, getDoc } = await getFirestore();
    const snap = await getDoc(doc(db, "products", id));
    return snap.exists() ? snap.data() : null;
  } catch (err) {
    console.warn("[rcr] fetchProduct failed:", err.message);
    return null;
  }
}

// ---------- Products: write ----------

/** Creates a new product. `initialStock` seeds the barbería stock and
 *  `initialWarehouseStock` the almacén stock, each with a movement log entry. */
export async function createProduct(input) {
  if (!FIREBASE_ENABLED) throw new Error("Firebase no está habilitado.");
  const { db, doc, setDoc, collection } = await getFirestore();
  const id = makeId();
  const initialStock = Math.max(0, Number(input.initialStock) || 0);
  const initialWarehouse = Math.max(0, Number(input.initialWarehouseStock) || 0);
  const product = {
    id,
    name: input.name || "",
    description: input.description || "",
    category: input.category || "",
    brand: input.brand || "",
    size: input.size || "",
    highlights: Array.isArray(input.highlights) ? input.highlights : [],
    usage: input.usage || "",
    price: input.price === "" || input.price == null ? "" : Number(input.price),
    cost: input.cost === "" || input.cost == null ? "" : Number(input.cost),
    unit: input.unit || "pieza",
    stock: initialStock,
    warehouseStock: initialWarehouse,
    lowStockThreshold: Number(input.lowStockThreshold) || 3,
    active: input.active !== false,
    order: Number(input.order) || 0,
    photos: [],
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
  await setDoc(doc(db, "products", id), product);
  for (const [location, qty] of [["barberia", initialStock], ["almacen", initialWarehouse]]) {
    if (qty <= 0) continue;
    const movementRef = doc(collection(db, "inventoryMovements"));
    await setDoc(movementRef, {
      id: movementRef.id,
      productId: id,
      productName: product.name,
      type: "entrada",
      location,
      quantity: qty,
      stockAfter: qty,
      reason: "Alta inicial",
      createdAt: nowIso(),
    });
  }
  return product;
}

/** Updates product fields. Never touches stock — use adjustStock()/transferStock(). */
export async function updateProduct(id, patch) {
  if (!FIREBASE_ENABLED) throw new Error("Firebase no está habilitado.");
  const { db, doc, updateDoc } = await getFirestore();
  const clean = { ...patch, updatedAt: nowIso() };
  delete clean.stock;
  delete clean.warehouseStock;
  delete clean.id;
  delete clean.createdAt;
  await updateDoc(doc(db, "products", id), clean);
}

export async function deleteProduct(id) {
  if (!FIREBASE_ENABLED) throw new Error("Firebase no está habilitado.");
  const { db, doc, deleteDoc } = await getFirestore();
  await deleteDoc(doc(db, "products", id));
}

/**
 * Adds or removes stock at one location atomically and appends an entry to
 * the movement log.
 * type: "entrada" | "salida"; location: "barberia" (default) | "almacen".
 */
export async function adjustStock(productId, { type, quantity, reason, location = "barberia" }) {
  if (!FIREBASE_ENABLED) throw new Error("Firebase no está habilitado.");
  const { db, doc, collection, runTransaction } = await getFirestore();
  const qty = Math.abs(Number(quantity) || 0);
  if (qty <= 0) throw new Error("La cantidad debe ser mayor a cero.");
  if (!LOCATIONS.includes(location)) throw new Error("Ubicación inválida.");
  const field = stockField(location);

  const productRef = doc(db, "products", productId);
  const movementRef = doc(collection(db, "inventoryMovements"));
  let stockAfter;

  await runTransaction(db, async (tx) => {
    const snap = await tx.get(productRef);
    if (!snap.exists()) throw new Error("El producto ya no existe.");
    const current = Number(snap.data()[field]) || 0;
    stockAfter = type === "salida" ? current - qty : current + qty;
    if (stockAfter < 0) {
      throw new Error(`No hay suficiente inventario en ${LOCATION_LABELS[location]} (quedan ${current}).`);
    }
    tx.update(productRef, { [field]: stockAfter, updatedAt: nowIso() });
    tx.set(movementRef, {
      id: movementRef.id,
      productId,
      productName: snap.data().name || "",
      type,
      location,
      quantity: qty,
      stockAfter,
      reason: reason || "",
      createdAt: nowIso(),
    });
  });

  return stockAfter;
}

/**
 * Moves stock between locations in one transaction (e.g. almacén → barbería
 * to restock the shelves). Logs a "salida" at the origin and an "entrada" at
 * the destination, both flagged `transfer: true`.
 * Returns { barberia, almacen } stock after the move.
 */
export async function transferStock(productId, { from, quantity, reason }) {
  if (!FIREBASE_ENABLED) throw new Error("Firebase no está habilitado.");
  if (!LOCATIONS.includes(from)) throw new Error("Ubicación inválida.");
  const to = from === "almacen" ? "barberia" : "almacen";
  const { db, doc, collection, runTransaction } = await getFirestore();
  const qty = Math.abs(Number(quantity) || 0);
  if (qty <= 0) throw new Error("La cantidad debe ser mayor a cero.");

  const productRef = doc(db, "products", productId);
  const outRef = doc(collection(db, "inventoryMovements"));
  const inRef = doc(collection(db, "inventoryMovements"));
  const result = {};

  await runTransaction(db, async (tx) => {
    const snap = await tx.get(productRef);
    if (!snap.exists()) throw new Error("El producto ya no existe.");
    const data = snap.data();
    const fromBefore = Number(data[stockField(from)]) || 0;
    const toBefore = Number(data[stockField(to)]) || 0;
    if (fromBefore < qty) {
      throw new Error(`No hay suficiente inventario en ${LOCATION_LABELS[from]} (quedan ${fromBefore}).`);
    }
    const fromAfter = fromBefore - qty;
    const toAfter = toBefore + qty;
    tx.update(productRef, {
      [stockField(from)]: fromAfter,
      [stockField(to)]: toAfter,
      updatedAt: nowIso(),
    });
    const base = {
      productId,
      productName: data.name || "",
      quantity: qty,
      transfer: true,
      createdAt: nowIso(),
    };
    tx.set(outRef, {
      ...base, id: outRef.id, type: "salida", location: from, stockAfter: fromAfter,
      reason: reason || `Traspaso a ${LOCATION_LABELS[to]}`,
    });
    tx.set(inRef, {
      ...base, id: inRef.id, type: "entrada", location: to, stockAfter: toAfter,
      reason: reason || `Traspaso desde ${LOCATION_LABELS[from]}`,
    });
    result[from] = fromAfter;
    result[to] = toAfter;
  });

  return result;
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

// ---------- Photos ----------

export async function uploadProductPhoto(productId, file) {
  const { storage, ref, uploadBytes, getDownloadURL } = await getStorage();
  const id = makeId();
  const ext = (file.name.split(".").pop() || "jpg").toLowerCase();
  const path = `products/${productId}/${id}.${ext}`;
  const r = ref(storage, path);
  await uploadBytes(r, file, { contentType: file.type });
  const url = await getDownloadURL(r);
  return { id, url, path, order: 0 };
}

export async function deleteProductPhoto(path) {
  const { storage, ref, deleteObject } = await getStorage();
  await deleteObject(ref(storage, path));
}
