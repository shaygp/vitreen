import { getShop } from "./aws.mjs";

const SUPABASE_URL = (process.env.SUPABASE_URL ?? "").replace(/\/$/, "");
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY ?? "";
const DIRECTORY_OWNER = (process.env.DIRECTORY_OWNER_WA_ID ?? "").replace(/\D/g, "");
const SITE_URL = (process.env.SITE_URL ?? "").replace(/\/$/, "");
const DAYS = { fr: ["dimanche", "lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi"], en: ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] };

export const directoryEnabled = () => Boolean(SUPABASE_URL && SUPABASE_ANON_KEY && DIRECTORY_OWNER);

async function rest(path, init = {}) {
  const response = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...init,
    headers: { apikey: SUPABASE_ANON_KEY, authorization: `Bearer ${SUPABASE_ANON_KEY}`, "content-type": "application/json", ...(init.headers ?? {}) },
    signal: AbortSignal.timeout(8000),
  });
  if (!response.ok) throw new Error(`directory ${response.status}`);
  return response.json();
}

const hm = (time) => time.slice(0, 5).replace(":", "h");

export function hoursText(rows, lang = "fr") {
  return [1, 2, 3, 4, 5, 6, 0]
    .map((day) => {
      const row = rows.find((r) => r.day_of_week === day);
      const label = DAYS[lang][day];
      if (!row || row.is_closed || !row.opens_at || !row.closes_at) return `${label} ${lang === "fr" ? "fermé" : "closed"}`;
      return `${label} ${hm(row.opens_at)} ${lang === "fr" ? "à" : "to"} ${hm(row.closes_at)}`;
    })
    .join(", ");
}

export function toAgentShop(row, categories, products, hours) {
  const byCategory = categories.map((c) => ({
    name: c.name,
    items: products.filter((p) => p.category_id === c.id).map((p) => ({ id: p.id, name: p.name, price: p.price_cents / 100, available: p.is_available !== false, description: p.description ?? "" })),
  }));
  const loose = products.filter((p) => !categories.some((c) => c.id === p.category_id));
  if (loose.length) byCategory.push({ name: "Menu", items: loose.map((p) => ({ id: p.id, name: p.name, price: p.price_cents / 100, available: p.is_available !== false, description: p.description ?? "" })) });
  return {
    slug: row.slug,
    name: row.name,
    tagline: row.description ?? "",
    address: row.address ?? "",
    hours: hoursText(hours),
    menu: byCategory.filter((c) => c.items.length),
    lang: "fr",
    timeZone: "Europe/Paris",
    ownerWaId: DIRECTORY_OWNER,
    pageUrl: SITE_URL ? `${SITE_URL}/s/${row.slug}` : "",
    source: "directory",
    directoryId: row.id,
  };
}

export async function fetchDirectoryShop(slug) {
  if (!directoryEnabled() || !/^[a-z0-9-]{3,48}$/.test(slug)) return null;
  const [row] = await rest(`shops?select=id,slug,name,description,address&slug=eq.${slug}&is_published=eq.true&limit=1`);
  if (!row) return null;
  const [categories, products, hours] = await Promise.all([
    rest(`categories?select=id,name,position&shop_id=eq.${row.id}&order=position`),
    rest(`products?select=id,category_id,name,description,price_cents,is_available&shop_id=eq.${row.id}&order=position`),
    rest(`opening_hours?select=day_of_week,opens_at,closes_at,is_closed&shop_id=eq.${row.id}`),
  ]);
  return toAgentShop(row, categories, products, hours);
}

export async function findShop(slug) {
  const own = await getShop(slug);
  if (own) return own;
  try {
    return await fetchDirectoryShop(slug);
  } catch (error) {
    console.error(JSON.stringify({ level: "warn", event: "directory_unavailable", slug, error: error.message }));
    return null;
  }
}

function parisDate(hour, minute, now = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Paris", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(now).map((p) => [p.type, p.value]));
  const offset = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute) - Math.floor(now.getTime() / 60000) * 60000;
  const target = Date.UTC(+parts.year, +parts.month - 1, +parts.day, hour, minute) - offset;
  return new Date(target < now.getTime() ? target + 86400000 : target);
}

export function pickupIso(text, now = new Date()) {
  const match = String(text ?? "").match(/\b(\d{1,2})\s*(?:h|:)\s*(\d{2})?/i);
  if (match && +match[1] < 24 && +(match[2] ?? 0) < 60) return parisDate(+match[1], +(match[2] ?? 0), now).toISOString();
  return new Date(now.getTime() + 30 * 60000).toISOString();
}

export async function mirrorOrder(shop, order) {
  if (shop.source !== "directory") return null;
  const items = order.lines.filter((l) => l.id).map((l) => ({ product_id: l.id, quantity: Math.min(l.qty, 20) }));
  if (!items.length) return null;
  const [created] = await rest("rpc/create_public_order", {
    method: "POST",
    body: JSON.stringify({
      p_shop_id: shop.directoryId,
      p_first_name: (order.customer || "WhatsApp").slice(0, 80),
      p_phone: `+${order.customerWaId ?? ""}`.slice(0, 40),
      p_pickup_time: pickupIso(order.pickup),
      p_items: items,
    }),
  });
  return created ?? null;
}
