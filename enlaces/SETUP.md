# RCR Enlaces · Setup

Esta guía deja el panel de control listo en ~10 minutos. Lo único que cambia
en código son **6 valores** dentro de `firebase-config.js`.

## 1. Crear el proyecto en Firebase

1. Ve a <https://console.firebase.google.com/> y crea un proyecto nuevo
   (sugerencia: `rcr-barbershop`).
2. (Opcional) desactiva Google Analytics si no lo necesitas.

## 2. Habilitar los servicios

En la consola del proyecto, en el menú izquierdo:

### Authentication
- Build → Authentication → **Get started**
- Pestaña **Sign-in method** → habilita **Email/Password**
- Pestaña **Users** → **Add user** → crea el usuario del cliente
  (ej. `barberia@rcr-barbershop.com` + contraseña fuerte)

### Cloud Firestore
- Build → Firestore Database → **Create database**
- Modo: **Production**
- Región: `nam5 (us-central)` o la que prefieras (no se puede cambiar después)
- Una vez creada, pestaña **Rules** → pega el contenido de
  [`firestore.rules`](./firestore.rules) → **Publish**

### Cloud Storage
- Build → Storage → **Get started**
- Modo: **Production**
- Región: la misma que Firestore
- Pestaña **Rules** → pega el contenido de
  [`storage.rules`](./storage.rules) → **Publish**

## 3. Obtener la configuración web

1. ⚙️ (engrane) **Project settings**
2. Sección **Your apps** → ícono `</>` (Web)
3. Apodo: `rcr-enlaces` → **Register app** (no necesitas Hosting)
4. Copia los valores del `firebaseConfig`:

```js
const firebaseConfig = {
  apiKey: "AIzaSy...",
  authDomain: "rcr-barbershop.firebaseapp.com",
  projectId: "rcr-barbershop",
  storageBucket: "rcr-barbershop.appspot.com",
  messagingSenderId: "12345...",
  appId: "1:12345...:web:..."
};
```

## 4. Pegarlos en el repo

1. Abre `enlaces/firebase-config.js`
2. Reemplaza los placeholders con los valores reales
3. Cambia `FIREBASE_ENABLED = false` a `FIREBASE_ENABLED = true`
4. Commit + push → GitHub Pages publica en 1–2 min

> **Nota:** estas credenciales son **públicas** por diseño en Firebase Web. La
> seguridad real vive en las **rules** que ya aplicaste arriba (solo
> autenticados pueden escribir).

## 5. Probar

- **Página pública:** <https://www.rcr-barbershop.com/enlaces/>
- **Panel admin:** <https://www.rcr-barbershop.com/admin/>

Inicia sesión con el usuario que creaste en el paso 2. Edita servicios,
horarios, enlaces, sube fotos a la galería → **Guardar cambios** → verás
los cambios en la página pública al refrescar.

## 6. (Opcional) Sembrar datos iniciales

Si nunca guardas desde el panel, la página pública usa los valores por defecto
de `enlaces/data.default.json`. La primera vez que el cliente entre al panel y
haga clic en **Guardar cambios**, esos defaults quedan persistidos en Firestore
y a partir de ahí ya son editables sin tocar código.

## Estructura del documento en Firestore

Todo vive en un único documento: `config/site`.

```json
{
  "business":  { "name", "tagline", "established", "location", "rating" },
  "links":     { "whatsapp", "whatsappBookingMessage", "instagram", ... },
  "hours":     { "0": {open,close,closed}, "1": {...}, ... },
  "services":  [ { id, name, description, price, note, active, order } ],
  "gallery":   [ { id, url, alt, order, path, uploadedAt } ]
}
```

## Costos

Para una barbería:
- **Auth**: gratis (50k MAU)
- **Firestore**: gratis (~50k lecturas/día). El sitio cachea en localStorage.
- **Storage**: gratis hasta 5 GB. Una galería de 50 fotos pesa ~50 MB.

No deberías ver factura nunca.

## Inventario

El catálogo (`products`) y las existencias (`inventory`) son colecciones separadas.
Si vienes de una versión anterior: **primero** publica `firestore.rules` y luego,
en el panel → **Inventario**, pulsa **Migrar inventario** (una sola vez) para pasar
las existencias que estaban dentro de cada producto.
