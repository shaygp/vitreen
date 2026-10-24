import { randomBytes } from "node:crypto";

const LIMITS = { name: 80, tagline: 140, text: 200, category: 60, item: 80, categories: 20, items: 60 };

export const clean = (value, max) =>
  typeof value === "string"
    ? value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max)
    : "";

export function cleanPrice(value) {
  if (value === null || value === undefined || value === "") return null;
  const digits = typeof value === "number" ? null : String(value).replace(",", ".").replace(/[^\d.]/g, "");
  if (digits === "") return null;
  const n = typeof value === "number" ? value : Number(digits);
  return Number.isFinite(n) && n >= 0 && n < 10000 ? Math.round(n * 100) / 100 : null;
}

export const newId = () => randomBytes(4).toString("hex");

export function sanitizeMenu(categories, previous = [], defaultCategory = "La carte") {
  if (!Array.isArray(categories)) return [];
  const knownIds = new Map(previous.flatMap((c) => c.items).map((i) => [i.name.toLowerCase(), i.id]));
  return categories
    .slice(0, LIMITS.categories)
    .map((category) => ({
      name: clean(category?.name, LIMITS.category) || defaultCategory,
      items: (Array.isArray(category?.items) ? category.items : [])
        .slice(0, LIMITS.items)
        .map((item) => {
          const name = clean(item?.name, LIMITS.item);
          if (!name) return null;
          return {
            id: knownIds.get(name.toLowerCase()) ?? newId(),
            name,
            price: cleanPrice(item?.price),
            available: item?.available !== false,
          };
        })
        .filter(Boolean),
    }))
    .filter((category) => category.items.length > 0);
}

export function sanitizeDetails(details = {}) {
  return {
    name: clean(details.name, LIMITS.name),
    tagline: clean(details.tagline, LIMITS.tagline),
    hours: clean(details.hours, LIMITS.text),
    address: clean(details.address, LIMITS.text),
  };
}

export function slugify(name) {
  const base =
    name
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "boutique";
  return `${base}-${randomBytes(2).toString("hex")}`;
}

export const isValidEmail = (email) => typeof email === "string" && email.length <= 254 && /^[^\s@<>()"',;:]+@[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(email);

export function normalizePhone(value, countryCode = "33") {
  const raw = String(value ?? "").trim();
  const digits = raw.replace(/\D/g, "");
  if (raw.startsWith("+")) return digits.length >= 8 && digits.length <= 15 ? digits : null;
  if (digits.startsWith("00")) return digits.length >= 10 && digits.length <= 17 ? digits.slice(2) : null;
  if (digits.startsWith("0") && digits.length === 10) return `${countryCode}${digits.slice(1)}`;
  return null;
}

export const isValidSlug = (slug) => typeof slug === "string" && /^[a-z0-9-]{3,48}$/.test(slug);

export function buildOrder(shop, form) {
  const orderable = (shop.menu ?? []).flatMap((c) => c.items).filter((i) => i.available && i.price !== null);
  const lines = [];
  for (const item of orderable) {
    const qty = Number.parseInt(form[`q_${item.id}`] ?? "0", 10);
    if (Number.isInteger(qty) && qty > 0) lines.push({ name: item.name, price: item.price, qty: Math.min(qty, 50) });
  }
  const customer = clean(form.name, 60);
  const phone = clean(form.phone, 20).replace(/[^\d+ ]/g, "");
  const pickup = clean(form.pickup, 40);
  const errors = [];
  if (lines.length === 0) errors.push("items");
  if (!customer) errors.push("name");
  if (!normalizePhone(phone)) errors.push("phone");
  const total = Math.round(lines.reduce((sum, l) => sum + l.price * l.qty, 0) * 100) / 100;
  return { errors, order: { lines, customer, phone, customerPhone: normalizePhone(phone), pickup, total } };
}

export function buildOrderFromItems(shop, items) {
  const byId = new Map((shop.menu ?? []).flatMap((c) => c.items).map((i) => [i.id, i]));
  const lines = [];
  const unavailable = [];
  for (const requested of Array.isArray(items) ? items.slice(0, 30) : []) {
    const item = byId.get(requested?.id);
    const qty = Number.parseInt(requested?.qty, 10);
    if (!item || !Number.isInteger(qty) || qty < 1) continue;
    if (!item.available || item.price === null) unavailable.push(item.name);
    else lines.push({ id: item.id, name: item.name, price: item.price, qty: Math.min(qty, 50) });
  }
  const total = Math.round(lines.reduce((sum, l) => sum + l.price * l.qty, 0) * 100) / 100;
  return { lines, unavailable, total };
}

export const formatPrice = (price) => (price === null || price === undefined ? "" : `${price.toFixed(2).replace(".", ",")} €`);

export const orderLines = (order) => order.lines.map((l) => `${l.qty} x ${l.name}  ${formatPrice(l.price * l.qty)}`).join("\n");

const SHOP_CODE = /\b([a-z0-9]+(?:-[a-z0-9]+)*-[a-f0-9]{4})\b/i;

const DIRECTORY_CODE = /\s([a-z0-9]+(?:-[a-z0-9]+)+)\s*$/;

export function extractShopCode(text) {
  if (typeof text !== "string") return null;
  const match = text.match(SHOP_CODE);
  if (match && isValidSlug(match[1].toLowerCase())) return match[1].toLowerCase();
  const firstLine = text.split("\n")[0];
  const directory = ` ${firstLine}`.match(DIRECTORY_CODE);
  if (!directory || !isValidSlug(directory[1])) return null;
  const nameSlug = firstLine.slice(0, firstLine.lastIndexOf(directory[1])).normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
  return nameSlug.length >= 3 && (nameSlug.includes(directory[1]) || directory[1].startsWith(nameSlug)) ? directory[1] : null;
}

export const normalizeName = (name) =>
  clean(name, 80)
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

export function itemsBackInStock(previousMenu = [], nextMenu = []) {
  const before = new Map(previousMenu.flatMap((c) => c.items).map((i) => [normalizeName(i.name), i.available]));
  return nextMenu
    .flatMap((c) => c.items)
    .filter((i) => i.available && before.get(normalizeName(i.name)) !== true)
    .map((i) => i.name);
}
