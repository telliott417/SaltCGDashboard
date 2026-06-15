import { auth, googleProvider } from "./firebase-init.js";
import {
  signInWithPopup,
  signOut,
  onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";

const ALLOWED_DOMAIN = "candeochurch.com";

export function isAllowedEmail(email) {
  return email && email.endsWith("@" + ALLOWED_DOMAIN);
}

export async function signInWithGoogle() {
  try {
    const result = await signInWithPopup(auth, googleProvider);
    const email = result.user.email;
    if (!isAllowedEmail(email)) {
      await signOut(auth);
      throw new Error("Access restricted to Candeo Church staff accounts.");
    }
    return result.user;
  } catch (err) {
    if (err.code === "auth/popup-closed-by-user") return null;
    throw err;
  }
}

export async function signOutUser() {
  await signOut(auth);
  window.location.href = "/SaltCGDashboard/index.html";
}

export function requireAuth(onAuthed, onUnauthed) {
  onAuthStateChanged(auth, (user) => {
    if (user && isAllowedEmail(user.email)) {
      onAuthed(user);
    } else {
      onUnauthed();
    }
  });
}
