// ============================================================
// Sales reports (admin): aggregates `transactions` per barber / day / item
// and exports an .xlsx. Whoever rings up the sale is treated as the barber
// who did the service. Cancelled sales never count toward totals; they are
// only listed in the detail sheet.
// ============================================================

import { getXlsx } from "./xlsx-export.js";
import { paymentLines, saleCommission } from "./transactions-store.js";

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const pct = (part, whole) => (whole > 0 ? r2((part / whole) * 100) : 0);
const METHOD_LABELS = { efectivo: "Efectivo", tarjeta: "Tarjeta", transferencia: "Transferencia" };

function fmts(tz) {
  return {
    day: new Intl.DateTimeFormat("en-CA", { timeZone: tz }),
    time: new Intl.DateTimeFormat("es-MX", { timeZone: tz, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }),
    weekday: new Intl.DateTimeFormat("es-MX", { timeZone: tz, weekday: "long" }),
  };
}

const lineAmount = (i) => r2((Number(i.unitPrice) || 0) * (Number(i.qty) || 0));
const isProduct = (i) => i.kind === "product";

function paymentText(tx) {
  if (tx.paymentMethod === "mixto") {
    return "Mixto (" + paymentLines(tx).map((p) => `${METHOD_LABELS[p.method] || p.method} ${r2(p.amount)}`).join(" + ") + ")";
  }
  return METHOD_LABELS[tx.paymentMethod] || "Efectivo";
}

/**
 * Pure aggregation. `rows`: transactions in range. `users`: profiles
 * ({uid, displayName, email}) used only to name barbers.
 * Returns { totals, methods, barbers[], days[], items[] } with every money
 * figure computed over non-cancelled sales.
 */
export function computeReport(rows, { users = [], commission, tz }) {
  const f = fmts(tz);
  const nameOf = new Map(users.map((u) => [u.uid, u.displayName || u.email]));
  const valid = rows.filter((r) => !r.voided);
  const voided = rows.filter((r) => r.voided);

  const barbers = new Map();
  const barberOf = (r) => {
    const key = r.cashierUid || r.cashierName || "—";
    if (!barbers.has(key)) {
      barbers.set(key, {
        key, name: nameOf.get(r.cashierUid) || r.cashierName || "—",
        sales: 0, total: 0, serviceUnits: 0, serviceAmount: 0, productUnits: 0, productAmount: 0,
        commission: 0, voided: 0, voidedAmount: 0, days: new Set(),
      });
    }
    return barbers.get(key);
  };

  const methods = { efectivo: 0, tarjeta: 0, transferencia: 0 };
  const days = new Map();   // ymd -> { sales, byBarber: Map(key -> amount), total }
  const items = new Map();  // kind|name -> { kind, name, units, amount, byBarber: Map(key -> units) }
  const totals = { sales: 0, total: 0, serviceUnits: 0, serviceAmount: 0, productUnits: 0, productAmount: 0, commission: 0 };

  valid.forEach((r) => {
    const b = barberOf(r);
    const ymd = f.day.format(new Date(r.createdAt));
    const comm = saleCommission(r, commission);
    b.sales++; b.total += Number(r.total) || 0; b.commission += comm; b.days.add(ymd);
    totals.sales++; totals.total += Number(r.total) || 0; totals.commission += comm;

    if (!days.has(ymd)) days.set(ymd, { ymd, sales: 0, total: 0, commission: 0, byBarber: new Map() });
    const d = days.get(ymd);
    d.sales++; d.total += Number(r.total) || 0; d.commission += comm;
    d.byBarber.set(b.key, (d.byBarber.get(b.key) || 0) + (Number(r.total) || 0));

    paymentLines(r).forEach((p) => {
      const m = p.method in methods ? p.method : "efectivo";
      methods[m] += Number(p.amount) || 0;
    });

    (r.items || []).forEach((i) => {
      const qty = Number(i.qty) || 0, amt = lineAmount(i);
      if (isProduct(i)) { b.productUnits += qty; b.productAmount += amt; totals.productUnits += qty; totals.productAmount += amt; }
      else { b.serviceUnits += qty; b.serviceAmount += amt; totals.serviceUnits += qty; totals.serviceAmount += amt; }
      const ik = `${isProduct(i) ? "p" : "s"}|${i.name}`;
      if (!items.has(ik)) items.set(ik, { kind: isProduct(i) ? "Producto" : "Servicio", name: i.name || "", units: 0, amount: 0, byBarber: new Map() });
      const it = items.get(ik);
      it.units += qty; it.amount += amt;
      it.byBarber.set(b.key, (it.byBarber.get(b.key) || 0) + qty);
    });
  });

  voided.forEach((r) => {
    const b = barberOf(r);
    b.voided++; b.voidedAmount += Number(r.total) || 0;
  });

  const barberList = [...barbers.values()].map((b) => ({
    ...b,
    total: r2(b.total), serviceAmount: r2(b.serviceAmount), productAmount: r2(b.productAmount),
    commission: r2(b.commission), voidedAmount: r2(b.voidedAmount),
    daysWorked: b.days.size,
    ticket: b.sales ? r2(b.total / b.sales) : 0,
    perDay: b.days.size ? r2(b.total / b.days.size) : 0,
    productShare: pct(b.productAmount, b.total),
    teamShare: pct(b.total, totals.total),
  })).sort((a, b) => b.total - a.total);

  Object.keys(methods).forEach((k) => { methods[k] = r2(methods[k]); });
  ["total", "serviceAmount", "productAmount", "commission"].forEach((k) => { totals[k] = r2(totals[k]); });
  totals.ticket = totals.sales ? r2(totals.total / totals.sales) : 0;
  totals.voided = voided.length;
  totals.voidedAmount = r2(voided.reduce((s, r) => s + (Number(r.total) || 0), 0));
  totals.net = r2(totals.total - totals.commission);

  const nameByKey = new Map(barberList.map((b) => [b.key, b.name]));
  const itemList = [...items.values()].map((it) => {
    let top = null;
    it.byBarber.forEach((units, key) => { if (!top || units > top.units) top = { key, units }; });
    return { ...it, amount: r2(it.amount), topSeller: top ? nameByKey.get(top.key) || "—" : "", topUnits: top ? top.units : 0 };
  }).sort((a, b) => (a.kind === b.kind ? b.amount - a.amount : a.kind < b.kind ? 1 : -1));

  const dayList = [...days.values()].map((d) => ({ ...d, total: r2(d.total), commission: r2(d.commission) })).sort((a, b) => (a.ymd < b.ymd ? -1 : 1));

  return { totals, methods, barbers: barberList, days: dayList, items: itemList, nameByKey, valid, voided };
}

function sheetFromRows(XLSX, wb, name, rows, widths) {
  const ws = XLSX.utils.json_to_sheet(rows);
  ws["!cols"] = widths.map((wch) => ({ wch }));
  if (rows.length) ws["!autofilter"] = { ref: ws["!ref"] };
  XLSX.utils.book_append_sheet(wb, ws, name);
}

/** Builds and downloads the .xlsx. `from`/`to`: "YYYY-MM-DD" shop days. */
export async function exportSalesReportXlsx({ rows, users, commission, tz, from, to, barberLabel = "Todos" }) {
  const XLSX = await getXlsx();
  const f = fmts(tz);
  const rep = computeReport(rows, { users, commission, tz });
  const { totals: t, methods, barbers, days, items } = rep;
  const wb = XLSX.utils.book_new();

  // 1. Resumen (label / value / extra layout)
  const aoa = [
    ["Reporte de ventas · RCR Barber Shop"],
    ["Periodo", `${from} a ${to}`],
    ["Barbero", barberLabel],
    ["Generado", f.day.format(new Date()) + " " + f.time.format(new Date())],
    [],
    ["TOTALES", "Monto", "% del total"],
    ["Total vendido", t.total],
    ["Número de ventas", t.sales],
    ["Ticket promedio", t.ticket],
    ["Servicios", t.serviceAmount, pct(t.serviceAmount, t.total)],
    ["Productos", t.productAmount, pct(t.productAmount, t.total)],
    ["Servicios realizados (unidades)", t.serviceUnits],
    ["Productos vendidos (piezas)", t.productUnits],
    ["Comisiones", t.commission, pct(t.commission, t.total)],
    ["Neto para la barbería (total − comisiones)", t.net, pct(t.net, t.total)],
    [],
    ["COBRADO POR MÉTODO DE PAGO", "Monto", "% del total"],
    ["Efectivo", methods.efectivo, pct(methods.efectivo, t.total)],
    ["Tarjeta", methods.tarjeta, pct(methods.tarjeta, t.total)],
    ["Transferencia", methods.transferencia, pct(methods.transferencia, t.total)],
    [],
    ["VENTAS CANCELADAS (no incluidas arriba)", "Monto"],
    ["Número de cancelaciones", t.voided],
    ["Monto cancelado", t.voidedAmount],
  ];
  const wsRes = XLSX.utils.aoa_to_sheet(aoa);
  wsRes["!cols"] = [{ wch: 44 }, { wch: 18 }, { wch: 12 }];
  XLSX.utils.book_append_sheet(wb, wsRes, "Resumen");

  // 2. Por barbero
  sheetFromRows(XLSX, wb, "Por barbero", barbers.map((b) => ({
    "Barbero": b.name,
    "Ventas (tickets)": b.sales,
    "Total vendido": b.total,
    "% del equipo": b.teamShare,
    "Ticket promedio": b.ticket,
    "Días con ventas": b.daysWorked,
    "Promedio por día": b.perDay,
    "Servicios (unidades)": b.serviceUnits,
    "Importe servicios": b.serviceAmount,
    "Productos (piezas)": b.productUnits,
    "Importe productos": b.productAmount,
    "% de ventas en productos": b.productShare,
    "Comisión": b.commission,
    "Cancelaciones": b.voided,
    "Monto cancelado": b.voidedAmount,
  })), [24, 14, 14, 12, 14, 14, 16, 18, 16, 16, 16, 20, 12, 13, 15]);

  // 3. Por día (one column per barber)
  const names = barbers.map((b) => b.name);
  sheetFromRows(XLSX, wb, "Por día", days.map((d) => {
    const [y, m, dd] = d.ymd.split("-").map(Number);
    const row = {
      "Fecha": d.ymd,
      "Día": f.weekday.format(new Date(Date.UTC(y, m - 1, dd, 12))),
      "Ventas (tickets)": d.sales,
    };
    barbers.forEach((b) => { row[b.name] = r2(d.byBarber.get(b.key) || 0); });
    row["Total"] = r2(d.total);
    return row;
  }), [12, 12, 15, ...names.map(() => 16), 14]);

  // 4. Servicios y productos
  const kindTotal = { Servicio: t.serviceAmount, Producto: t.productAmount };
  sheetFromRows(XLSX, wb, "Servicios y productos", items.map((it) => ({
    "Tipo": it.kind,
    "Concepto": it.name,
    "Unidades": it.units,
    "Importe": it.amount,
    "% de su tipo": pct(it.amount, kindTotal[it.kind]),
    "Quién lo vende más": it.topSeller,
    "Unidades de esa persona": it.topUnits,
  })), [11, 34, 10, 12, 12, 22, 22]);

  // 5. Detalle: one row per sold line, oldest first; cancelled ones flagged.
  const detail = [];
  rows.slice().sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1)).forEach((r) => {
    const when = new Date(r.createdAt);
    (r.items || []).forEach((i) => {
      detail.push({
        "Fecha": f.day.format(when),
        "Hora": f.time.format(when),
        "Barbero": rep.nameByKey.get(r.cashierUid || r.cashierName || "—") || r.cashierName || "—",
        "Tipo": isProduct(i) ? "Producto" : "Servicio",
        "Concepto": i.name || "",
        "Cantidad": Number(i.qty) || 0,
        "Precio unitario": Number(i.unitPrice) || 0,
        "Importe": lineAmount(i),
        "Método de pago": paymentText(r),
        "Estado": r.voided ? "Cancelada" : "Válida",
        "Notas": r.notes || "",
        "Folio": r.id || "",
      });
    });
  });
  sheetFromRows(XLSX, wb, "Detalle de ventas", detail, [12, 8, 22, 11, 34, 9, 14, 12, 34, 11, 30, 16]);

  XLSX.writeFile(wb, `reporte-ventas-${from}_a_${to}.xlsx`);
  return { sales: t.sales, lines: detail.length };
}
