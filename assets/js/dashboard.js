import {
  auth, db, guardDeveloperPage, signOut,
  doc, getDoc, setDoc, updateDoc, deleteDoc, collection, query, orderBy, onSnapshot, serverTimestamp,
  createAuthUserWithoutSignOut, sendPasswordResetEmail, showError, clearError
} from "./core.js";

const clinicsBody   = document.getElementById("clinicsBody");
const emptyState    = document.getElementById("emptyState");
const statTotal     = document.getElementById("statTotal");
const statActive    = document.getElementById("statActive");
const statInactive  = document.getElementById("statInactive");
const sideUserName  = document.getElementById("sideUserName");
const searchInput   = document.getElementById("clinicSearchInput");

const addModal       = document.getElementById("addModal");
const openAddBtn     = document.getElementById("openAddBtn");
const closeModalBtn  = document.getElementById("closeModalBtn");
const cancelAddBtn   = document.getElementById("cancelAddBtn");
const addForm        = document.getElementById("addForm");
const addErrBox      = document.getElementById("addErrBox");
const submitAddBtn   = document.getElementById("submitAddBtn");

const editModal        = document.getElementById("editModal");
const closeEditModalBtn = document.getElementById("closeEditModalBtn");
const cancelEditBtn     = document.getElementById("cancelEditBtn");
const editForm          = document.getElementById("editForm");
const editErrBox        = document.getElementById("editErrBox");
const submitEditBtn     = document.getElementById("submitEditBtn");
const resetPwMsgBox     = document.getElementById("resetPwMsgBox");

let currentDevUid = null;
let allClinics = [];       // آخر نسخة من قائمة العيادات (للفلترة بدون إعادة استعلام)
let editingClinic = null;  // العيادة المفتوحة حالياً بنافذة التعديل

// ---------- حماية الصفحة ----------
guardDeveloperPage((user, userDoc) => {
  currentDevUid = user.uid;
  sideUserName.textContent = userDoc.name || user.email;
  listenToClinics();
});

document.getElementById("logoutBtn").addEventListener("click", async () => {
  await signOut(auth);
  window.location.href = "index.html";
});

// ---------- الاستماع الحي لقائمة العيادات ----------
function listenToClinics() {
  const q = query(collection(db, "clinics"), orderBy("createdAt", "desc"));
  onSnapshot(q, (snap) => {
    allClinics = [];
    snap.forEach((d) => allClinics.push({ id: d.id, ...d.data() }));
    renderClinics();
  });
}

searchInput.addEventListener("input", () => renderClinics());

function renderClinics() {
  const q = searchInput.value.trim().toLowerCase();
  const clinics = !q ? allClinics : allClinics.filter((c) => {
    const haystack = [c.doctorName, c.specialty, c.secretaryName, c.phone, c.doctorEmail, c.secretaryEmail]
      .map((v) => (v || "").toLowerCase()).join(" ");
    return haystack.includes(q);
  });

  clinicsBody.innerHTML = "";
  emptyState.style.display = clinics.length === 0 ? "block" : "none";
  if (clinics.length === 0 && q) {
    emptyState.textContent = "ما فيه نتائج مطابقة لبحثك";
  } else {
    emptyState.textContent = 'ما فيه عيادات مسجّلة لحد الآن — اضغط "إضافة طبيب جديد" لبدء أول حساب';
  }

  statTotal.textContent = allClinics.length;
  statActive.textContent = allClinics.filter(c => c.active).length;
  statInactive.textContent = allClinics.filter(c => !c.active).length;

  clinics.forEach((c) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>
        <div class="doc-name">${escapeHtml(c.doctorName)}</div>
        <div class="doc-sub">${escapeHtml(c.doctorEmail || "")}</div>
      </td>
      <td>${escapeHtml(c.specialty || "—")}</td>
      <td>
        <div>${escapeHtml(c.secretaryName || "—")}</div>
        <div class="doc-sub">${escapeHtml(c.secretaryEmail || "")}</div>
      </td>
      <td>${escapeHtml(c.phone || "—")}</td>
      <td>
        <span class="status-pill ${c.active ? "active" : "inactive"}">
          ${c.active ? "فعّالة" : "معطّلة"}
        </span>
      </td>
      <td>
        <div style="display:flex; gap:8px; flex-wrap:wrap;">
          <button class="btn ${c.active ? "btn-danger-ghost" : "btn-teal-ghost"} toggle-btn" data-id="${c.id}" data-active="${c.active}">
            ${c.active ? "تعطيل" : "تفعيل"}
          </button>
          <button class="btn btn-outline edit-btn" data-id="${c.id}">تعديل</button>
        </div>
      </td>
    `;
    clinicsBody.appendChild(tr);
  });

  document.querySelectorAll(".toggle-btn").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const id = btn.dataset.id;
      const isActive = btn.dataset.active === "true";
      btn.disabled = true;
      try {
        await updateDoc(doc(db, "clinics", id), { active: !isActive });
      } catch (err) {
        alert("صار خطأ أثناء تحديث الحالة، حاول مرة ثانية");
      } finally {
        btn.disabled = false;
      }
    });
  });

  document.querySelectorAll(".edit-btn").forEach((btn) => {
    btn.addEventListener("click", () => openEditModal(btn.dataset.id));
  });
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (m) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[m]));
}

// ---------- نافذة إضافة طبيب ----------
openAddBtn.addEventListener("click", () => addModal.classList.add("open"));
closeModalBtn.addEventListener("click", closeModal);
cancelAddBtn.addEventListener("click", closeModal);
addModal.addEventListener("click", (e) => { if (e.target === addModal) closeModal(); });

function closeModal() {
  addModal.classList.remove("open");
  addForm.reset();
  clearError(addErrBox);
}

addForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  clearError(addErrBox);

  const doctorName       = document.getElementById("doctorName").value.trim();
  const specialty         = document.getElementById("specialty").value.trim();
  const phone             = document.getElementById("phone").value.trim();
  const doctorEmail       = document.getElementById("doctorEmail").value.trim();
  const doctorPassword    = document.getElementById("doctorPassword").value;
  const secretaryName     = document.getElementById("secretaryName").value.trim();
  const secretaryEmail    = document.getElementById("secretaryEmail").value.trim();
  const secretaryPassword = document.getElementById("secretaryPassword").value;

  submitAddBtn.disabled = true;
  submitAddBtn.textContent = "جارِ الإنشاء...";

  try {
    // 1) إنشاء حساب الدخول للطبيب والسكرتيرة (بدون تسجيل خروج المطوّر)
    const doctorUid    = await createAuthUserWithoutSignOut(doctorEmail, doctorPassword);
    const secretaryUid = await createAuthUserWithoutSignOut(secretaryEmail, secretaryPassword);

    // 2) توليد معرّف عيادة فريد (clinicId) — هذا هو أساس العزل بين الحسابات
    const clinicRef = doc(collection(db, "clinics"));
    const clinicId = clinicRef.id;

    // 3) حفظ مستند العيادة
    await setDoc(clinicRef, {
      doctorName, specialty, phone,
      doctorEmail, doctorUid,
      secretaryName, secretaryEmail, secretaryUid,
      active: true,
      createdBy: currentDevUid,
      createdAt: serverTimestamp()
    });

    // 4) حفظ مستندات المستخدمين (تُستخدم في قواعد الأمان وتحديد الصلاحيات)
    await setDoc(doc(db, "users", doctorUid), {
      role: "doctor", clinicId, name: doctorName, email: doctorEmail,
      active: true, createdAt: serverTimestamp()
    });
    await setDoc(doc(db, "users", secretaryUid), {
      role: "secretary", clinicId, name: secretaryName, email: secretaryEmail,
      active: true, createdAt: serverTimestamp()
    });

    closeModal();
  } catch (err) {
    showError(addErrBox, translateError(err));
  } finally {
    submitAddBtn.disabled = false;
    submitAddBtn.textContent = "إنشاء الحسابات";
  }
});

function translateError(err) {
  const code = err && err.code;
  if (code === "auth/email-already-in-use") return "أحد البريدين مستخدم مسبقاً بحساب آخر";
  if (code === "auth/weak-password") return "كلمة المرور ضعيفة جداً، استخدم 6 أحرف على الأقل";
  if (code === "auth/invalid-email") return "صيغة البريد الإلكتروني غير صحيحة";
  return "صار خطأ أثناء إنشاء الحساب، تأكد من البيانات وحاول مرة ثانية";
}

/* =====================================================================
   نافذة تعديل بيانات العيادة — تعديل، إعادة تعيين كلمة مرور، حذف نهائي
   ===================================================================== */

function openEditModal(clinicId) {
  const c = allClinics.find((x) => x.id === clinicId);
  if (!c) return;
  editingClinic = c;

  clearError(editErrBox);
  resetPwMsgBox.textContent = "";
  resetPwMsgBox.classList.remove("visible");

  document.getElementById("editDoctorName").value = c.doctorName || "";
  document.getElementById("editSpecialty").value = c.specialty || "";
  document.getElementById("editPhone").value = c.phone || "";
  document.getElementById("editSecretaryName").value = c.secretaryName || "";

  editModal.classList.add("open");
}

function closeEditModal() {
  editModal.classList.remove("open");
  editingClinic = null;
  editForm.reset();
  clearError(editErrBox);
}
closeEditModalBtn.addEventListener("click", closeEditModal);
cancelEditBtn.addEventListener("click", closeEditModal);
editModal.addEventListener("click", (e) => { if (e.target === editModal) closeEditModal(); });

editForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!editingClinic) return;
  clearError(editErrBox);

  const doctorName = document.getElementById("editDoctorName").value.trim();
  const specialty = document.getElementById("editSpecialty").value.trim();
  const phone = document.getElementById("editPhone").value.trim();
  const secretaryName = document.getElementById("editSecretaryName").value.trim();

  submitEditBtn.disabled = true;
  submitEditBtn.textContent = "جارِ الحفظ...";
  try {
    // تحديث مستند العيادة
    await updateDoc(doc(db, "clinics", editingClinic.id), {
      doctorName, specialty, phone, secretaryName
    });
    // مزامنة الاسمين بمستندات users حتى تنعكس فوراً بلوحة العيادة (اسم الطبيب/السكرتيرة بالشريط الجانبي)
    if (editingClinic.doctorUid) {
      await updateDoc(doc(db, "users", editingClinic.doctorUid), { name: doctorName });
    }
    if (editingClinic.secretaryUid) {
      await updateDoc(doc(db, "users", editingClinic.secretaryUid), { name: secretaryName });
    }
    closeEditModal();
  } catch (err) {
    showError(editErrBox, "صار خطأ أثناء حفظ التعديلات، حاول مرة ثانية");
  } finally {
    submitEditBtn.disabled = false;
    submitEditBtn.textContent = "حفظ التعديلات";
  }
});

// ---------- إرسال رابط إعادة تعيين كلمة المرور ----------
document.getElementById("resetDoctorPwBtn").addEventListener("click", () => sendResetLink("doctor"));
document.getElementById("resetSecretaryPwBtn").addEventListener("click", () => sendResetLink("secretary"));

async function sendResetLink(who) {
  if (!editingClinic) return;
  const email = who === "doctor" ? editingClinic.doctorEmail : editingClinic.secretaryEmail;
  const label = who === "doctor" ? "الطبيب" : "السكرتيرة";
  if (!email) return;

  resetPwMsgBox.classList.remove("visible");
  try {
    await sendPasswordResetEmail(auth, email);
    resetPwMsgBox.textContent = `تم إرسال رابط إعادة تعيين كلمة المرور لبريد ${label} (${email})`;
    resetPwMsgBox.style.background = "var(--teal-light)";
    resetPwMsgBox.style.color = "var(--teal)";
    resetPwMsgBox.classList.add("visible");
  } catch (err) {
    resetPwMsgBox.textContent = `تعذّر إرسال الرابط لبريد ${label} — تأكد من صحة البريد المسجّل`;
    resetPwMsgBox.style.background = "var(--danger-light)";
    resetPwMsgBox.style.color = "var(--danger)";
    resetPwMsgBox.classList.add("visible");
  }
}

// ---------- حذف العيادة نهائياً ----------
document.getElementById("deleteClinicBtn").addEventListener("click", async () => {
  if (!editingClinic) return;
  const confirmed = confirm(
    `حذف عيادة الدكتور "${editingClinic.doctorName}" نهائياً؟\n` +
    `راح ينحذف حساب الدخول (الطبيب والسكرتيرة) وبيانات العيادة من القائمة، وهذا الإجراء ما ينرجع.\n` +
    `(بيانات المرضى والزيارات القديمة تضل محفوظة بقاعدة البيانات لكنها تصير غير قابلة للوصول من أي حد)`
  );
  if (!confirmed) return;

  const btn = document.getElementById("deleteClinicBtn");
  btn.disabled = true;
  btn.textContent = "جارِ الحذف...";
  try {
    await deleteDoc(doc(db, "clinics", editingClinic.id));
    if (editingClinic.doctorUid) {
      await deleteDoc(doc(db, "users", editingClinic.doctorUid));
    }
    if (editingClinic.secretaryUid) {
      await deleteDoc(doc(db, "users", editingClinic.secretaryUid));
    }
    closeEditModal();
  } catch (err) {
    alert("صار خطأ أثناء حذف العيادة، حاول مرة ثانية");
    console.error("deleteClinicBtn failed", err);
  } finally {
    btn.disabled = false;
    btn.textContent = "حذف هذه العيادة نهائياً";
  }
});
