import {
  auth, db, guardClinicPage, signOut,
  doc, getDoc, setDoc, updateDoc, deleteDoc, addDoc, collection, query, where, orderBy,
  getDocs, onSnapshot, runTransaction, serverTimestamp,
  showError, clearError
} from "./core.js";

let clinicId = null;
let currentRole = null;
let allPatients = [];          // كاش محلي لكل مرضى العيادة
let todayVisits = [];          // زيارات اليوم (حي)
let selectedExistingPatientId = null;   // عند اختيار مريض موجود بنافذة تسجيل الزيارة
let pendingVisitType = "walkin";        // "walkin" أو "appointment"
let openPatientVisitContext = null;     // معرف الزيارة الحالية عند فتح ملف المريض من الطابور
let currentOpenPatientId = null;        // معرف المريض المفتوح حالياً بالنافذة (لحفظ الحالة الطبية العامة)

// ---- حالة تبويب الحسابات المالية ----
let financeMonthDate = startOfMonth(new Date()); // أول يوم بالشهر المعروض حالياً
let financeMonthVisits = [];
let financeMonthExpenses = [];
let unsubFinanceVisits = null;
let unsubFinanceExpenses = null;

const todayStr = formatDate(new Date());

// ---------------- حماية الصفحة + بدء التشغيل ----------------
guardClinicPage((user, userDoc) => {
  clinicId = userDoc.clinicId;
  currentRole = userDoc.role;
  document.getElementById("sideUserName").textContent = userDoc.name || user.email;
  document.getElementById("roleBadge").textContent = currentRole === "doctor" ? "طبيب" : "سكرتيرة";
  document.getElementById("todayDateLabel").textContent = "تاريخ اليوم: " + todayStr;

  applyRolePermissions();
  loadClinicName();
  listenPatients();
  listenTodayVisits();
});

// السكرتيرة: صلاحيتها تقتصر على حجز/تسجيل المواعيد فقط — بدون فتح ملفات المرضى أو بياناتهم الطبية
function applyRolePermissions() {
  if (currentRole === "secretary") {
    const patientsTabBtn = document.querySelector('.side-tab[data-tab="patients"]');
    if (patientsTabBtn) patientsTabBtn.style.display = "none";
    const financeTabBtn = document.querySelector('.side-tab[data-tab="finance"]');
    if (financeTabBtn) financeTabBtn.style.display = "none";
  }
}

document.getElementById("logoutBtn").addEventListener("click", async () => {
  await signOut(auth);
  window.location.href = "clinic-login.html";
});

async function loadClinicName() {
  const snap = await getDoc(doc(db, "clinics", clinicId));
  if (snap.exists()) {
    document.getElementById("clinicNameLabel").textContent = "عيادة " + (snap.data().doctorName || "");
  }
}

// ---------------- تبديل التبويبات ----------------
document.querySelectorAll(".side-tab").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".side-tab").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    const tab = btn.dataset.tab;
    document.getElementById("tab-today").style.display = tab === "today" ? "block" : "none";
    document.getElementById("tab-patients").style.display = tab === "patients" ? "block" : "none";
    document.getElementById("tab-finance").style.display = tab === "finance" ? "block" : "none";
    if (tab === "patients") renderPatientsList();
    if (tab === "finance" && currentRole === "doctor") listenFinanceMonth();
  });
});

function formatDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
function formatTimeNow() {
  const d = new Date();
  return String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
}
function escapeHtml(str) {
  return String(str ?? "").replace(/[&<>"']/g, (m) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[m]));
}
function genderLabel(g) { return g === "female" ? "أنثى" : "ذكر"; }

const ARABIC_MONTHS = [
  "يناير", "فبراير", "مارس", "أبريل", "مايو", "يونيو",
  "يوليو", "أغسطس", "سبتمبر", "أكتوبر", "نوفمبر", "ديسمبر"
];
function startOfMonth(d) { return new Date(d.getFullYear(), d.getMonth(), 1); }
function monthRangeStrings(d) {
  const start = formatDate(new Date(d.getFullYear(), d.getMonth(), 1));
  const end = formatDate(new Date(d.getFullYear(), d.getMonth() + 1, 0));
  return { start, end };
}
function monthLabel(d) { return `${ARABIC_MONTHS[d.getMonth()]} ${d.getFullYear()}`; }
function money(n) { return Number(n || 0).toLocaleString() + " د.ع"; }

/* =====================================================================
   المرضى — تحميل وعرض
   ===================================================================== */
function listenPatients() {
  const q = query(collection(db, "clinics", clinicId, "patients"), orderBy("createdAt", "desc"));
  onSnapshot(q, (snap) => {
    allPatients = [];
    snap.forEach((d) => allPatients.push({ id: d.id, ...d.data() }));
    renderPatientsList();
  });
}

function renderPatientsList() {
  const wrap = document.getElementById("patientsList");
  const empty = document.getElementById("patientsEmpty");
  const term = (document.getElementById("patientSearchInput").value || "").trim().toLowerCase();

  const filtered = allPatients.filter((p) => {
    if (!term) return true;
    return (p.fullName || "").toLowerCase().includes(term) || (p.phone || "").includes(term);
  });

  wrap.innerHTML = "";
  empty.style.display = filtered.length === 0 ? "block" : "none";

  filtered.forEach((p) => {
    const row = document.createElement("div");
    row.className = "patient-row";
    row.innerHTML = `
      <div>
        <div class="pname">${escapeHtml(p.fullName)}</div>
        <div class="pmeta">${genderLabel(p.gender)} • ${escapeHtml(p.age ?? "—")} سنة • ${escapeHtml(p.phone || "—")}</div>
      </div>
      <span style="color:var(--ink-soft); font-size:18px;">›</span>
    `;
    row.addEventListener("click", () => openPatientModal(p.id, null));
    wrap.appendChild(row);
  });
}

document.getElementById("patientSearchInput").addEventListener("input", renderPatientsList);

/* =====================================================================
   نافذة "مريض جديد" (من تبويب المرضى)
   ===================================================================== */
const newPatientModal = document.getElementById("newPatientModal");
document.getElementById("openNewPatientBtn").addEventListener("click", () => newPatientModal.classList.add("open"));
document.getElementById("closeNewPatientModalBtn").addEventListener("click", closeNewPatientModal);
document.getElementById("cancelNewPatientBtn").addEventListener("click", closeNewPatientModal);
function closeNewPatientModal() {
  newPatientModal.classList.remove("open");
  document.getElementById("newPatientForm").reset();
  clearError(document.getElementById("newPatientErrBox"));
}

document.getElementById("newPatientForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const errBox = document.getElementById("newPatientErrBox");
  clearError(errBox);
  try {
    await addDoc(collection(db, "clinics", clinicId, "patients"), {
      fullName: document.getElementById("npName").value.trim(),
      age: Number(document.getElementById("npAge").value),
      gender: document.getElementById("npGender").value,
      phone: document.getElementById("npPhone").value.trim(),
      createdAt: serverTimestamp()
    });
    closeNewPatientModal();
  } catch (err) {
    showError(errBox, "صار خطأ أثناء حفظ المريض، حاول مرة ثانية");
  }
});

/* =====================================================================
   جدول اليوم — الاستماع الحي وعرض القائمة
   ===================================================================== */
function listenTodayVisits() {
  const q = query(
    collection(db, "clinics", clinicId, "visits"),
    where("date", "==", todayStr),
    orderBy("sortTime", "asc")
  );
  onSnapshot(q, (snap) => {
    todayVisits = [];
    snap.forEach((d) => todayVisits.push({ id: d.id, ...d.data() }));
    renderQueue();
  });
}

function renderQueue() {
  const wrap = document.getElementById("queueList");
  const empty = document.getElementById("queueEmpty");

  document.getElementById("statWaiting").textContent = todayVisits.filter(v => v.status === "waiting").length;
  document.getElementById("statDone").textContent = todayVisits.filter(v => v.status === "done").length;
  document.getElementById("statTotalToday").textContent = todayVisits.length;

  wrap.innerHTML = "";
  empty.style.display = todayVisits.length === 0 ? "block" : "none";

  todayVisits.forEach((v) => {
    const row = document.createElement("div");
    row.className = "queue-item";

    const statusLabel = { waiting: "بالانتظار", in_progress: "جارِ الكشف", done: "تم الكشف" }[v.status] || v.status;
    const isDoctor = currentRole === "doctor";

    let actionsHtml = "";
    if (isDoctor) {
      if (v.status === "waiting") {
        actionsHtml = `<button class="btn btn-teal start-btn" data-id="${v.id}">بدء الكشف</button>`;
      } else if (v.status === "in_progress") {
        actionsHtml = `
          <button class="btn btn-outline open-file-btn" data-id="${v.id}" data-pid="${v.patientId}">فتح الملف</button>
          <button class="btn btn-teal finish-btn" data-id="${v.id}">إنهاء</button>`;
      } else {
        actionsHtml = `<button class="btn btn-outline open-file-btn" data-id="${v.id}" data-pid="${v.patientId}">عرض الملف</button>`;
      }
    }

    row.innerHTML = `
      <div class="queue-num">${v.sortTime || "--:--"}</div>
      <div class="queue-info">
        <div class="qname ${isDoctor ? "clickable-name" : ""}" ${isDoctor ? `data-pid="${v.patientId}" data-vid="${v.id}"` : ""}>${escapeHtml(v.patientName)}
          <span class="type-badge ${v.visitType === "appointment" ? "appt" : "walkin"}">
            ${v.visitType === "appointment" ? "موعد" : "مباشر"}
          </span>
        </div>
        <div class="qmeta">${escapeHtml(v.patientPhone || "")} • ${statusLabel}${v.fee ? " • " + Number(v.fee).toLocaleString() + " د.ع" : ""}</div>
      </div>
      <div class="queue-actions">${actionsHtml}</div>
    `;
    wrap.appendChild(row);
  });

  if (currentRole === "doctor") {
    wrap.querySelectorAll(".clickable-name").forEach((el) => {
      el.addEventListener("click", () => openPatientModal(el.dataset.pid, el.dataset.vid));
    });
  }

  wrap.querySelectorAll(".start-btn").forEach((btn) => {
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      await updateDoc(doc(db, "clinics", clinicId, "visits", btn.dataset.id), { status: "in_progress" });
      const v = todayVisits.find(x => x.id === btn.dataset.id);
      if (v) openPatientModal(v.patientId, v.id);
    });
  });
  wrap.querySelectorAll(".finish-btn").forEach((btn) => {
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      await updateDoc(doc(db, "clinics", clinicId, "visits", btn.dataset.id), { status: "done" });
    });
  });
  wrap.querySelectorAll(".open-file-btn").forEach((btn) => {
    btn.addEventListener("click", () => openPatientModal(btn.dataset.pid, btn.dataset.id));
  });
}

/* =====================================================================
   نافذة تسجيل زيارة (موعد مسبق أو دخول مباشر)
   ===================================================================== */
const visitModal = document.getElementById("visitModal");
const apptTimeField = document.getElementById("apptTimeField");
const visitPatientSearch = document.getElementById("visitPatientSearch");
const patientSuggestions = document.getElementById("patientSuggestions");
const selectedPatientCard = document.getElementById("selectedPatientCard");
const newPatientFields = document.getElementById("newPatientFields");

document.getElementById("openWalkinBtn").addEventListener("click", () => openVisitModal("walkin"));
document.getElementById("openApptBtn").addEventListener("click", () => openVisitModal("appointment"));
document.getElementById("closeVisitModalBtn").addEventListener("click", closeVisitModal);
document.getElementById("cancelVisitBtn").addEventListener("click", closeVisitModal);

function openVisitModal(type) {
  pendingVisitType = type;
  selectedExistingPatientId = null;
  document.getElementById("visitModalTitle").textContent = type === "appointment" ? "حجز موعد" : "تسجيل دخول مباشر";
  apptTimeField.style.display = type === "appointment" ? "block" : "none";
  document.getElementById("apptTime").required = type === "appointment";
  resetPatientSelectionUI();
  clearError(document.getElementById("visitErrBox"));
  visitModal.classList.add("open");
}
function closeVisitModal() {
  visitModal.classList.remove("open");
  document.getElementById("visitForm").reset();
  resetPatientSelectionUI();
}
function resetPatientSelectionUI() {
  selectedExistingPatientId = null;
  visitPatientSearch.value = "";
  patientSuggestions.classList.remove("open");
  patientSuggestions.innerHTML = "";
  selectedPatientCard.style.display = "none";
  newPatientFields.style.display = "block";
}

visitPatientSearch.addEventListener("input", () => {
  const term = visitPatientSearch.value.trim().toLowerCase();
  if (!term) { patientSuggestions.classList.remove("open"); return; }
  const matches = allPatients.filter(p =>
    (p.fullName || "").toLowerCase().includes(term) || (p.phone || "").includes(term)
  ).slice(0, 6);

  patientSuggestions.innerHTML = "";
  if (matches.length === 0) {
    patientSuggestions.classList.remove("open");
    return;
  }
  matches.forEach((p) => {
    const item = document.createElement("div");
    item.className = "suggestion-item";
    item.innerHTML = `<div class="sname">${escapeHtml(p.fullName)}</div><div class="sphone">${escapeHtml(p.phone || "")}</div>`;
    item.addEventListener("click", () => selectExistingPatient(p));
    patientSuggestions.appendChild(item);
  });
  patientSuggestions.classList.add("open");
});

function selectExistingPatient(p) {
  selectedExistingPatientId = p.id;
  patientSuggestions.classList.remove("open");
  visitPatientSearch.value = "";
  newPatientFields.style.display = "none";
  selectedPatientCard.style.display = "flex";
  selectedPatientCard.innerHTML = `
    <div>
      <div class="spname">${escapeHtml(p.fullName)}</div>
      <div class="spmeta">${genderLabel(p.gender)} • ${escapeHtml(p.age ?? "—")} سنة • ${escapeHtml(p.phone || "—")}</div>
    </div>
    <button type="button" id="clearSelectedPatientBtn">تغيير</button>
  `;
  document.getElementById("clearSelectedPatientBtn").addEventListener("click", resetPatientSelectionUI);
}

document.getElementById("visitForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const errBox = document.getElementById("visitErrBox");
  clearError(errBox);
  const submitBtn = document.getElementById("submitVisitBtn");
  submitBtn.disabled = true;
  submitBtn.textContent = "جارِ الحفظ...";

  try {
    let patientId = selectedExistingPatientId;
    let patientName, patientPhone;

    if (!patientId) {
      const name = document.getElementById("newPatientName").value.trim();
      const phone = document.getElementById("newPatientPhone").value.trim();
      const age = Number(document.getElementById("newPatientAge").value);
      const gender = document.getElementById("newPatientGender").value;
      if (!name) throw new Error("NAME_REQUIRED");

      const newPatientRef = await addDoc(collection(db, "clinics", clinicId, "patients"), {
        fullName: name, age, gender, phone, createdAt: serverTimestamp()
      });
      patientId = newPatientRef.id;
      patientName = name; patientPhone = phone;
    } else {
      const p = allPatients.find(x => x.id === patientId);
      patientName = p.fullName; patientPhone = p.phone;
    }

    const sortTime = pendingVisitType === "appointment"
      ? document.getElementById("apptTime").value
      : formatTimeNow();

    const fee = Number(document.getElementById("visitFee").value);
    if (!fee || fee <= 0) throw new Error("FEE_REQUIRED");

    // رقم دور ذري لهذا اليوم (عداد آمن حتى مع تسجيل متزامن)
    const counterRef = doc(db, "clinics", clinicId, "counters", todayStr);
    const queueNumber = await runTransaction(db, async (tx) => {
      const snap = await tx.get(counterRef);
      const next = (snap.exists() ? snap.data().lastNumber : 0) + 1;
      tx.set(counterRef, { lastNumber: next }, { merge: true });
      return next;
    });

    await addDoc(collection(db, "clinics", clinicId, "visits"), {
      patientId, patientName, patientPhone,
      visitType: pendingVisitType,
      scheduledTime: pendingVisitType === "appointment" ? sortTime : null,
      sortTime,
      queueNumber,
      fee,
      date: todayStr,
      status: "waiting",
      symptoms: "",
      diagnosis: "",
      treatment: "",
      createdAt: serverTimestamp()
    });

    closeVisitModal();
  } catch (err) {
    if (err.message === "NAME_REQUIRED") {
      showError(errBox, "لازم تكتب اسم المريض أو تختار مريض موجود");
    } else if (err.message === "FEE_REQUIRED") {
      showError(errBox, "لازم تكتب مبلغ الكشفية");
    } else {
      showError(errBox, "صار خطأ أثناء تسجيل الزيارة، حاول مرة ثانية");
    }
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = "تأكيد التسجيل";
  }
});

/* =====================================================================
   نافذة ملف المريض (بيانات أساسية + تشخيص الزيارة الحالية + السجل)
   ===================================================================== */
const patientModal = document.getElementById("patientModal");
document.getElementById("closePatientModalBtn").addEventListener("click", () => patientModal.classList.remove("open"));

async function openPatientModal(patientId, visitId) {
  if (currentRole !== "doctor") return; // السكرتيرة ما تملك صلاحية فتح ملف المريض
  openPatientVisitContext = visitId;
  const snap = await getDoc(doc(db, "clinics", clinicId, "patients", patientId));
  if (!snap.exists()) return;
  const p = snap.data();

  document.getElementById("patientModalName").textContent = p.fullName;
  document.getElementById("patientBasicInfo").innerHTML = `
    <div><span>العمر</span>${escapeHtml(p.age ?? "—")} سنة</div>
    <div><span>الجنس</span>${genderLabel(p.gender)}</div>
    <div><span>الهاتف</span>${escapeHtml(p.phone || "—")}</div>
  `;

  document.getElementById("chronicDiseases").value = p.chronicDiseases || "";
  document.getElementById("allergiesNotes").value = p.allergiesNotes || "";
  currentOpenPatientId = patientId;

  const diagSection = document.getElementById("diagnosisSection");
  document.getElementById("currentSymptoms").value = "";
  document.getElementById("currentDiagnosis").value = "";
  document.getElementById("currentTreatment").value = "";
  diagSection.style.display = visitId ? "block" : "none";

  await loadVisitHistory(patientId);
  patientModal.classList.add("open");
}

document.getElementById("saveGeneralStatusBtn").addEventListener("click", async () => {
  if (!currentOpenPatientId) return;
  const btn = document.getElementById("saveGeneralStatusBtn");
  btn.disabled = true;
  try {
    await updateDoc(doc(db, "clinics", clinicId, "patients", currentOpenPatientId), {
      chronicDiseases: document.getElementById("chronicDiseases").value.trim(),
      allergiesNotes: document.getElementById("allergiesNotes").value.trim()
    });
    btn.textContent = "تم الحفظ ✓";
    setTimeout(() => { btn.textContent = "حفظ الحالة الطبية العامة"; btn.disabled = false; }, 1400);
  } catch (err) {
    btn.disabled = false;
    alert("صار خطأ أثناء حفظ الحالة الطبية العامة");
  }
});

document.getElementById("saveDiagnosisBtn").addEventListener("click", async () => {
  if (!openPatientVisitContext) return;
  const btn = document.getElementById("saveDiagnosisBtn");
  btn.disabled = true;
  try {
    await updateDoc(doc(db, "clinics", clinicId, "visits", openPatientVisitContext), {
      symptoms: document.getElementById("currentSymptoms").value.trim(),
      diagnosis: document.getElementById("currentDiagnosis").value.trim(),
      treatment: document.getElementById("currentTreatment").value.trim()
    });
    btn.textContent = "تم الحفظ ✓";
    setTimeout(() => { btn.textContent = "حفظ نتيجة الزيارة"; btn.disabled = false; }, 1400);
  } catch (err) {
    btn.disabled = false;
    alert("صار خطأ أثناء حفظ نتيجة الزيارة");
  }
});

async function loadVisitHistory(patientId) {
  const wrap = document.getElementById("visitHistoryList");
  const empty = document.getElementById("historyEmpty");
  wrap.innerHTML = "";

  const q = query(
    collection(db, "clinics", clinicId, "visits"),
    where("patientId", "==", patientId),
    orderBy("date", "desc")
  );
  const snap = await getDocs(q);

  const items = [];
  snap.forEach((d) => items.push(d.data()));

  empty.style.display = items.length === 0 ? "block" : "none";
  items.forEach((v) => {
    const div = document.createElement("div");
    div.className = "history-item";
    const rows = [];
    if (v.symptoms) rows.push(`<div><strong>الأعراض:</strong> ${escapeHtml(v.symptoms)}</div>`);
    if (v.diagnosis) rows.push(`<div><strong>التشخيص:</strong> ${escapeHtml(v.diagnosis)}</div>`);
    if (v.treatment) rows.push(`<div><strong>العلاج:</strong> ${escapeHtml(v.treatment)}</div>`);
    const detailsHtml = rows.length
      ? rows.join("")
      : '<span style="color:var(--ink-soft)">بدون تفاصيل مسجّلة</span>';
    div.innerHTML = `
      <div class="hdate">${v.date} — ${v.sortTime || ""} ${v.visitType === "appointment" ? "(موعد)" : "(مباشر)"}${v.fee ? " • " + Number(v.fee).toLocaleString() + " د.ع" : ""}</div>
      <div class="hdiag">${detailsHtml}</div>
    `;
    wrap.appendChild(div);
  });
}

/* =====================================================================
   الحسابات المالية — إيرادات الكشفيات، الصرفيات الشهرية، الجدول اليومي
   ===================================================================== */

document.getElementById("prevMonthBtn").addEventListener("click", () => {
  financeMonthDate = new Date(financeMonthDate.getFullYear(), financeMonthDate.getMonth() - 1, 1);
  listenFinanceMonth();
});
document.getElementById("nextMonthBtn").addEventListener("click", () => {
  financeMonthDate = new Date(financeMonthDate.getFullYear(), financeMonthDate.getMonth() + 1, 1);
  listenFinanceMonth();
});

function listenFinanceMonth() {
  document.getElementById("financeMonthLabel").textContent = monthLabel(financeMonthDate);
  const { start, end } = monthRangeStrings(financeMonthDate);

  if (unsubFinanceVisits) unsubFinanceVisits();
  if (unsubFinanceExpenses) unsubFinanceExpenses();

  const visitsQ = query(
    collection(db, "clinics", clinicId, "visits"),
    where("date", ">=", start),
    where("date", "<=", end),
    orderBy("date", "asc")
  );
  unsubFinanceVisits = onSnapshot(visitsQ, (snap) => {
    financeMonthVisits = [];
    snap.forEach((d) => financeMonthVisits.push({ id: d.id, ...d.data() }));
    renderFinance();
  });

  const expensesQ = query(
    collection(db, "clinics", clinicId, "expenses"),
    where("date", ">=", start),
    where("date", "<=", end),
    orderBy("date", "asc")
  );
  unsubFinanceExpenses = onSnapshot(expensesQ, (snap) => {
    financeMonthExpenses = [];
    snap.forEach((d) => financeMonthExpenses.push({ id: d.id, ...d.data() }));
    renderFinance();
  });
}

function renderFinance() {
  const doneVisits = financeMonthVisits.filter((v) => v.status === "done");
  const revenue = doneVisits.reduce((sum, v) => sum + (Number(v.fee) || 0), 0);
  const expenseTotal = financeMonthExpenses.reduce((sum, e) => sum + (Number(e.amount) || 0), 0);

  document.getElementById("statMonthVisitors").textContent = financeMonthVisits.length;
  document.getElementById("statMonthRevenue").textContent = money(revenue);
  document.getElementById("statMonthExpenses").textContent = money(expenseTotal);
  document.getElementById("statMonthNet").textContent = money(revenue - expenseTotal);

  renderDailyBreakdown(doneVisits);
  renderExpensesList();
}

function renderDailyBreakdown(doneVisits) {
  const body = document.getElementById("dailyBreakdownBody");
  const empty = document.getElementById("dailyBreakdownEmpty");

  const byDay = {};
  doneVisits.forEach((v) => {
    if (!byDay[v.date]) byDay[v.date] = { count: 0, revenue: 0 };
    byDay[v.date].count += 1;
    byDay[v.date].revenue += Number(v.fee) || 0;
  });

  const days = Object.keys(byDay).sort((a, b) => (a < b ? 1 : -1));
  body.innerHTML = "";
  empty.style.display = days.length === 0 ? "block" : "none";

  days.forEach((day) => {
    const row = document.createElement("tr");
    row.innerHTML = `
      <td>${day}</td>
      <td>${byDay[day].count}</td>
      <td>${money(byDay[day].revenue)}</td>
    `;
    body.appendChild(row);
  });
}

function renderExpensesList() {
  const wrap = document.getElementById("expensesList");
  const empty = document.getElementById("expensesEmpty");

  const sorted = [...financeMonthExpenses].sort((a, b) => (a.date < b.date ? 1 : -1));
  wrap.innerHTML = "";
  empty.style.display = sorted.length === 0 ? "block" : "none";

  sorted.forEach((e) => {
    const row = document.createElement("div");
    row.className = "expense-row";
    row.innerHTML = `
      <div>
        <div class="exname">${escapeHtml(e.description)}</div>
        <div class="exmeta">${e.date}</div>
      </div>
      <div class="exright">
        <span class="examount">${money(e.amount)}</span>
        <button class="expense-del-btn" data-id="${e.id}" title="حذف">&times;</button>
      </div>
    `;
    wrap.appendChild(row);
  });

  wrap.querySelectorAll(".expense-del-btn").forEach((btn) => {
    btn.addEventListener("click", async () => {
      if (!confirm("حذف هذا الصرف نهائياً؟")) return;
      btn.disabled = true;
      try {
        await deleteDoc(doc(db, "clinics", clinicId, "expenses", btn.dataset.id));
      } catch (err) {
        alert("صار خطأ أثناء حذف الصرف");
        btn.disabled = false;
      }
    });
  });
}

/* ---------------- نافذة إضافة صرف ---------------- */
const expenseModal = document.getElementById("expenseModal");
document.getElementById("openExpenseBtn").addEventListener("click", () => {
  clearError(document.getElementById("expenseErrBox"));
  document.getElementById("expDate").value = todayStr;
  expenseModal.classList.add("open");
});
document.getElementById("closeExpenseModalBtn").addEventListener("click", closeExpenseModal);
document.getElementById("cancelExpenseBtn").addEventListener("click", closeExpenseModal);
function closeExpenseModal() {
  expenseModal.classList.remove("open");
  document.getElementById("expenseForm").reset();
  clearError(document.getElementById("expenseErrBox"));
}

document.getElementById("expenseForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const errBox = document.getElementById("expenseErrBox");
  clearError(errBox);

  const description = document.getElementById("expDescription").value.trim();
  const amount = Number(document.getElementById("expAmount").value);
  const date = document.getElementById("expDate").value;

  if (!description) { showError(errBox, "لازم تكتب وصف الصرف"); return; }
  if (!amount || amount <= 0) { showError(errBox, "لازم تكتب مبلغ صحيح"); return; }
  if (!date) { showError(errBox, "لازم تختار تاريخ الصرف"); return; }

  const submitBtn = expenseModal.querySelector('button[type="submit"]');
  submitBtn.disabled = true;
  submitBtn.textContent = "جارِ الحفظ...";
  try {
    await addDoc(collection(db, "clinics", clinicId, "expenses"), {
      description, amount, date, createdAt: serverTimestamp()
    });
    closeExpenseModal();
    // إذا الصرف بشهر غير الشهر المعروض حالياً، انتقل لعرض شهره تلقائياً
    const expenseMonth = new Date(date + "T00:00:00");
    if (expenseMonth.getFullYear() !== financeMonthDate.getFullYear() || expenseMonth.getMonth() !== financeMonthDate.getMonth()) {
      financeMonthDate = startOfMonth(expenseMonth);
      listenFinanceMonth();
    }
  } catch (err) {
    showError(errBox, "صار خطأ أثناء حفظ الصرف، حاول مرة ثانية");
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = "حفظ الصرف";
  }
});
