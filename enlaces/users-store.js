// ============================================================
// Users / roles data layer.
// Collection: `users/{uid}` — one profile per Firebase Auth account,
// { uid, email, displayName, role: "admin"|"cajero", active, createdAt }.
// Roles are enforced by firestore.rules; this module is the client-side
// mirror of that logic (bootstrap, CRUD, admin re-auth for voids).
// ============================================================

import { FIREBASE_ENABLED } from "./firebase-config.js";
import {
  getFirestore, getAuth,
  createSecondaryApp, getAuthForApp, getFirestoreForApp, destroySecondaryApp,
} from "./data-store.js";

/** Starting cash each cashier gets per day (users/{uid}.pettyCash); admin can change it per cashier. */
export const DEFAULT_PETTY_CASH = 300;

export function pettyCashOf(profile) {
  const n = Number(profile && profile.pettyCash);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_PETTY_CASH;
}

function nowIso() {
  return new Date().toISOString();
}

/**
 * Resolves the signed-in user's profile doc, bootstrapping the very
 * first admin account the one time meta/setup doesn't exist yet.
 * Returns null if this account has no role assigned (and isn't the
 * bootstrap case) — the caller should sign them out.
 */
export async function resolveMyProfile(user) {
  const { db, doc, getDoc, writeBatch } = await getFirestore();
  const userRef = doc(db, "users", user.uid);
  const snap = await getDoc(userRef);
  if (snap.exists()) return snap.data();

  const setupRef = doc(db, "meta", "setup");
  const setupSnap = await getDoc(setupRef);
  if (setupSnap.exists()) return null; // role assignment already in use elsewhere

  const profile = {
    uid: user.uid,
    email: user.email || "",
    displayName: (user.email || "Admin").split("@")[0],
    role: "admin",
    active: true,
    createdAt: nowIso(),
  };
  // Both writes commit together: firestore.rules re-checks !exists(meta/setup)
  // against the server at commit time, so a second concurrent first-login
  // (or a retry after a dropped connection) can never leave meta/setup
  // missing while a users/{uid} admin doc exists — the bootstrap door
  // closes atomically with the profile being created.
  const batch = writeBatch(db);
  batch.set(userRef, profile);
  batch.set(setupRef, { adminBootstrapped: true, adminUid: user.uid, at: nowIso() });
  await batch.commit();
  return profile;
}

/** Live list of all user profiles (admin only — rules will reject others). */
export async function subscribeUsers(onData) {
  if (!FIREBASE_ENABLED) { onData([]); return () => {}; }
  const { db, collection, onSnapshot } = await getFirestore();
  return onSnapshot(
    collection(db, "users"),
    (snap) => onData(snap.docs.map((d) => d.data())),
    (err) => console.warn("[rcr] users subscription error:", err.message)
  );
}

/**
 * Creates a new cashier account. Uses a throwaway secondary Firebase App
 * so the admin's own session stays signed in (createUserWithEmailAndPassword
 * would otherwise switch the *primary* app's currentUser to the new user).
 */
export async function createCashier({ email, password, displayName }) {
  if (!FIREBASE_ENABLED) throw new Error("Firebase no está habilitado.");
  const secondaryApp = await createSecondaryApp();
  try {
    const { auth, createUserWithEmailAndPassword, signOut } = await getAuthForApp(secondaryApp);
    const cred = await createUserWithEmailAndPassword(auth, email, password);
    const uid = cred.user.uid;
    await signOut(auth);

    const { db, doc, setDoc } = await getFirestore();
    const profile = {
      uid, email, displayName: displayName || email.split("@")[0],
      role: "cajero", active: true, pettyCash: DEFAULT_PETTY_CASH, createdAt: nowIso(),
    };
    await setDoc(doc(db, "users", uid), profile);
    return profile;
  } finally {
    await destroySecondaryApp(secondaryApp);
  }
}

/** Activates/deactivates a cashier account (blocks sales + logins at the rules level). */
export async function setUserActive(uid, active) {
  const { db, doc, updateDoc } = await getFirestore();
  await updateDoc(doc(db, "users", uid), { active });
}

export async function updateUserProfile(uid, patch) {
  const { db, doc, updateDoc } = await getFirestore();
  const clean = { ...patch };
  delete clean.uid; delete clean.email; delete clean.createdAt;
  await updateDoc(doc(db, "users", uid), clean);
}

/** Sends a password-reset email to a cashier — doesn't require their session. */
export async function sendPasswordReset(email) {
  const { auth, sendPasswordResetEmail } = await getAuth();
  await sendPasswordResetEmail(auth, email);
}

/**
 * Verifies admin credentials in a throwaway secondary session (so the
 * cashier stays logged in) and, if valid, runs `action` with a Firestore
 * context whose writes carry the *admin's* auth — this is what lets a
 * cashier trigger an admin-authorized void without the admin's phone/
 * session ever touching this device otherwise.
 */
export async function withAdminAuthorization(adminEmail, adminPassword, action) {
  if (!FIREBASE_ENABLED) throw new Error("Firebase no está habilitado.");
  const secondaryApp = await createSecondaryApp();
  try {
    const { auth, signInWithEmailAndPassword, signOut } = await getAuthForApp(secondaryApp);
    let cred;
    try {
      cred = await signInWithEmailAndPassword(auth, adminEmail, adminPassword);
    } catch (err) {
      throw new Error("Correo o contraseña de administrador incorrectos.");
    }

    const fsCtx = await getFirestoreForApp(secondaryApp);
    const { doc, getDoc } = fsCtx;
    const profileSnap = await getDoc(doc(fsCtx.db, "users", cred.user.uid));
    const profile = profileSnap.exists() ? profileSnap.data() : null;
    if (!profile || profile.role !== "admin" || profile.active === false) {
      await signOut(auth);
      throw new Error("Esa cuenta no tiene permisos de administrador.");
    }

    try {
      return await action(fsCtx, cred.user);
    } finally {
      await signOut(auth);
    }
  } finally {
    await destroySecondaryApp(secondaryApp);
  }
}
