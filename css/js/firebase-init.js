import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import { getAuth, GoogleAuthProvider } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "AIzaSyAs0yJorw8sx7bmoMo-z8vO5Qg58PVAyac",
  authDomain: "salt-cg-dashboard.firebaseapp.com",
  projectId: "salt-cg-dashboard",
  storageBucket: "salt-cg-dashboard.firebasestorage.app",
  messagingSenderId: "84113461655",
  appId: "1:84113461655:web:16cbeadb6cc861cd4f34d2"
};

const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);
export const googleProvider = new GoogleAuthProvider();

// Restrict sign-in to Candeo church emails only
googleProvider.setCustomParameters({
  hd: "candeo.church"
});
