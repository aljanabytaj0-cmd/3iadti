import {
  auth, db, guardDeveloperPage, signOut,
  doc, setDoc, updateDoc, collection, query, orderBy, onSnapshot, serverTimestamp,
  createAuthUserWithoutSignOut, showError, clearError
} from "./core.js";

const clinicsBody   = document.getElementById("clinicsBody");
const emptyState    = document.getElementById("emptyState");
const statTotal     = document.getElementById("statTotal");
const statActive    = document.getElementById("statActive");
const statInactive  = document.getElementById("statInactive");
const sideUserName  = document.getElementById("sideUserName");

const addModal       = document.getElementById("addModal");
const openAddBtn     = document.getElementById("openAddBtn");
const closeModalBtn  = document.getElementById("closeModalBtn");
const cancelAddBtn   = document.getElementById("cancelAddBtn");
const addForm        = document.getElementById("addForm");
const addErrBox      = document.getElementById("addErrBox");
const submitAddBtn   = document.getElementById("submitAddBtn");

let currentDevUid = null;

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
    const clinics = [];
    snap.forEach((d) => clinics.push({ id: d.id, ...d.data() }));
    renderClinics(clinics);
  });
}

function renderClinics(clinics) {
  clinicsBody.innerHTML = "";
  emptyState.style.display = clinics.length === 0 ? "block" : "none";

  statTotal.textContent = clinics.length;
  statActive.textContent = clinics.filter(c => c.active).length;
  statInactive.textContent = clinics.filter(c => !c.active).length;

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
        <button class="btn ${c.active ? "btn-danger-ghost" : "btn-teal-ghost"} toggle-btn" data-id="${c.id}" data-active="${c.active}">
          ${c.active ? "تعطيل" : "تفعيل"}
        </button>
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
