import QRCode from "qrcode";
import { countRecentOrders, getShop, photoUrl, sendEmail } from "./lib/aws.mjs";
import { PAGE_LABELS } from "./lib/i18n.mjs";
import { placeOrder } from "./lib/orders.mjs";
import { renderConfirmation, renderMessage, renderQrPoster, renderReceipt, renderShop, SECURITY_HEADERS } from "./lib/render.mjs";
import { buildOrder, isValidEmail, isValidSlug } from "./lib/shop.mjs";

const MAX_BODY_BYTES = 8192;
const MAX_ORDERS_PER_10_MIN = 30;
const BUSINESS_PHONE = (process.env.BUSINESS_PHONE ?? "").replace(/\D/g, "");

const respond = (statusCode, body, headers = {}) => ({ statusCode, headers: { ...SECURITY_HEADERS, ...headers }, body });
const notFound = () => respond(404, renderMessage("Page introuvable", "Ce commerce n'existe pas ou n'est plus en ligne."));
const whatsAppUrl = (shop) => (BUSINESS_PHONE ? `https://wa.me/${BUSINESS_PHONE}?text=${encodeURIComponent(`${shop.name} ${shop.slug}`)}` : "");

function readForm(event) {
  const raw = event.body ? (event.isBase64Encoded ? Buffer.from(event.body, "base64").toString("utf8") : event.body) : "";
  if (Buffer.byteLength(raw) > MAX_BODY_BYTES) return null;
  return Object.fromEntries(new URLSearchParams(raw));
}

export async function handler(event) {
  const method = event.requestContext?.http?.method ?? "GET";
  const path = event.rawPath ?? "/";

  if (method === "GET" && path === "/") {
    return respond(200, renderMessage("Vitrine", "Send a photo of your chalkboard on WhatsApp and your shop is online in a minute."));
  }

  const match = path.match(/^\/s\/([^/]+)(?:\/(order|qr))?\/?$/);
  if (!match || !isValidSlug(match[1])) return notFound();
  const shop = await getShop(match[1]);
  if (!shop) return notFound();
  const action = match[2];

  if (method === "GET" && action === "qr") {
    const link = whatsAppUrl(shop);
    if (!link) return notFound();
    const svg = await QRCode.toString(link, { type: "svg", errorCorrectionLevel: "M", margin: 1, color: { dark: "#1E1712", light: "#FFFFFF" } });
    return respond(200, renderQrPoster(shop, svg));
  }

  const photo = await photoUrl(shop.photoKey);
  if (method === "GET" && !action) {
    return respond(200, renderShop(shop, { photoUrl: photo, whatsAppUrl: whatsAppUrl(shop) }), { "cache-control": "public, max-age=30" });
  }

  if (method === "POST" && action === "order") {
    const form = readForm(event);
    if (!form) return respond(413, renderMessage("Commande trop longue", "Réduisez votre commande et réessayez."));
    if (form.website) return respond(200, renderMessage("Merci", "Votre demande a bien été reçue."));

    const { errors, order } = buildOrder(shop, form);
    if (errors.length) return respond(400, renderShop(shop, { photoUrl: photo, whatsAppUrl: whatsAppUrl(shop), errors, values: form }));

    const since = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    if ((await countRecentOrders(shop.slug, since)) >= MAX_ORDERS_PER_10_MIN) {
      return respond(429, renderMessage("Trop de commandes", "Le commerce reçoit beaucoup de commandes. Réessayez dans quelques minutes."));
    }

    try {
      await placeOrder(shop, { ...order, customer: `${order.customer}, ${order.phone}`, channel: "web" });
    } catch (error) {
      console.error(JSON.stringify({ level: "error", slug: shop.slug, name: error.name, error: error.message }));
      return respond(502, renderMessage("Commande non transmise", "Le commerce n'a pas pu être prévenu. Appelez-le pour commander."));
    }
    const email = (form.email ?? "").trim().toLowerCase();
    if (email && isValidEmail(email)) {
      const labels = PAGE_LABELS[shop.lang] ?? PAGE_LABELS.fr;
      await sendEmail({ to: email, ...renderReceipt(shop, order, labels.pickup) }).catch((error) =>
        console.error(JSON.stringify({ level: "warn", event: "receipt_failed", slug: shop.slug, name: error.name })),
      );
    }
    return respond(200, renderConfirmation(shop, order));
  }

  return respond(405, renderMessage("Action impossible", "Cette action n'est pas disponible."), { allow: "GET, POST" });
}
