// Firebase config for the admin panel.
//
// IMPORTANT DISCOVERY — this app is actually wired to TWO separate Firebase
// projects, not one. This was not obvious from the Flutter source alone
// (lib/firebase/catalog_firebase.dart only shows "french-mobiles-marketplace"
// everywhere) — it only became clear from android/app/google-services.json,
// which is the file that native-initializes Firebase on Android *before* any
// Dart code runs, and it points at a different, second project: "fren-75087".
//
//   fren-75087               → the project google-services.json ships with.
//                               The Flutter app's *default* FirebaseApp
//                               (`FirebaseFirestore.instance`, used with no
//                               explicit app name) resolves here on a real
//                               device, because Android auto-initializes the
//                               default app from google-services.json before
//                               main.dart's own Firebase.initializeApp() call
//                               even runs — that call most likely throws
//                               "already exists" and is silently swallowed
//                               (see the empty catch in lib/main.dart). This
//                               is where `second_hand_mobiles` actually lives
//                               on a device (lib/features/home/data/
//                               home_repository.dart,
//                               lib/profile/wishlist_page.dart).
//
//   french-mobiles-marketplace → the project every OTHER collection lives in
//                               (brands/*/models/*/variants, orders, users,
//                               addresses, payment methods, deduction_rules),
//                               reached through a second, explicitly-named
//                               Flutter app called "catalogApp"
//                               (lib/firebase/catalog_firebase.dart). Because
//                               that app has its own name, it isn't affected
//                               by whatever google-services.json set up for
//                               the default app, so it genuinely does connect
//                               where the Dart source says it does.
//
// Neither config below was copied from the mobile app's files. Both are
// dedicated Web app registrations created specifically for this admin panel
// (via the Firebase MCP's firebase_create_app), one under each project — so
// this panel has its own apiKeys, independently revocable from both the
// Android app's key AND from each other, while still reading/writing the
// exact same data the phones do.
export const catalogFirebaseConfig = {
  apiKey: "AIzaSyBPEZYTwR5PMdJgdX_zj36Nrrrzr9oUBAY",
  authDomain: "french-mobiles-marketplace.firebaseapp.com",
  projectId: "french-mobiles-marketplace",
  storageBucket: "french-mobiles-marketplace.firebasestorage.app",
  messagingSenderId: "1086357315686",
  appId: "1:1086357315686:web:af8b68f30d6173385c4da7",
};

export const secondHandFirebaseConfig = {
  apiKey: "AIzaSyCYCuif_LdZ9qCMSDivntFSNBNszYmVAbo",
  authDomain: "fren-75087.firebaseapp.com",
  projectId: "fren-75087",
  storageBucket: "fren-75087.firebasestorage.app",
  messagingSenderId: "530574210824",
  appId: "1:530574210824:web:375dc539eddf788eb89ebd",
};

// Web Push certificate key pair, from the Firebase console:
//   Project settings -> Cloud Messaging -> Web configuration -> Web Push
//   certificates -> Generate key pair
//
// Safe to ship: it is a public key, and it only lets this origin be issued a
// push subscription. Without it `getToken` throws and the panel silently
// never receives anything, so it is checked for explicitly at startup rather
// than being left to fail quietly.
export const webPushVapidKey =
  "BBvodiNxTjFM9-u7AwgHq2ktVuetbSudmHRYmq9T1EuHGQJgme9RdoXdp3zNcc37uOoCXIIBipQYiI0nhUPLFL8";
