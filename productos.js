// ============================================================
// productos.js
// Renders the public product grid on productos/index.html from the same
// `products` Firestore collection the admin panel writes to.
// ============================================================

import { subscribeProducts } from "./enlaces/products-store.js";

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

function render(products) {
  const grid = document.querySelector("[data-shop-grid]");
  if (!grid) return;

  const active = (products || [])
    .filter((p) => p && p.active !== false)
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));

  if (active.length === 0) {
    grid.innerHTML = `<div class="col-12 text-center text-secondary py-4" style="font-family:'Montserrat';">Estamos preparando la primera línea. Muy pronto aquí.</div>`;
    return;
  }

  grid.innerHTML = active.map((p) => {
    const photo = p.photos && p.photos[0] ? p.photos[0].url : null;
    // Quantities are staff-only (inventory); the catalog just says whether any is left.
    const soldOut = p.inStock === false;
    return `
      <div class="col-12 col-md-6 col-lg-4">
        <a href="../producto.html?id=${encodeURIComponent(p.id)}" class="text-decoration-none">
          <div class="card h-100 product-shop-card bg-dark text-white border-warning">
            ${photo
              ? `<img src="${escapeHtml(photo)}" alt="${escapeHtml(p.name)}" class="product-shop-photo" loading="lazy">`
              : `<div class="product-shop-photo-placeholder"><i class="bi bi-bag"></i></div>`}
            <div class="card-body text-center p-4">
              ${p.category ? `<div class="small text-secondary mb-1" style="font-family:'Montserrat';">${escapeHtml(p.category)}</div>` : ""}
              <h4 style="font-family:'Cinzel'; color:#D4BA67;">${escapeHtml(p.name)}</h4>
              ${p.brand ? `<div class="small text-secondary mb-2" style="font-family:'Montserrat';">${escapeHtml(p.brand)}${p.size ? ` · ${escapeHtml(p.size)}` : ""}</div>` : ""}
              ${p.description ? `<p class="mb-3 small" style="font-family:'Montserrat';">${escapeHtml(p.description)}</p>` : ""}
              <span class="badge rounded-pill text-bg-dark border border-warning px-3 py-2">${fmtPriceMxn(p.price)}</span>
              ${soldOut ? `<div class="small text-danger mt-2">Agotado</div>` : ""}
            </div>
          </div>
        </a>
      </div>
    `;
  }).join("");
}

subscribeProducts(render);
