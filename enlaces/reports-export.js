// ============================================================
// Sales reports (admin): aggregates `transactions` per barber / day / item
// and exports an .xlsx. Whoever rings up the sale is treated as the barber
// who did the service. Cancelled sales never count toward totals; they are
// only listed in the detail sheet.
// ============================================================

import { getXlsx } from "./xlsx-export.js";
import { paymentLines, saleCommission, isWholesale } from "./transactions-store.js";

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

/** The base service is the haircut; everything else a barber sells is an "adicional" (barba, ceja, etc.).
 *  Matched by name since services are free-text — a combo named "Corte y barba" counts as a corte. */
export const isCutService = (name) => /corte/i.test(String(name || ""));

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
  // Sales to other barbershops (mayoreo) are accounted for separately: they
  // are not a barber's sale, earn no commission and are not counted as cuts.
  const wholesaleRows = rows.filter(isWholesale);
  rows = rows.filter((r) => !isWholesale(r));
  const valid = rows.filter((r) => !r.voided);
  const voided = rows.filter((r) => r.voided);

  const barbers = new Map();
  const barberOf = (r) => {
    const key = r.cashierUid || r.cashierName || "—";
    if (!barbers.has(key)) {
      barbers.set(key, {
        key, name: nameOf.get(r.cashierUid) || r.cashierName || "—",
        sales: 0, serviceSales: 0, productOnlySales: 0, total: 0, serviceUnits: 0, serviceAmount: 0, productUnits: 0, productAmount: 0,
        cutUnits: 0, extraUnits: 0, services: new Map(),
        commission: 0, voided: 0, voidedAmount: 0, days: new Set(),
      });
    }
    return barbers.get(key);
  };

  const methods = { efectivo: 0, tarjeta: 0, transferencia: 0 };
  const days = new Map();   // ymd -> { sales, byBarber: Map(key -> amount), total }
  const items = new Map();  // kind|name -> { kind, name, units, amount, byBarber: Map(key -> units) }
  const totals = { sales: 0, serviceSales: 0, productOnlySales: 0, total: 0, cutUnits: 0, extraUnits: 0, serviceUnits: 0, serviceAmount: 0, productUnits: 0, productAmount: 0, commission: 0 };

  valid.forEach((r) => {
    const b = barberOf(r);
    const ymd = f.day.format(new Date(r.createdAt));
    const comm = saleCommission(r, commission);
    b.sales++; b.total += Number(r.total) || 0; b.commission += comm; b.days.add(ymd);
    totals.sales++; totals.total += Number(r.total) || 0; totals.commission += comm;

    // A ticket is a "service ticket" when it has any service line; otherwise it is a pure product sale.
    const hasService = (r.items || []).some((i) => !isProduct(i));
    if (hasService) { b.serviceSales++; totals.serviceSales++; } else { b.productOnlySales++; totals.productOnlySales++; }

    if (!days.has(ymd)) days.set(ymd, { ymd, sales: 0, cutUnits: 0, total: 0, commission: 0, byBarber: new Map() });
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
      else {
        b.serviceUnits += qty; b.serviceAmount += amt; totals.serviceUnits += qty; totals.serviceAmount += amt;
        if (isCutService(i.name)) { b.cutUnits += qty; totals.cutUnits += qty; d.cutUnits += qty; } else { b.extraUnits += qty; totals.extraUnits += qty; }
        const sv = b.services.get(i.name || "") || { units: 0, amount: 0 };
        sv.units += qty; sv.amount += amt;
        b.services.set(i.name || "", sv);
      }
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
    extraShare: pct(b.extraUnits, b.serviceUnits),
    servicesPerSale: b.sales ? r2(b.serviceUnits / b.sales) : 0,
    teamShare: pct(b.total, totals.total),
  })).sort((a, b) => b.total - a.total);

  Object.keys(methods).forEach((k) => { methods[k] = r2(methods[k]); });
  ["total", "serviceAmount", "productAmount", "commission"].forEach((k) => { totals[k] = r2(totals[k]); });
  totals.extraShare = pct(totals.extraUnits, totals.serviceUnits);
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

  const wholesale = summarizeWholesale(wholesaleRows);
  return { totals, methods, barbers: barberList, days: dayList, items: itemList, nameByKey, valid, voided, wholesale };
}

/** Totals of the non-cancelled wholesale (mayoreo) sales in `rows`. */
export function summarizeWholesale(rows) {
  const ws = rows.filter((r) => isWholesale(r) && !r.voided);
  const customers = new Map();
  let units = 0, total = 0;
  ws.forEach((r) => {
    let u = 0;
    (r.items || []).forEach((i) => { u += Number(i.qty) || 0; });
    units += u; total += Number(r.total) || 0;
    const c = customers.get(r.customer || "—") || { name: r.customer || "—", sales: 0, units: 0, total: 0 };
    c.sales++; c.units += u; c.total += Number(r.total) || 0;
    customers.set(c.name, c);
  });
  return {
    sales: ws.length, units, total: r2(total),
    customers: [...customers.values()].map((c) => ({ ...c, total: r2(c.total) })).sort((a, b) => b.total - a.total),
  };
}

/**
 * Units and money of every product sold, kept apart by channel: the counter
 * ("tienda", minus the per-piece barber commission) and other barbershops
 * ("mayoreo"). `profit` = what the owner keeps after cost (and commission).
 * Returns Map productId -> { shopUnits, shopAmount, wholeUnits, wholeAmount, profit }
 * plus a `totals` entry under key "__total".
 */
export function computeProductSales(rows, products, commission) {
  const cost = new Map(products.map((p) => [p.id, Number(p.cost) || 0]));
  const blank = () => ({ shopUnits: 0, shopAmount: 0, wholeUnits: 0, wholeAmount: 0, profit: 0 });
  const out = new Map();
  const all = blank();
  rows.filter((r) => !r.voided).forEach((r) => {
    const whole = isWholesale(r);
    (r.items || []).filter(isProduct).forEach((i) => {
      const qty = Number(i.qty) || 0, amt = lineAmount(i);
      const net = amt - (whole ? 0 : qty * (Number(commission?.productAmount) || 0)) - qty * (cost.get(i.refId) || 0);
      [out.get(i.refId) || out.set(i.refId, blank()).get(i.refId), all].forEach((e) => {
        if (whole) { e.wholeUnits += qty; e.wholeAmount += amt; } else { e.shopUnits += qty; e.shopAmount += amt; }
        e.profit += net;
      });
    });
  });
  const round = (e) => { ["shopAmount", "wholeAmount", "profit"].forEach((k) => { e[k] = r2(e[k]); }); return e; };
  out.forEach(round);
  out.set("__total", round(all));
  return out;
}

function sheetFromRows(XLSX, wb, name, rows, widths) {
  const ws = XLSX.utils.json_to_sheet(rows);
  ws["!cols"] = widths.map((wch) => ({ wch }));
  if (rows.length) ws["!autofilter"] = { ref: ws["!ref"] };
  XLSX.utils.book_append_sheet(wb, ws, name);
}

/** Builds and downloads the .xlsx. `from`/`to`: "YYYY-MM-DD" shop days. */
export async function exportSalesReportXlsx({ rows, products = [], users, commission, tz, from, to, barberLabel = "Todos" }) {
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
    ["Cobros con servicio (clientes)", t.serviceSales],
    ["Cobros solo de producto", t.productOnlySales],
    ["Servicios realizados (unidades)", t.serviceUnits],
    ["   de los cuales cortes", t.cutUnits, pct(t.cutUnits, t.serviceUnits)],
    ["   de los cuales adicionales (barba, ceja, etc.)", t.extraUnits, t.extraShare],
    ["   Nota: es corte todo servicio con «corte» en el nombre; lo demás es adicional."],
    ["Productos vendidos (piezas)", t.productUnits],
    ["Comisiones", t.commission, pct(t.commission, t.total)],
    ["Neto para la barbería (total − comisiones)", t.net, pct(t.net, t.total)],
    [],
    ["VENTAS A BARBERÍAS (mayoreo, aparte de los totales de arriba)", "Monto"],
    ["Número de ventas", rep.wholesale.sales],
    ["Piezas vendidas", rep.wholesale.units],
    ["Monto vendido", rep.wholesale.total],
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
    "Cobros (tickets)": b.sales,
    "Total vendido": b.total,
    "% del equipo": b.teamShare,
    "Ticket promedio": b.ticket,
    "Días con ventas": b.daysWorked,
    "Promedio por día": b.perDay,
    "Servicios (unidades)": b.serviceUnits,
    "Cortes": b.cutUnits,
    "Servicios adicionales": b.extraUnits,
    "% adicionales": b.extraShare,
    "Servicios por venta": b.servicesPerSale,
    "Importe servicios": b.serviceAmount,
    "Productos (piezas)": b.productUnits,
    "Importe productos": b.productAmount,
    "% de ventas en productos": b.productShare,
    "Comisión": b.commission,
    "Cancelaciones": b.voided,
    "Monto cancelado": b.voidedAmount,
  })), [24, 14, 14, 12, 14, 14, 16, 18, 9, 20, 14, 18, 16, 16, 16, 20, 12, 13, 15]);

  // 2b. Servicios por barbero: units of each service per barber (cortes vs adicionales).
  const serviceNames = new Map(); // name -> total units
  barbers.forEach((b) => b.services.forEach((v, name) => serviceNames.set(name, (serviceNames.get(name) || 0) + v.units)));
  sheetFromRows(XLSX, wb, "Servicios por barbero", [...serviceNames.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([name, total]) => {
      const row = { "Servicio": name, "Tipo": isCutService(name) ? "Corte" : "Adicional" };
      barbers.forEach((b) => { row[b.name] = b.services.get(name)?.units || 0; });
      row["Total"] = total;
      return row;
    }), [34, 11, ...barbers.map(() => 16), 10]);

  // 3. Por día (one column per barber)
  const names = barbers.map((b) => b.name);
  sheetFromRows(XLSX, wb, "Por día", days.map((d) => {
    const [y, m, dd] = d.ymd.split("-").map(Number);
    const row = {
      "Fecha": d.ymd,
      "Día": f.weekday.format(new Date(Date.UTC(y, m - 1, dd, 12))),
      "Cobros (tickets)": d.sales,
      "Cortes": d.cutUnits,
    };
    barbers.forEach((b) => { row[b.name] = r2(d.byBarber.get(b.key) || 0); });
    row["Total"] = r2(d.total);
    return row;
  }), [12, 12, 15, 9, ...names.map(() => 16), 14]);

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

  // 4b. Productos por canal: tienda vs. barberías, cada uno por separado y en total.
  const sales = computeProductSales(rows, products, commission);
  const prodRows = products.filter((p) => sales.has(p.id)).map((p) => {
    const e = sales.get(p.id);
    return {
      "Producto": p.name || "",
      "Piezas en tienda": e.shopUnits, "Importe tienda": e.shopAmount,
      "Piezas a barberías": e.wholeUnits, "Importe barberías": e.wholeAmount,
      "Piezas totales": e.shopUnits + e.wholeUnits, "Importe total": r2(e.shopAmount + e.wholeAmount),
      "Ganancia (después de costo y comisión)": e.profit,
    };
  });
  const tot = sales.get("__total");
  prodRows.push({
    "Producto": "TOTAL",
    "Piezas en tienda": tot.shopUnits, "Importe tienda": tot.shopAmount,
    "Piezas a barberías": tot.wholeUnits, "Importe barberías": tot.wholeAmount,
    "Piezas totales": tot.shopUnits + tot.wholeUnits, "Importe total": r2(tot.shopAmount + tot.wholeAmount),
    "Ganancia (después de costo y comisión)": tot.profit,
  });
  sheetFromRows(XLSX, wb, "Productos por canal", prodRows, [32, 14, 14, 16, 16, 14, 14, 24]);

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
        "Canal": isWholesale(r) ? "Barbería: " + (r.customer || "") : "Tienda",
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
  sheetFromRows(XLSX, wb, "Detalle de ventas", detail, [12, 8, 22, 11, 24, 34, 9, 14, 12, 34, 11, 30, 16]);

  XLSX.writeFile(wb, `reporte-ventas-${from}_a_${to}.xlsx`);
  return { sales: t.sales, lines: detail.length };
}
