// ============================================================
// Excel export of the inventories (products + services).
// Loads SheetJS from a CDN on demand — same no-build approach as qr.js —
// so nothing is downloaded until someone actually clicks "Exportar Excel".
// ============================================================

import { LOCATION_LABELS, STATUS_LABELS, levelOf, totalOf, stockStatus, movementLabel, movementDelta } from "./inventory-store.js";

const XLSX_LIB_URL = "https://cdn.jsdelivr.net/npm/xlsx@0.18.5/+esm";

let _xlsxPromise = null;
export function getXlsx() {
  if (!_xlsxPromise) _xlsxPromise = import(XLSX_LIB_URL).then((m) => m.default || m);
  return _xlsxPromise;
}

const num = (v) => (v === "" || v == null || Number.isNaN(Number(v)) ? "" : Number(v));

function addSheet(XLSX, wb, name, rows, widths) {
  const ws = XLSX.utils.json_to_sheet(rows);
  ws["!cols"] = widths.map((wch) => ({ wch }));
  if (rows.length) ws["!autofilter"] = { ref: ws["!ref"] };
  XLSX.utils.book_append_sheet(wb, ws, name);
}

/**
 * Builds and downloads an .xlsx with one sheet for the product inventory,
 * one for the service catalog and (when loaded) one for stock movements.
 * `products`: catalog list, `inventory`: Map productId -> inventory doc,
 * `services`: config services, `movements`: latest inventoryMovements.
 */
export async function exportInventoryXlsx({ products, inventory, services, movements = [] }) {
  const XLSX = await getXlsx();
  const wb = XLSX.utils.book_new();

  const productRows = products
    .slice()
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
    .map((p) => {
      const inv = inventory.get(p.id);
      const total = totalOf(inv);
      const cost = num(p.cost);
      return {
        "Producto": p.name || "",
        "Marca": p.brand || "",
        "Categoría": p.category || "",
        "Tamaño": p.size || "",
        "Unidad": p.unit || "pza",
        "Barbería": levelOf(inv, "barberia"),
        "Almacén": levelOf(inv, "almacen"),
        "Total": total,
        "Alerta bajo stock": inv ? Number(inv.lowThreshold) || 0 : "",
        "Estado": STATUS_LABELS[stockStatus(inv)],
        "Costo": cost,
        "Precio": num(p.price),
        "Valor a costo": cost === "" ? "" : Math.round(cost * total * 100) / 100,
        "Valor a precio": p.price === "" || p.price == null ? "" : Math.round(Number(p.price) * total * 100) / 100,
        "Visible en tienda": p.active === false ? "No" : "Sí",
        "Actualizado": inv?.updatedAt ? inv.updatedAt.slice(0, 10) : "",
      };
    });
  addSheet(XLSX, wb, "Productos", productRows, [32, 16, 18, 12, 10, 10, 10, 8, 12, 16, 10, 10, 13, 13, 12, 12]);

  const serviceRows = services
    .slice()
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
    .map((s) => ({
      "Servicio": s.name || "",
      "Precio": num(s.price),
      "Descripción": s.description || "",
      "Nota": s.note || "",
      "Visible": s.active === false ? "No" : "Sí",
    }));
  addSheet(XLSX, wb, "Servicios", serviceRows, [32, 10, 50, 36, 9]);

  if (movements.length) {
    const movRows = movements.map((m) => ({
      "Fecha": m.createdAt ? m.createdAt.replace("T", " ").slice(0, 16) : "",
      "Producto": m.productName || "",
      "Ubicación": LOCATION_LABELS[m.location || "barberia"] || m.location || "",
      "Tipo": movementLabel(m),
      "Cambio": movementDelta(m),
      "Existencia después": m.stockAfter ?? "",
      "Motivo": m.reason || "",
      "Usuario": m.byName || "",
    }));
    addSheet(XLSX, wb, "Movimientos", movRows, [17, 32, 12, 20, 8, 18, 40, 18]);
  }

  const stamp = new Date().toISOString().slice(0, 10);
  XLSX.writeFile(wb, `inventario-rcr-${stamp}.xlsx`);
  return { products: productRows.length, services: serviceRows.length };
}
