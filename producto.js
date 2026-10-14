// ============================================================
// producto.js
// Single-product landing page — this is what a product's QR
// label points to. Reads ?id= from the URL and looks it up in
// the same `products` Firestore collection the admin panel uses.
// ============================================================

import { fetchProduct } from "./enlaces/products-store.js";
import { subscribeData } from "./enlaces/data-store.js";

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, c => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

function fmtPriceMxn(p) {
  if (p == null || p === "") return "—";
  const n = Number(p);
  if (Number.isNaN(n)) return String(p);
  return `$${n.toLocaleString("es-MX", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function buildWa(phone, msg) {
  const num = String(phone || "").replace(/[^\d]/g, "");
  if (!num) return "#";
  const t = msg ? `?text=${encodeURIComponent(msg)}` : "";
  return `https://wa.me/${num}${t}`;
}

function notFoundHtml(msg) {
  return `
    <div class="text-center text-secondary py-5" style="font-family:'Montserrat';">
      <i class="bi bi-exclamation-circle" style="font-size:2rem;color:#D4BA67;"></i>
      <p class="mt-3">${escapeHtml(msg)}</p>
      <a href="productos/" class="btn btn-warning fw-semibold mt-2">Ver todos los productos</a>
    </div>`;
}

// Resolves once the site's WhatsApp number is known (cache/defaults/Firestore).
let waPhone = "524423536769";
let resolveWaReady;
const waReady = new Promise((resolve) => { resolveWaReady = resolve; });
subscribeData((data) => {
  waPhone = data.links?.whatsapp || waPhone;
  resolveWaReady();
});

async function render() {
  const root = document.getElementById("productDetail");
  const id = new URLSearchParams(location.search).get("id");

  if (!id) {
    root.innerHTML = notFoundHtml("Producto no especificado.");
    return;
  }

  const p = await fetchProduct(id);
  if (!p) {
    root.innerHTML = notFoundHtml("No encontramos este producto. Puede que ya no esté disponible.");
    return;
  }

  await waReady;

  document.title = `${p.name} · RCR Barber Shop`;
  const photos = p.photos || [];
  // Quantities are staff-only (inventory); the catalog just says whether any is left.
  const soldOut = p.inStock === false;
  const waHref = buildWa(waPhone, `Hola RCR, quiero preguntar por: ${p.name}`);

  root.innerHTML = `
    <div class="row g-4">
      <div class="col-12 col-md-6">
        ${photos.length
          ? `<img src="${escapeHtml(photos[0].url)}" alt="${escapeHtml(p.name)}" class="img-fluid rounded border border-warning">`
          : `<div class="product-shop-photo-placeholder rounded border border-warning"><i class="bi bi-bag"></i></div>`}
        ${photos.length > 1 ? `
          <div class="d-flex gap-2 mt-2 flex-wrap">
            ${photos.slice(1).map(ph => `<img src="${escapeHtml(ph.url)}" alt="" class="rounded border border-warning" style="width:64px;height:64px;object-fit:cover;">`).join("")}
          </div>` : ""}
      </div>
      <div class="col-12 col-md-6">
        <div class="card bg-dark text-white border-warning h-100">
          <div class="card-body p-4">
            ${p.category ? `<div class="small text-secondary mb-1" style="font-family:'Montserrat';">${escapeHtml(p.category)}</div>` : ""}
            <h2 style="font-family:'Cinzel'; color:#D4BA67;">${escapeHtml(p.name)}</h2>

            ${p.brand || p.size ? `
              <div class="d-flex flex-wrap gap-2 mb-2">
                ${p.brand ? `<span class="badge rounded-pill text-bg-dark border border-warning px-3 py-2">${escapeHtml(p.brand)}</span>` : ""}
                ${p.size ? `<span class="badge rounded-pill text-bg-dark border border-warning px-3 py-2">${escapeHtml(p.size)}</span>` : ""}
              </div>` : ""}

            <span class="badge rounded-pill text-bg-dark border border-warning px-3 py-2 mb-3">${fmtPriceMxn(p.price)}</span>
            ${p.description ? `<p style="font-family:'Montserrat';">${escapeHtml(p.description)}</p>` : ""}

            ${(p.highlights && p.highlights.length) ? `
              <ul class="mb-3" style="font-family:'Montserrat';padding-left:1.1rem;">
                ${p.highlights.map(h => `<li>${escapeHtml(h)}</li>`).join("")}
              </ul>` : ""}

            ${p.usage ? `
              <p class="small text-secondary mb-3" style="font-family:'Montserrat';">
                <b>Modo de uso:</b> ${escapeHtml(p.usage)}
              </p>` : ""}

            <p class="small ${soldOut ? "text-danger" : "text-secondary"}" style="font-family:'Montserrat';">
              ${soldOut ? "Agotado por el momento." : "Disponible en la barbería."}
            </p>
            <p class="small text-secondary" style="font-family:'Montserrat';">
              <b>Disponibilidad y entrega únicamente en RCR Barber Shop.</b>
              Por ahora no ofrecemos envíos ni compra en línea.
            </p>
            <a href="${waHref}" target="_blank" rel="noopener" class="btn btn-warning fw-semibold mt-2">
              <i class="bi bi-whatsapp me-2"></i>Preguntar por WhatsApp
            </a>
          </div>
        </div>
      </div>
    </div>
  `;
}

render();
