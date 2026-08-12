// ========================================================
// core.js — تهيئة Firebase الأساسية + دوال مساعدة مشتركة
// ========================================================
import { initializeApp, deleteApp } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-app.js";
import {
  getAuth,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  sendPasswordResetEmail,
  signOut
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-auth.js";
import {
  getFirestore,
  doc,
  getDoc,
  setDoc,
  updateDoc,
  deleteDoc,
  addDoc,
  collection,
  query,
  where,
  orderBy,
  limit,
  getDocs,
  onSnapshot,
  runTransaction,
  serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";
import { firebaseConfig } from "./firebase-config.js";

export const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);

export {
  onAuthStateChanged, signInWithEmailAndPassword, signOut, sendPasswordResetEmail,
  doc, getDoc, setDoc, updateDoc, deleteDoc, addDoc, collection, query, where, orderBy, limit,
  getDocs, onSnapshot, runTransaction, serverTimestamp
};

// جلب مستند المستخدم (الدور + العيادة المرتبط بها)
export async function fetchUserDoc(uid) {
  const snap = await getDoc(doc(db, "users", uid));
  return snap.exists() ? snap.data() : null;
}

// إنشاء مستخدم Firebase Auth جديد (طبيب أو سكرتيرة) دون تسجيل خروج المطور الحالي
// نستخدم تطبيق Firebase ثانوي مؤقت لهذا الغرض فقط
export async function createAuthUserWithoutSignOut(email, password) {
  const secondaryApp = initializeApp(firebaseConfig, "secondary-" + Date.now());
  const secondaryAuth = getAuth(secondaryApp);
  try {
    const cred = await createUserWithEmailAndPassword(secondaryAuth, email, password);
    const uid = cred.user.uid;
    await signOut(secondaryAuth);
    await deleteApp(secondaryApp);
    return uid;
  } catch (err) {
    await deleteApp(secondaryApp);
    throw err;
  }
}

// حماية الصفحات: يتأكد إن المستخدم مسجل دخول وإنه "مطوّر" فعّال، وإلا يرجعه لصفحة الدخول
export function guardDeveloperPage(onReady) {
  onAuthStateChanged(auth, async (user) => {
    if (!user) {
      window.location.href = "index.html";
      return;
    }
    const userDoc = await fetchUserDoc(user.uid);
    if (!userDoc || userDoc.role !== "developer" || userDoc.active !== true) {
      alert("هذا الحساب غير مخوّل للدخول للوحة المطور");
      await signOut(auth);
      window.location.href = "index.html";
      return;
    }
    onReady(user, userDoc);
  });
}

// حماية صفحات الطبيب/السكرتيرة: يتأكد إن المستخدم فعّال وعنده clinicId، ويرجّعه بالـ callback
export function guardClinicPage(onReady) {
  onAuthStateChanged(auth, async (user) => {
    if (!user) {
      window.location.href = "clinic-login.html";
      return;
    }
    const userDoc = await fetchUserDoc(user.uid);
    if (!userDoc || !["doctor", "secretary"].includes(userDoc.role) || userDoc.active !== true || !userDoc.clinicId) {
      alert("هذا الحساب غير مخوّل بالدخول لهذه الصفحة");
      await signOut(auth);
      window.location.href = "clinic-login.html";
      return;
    }
    onReady(user, userDoc);
  });
}

export function showError(el, message) {
  el.textContent = message;
  el.classList.add("visible");
}

export function clearError(el) {
  el.textContent = "";
  el.classList.remove("visible");
}
