// ============================================================
// Product catalog data layer.
// Collection: `products` (public read, admin write), separate from the
// single config/site document because it grows unbounded over time.
// Quantities live in `inventory` (see inventory-store.js); the catalog only
// carries the public `inStock` flag that the inventory transactions maintain.
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

/** Creates a new catalog product. Its inventory is set up separately (initInventory). */
export async function createProduct(input) {
  if (!FIREBASE_ENABLED) throw new Error("Firebase no está habilitado.");
  const { db, doc, setDoc } = await getFirestore();
  const id = makeId();
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
    inStock: false, // flipped by inventory transactions once stock is added
    active: input.active !== false,
    order: Number(input.order) || 0,
    photos: [],
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
  await setDoc(doc(db, "products", id), product);
  return product;
}

/** Updates catalog fields. Never touches inventory or `inStock` (inventory-store owns those). */
export async function updateProduct(id, patch) {
  if (!FIREBASE_ENABLED) throw new Error("Firebase no está habilitado.");
  const { db, doc, updateDoc } = await getFirestore();
  const clean = { ...patch, updatedAt: nowIso() };
  delete clean.stock;
  delete clean.warehouseStock;
  delete clean.inStock;
  delete clean.id;
  delete clean.createdAt;
  await updateDoc(doc(db, "products", id), clean);
}

export async function deleteProduct(id) {
  if (!FIREBASE_ENABLED) throw new Error("Firebase no está habilitado.");
  const { db, doc, deleteDoc } = await getFirestore();
  await deleteDoc(doc(db, "products", id));
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
