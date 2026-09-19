# French Mobiles — Admin Panel

A plain HTML/CSS/JS admin tool. **Not part of the Flutter app** — no
`pubspec.yaml` entry, no Dart, no build step. Open `index.html` in a browser
and it works. This folder could be deleted entirely and the mobile app would
be completely unaffected, and vice versa.

It manages the exact same data the mobile app reads: brand catalogue (models
+ storage variants + base prices), and order status. It also shows (read-only)
the second-hand listings the app's home screen displays — see **"Two Firebase
projects"** below for why that one is different.

---

## Important: this app uses TWO Firebase projects

This wasn't obvious from the Flutter source alone, and it's worth
understanding before you use this panel:

| Project | Used for | How the app reaches it |
|---|---|---|
| **`fren-75087`** | `second_hand_mobiles` (home screen listings, wishlist) | The Flutter app's **default** Firebase connection — the one with no explicit name (`FirebaseFirestore.instance`). Android auto-connects to this project on startup because it's the project baked into `android/app/google-services.json`, **before Dart's own `main()` even runs.** |
| **`french-mobiles-marketplace`** | Everything else: `brands/*/models/*/variants`, `orders`, `users`, addresses, payment methods, `deduction_rules` | A second, explicitly-named Firebase connection in the Dart code called `"catalogApp"` (see `lib/firebase/catalog_firebase.dart`). Because it has its own name, it isn't affected by whatever `google-services.json` set up for the default connection, so it genuinely does land on the project the Dart source says it does. |

**Practically, for this admin panel:** the Catalog and Orders tabs — the
things you actually asked this panel to manage (base price, add/delete
models, add variants, order status) — all live in
`french-mobiles-marketplace`, and that's the only project this panel signs
in to or writes to. The Second-hand listings tab reads `fren-75087` directly,
with no sign-in, the same way the app's own home screen does — and it's
**read-only**, because writing to it securely would need a *second*,
separate admin sign-in scoped to that project specifically (a Firebase Auth
session from one project's Auth isn't valid against another project's
Firestore rules — there's no way around that without much more machinery
than this panel needs).

If the plan is ever to fully retire the `fren-75087` split (point the
default connection at `french-mobiles-marketplace` too, so there's only one
project), that's a real, deliberate change to the Flutter app's `main.dart`
— not something to do casually, since it changes which database
`second_hand_mobiles` reads/writes actually land in on every phone that's
already installed the app.

---

## One-time setup

### 1. Enable Email/Password sign-in

This panel uses ordinary Firebase Authentication (email + password) for the
admin login — not a hardcoded password in the JavaScript, which would be
visible to anyone who views the page source and would protect nothing.

In the [Firebase console](https://console.firebase.google.com/project/french-mobiles-marketplace/authentication/providers):
- Go to **Authentication → Sign-in method**
- Enable **Email/Password**

### 2. Create your admin account

- **Authentication → Users → Add user**
- Enter the email + password you (the admin) want to sign in with here.
- Copy the **User UID** it generates — you need it for the next step.

### 3. Allow that account to actually use the panel

Signing in only proves *who* someone is — it doesn't by itself grant access
to edit anything. That has to be enforced by Firestore's security rules
(anyone can read this JavaScript's source and see the project's `apiKey`,
so the real gate can never be client-side code).

- **Firestore Database → Start collection** (if `admins` doesn't exist yet)
- Collection ID: `admins`
- Document ID: **paste the UID from step 2**
- Add any one field, e.g. `role` (string) = `admin`
- Save

### 4. Add security rules

This panel doesn't touch your live rules automatically — merge this into
whatever `french-mobiles-marketplace` already has (in **Firestore Database →
Rules**). The important parts:

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {

    function isAdmin() {
      return request.auth != null &&
        exists(/databases/$(database)/documents/admins/$(request.auth.uid));
    }

    // Catalog: the app reads this for anyone, browsing or not.
    match /brands/{brand} {
      match /models/{model} {
        allow read: if true;
        allow write: if isAdmin();

        match /variants/{variant} {
          allow read: if true;
          allow write: if isAdmin();
        }
      }
    }

    // Orders: keep whatever read/create rules you already have for buyers
    // placing an order — just make sure isAdmin() is included wherever you
    // allow *updates*, so this panel can change `status`:
    match /orders/{order} {
      allow update: if isAdmin();
      // ...your existing allow read / allow create rules stay as they are.
    }

    // The allowlist itself — an admin can check their own membership,
    // nobody can grant themselves access by writing here.
    match /admins/{uid} {
      allow read: if request.auth != null && request.auth.uid == uid;
      allow write: if false; // only ever set by hand in the console
    }
  }
}
```

If you're not sure what your current rules look like, open **Firestore
Database → Rules** in the console and paste the relevant `match` blocks in
next to what's already there — don't replace the whole file blindly.

### 5. Open the panel

No build, no install. Either:

- Double-click `index.html`, **or**
- From this folder: `python3 -m http.server 8080` then visit
  `http://localhost:8080`, **or**
- Deploy it as a Firebase Hosting site if you want a real URL for it (not
  set up here — ask if you want that added).

---

## What each tab does

### Catalog
- Pick a brand (the same nine the app's own Sell → Brand list recognises —
  see the warning banner if you type a custom one).
- Add, edit, or delete a model. Deleting a model also deletes all of its
  variants (can't be undone).
- Click **Variants** on a model to add/edit/delete its storage options and
  their prices — this is exactly what `VariantSelectionPage` in the app
  reads, and it is where you change what a seller gets paid. See
  **Where the price actually comes from** below before using the model-level
  "Headline price" field instead.

### Orders
- Live — this table updates itself the instant an order's data changes
  anywhere (including from a phone), and any status change you make here
  shows up in the app's Orders tab and tracker immediately.
- The status dropdown only offers the four values the app actually
  understands (`placed`, `agent_assigned`, `inspection`, `paid`) — typing
  anything else directly into Firestore would make the app silently treat
  the order as "placed" again, so the dropdown is deliberately the only way
  to change it here.

### Second-hand listings
- Read-only, from the other Firebase project. See the explanation above.

---

## Data shapes (kept in sync with the Flutter app)

**Model** (`brands/{brand}/models/{modelId}`):
```
model: string        — display name, e.g. "Motorola Edge (2022)"
release_year: number — optional
image_url: string    — optional
base_price: number   — OPTIONAL override, see below. Absent on every
                       currently-imported model, which is the normal case.
specs: map           — written by the import script; this panel never
                       touches it, and editing a model preserves it.
```

**Variant** (`brands/{brand}/models/{modelId}/variants/{variantId}`):
```
storage: string     — e.g. "128GB 8GB RAM"
base_price: number  — this variant's own price. THIS is the number a
                      seller is actually quoted.
```

### Where the price actually comes from

Worth being precise about, because it is not obvious and it is easy to break:

`brand_detail_page.dart` reads the model's `base_price` **first**. If it is
present and non-zero, that value is used as the headline price and **the
variants are never read**. If it is absent or zero, the app falls back to
reading every variant and using the **highest** `base_price` among them.

Every model in this catalogue today has no model-level `base_price`, so every
price the app shows comes from the variants. That means:

- **To change what a seller is paid, edit the variants.** That is the real
  price.
- The model's "Headline price" field is an override that also turns off the
  variant lookup. Setting it can make the brand list advertise one price
  while the variant screen quotes another. The panel leaves it blank by
  default and explains this in the form; clearing it removes the field
  entirely rather than writing a zero.

The Catalog table shows the *resolved* price — the same one the app will
show — and labels which rule produced it ("highest variant" or "fixed on
model"), so a model with no price at all reads as "no price set" instead of
a misleading ₹0.

**Order** (`orders/{orderId}`) — this panel only ever writes `status` and
`updatedAt`; everything else is written once by the app at checkout. The
details sheet also renders `quote.lines`, the grading wizard's itemised
deductions (`choice`, `category`, `percent`, `amount`), and flags
`quote.floored` when the deductions exceeded the device's value and the
payout was floored.

```
status: string       — "placed" | "agent_assigned" | "inspection" | "paid"
updatedAt: timestamp — bumped by this panel on every status change
```

---

## Explicitly out of scope

Kept out on purpose, not forgotten:

- **`deduction_rules`** (the grading wizard's condition-based price
  deductions) — never asked for, not built.
- **Editing `second_hand_mobiles`** — read-only, see above.
- **Creating a brand outside the known nine** — the custom-id field lets you
  do it, but it's clearly flagged as reducing discoverability in the app,
  rather than silently allowed.
