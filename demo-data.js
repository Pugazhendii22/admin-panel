// Interactive preview fixtures for local / sandbox previews only.
// Never loaded into real Firebase sessions — activated only when the user
// clicks a Preview button on localhost / *.e2b.app or opens ?demo=admin|inspector.

function demoTs(daysAgo, hoursAgo = 0) {
  const ms = Date.now() - daysAgo * 86400000 - hoursAgo * 3600000;
  return { toDate: () => new Date(ms) };
}

export function isPreviewHost() {
  const host = window.location.hostname || "";
  const params = new URLSearchParams(window.location.search);
  if (params.has("demo")) return true;
  return (
    host === "localhost" ||
    host === "127.0.0.1" ||
    host.endsWith(".e2b.app") ||
    host.endsWith(".local")
  );
}

export function requestedDemoRole() {
  const val = (new URLSearchParams(window.location.search).get("demo") || "").toLowerCase();
  if (val === "inspector") return "inspector";
  if (val === "admin" || val === "1" || val === "true") return "admin";
  return null;
}

export function createDemoState() {
  const catalog = {
    apple: {
      models: [
        { id: "iphone-16-pro-max", model: "iPhone 16 Pro Max", release_year: 2024, base_price: 0, hidden: false },
        { id: "iphone-16-pro", model: "iPhone 16 Pro", release_year: 2024, base_price: 0, hidden: false },
        { id: "iphone-15-pro", model: "iPhone 15 Pro", release_year: 2023, base_price: 0, hidden: false },
        { id: "iphone-15", model: "iPhone 15", release_year: 2023, base_price: 0, hidden: false },
        { id: "iphone-14-pro", model: "iPhone 14 Pro", release_year: 2022, base_price: 0, hidden: false },
        { id: "iphone-14", model: "iPhone 14", release_year: 2022, base_price: 0, hidden: false },
        { id: "iphone-13", model: "iPhone 13", release_year: 2021, base_price: 0, hidden: false },
        { id: "iphone-se-2022", model: "iPhone SE (3rd Gen)", release_year: 2022, base_price: 16500, hidden: true },
      ],
      variants: {
        "iphone-16-pro-max": [
          { id: "v-16pm-256", storage: "256GB", base_price: 98500 },
          { id: "v-16pm-512", storage: "512GB", base_price: 109000 },
          { id: "v-16pm-1tb", storage: "1TB", base_price: 118500 },
        ],
        "iphone-16-pro": [
          { id: "v-16p-128", storage: "128GB", base_price: 84000 },
          { id: "v-16p-256", storage: "256GB", base_price: 91500 },
          { id: "v-16p-512", storage: "512GB", base_price: 101000 },
        ],
        "iphone-15-pro": [
          { id: "v-15p-128", storage: "128GB", base_price: 69500 },
          { id: "v-15p-256", storage: "256GB", base_price: 76500 },
          { id: "v-15p-512", storage: "512GB", base_price: 84500 },
        ],
        "iphone-15": [
          { id: "v-15-128", storage: "128GB", base_price: 49000 },
          { id: "v-15-256", storage: "256GB", base_price: 54500 },
        ],
        "iphone-14-pro": [
          { id: "v-14p-128", storage: "128GB", base_price: 53500 },
          { id: "v-14p-256", storage: "256GB", base_price: 59000 },
        ],
        "iphone-14": [
          { id: "v-14-128", storage: "128GB", base_price: 37500 },
          { id: "v-14-256", storage: "256GB", base_price: 42500 },
        ],
        "iphone-13": [
          { id: "v-13-128", storage: "128GB", base_price: 31000 },
          { id: "v-13-256", storage: "256GB", base_price: 35000 },
        ],
        "iphone-se-2022": [
          { id: "v-se-64", storage: "64GB", base_price: 15500 },
          { id: "v-se-128", storage: "128GB", base_price: 18500 },
        ],
      },
    },
    samsung: {
      models: [
        { id: "galaxy-s24-ultra", model: "Samsung Galaxy S24 Ultra", release_year: 2024, base_price: 0, hidden: false },
        { id: "galaxy-s24-plus", model: "Samsung Galaxy S24+", release_year: 2024, base_price: 0, hidden: false },
        { id: "galaxy-z-fold-6", model: "Samsung Galaxy Z Fold6", release_year: 2024, base_price: 0, hidden: false },
        { id: "galaxy-s23-ultra", model: "Samsung Galaxy S23 Ultra", release_year: 2023, base_price: 0, hidden: false },
        { id: "galaxy-a55", model: "Samsung Galaxy A55 5G", release_year: 2024, base_price: 0, hidden: false },
        { id: "galaxy-m35", model: "Samsung Galaxy M35 5G", release_year: 2024, base_price: 12500, hidden: true },
      ],
      variants: {
        "galaxy-s24-ultra": [
          { id: "v-s24u-256", storage: "256GB 12GB RAM", base_price: 78500 },
          { id: "v-s24u-512", storage: "512GB 12GB RAM", base_price: 86000 },
        ],
        "galaxy-s24-plus": [
          { id: "v-s24p-256", storage: "256GB 12GB RAM", base_price: 54500 },
          { id: "v-s24p-512", storage: "512GB 12GB RAM", base_price: 60500 },
        ],
        "galaxy-z-fold-6": [
          { id: "v-zf6-256", storage: "256GB 12GB RAM", base_price: 94000 },
          { id: "v-zf6-512", storage: "512GB 12GB RAM", base_price: 103000 },
        ],
        "galaxy-s23-ultra": [
          { id: "v-s23u-256", storage: "256GB 12GB RAM", base_price: 56000 },
          { id: "v-s23u-512", storage: "512GB 12GB RAM", base_price: 61500 },
        ],
        "galaxy-a55": [
          { id: "v-a55-128", storage: "128GB 8GB RAM", base_price: 21500 },
          { id: "v-a55-256", storage: "256GB 8GB RAM", base_price: 24500 },
        ],
        "galaxy-m35": [
          { id: "v-m35-128", storage: "128GB 6GB RAM", base_price: 12500 },
        ],
      },
    },
    oneplus: {
      models: [
        { id: "oneplus-13", model: "OnePlus 13", release_year: 2025, base_price: 0, hidden: false },
        { id: "oneplus-12", model: "OnePlus 12", release_year: 2024, base_price: 0, hidden: false },
        { id: "oneplus-12r", model: "OnePlus 12R", release_year: 2024, base_price: 0, hidden: false },
        { id: "oneplus-nord-4", model: "OnePlus Nord 4", release_year: 2024, base_price: 0, hidden: false },
      ],
      variants: {
        "oneplus-13": [
          { id: "v-op13-256", storage: "256GB 12GB RAM", base_price: 52500 },
          { id: "v-op13-512", storage: "512GB 16GB RAM", base_price: 58500 },
        ],
        "oneplus-12": [
          { id: "v-op12-256", storage: "256GB 12GB RAM", base_price: 39500 },
          { id: "v-op12-512", storage: "512GB 16GB RAM", base_price: 44000 },
        ],
        "oneplus-12r": [
          { id: "v-op12r-128", storage: "128GB 8GB RAM", base_price: 25500 },
          { id: "v-op12r-256", storage: "256GB 16GB RAM", base_price: 29500 },
        ],
        "oneplus-nord-4": [
          { id: "v-opn4-256", storage: "256GB 8GB RAM", base_price: 20500 },
        ],
      },
    },
    google: {
      models: [
        { id: "pixel-9-pro", model: "Google Pixel 9 Pro", release_year: 2024, base_price: 0, hidden: false },
        { id: "pixel-8-pro", model: "Google Pixel 8 Pro", release_year: 2023, base_price: 0, hidden: false },
      ],
      variants: {
        "pixel-9-pro": [
          { id: "v-p9p-256", storage: "256GB 16GB RAM", base_price: 68500 },
        ],
        "pixel-8-pro": [
          { id: "v-p8p-128", storage: "128GB 12GB RAM", base_price: 44500 },
        ],
      },
    },
  };

  const inspectors = [
    { id: "insp-ravi", name: "Ravi Kumar", email: "ravi.k@frenchmobiles.in", active: true },
    { id: "insp-priya", name: "Priya Nair", email: "priya.n@frenchmobiles.in", active: true },
    { id: "insp-karthik", name: "Karthik Raja", email: "karthik.r@frenchmobiles.in", active: true },
    { id: "insp-meena", name: "Meena Sundaram", email: "meena.s@frenchmobiles.in", active: false },
  ];

  const orders = [
    {
      id: "ord-884210",
      reference: "FM-884210",
      modelName: "iPhone 15 Pro",
      brand: "Apple",
      storage: "256GB",
      basePrice: 76500,
      finalPayout: 71200,
      status: "placed",
      createdAt: demoTs(0, 2),
      customerName: "Arjun Subramanian",
      customerPhone: "+91 98423 41022",
      addressLabel: "Home",
      addressFullText: "42 Mission Street, White Town, Puducherry 605001",
      quote: {
        lines: [
          { category: "Body", choice: "Minor frame scuffs", percent: 4, amount: 3060 },
          { category: "Battery", choice: "Battery health 85% – 90%", percent: 3, amount: 2240 },
        ],
      },
      checkup: {
        batteryHealth: 87,
        passed: ["touch", "wifi", "bluetooth", "speaker", "mic", "camera_back", "camera_front", "biometric"],
        failed: [],
      },
      declared: {
        "Screen": "Flawless glass, no scratches",
        "Accessories": "Original box and USB-C cable",
        "Device age": "6 to 11 months",
      },
    },
    {
      id: "ord-884205",
      reference: "FM-884205",
      modelName: "Samsung Galaxy S24 Ultra",
      brand: "Samsung",
      storage: "256GB 12GB RAM",
      basePrice: 78500,
      finalPayout: 68400,
      status: "agent_assigned",
      inspectorId: "insp-ravi",
      inspectorName: "Ravi Kumar",
      createdAt: demoTs(0, 6),
      customerName: "Divya Venkatesh",
      customerPhone: "+91 94431 78219",
      addressLabel: "Office",
      addressFullText: "18 Anna Salai, Heritage Town, Puducherry 605001",
      quote: {
        lines: [
          { category: "Screen", choice: "Light micro scratches", percent: 5, amount: 3925 },
          { category: "Accessories", choice: "Missing original box", percent: 8, amount: 6175 },
        ],
      },
      checkup: {
        batteryHealth: 93,
        passed: ["touch", "wifi", "bluetooth", "speaker", "camera_back", "gyroscope"],
        failed: [],
      },
      declared: {
        "Body": "Clean titanium frame, no dents",
        "Functionality": "All sensors working normally",
      },
    },
    {
      id: "ord-884198",
      reference: "FM-884198",
      modelName: "iPhone 16 Pro",
      brand: "Apple",
      storage: "256GB",
      basePrice: 91500,
      finalPayout: 89600,
      status: "placed",
      createdAt: demoTs(0, 9),
      customerName: "Senthil Nathan",
      customerPhone: "+91 97890 11234",
      addressLabel: "Home",
      addressFullText: "115 Kamaraj Salai, Thattanchavady, Puducherry 605009",
      quote: {
        lines: [
          { category: "Accessories", choice: "No charger brick", percent: 2, amount: 1900 },
        ],
      },
      checkup: { batteryHealth: 99, passed: ["touch", "wifi", "speaker", "camera_back", "biometric"], failed: [] },
      declared: { "Screen": "Zero scratches", "Body": "Mint condition" },
    },
    {
      id: "ord-884176",
      reference: "FM-884176",
      modelName: "OnePlus 12",
      brand: "OnePlus",
      storage: "256GB 12GB RAM",
      basePrice: 39500,
      finalPayout: 34800,
      status: "inspection",
      inspectorId: "insp-ravi",
      inspectorName: "Ravi Kumar",
      createdAt: demoTs(1, 3),
      customerName: "Praveen Raj",
      customerPhone: "+91 96295 45018",
      addressLabel: "Home",
      addressFullText: "7 Bharathi Street, Lawspet, Puducherry 605008",
      quote: {
        lines: [
          { category: "Body", choice: "Small corner dent", percent: 7, amount: 2765 },
          { category: "Battery", choice: "Battery health 80% – 85%", percent: 5, amount: 1935 },
        ],
      },
      checkup: { batteryHealth: 83, passed: ["touch", "wifi", "speaker", "camera_back"], failed: ["proximity"] },
      declared: { "Screen": "No cracks or spots" },
    },
    {
      id: "ord-884145",
      reference: "FM-884145",
      modelName: "Google Pixel 9 Pro",
      brand: "Google",
      storage: "256GB 16GB RAM",
      basePrice: 68500,
      finalPayout: 61500,
      status: "inspection",
      inspectorId: "insp-priya",
      inspectorName: "Priya Nair",
      createdAt: demoTs(1, 8),
      customerName: "Ananya Krishnan",
      customerPhone: "+91 98944 62109",
      addressLabel: "Home",
      addressFullText: "23 Rue Suffren, White Town, Puducherry 605001",
      quote: {
        lines: [
          { category: "Screen", choice: "Minor hairline scratch", percent: 6, amount: 4110 },
          { category: "Accessories", choice: "Cable only", percent: 4, amount: 2890 },
        ],
      },
      checkup: { batteryHealth: 95, passed: ["touch", "wifi", "camera_back", "camera_front"], failed: [] },
    },
    {
      id: "ord-884092",
      reference: "FM-884092",
      modelName: "iPhone 14",
      brand: "Apple",
      storage: "128GB",
      basePrice: 37500,
      finalPayout: 34200,
      status: "paid",
      inspectorId: "insp-ravi",
      inspectorName: "Ravi Kumar",
      createdAt: demoTs(2, 4),
      customerName: "Vigneshwaran M",
      customerPhone: "+91 90432 88712",
      addressLabel: "Shop pickup",
      addressFullText: "French Mobiles Flagship, Nehru Street, Puducherry 605001",
      quote: {
        lines: [{ category: "Battery", choice: "Battery health 80% – 85%", percent: 9, amount: 3300 }],
      },
    },
    {
      id: "ord-884041",
      reference: "FM-884041",
      modelName: "Samsung Galaxy S23 Ultra",
      brand: "Samsung",
      storage: "256GB 12GB RAM",
      basePrice: 56000,
      finalPayout: 49800,
      status: "paid",
      inspectorId: "insp-karthik",
      inspectorName: "Karthik Raja",
      createdAt: demoTs(3, 2),
      customerName: "Lakshmi Narayanan",
      customerPhone: "+91 94862 33091",
      addressLabel: "Home",
      addressFullText: "88 East Coast Road, Auroville Main Rd, Puducherry 605104",
      quote: {
        lines: [{ category: "Body", choice: "Light wear around S-Pen slot", percent: 11, amount: 6200 }],
      },
    },
    {
      id: "ord-883990",
      reference: "FM-883990",
      modelName: "OnePlus 12R",
      brand: "OnePlus",
      storage: "128GB 8GB RAM",
      basePrice: 25500,
      finalPayout: 17400,
      status: "declined",
      inspectorId: "insp-priya",
      inspectorName: "Priya Nair",
      createdAt: demoTs(4, 1),
      customerName: "Deepak Kumar",
      customerPhone: "+91 99408 55210",
      addressLabel: "Home",
      addressFullText: "14 Rainbow Nagar, 6th Cross, Puducherry 605011",
      quote: {
        lines: [
          { category: "Screen", choice: "Cracked glass corner", percent: 24, amount: 6120 },
          { category: "Body", choice: "Back glass hairline crack", percent: 8, amount: 1980 },
        ],
      },
    },
  ];

  const pricingRules = {
    device_questions: {
      options: [
        { question: "Does the phone switch on and stay charged?", help: "Must boot cleanly to home screen", label: "Will not boot", percent: 65, deduct_on: "no", gates: true },
        { question: "Are both front and rear cameras crisp?", help: "Check autofocus and OIS shake", label: "Camera fault", percent: 16, deduct_on: "no", gates: false },
        { question: "Do Face ID / Fingerprint sensors unlock normally?", help: "Test biometric enrollment", label: "Biometric fault", percent: 18, deduct_on: "no", gates: false },
      ],
    },
    screen_condition: {
      options: [
        { label: "Flawless display, no scratches", percent: 0 },
        { label: "Light micro scratches (visible under light)", percent: 6 },
        { label: "Deep scratches or minor edge chip", percent: 14 },
        { label: "Cracked screen glass (touch working)", percent: 26 },
        { label: "Dead pixels, green line, or dead touch", percent: 45 },
      ],
    },
    body_condition: {
      options: [
        { label: "Mint frame & back glass", percent: 0 },
        { label: "Minor frame scuffs or cover marks", percent: 4 },
        { label: "Visible corner dents or heavy scratches", percent: 10 },
        { label: "Cracked back glass or bent chassis", percent: 18 },
      ],
    },
    battery_health: {
      options: [
        { label: "Above 90% battery health", percent: 0 },
        { label: "85% to 90% battery health", percent: 3 },
        { label: "80% to 85% battery health", percent: 7 },
        { label: "Below 80% or Service warning", percent: 14 },
      ],
    },
    accessories: {
      options: [
        { label: "Original box, cable & valid invoice", percent: 0 },
        { label: "Original charger / cable missing", percent: 3 },
        { label: "Original box missing", percent: 5 },
        { label: "Device only (no box or accessories)", percent: 8 },
      ],
    },
    warranty_status: {
      options: [
        { label: "Under 3 months (with GST bill)", percent: 0 },
        { label: "3 to 6 months", percent: 4 },
        { label: "6 to 11 months", percent: 8 },
        { label: "Out of warranty", percent: 12 },
      ],
    },
    checkup_deductions: {
      options: [
        { key: "touch", label: "Dead touch zones", percent: 25, same_as: "" },
        { key: "biometric", label: "Biometric sensor fault", percent: 18, same_as: "" },
        { key: "camera_back", label: "Rear camera fault", percent: 16, same_as: "" },
        { key: "speaker", label: "Loudspeaker distortion", percent: 8, same_as: "" },
        { key: "wifi", label: "Wi-Fi connectivity fault", percent: 6, same_as: "" },
      ],
    },
    scrap_value: {
      options: [
        { brand: "apple", series: "iPhone Pro", amount: 9500 },
        { brand: "apple", series: "iPhone", amount: 5500 },
        { brand: "samsung", series: "S series", amount: 6000 },
        { brand: "oneplus", series: "Flagship", amount: 4200 },
      ],
    },
  };

  const listings = [
    { brand: "Apple", model: "iPhone 15 Pro", storage: "256GB · Natural Titanium", condition: "Superb (Grade A+)", salePrice: 82900, originalPrice: 134900 },
    { brand: "Samsung", model: "Galaxy S24 Ultra", storage: "256GB · Titanium Gray", condition: "Mint (Grade A+)", salePrice: 84500, originalPrice: 129999 },
    { brand: "Apple", model: "iPhone 14", storage: "128GB · Midnight", condition: "Good (Grade A)", salePrice: 43900, originalPrice: 69900 },
    { brand: "OnePlus", model: "OnePlus 12", storage: "256GB · Flowy Emerald", condition: "Superb (Grade A+)", salePrice: 44500, originalPrice: 64999 },
    { brand: "Google", model: "Pixel 8 Pro", storage: "128GB · Obsidian", condition: "Good (Grade A)", salePrice: 49900, originalPrice: 106999 },
  ];

  return { catalog, inspectors, orders, pricingRules, listings };
}
