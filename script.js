const API_URL = "https://script.google.com/macros/s/AKfycbxnHfI687iXvvGAykxJCC0X9vex02cIJko0XBJYgIiZSSFFVF_qLg5GuyFw8cs5DE-uyA/exec";

const CFG = {
  HIST_DAYS: 90,
  LEAD_DAYS: 7,
  SAFETY_DAYS: 7,
  CYCLE_DAYS: 14,
  FRONT_DAYS: 3
};

// ตำแหน่งที่ไม่มีอยู่จริง/ถูกยกเลิก ไม่นับเป็นสต๊อกเลยไม่ว่าหน้าไหน
const EXCLUDED_LOCATIONS = ["DELETE", "ในบ้าน"];

let CACHE = null;
let currentMode = "purchase";
let PENDING_CHECKLIST = { title: "", items: [] }; // ตั้งไว้ตอน render แล้วค่อยใช้จริงตอนกดพิมพ์
let LOAD_TOKEN = 0; // เพิ่มทุกครั้งที่เปลี่ยนหน้า ใช้กันคำขอเก่าเขียนทับคำขอใหม่
let ROW_SEARCH_CACHE = []; // ข้อความค้นหาต่อแถว (lowercase) เตรียมไว้ตอนสร้างตาราง กันไม่ต้องอ่านจาก DOM ซ้ำตอนพิมพ์ค้นหา (ช้ามากถ้าตารางมีหลักพันแถว)

const MODE_TITLES = {
  purchase: "ใบสั่งซื้อล่วงหน้า",
  best: "สินค้าขายดี ABC"
};

function setStatus(msg) {
  document.getElementById("status").innerText = msg;
}

// อ่าน response เป็นข้อความก่อน แล้วค่อยลอง parse เป็น JSON
// ถ้า parse ไม่ผ่าน (เช่น Apps Script ส่งหน้า HTML/login กลับมาแทน) จะโชว์เนื้อหาจริงบางส่วน
// แทนที่จะบอกแค่ "Unexpected token '<'" เฉยๆ ซึ่งไม่ช่วยวินิจฉัยปัญหา
async function safeParseJsonResponse(res) {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch (e) {
    const preview = text.slice(0, 300).replace(/\s+/g, " ").trim();
    throw new Error("เซิร์ฟเวอร์ตอบกลับไม่ใช่ JSON (HTTP " + res.status + "): " + preview);
  }
}

function norm(v) {
  return String(v == null ? "" : v).trim();
}

function num(v) {
  const n = Number(String(v).replace(/[^0-9.-]/g, ""));
  return isNaN(n) ? 0 : n;
}

function zoneOf(loc) {
  const l = norm(loc).toUpperCase();
  if (l.indexOf("FRONT") === 0) return "F";
  if (l.indexOf("KT-") === 0) return "K";
  return "Y";
}

function buildStock(st) {
  const m = {};
  st.forEach(function (r) {
    const sku = norm(r["ชื่อSKU"]);
    if (!sku) return;
    const loc = norm(r["ตำแหน่ง"]) || "-";
    if (EXCLUDED_LOCATIONS.indexOf(loc.toUpperCase()) !== -1) return; // ตำแหน่งที่ถูกยกเลิก/ลบ ไม่นับเป็นสต๊อกที่หยิบได้
    const qty = num(r["สต็อกที่มีอยู่ของตำแหน่ง"]);
    const zone = zoneOf(loc);
    if (!m[sku]) m[sku] = { F: 0, K: 0, Y: 0, total: 0, locs: [] };
    m[sku][zone] += qty;
    m[sku].total += qty;
    if (qty > 0) m[sku].locs.push({ loc: loc, qty: qty, zone: zone });
  });

  Object.keys(m).forEach(function (k) {
    m[k].locs.sort(function (a, b) {
      const fa = a.zone === "F" ? 0 : 1;
      const fb = b.zone === "F" ? 0 : 1;
      return fa - fb || a.loc.localeCompare(b.loc);
    });
  });
  return m;
}

// ตอนนี้ 3M ถูกสรุปยอดต่อ SKU มาจากฝั่ง Apps Script แล้ว (ไม่ใช่แถวออเดอร์ดิบนับแสนแถวอีกต่อไป)
// การกรอง Cancellation/เหตุผลยกเลิกทำไปแล้วฝั่งเซิร์ฟเวอร์ ที่นี่แค่รวมเป็น map เฉยๆ
function buildVelocity(hist) {
  const v = {};
  (hist || []).forEach(function (r) {
    const sku = norm(r["SKU Merchant"]);
    if (!sku) return;
    v[sku] = (v[sku] || 0) + num(r["จำนวน"]);
  });
  return v;
}

// เอาไว้ค้นหา/กรองด้วยชื่อสินค้า ไม่ใช่แค่รหัส SKU — อ่านจากชีต ST คอลัมน์ "ชื่อ SKU" ก่อน
// ถ้า ST ไม่มีชื่อแบรนด์ให้ SKU นั้น (เช่นสต๊อกหมดไปแล้วเลยไม่มีแถวในไฟล์สต๊อก) ค่อยเติมจากฐานข้อมูลแบรนด์กลาง (ชีต BRAND)
function buildSkuNameMap(st, brandMap) {
  const map = {};
  (st || []).forEach(function (r) {
    const sku = norm(r["ชื่อSKU"]);
    if (!sku || map[sku]) return;
    const name = norm(r["ชื่อ SKU"]);
    if (name) map[sku] = name;
  });

  Object.keys(brandMap || {}).forEach(function (sku) {
    if (!map[sku]) map[sku] = brandMap[sku];
  });

  return map;
}

// อ่านฐานข้อมูลแบรนด์กลาง (ชีต BRAND: เลข SKU → แบรนด์) เก็บครบทุก SKU แม้จะไม่มีสต๊อกเหลือแล้วก็ตาม
function buildBrandMap(brandRows) {
  const map = {};
  (brandRows || []).forEach(function (r) {
    const sku = norm(r["เลข SKU"]);
    if (!sku) return;
    const brand = norm(r["แบรนด์"]);
    if (brand) map[sku] = brand;
  });
  return map;
}

function gradeList(list, key) {
  list.sort(function (a, b) { return b[key] - a[key]; });
  const total = list.reduce(function (s, x) { return s + x[key]; }, 0) || 1;
  let acc = 0;
  list.forEach(function (i) {
    acc += i[key];
    i.cum = (acc / total) * 100;
    i.grade = i.cum <= 80 ? "A" : i.cum <= 95 ? "B" : "C";
  });
  return list;
}

function cards(items) {
  let h = '<div class="summary">';
  items.forEach(function (c) {
    h += '<div class="card ' + (c.type || "") + '"><div class="label">' + c.label +
         '</div><div class="value">' + c.value + '</div></div>';
  });
  return h + "</div>";
}

function table(head, body) {
  return '<div class="tablewrap"><table><thead><tr>' +
         head.map(function (h) { return "<th>" + h + "</th>"; }).join("") +
         '</tr></thead><tbody id="tbody">' + body + "</tbody></table></div>";
}

// เก็บ checklist ที่ "จะพิมพ์" ไว้เฉยๆ ยังไม่วาดอะไรลงหน้าจอ
// รอจนกว่าจะกดปุ่มพิมพ์จริง (handlePrint) ถึงค่อยสร้างเลขที่ใบวาง + QR แล้ววาดทีเดียว
// ป้องกันไม่ให้ทุกครั้งที่หน้าเว็บ re-render กลายเป็นสร้างใบวางใหม่ทิ้งไว้เต็มชีต
function setPendingChecklist(title, items) {
  PENDING_CHECKLIST = { title: title, items: items || [] };
}

// สร้าง checklist สำหรับตอนพิมพ์: SKU + จำนวน + ช่องติ๊ก เรียง 3 คอลัมน์
function buildPrintChecklistHtml(title, items) {
  const totalQty = items.reduce(function (s, it) { return s + it.qty; }, 0);
  const now = new Date().toLocaleString("th-TH", { hour12: false });

  let html = '<div class="print-head">' +
    '<div class="print-title">' + title + '</div>' +
    '<div class="print-meta">พิมพ์เมื่อ ' + now + ' • ' + items.length + ' SKU • รวม ' + totalQty + ' ชิ้น</div>' +
  '</div><div class="print-cols">';

  items.forEach(function (it) {
    html += '<div class="print-item">' +
      '<span class="pc-sku">' + it.sku + '</span>' +
      '<span class="pc-qty">' + it.qty + '</span>' +
      '<span class="pc-box"></span>' +
      '</div>';
  });

  html += '</div>';
  return html;
}

function handlePrint() {
  const pc = PENDING_CHECKLIST;
  const el = document.getElementById("printChecklist");

  if (el) {
    el.innerHTML = (pc && pc.items && pc.items.length > 0)
      ? buildPrintChecklistHtml(pc.title, pc.items)
      : "";
  }

  window.print();
}

async function loadData(mode) {
  const token = ++LOAD_TOKEN; // กันคำขอเก่าที่ยังค้างอยู่มาเขียนทับหน้าที่เพิ่งเปลี่ยนไป
  const out = document.getElementById("output");
  out.innerHTML = '<p class="hint">กำลังโหลดข้อมูล...</p>';
  setStatus("กำลังโหลด...");
  try {
    if (!CACHE) {
      const res = await fetch(API_URL);
      const json = await safeParseJsonResponse(res);
      if (token !== LOAD_TOKEN) return; // มีคนคลิกเปลี่ยนหน้าไปแล้วระหว่างรอ ทิ้งผลลัพธ์นี้
      if (!json || json.status !== "success") throw new Error("API ตอบกลับผิดรูปแบบ");
      CACHE = json.data;
    }
    if (token !== LOAD_TOKEN) return; // เช็คซ้ำเผื่อกรณีใช้ CACHE เดิม (ไม่ผ่าน fetch) แต่คลิกเปลี่ยนหน้าไปแล้ว

    const st = CACHE["ST"] || [];
    const hist = CACHE["3M"] || [];
    const brandMap = buildBrandMap(CACHE["BRAND"]);
    const skuNames = buildSkuNameMap(st, brandMap);

    if (mode === "purchase") renderPurchase(hist, st, skuNames);
    else renderBestSellers(hist, skuNames);

    setStatus("อัปเดตล่าสุด " + new Date().toLocaleTimeString("th-TH"));
  } catch (err) {
    if (token !== LOAD_TOKEN) return;
    out.innerHTML = '<div class="err">เกิดข้อผิดพลาด: ' + err.message +
      '<br>ตรวจสอบว่า Deploy Apps Script เป็น Web App และตั้งสิทธิ์เป็น Anyone แล้ว</div>';
    setStatus("ผิดพลาด");
  }
}

function refresh() {
  CACHE = null;
  loadData(currentMode);
}

function setMode(mode) {
  currentMode = mode;
  document.querySelectorAll(".nav-item").forEach(function (el) {
    el.classList.toggle("active", el.dataset.mode === mode);
  });
  document.getElementById("pageTitle").innerText = MODE_TITLES[mode] || "";
  document.getElementById("search").value = "";
  if (window.innerWidth <= 880) closeSidebar();
  loadData(mode);
}

function openUploadPanel() {
  document.getElementById("uploadPanel").classList.add("open");
  document.getElementById("overlay").classList.add("show");
}

function closeUploadPanel() {
  document.getElementById("uploadPanel").classList.remove("open");
  document.getElementById("overlay").classList.remove("show");
}

function toggleSidebar() {
  document.getElementById("sidebar").classList.toggle("open");
}

function closeSidebar() {
  document.getElementById("sidebar").classList.remove("open");
}

function renderPurchase(hist, st, skuNames) {
  const stock = buildStock(st);
  const vel = buildVelocity(hist);
  const th = getBestThresholds(); // ใช้เกณฑ์เดียวกับหน้าสินค้าขายดี ABC ไม่ต้องตั้งซ้ำ

  let list = Object.keys(vel).map(function (sku) {
    const s = stock[sku] || { F: 0, K: 0, Y: 0, total: 0 };
    // สต๊อก FRONT ต้องปริ้นใบไปเช็คนับจริงก่อนถึงจะเชื่อได้ ไม่เอามารวมคำนวณสั่งซื้อ
    const verified = s.K + s.Y;
    const ads = vel[sku] / CFG.HIST_DAYS;
    const cover = ads > 0 ? verified / ads : 9999;
    const rop = ads * (CFG.LEAD_DAYS + CFG.SAFETY_DAYS);
    return {
      sku: sku, sold: vel[sku], ads: ads, F: s.F, K: s.K, Y: s.Y,
      total: s.total, verified: verified, cover: cover, rop: rop,
      order: Math.max(0, vel[sku] - verified) // สั่งเพิ่ม = ยอดขาย 3 เดือน - คลัง
    };
  });

  list = gradeList(list, "sold");

  const urgent = list.filter(function (i) { return i.ads > 0 && i.verified <= i.rop; })
    .sort(function (a, b) { return a.cover - b.cover; });

  const BRANDS = ["WARRIX", "GRAND", "FLY HAWK", "CADENZA", "PEGAN", "BCS", "IMANE", "H3", "EGO"];

  let body = "";
  let gradeA = 0;
  let orderTotal = 0;
  ROW_SEARCH_CACHE = [];
  urgent.forEach(function (i) {
    if (i.grade === "A") gradeA++;
    orderTotal += i.order;
    const name = skuNames[i.sku] || "-";
    const rec = bestRecommend(i.sold, th.a, th.b);
    ROW_SEARCH_CACHE.push((i.sku + " " + name).toLowerCase());
    body += '<tr class="' + (i.cover <= CFG.LEAD_DAYS ? "row-warn" : "") +
      '" data-brand="' + name.toUpperCase() + '" data-grade="' + i.grade + '" data-rec="' + rec.cls + '">' +
      '<td class="g' + i.grade + '">' + i.grade + '</td>' +
      '<td>' + i.sku + '</td>' +
      '<td>' + name + '</td>' +
      '<td class="num">' + i.sold + '</td>' +
      '<td class="num">' + (i.ads * 30).toFixed(1) + '</td>' +
      '<td class="num">' + i.ads.toFixed(2) + '</td>' +
      '<td class="num"><b>' + i.verified + '</b></td>' +
      '<td class="num"><b>' + i.order + '</b></td>' +
      '<td class="' + rec.cls + '">' + rec.label + '</td></tr>';
  });

  const filterBarHtml =
    '<div class="thresh-bar">' +
      buildMultiselect("purchBrand", "แบรนด์", BRANDS.map(function (b) { return { value: b, text: b }; })) +
      buildMultiselect("purchGrade", "เกรด", [
        { value: "A", text: "A" },
        { value: "B", text: "B" },
        { value: "C", text: "C" }
      ]) +
      buildMultiselect("purchRec", "คำแนะนำ", [
        { value: "rec-none", text: "ขายไม่ดี" },
        { value: "rec-good", text: "ขายดี" },
        { value: "rec-stock", text: "ควรสต็อก" }
      ]) +
    '</div>';

  document.getElementById("output").innerHTML =
    filterBarHtml +
    table(["เกรด", "SKU", "ชื่อสินค้า", "ขาย 3 ด.", "ขาย/เดือน", "ขาย/วัน", "คลัง", "สั่งเพิ่ม", "คำแนะนำ"], body);

  const checklistItems = urgent
    .filter(function (i) { return i.order > 0; })
    .map(function (i) { return { sku: i.sku, qty: i.order }; })
    .sort(function (a, b) { return a.sku.localeCompare(b.sku); });
  setPendingChecklist("ใบสั่งซื้อล่วงหน้า", checklistItems);
}

// สร้าง dropdown แบบติ๊กเลือกได้หลายตัวเลือก (checkbox) — คืน HTML ของปุ่ม + แผงตัวเลือก
// options: [{value, text}]  ไม่ติ๊กอะไรเลย = ถือว่า "ทั้งหมด" ไม่กรองด้วยตัวนี้
function buildMultiselect(id, label, options) {
  const opts = options.map(function (o) {
    return '<label class="ms-option"><input type="checkbox" value="' + o.value +
      '" onchange="onMultiselectChange(\'' + id + '\', \'' + label + '\')"> ' + o.text + '</label>';
  }).join("");

  return '<div class="multiselect" id="' + id + 'Wrap">' +
    '<button type="button" class="multiselect-btn" id="' + id + 'Btn" onclick="toggleMultiselect(\'' + id + '\')">' +
      label + ': ทั้งหมด <span class="ms-caret">▾</span>' +
    '</button>' +
    '<div class="multiselect-panel" id="' + id + 'Panel">' + opts + '</div>' +
  '</div>';
}

// เปิด/ปิดแผงตัวเลือก ปิดแผงอื่นที่เปิดค้างอยู่ก่อนเสมอ (เปิดได้ทีละอัน)
function toggleMultiselect(id) {
  const panel = document.getElementById(id + "Panel");
  if (!panel) return;
  const willOpen = !panel.classList.contains("open");
  document.querySelectorAll(".multiselect-panel.open").forEach(function (p) { p.classList.remove("open"); });
  if (willOpen) panel.classList.add("open");
}

// คลิกนอกกล่อง multiselect ที่ไหนก็ได้ ให้ปิดแผงที่เปิดค้างอยู่ทั้งหมด
document.addEventListener("click", function (e) {
  if (e.target.closest(".multiselect")) return;
  document.querySelectorAll(".multiselect-panel.open").forEach(function (p) { p.classList.remove("open"); });
});

function getMultiselectChecked(id) {
  const panel = document.getElementById(id + "Panel");
  if (!panel) return [];
  return Array.prototype.filter.call(
    panel.querySelectorAll("input[type=checkbox]"),
    function (cb) { return cb.checked; }
  );
}

function getMultiselectValues(id) {
  return getMultiselectChecked(id).map(function (cb) { return cb.value; });
}

// อัปเดตข้อความบนปุ่มให้โชว์ว่าติ๊กอะไรอยู่บ้าง (ไม่เกิน 2 ชื่อ ถ้าเกินให้โชว์เป็นจำนวนแทน)
function updateMultiselectLabel(id, label) {
  const checked = getMultiselectChecked(id);
  const btn = document.getElementById(id + "Btn");
  if (!btn) return;
  const caret = '<span class="ms-caret">▾</span>';

  if (checked.length === 0) {
    btn.innerHTML = label + ": ทั้งหมด " + caret;
  } else if (checked.length <= 2) {
    const texts = checked.map(function (cb) { return cb.closest("label").textContent.trim(); });
    btn.innerHTML = label + ": " + texts.join(", ") + " " + caret;
  } else {
    btn.innerHTML = label + " (" + checked.length + " รายการ) " + caret;
  }
}

function onMultiselectChange(id, label) {
  updateMultiselectLabel(id, label);
  applyAllFilters();
}

// รวมทุกเงื่อนไข: ช่องค้นหา + แบรนด์ + เกรด + คำแนะนำ เข้าด้วยกันในฟังก์ชันเดียว
// ต้องผ่านทุกเงื่อนไขถึงจะโชว์แถวนั้น (แต่ภายในหมวดเดียวกัน เช่นติ๊กหลายแบรนด์ ผ่านแบรนด์ใดแบรนด์หนึ่งพอ)
// ใช้ฟังก์ชันเดียวทั้งตอนพิมพ์ค้นหาและตอนติ๊กตัวกรอง กันไม่ให้ทั้งสองฝั่งเขียนทับ display ของกันและกัน
function applyAllFilters() {
  const tbody = document.getElementById("tbody");
  if (!tbody) return;

  const searchEl = document.getElementById("search");
  const query = searchEl ? searchEl.value.toLowerCase() : "";
  const brands = getMultiselectValues("purchBrand").map(function (b) { return b.toUpperCase(); });
  const grades = getMultiselectValues("purchGrade");
  const recs = getMultiselectValues("purchRec");

  Array.prototype.forEach.call(tbody.rows, function (row, idx) {
    const rowBrand = row.dataset.brand || "";
    const rowGrade = row.dataset.grade || "";
    const rowRec = row.dataset.rec || "";
    const passBrand = brands.length === 0 || brands.some(function (b) { return rowBrand.indexOf(b) > -1; });
    const passGrade = grades.length === 0 || grades.indexOf(rowGrade) > -1;
    const passRec = recs.length === 0 || recs.indexOf(rowRec) > -1;
    const passSearch = !query || (ROW_SEARCH_CACHE[idx] || "").indexOf(query) > -1;
    row.style.display = (passBrand && passGrade && passRec && passSearch) ? "" : "none";
  });
}

// อ่าน/บันทึกเกณฑ์ A,B (จำนวนชิ้นที่ขายได้) ไว้ในเบราว์เซอร์ ไม่ต้องกรอกใหม่ทุกครั้ง
function getBestThresholds() {
  let a = 5, b = 20;
  try {
    const sa = localStorage.getItem("bestThreshA");
    const sb = localStorage.getItem("bestThreshB");
    if (sa !== null) a = Number(sa);
    if (sb !== null) b = Number(sb);
  } catch (e) { /* ไม่มี localStorage ก็ใช้ค่าเริ่มต้น */ }
  if (isNaN(a) || a < 0) a = 5;
  if (isNaN(b) || b < 0) b = 20;
  return { a: a, b: b };
}

function applyBestThresholds() {
  let a = Number(document.getElementById("threshA").value);
  let b = Number(document.getElementById("threshB").value);
  if (isNaN(a) || isNaN(b) || a < 0 || b < 0) {
    alert("กรุณากรอกตัวเลขให้ถูกต้อง");
    return;
  }
  if (a > b) { const t = a; a = b; b = t; } // สลับให้ A น้อยกว่า B เสมอ
  try {
    localStorage.setItem("bestThreshA", String(a));
    localStorage.setItem("bestThreshB", String(b));
  } catch (e) { /* บันทึกไม่ได้ก็ยังใช้งานรอบนี้ได้ปกติ */ }
  loadData("best");
}

function bestRecommend(sold, a, b) {
  if (sold < a) return { label: "ขายไม่ดี", cls: "rec-none" };
  if (sold > b) return { label: "ควรสต็อก", cls: "rec-stock" };
  return { label: "ขายดี", cls: "rec-good" };
}

function renderBestSellers(hist, skuNames) {
  const vel = buildVelocity(hist);
  let list = Object.keys(vel).map(function (sku) {
    return { sku: sku, sold: vel[sku] };
  });
  list = gradeList(list, "sold");

  const th = getBestThresholds();

  let body = "";
  ROW_SEARCH_CACHE = [];
  list.forEach(function (i, idx) {
    const rec = bestRecommend(i.sold, th.a, th.b);
    const name = skuNames[i.sku] || "-";
    ROW_SEARCH_CACHE.push((i.sku + " " + name).toLowerCase());
    body += '<tr>' +
      '<td class="num">' + (idx + 1) + '</td>' +
      '<td>' + i.sku + '</td>' +
      '<td>' + name + '</td>' +
      '<td class="num">' + i.sold + '</td>' +
      '<td class="num">' + i.cum.toFixed(1) + '%</td>' +
      '<td class="g' + i.grade + '">' + i.grade + '</td>' +
      '<td class="' + rec.cls + '">' + rec.label + '</td></tr>';
  });

  const noneCount = list.filter(function (i) { return i.sold < th.a; }).length;
  const goodCount = list.filter(function (i) { return i.sold >= th.a && i.sold <= th.b; }).length;
  const stockCount = list.filter(function (i) { return i.sold > th.b; }).length;

  const threshBar =
    '<div class="thresh-bar">' +
      '<label>เกณฑ์ "ขายไม่ดี" ต่ำกว่า <input type="number" id="threshA" min="0" value="' + th.a + '"></label>' +
      '<label>เกณฑ์ "ควรสต็อก" มากกว่า <input type="number" id="threshB" min="0" value="' + th.b + '"></label>' +
      '<button class="thresh-apply" onclick="applyBestThresholds()">ใช้งานเกณฑ์นี้</button>' +
    '</div>';

  document.getElementById("output").innerHTML =
    threshBar +
    cards([
      { label: "SKU ทั้งหมด", value: list.length },
      { label: "ขายไม่ดี", value: noneCount },
      { label: "ขายดี", value: goodCount, type: "ok" },
      { label: "ควรสต็อกเพิ่ม", value: stockCount, type: stockCount > 0 ? "danger" : "ok" }
    ]) +
    table(["อันดับ", "SKU", "ชื่อสินค้า", "ยอดขาย", "สะสม %", "เกรด", "คำแนะนำ"], body);

  setPendingChecklist("", []); // หน้านี้ไม่ใช่ checklist ให้พิมพ์ตารางปกติแทน
}

let SEARCH_DEBOUNCE_TIMER = null;
function filterTable() {
  clearTimeout(SEARCH_DEBOUNCE_TIMER);
  SEARCH_DEBOUNCE_TIMER = setTimeout(applyAllFilters, 120);
}

function exportCSV() {
  const tbl = document.querySelector("table");
  if (!tbl) { alert("ยังไม่มีข้อมูลให้ดาวน์โหลด"); return; }
  let csv = "";
  Array.prototype.forEach.call(tbl.rows, function (row) {
    const cells = Array.prototype.map.call(row.cells, function (c) {
      return '"' + c.textContent.replace(/"/g, '""') + '"';
    });
    csv += cells.join(",") + "\n";
  });
  const blob = new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8;" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "report_" + new Date().toISOString().slice(0, 10) + ".csv";
  a.click();
}

// ดาวน์โหลดตารางเป็นไฟล์ .xlsx จริงๆ (ใช้ SheetJS แปลง <table> ในหน้าเว็บตรงๆ) เปิดด้วย Excel ได้เลย
function exportExcel() {
  const tbl = document.querySelector("table");
  if (!tbl) { alert("ยังไม่มีข้อมูลให้ดาวน์โหลด"); return; }
  const wb = XLSX.utils.table_to_book(tbl, { sheet: "Report" });
  XLSX.writeFile(wb, "report_" + new Date().toISOString().slice(0, 10) + ".xlsx");
}

function readSheetFile(file) {
  return new Promise(function (resolve, reject) {
    const fr = new FileReader();
    fr.onload = function (e) {
      try {
        const wb = XLSX.read(new Uint8Array(e.target.result), { type: "array", cellDates: true });
        const ws = wb.Sheets[wb.SheetNames[0]];
        const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: "", raw: false, blankrows: false });
        resolve(rows);
      } catch (err) {
        reject(err);
      }
    };
    fr.onerror = function () { reject(new Error("อ่านไฟล์ไม่สำเร็จ")); };
    fr.readAsArrayBuffer(file);
  });
}

// อ่านหลายไฟล์ (เช่น ST ที่ export มาแยกหลายไฟล์) แล้วรวมเป็นชุดเดียว
// จับคู่คอลัมน์ตาม "ชื่อหัวตาราง" ของแต่ละไฟล์เอง ไม่ใช้ตำแหน่งคอลัมน์ (index)
// ป้องกันข้อมูลเลื่อนคอลัมน์ผิด กรณีบางไฟล์เรียงคอลัมน์ไม่ตรงกันหรือมี/ขาดบางคอลัมน์
async function readMultipleSheetFiles(files) {
  const headerOrder = []; // ลำดับคอลัมน์รวมทุกไฟล์ (union) เรียงตามที่เจอครั้งแรก
  const objRows = []; // แถวข้อมูลของทุกไฟล์ เก็บเป็น object {ชื่อคอลัมน์: ค่า} เพื่อกันคอลัมน์เพี้ยนตำแหน่ง

  for (const file of files) {
    const rows = await readSheetFile(file);
    if (!rows || rows.length < 1) continue;

    const header = rows[0].map(function (h) { return String(h == null ? "" : h).trim(); });
    header.forEach(function (h) {
      if (h && headerOrder.indexOf(h) === -1) headerOrder.push(h);
    });

    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      const obj = {};
      header.forEach(function (h, idx) {
        if (h) obj[h] = row[idx];
      });
      objRows.push(obj);
    }
  }

  if (headerOrder.length === 0) return [];

  const dataRows = objRows.map(function (obj) {
    return headerOrder.map(function (h) {
      return obj[h] !== undefined ? obj[h] : "";
    });
  });

  return [headerOrder].concat(dataRows);
}

// ส่ง payload ขึ้น Apps Script แล้วอัปเดต log/สถานะ ใช้ร่วมกันทั้ง OD และ 3M/ST
async function submitPayload(payload, logId, resetIds) {
  const log = document.getElementById(logId);
  const keys = Object.keys(payload);

  if (keys.length === 0) {
    log.innerHTML = '<span class="warn">ยังไม่ได้เลือกไฟล์ หรือไฟล์ไม่มีข้อมูล</span>';
    return;
  }

  try {
    log.innerHTML = "กำลังอัปโหลดขึ้น Google Sheets ...";
    const res = await fetch(API_URL, {
      method: "POST",
      body: JSON.stringify({ action: "upload", data: payload })
    });
    const json = await safeParseJsonResponse(res);
    if (json.status !== "success") throw new Error(json.message || "อัปโหลดไม่สำเร็จ");

    let msg = "อัปโหลดสำเร็จ: ";
    for (const k in json.rows) msg += k + " " + json.rows[k] + " แถว | ";
    msg += new Date().toLocaleTimeString("th-TH");
    log.innerHTML = '<span class="good">' + msg + "</span>";

    (resetIds || []).forEach(function (id) {
      const el = document.getElementById(id);
      if (el) el.value = "";
    });

    CACHE = null;
    loadData(currentMode);
  } catch (err) {
    log.innerHTML = '<span class="warn">ผิดพลาด: ' + err.message + "</span>";
  }
}

// อัปโหลด 3M + ST พร้อมกัน — ปกติทำวันละครั้ง
// ชีต ST เลือกได้หลายไฟล์ (กรณี export มาแยกเป็นหลายไฟล์) จะถูกรวมเป็นชุดเดียวก่อนส่ง
async function uploadMain() {
  const log = document.getElementById("uplog-main");
  const f3mInput = document.getElementById("f3m");
  const fstInput = document.getElementById("fst");
  const payload = {};

  try {
    const m3Files = Array.from(f3mInput.files || []);
    if (m3Files.length > 0) {
      log.innerHTML = m3Files.length > 1
        ? "กำลังอ่านไฟล์ 3M ทั้งหมด " + m3Files.length + " ไฟล์ ..."
        : "กำลังอ่านไฟล์ " + m3Files[0].name + " ...";
      const combined3m = await readMultipleSheetFiles(m3Files);
      if (combined3m.length >= 2) payload["3M"] = combined3m;
    }

    const stFiles = Array.from(fstInput.files || []);
    if (stFiles.length > 0) {
      log.innerHTML = stFiles.length > 1
        ? "กำลังอ่านไฟล์ ST ทั้งหมด " + stFiles.length + " ไฟล์ ..."
        : "กำลังอ่านไฟล์ " + stFiles[0].name + " ...";
      const combined = await readMultipleSheetFiles(stFiles);
      if (combined.length >= 2) payload["ST"] = combined;
    }
  } catch (err) {
    log.innerHTML = '<span class="warn">อ่านไฟล์ผิดพลาด: ' + err.message + "</span>";
    return;
  }

  await submitPayload(payload, "uplog-main", ["f3m", "fst"]);
}

// โหลดหน้าแรกทันทีที่เปิดเว็บ ไม่ต้องกดเลือกเอง
document.addEventListener("DOMContentLoaded", function () {
  loadData(currentMode);
});
