import {
  auth, db, guardClinicPage, signOut,
  doc, getDoc, setDoc, updateDoc, addDoc, collection, query, where, orderBy,
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

const todayStr = formatDate(new Date());

// ---------------- حماية الصفحة + بدء التشغيل ----------------
guardClinicPage((user, userDoc) => {
  clinicId = userDoc.clinicId;
  currentRole = userDoc.role;
  document.getElementById("sideUserName").textContent = userDoc.name || user.email;
  document.getElementById("roleBadge").textContent = currentRole === "doctor" ? "طبيب" : "سكرتيرة";
  document.getElementById("todayDateLabel").textContent = "تاريخ اليوم: " + todayStr;

  loadClinicName();
  listenPatients();
  listenTodayVisits();
});

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
    if (tab === "patients") renderPatientsList();
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

    let actionsHtml = "";
    if (v.status === "waiting") {
      actionsHtml = `<button class="btn btn-teal start-btn" data-id="${v.id}">بدء الكشف</button>`;
    } else if (v.status === "in_progress") {
      actionsHtml = `
        <button class="btn btn-outline open-file-btn" data-id="${v.id}" data-pid="${v.patientId}">فتح الملف</button>
        <button class="btn btn-teal finish-btn" data-id="${v.id}">إنهاء</button>`;
    } else {
      actionsHtml = `<button class="btn btn-outline open-file-btn" data-id="${v.id}" data-pid="${v.patientId}">عرض الملف</button>`;
    }

    row.innerHTML = `
      <div class="queue-num">${v.sortTime || "--:--"}</div>
      <div class="queue-info">
        <div class="qname">${escapeHtml(v.patientName)}
          <span class="type-badge ${v.visitType === "appointment" ? "appt" : "walkin"}">
            ${v.visitType === "appointment" ? "موعد" : "مباشر"}
          </span>
        </div>
        <div class="qmeta">${escapeHtml(v.patientPhone || "")} • ${statusLabel}</div>
      </div>
      <div class="queue-actions">${actionsHtml}</div>
    `;
    wrap.appendChild(row);
  });

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
      date: todayStr,
      status: "waiting",
      diagnosis: "",
      createdAt: serverTimestamp()
    });

    closeVisitModal();
  } catch (err) {
    if (err.message === "NAME_REQUIRED") {
      showError(errBox, "لازم تكتب اسم المريض أو تختار مريض موجود");
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

  const diagSection = document.getElementById("diagnosisSection");
  const diagField = document.getElementById("currentDiagnosis");
  const saveBtn = document.getElementById("saveDiagnosisBtn");
  diagField.value = "";

  diagSection.style.display = visitId ? "block" : "none";

  await loadVisitHistory(patientId);
  patientModal.classList.add("open");
}

document.getElementById("saveDiagnosisBtn").addEventListener("click", async () => {
  if (!openPatientVisitContext) return;
  const btn = document.getElementById("saveDiagnosisBtn");
  btn.disabled = true;
  try {
    await updateDoc(doc(db, "clinics", clinicId, "visits", openPatientVisitContext), {
      diagnosis: document.getElementById("currentDiagnosis").value.trim()
    });
    btn.textContent = "تم الحفظ ✓";
    setTimeout(() => { btn.textContent = "حفظ التشخيص"; btn.disabled = false; }, 1400);
  } catch (err) {
    btn.disabled = false;
    alert("صار خطأ أثناء حفظ التشخيص");
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
    const diagText = v.diagnosis ? escapeHtml(v.diagnosis) : '<span style="color:var(--ink-soft)">بدون تشخيص مسجّل</span>';
    div.innerHTML = `
      <div class="hdate">${v.date} — ${v.sortTime || ""} ${v.visitType === "appointment" ? "(موعد)" : "(مباشر)"}</div>
      <div class="hdiag">${diagText}</div>
    `;
    wrap.appendChild(div);
  });
}
