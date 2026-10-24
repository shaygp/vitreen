import QRCode from "qrcode";
import { countRecentOrders, getConversation, getShop, photoUrl, saveConversation, sendEmail } from "./lib/aws.mjs";
import { PAGE_LABELS } from "./lib/i18n.mjs";
import { placeOrder } from "./lib/orders.mjs";
import { renderConfirmation, renderMessage, renderQrPoster, renderReceipt, renderShop, SECURITY_HEADERS } from "./lib/render.mjs";
import { buildOrder, isValidEmail, isValidSlug } from "./lib/shop.mjs";

const MAX_BODY_BYTES = 8192;
const MAX_ORDERS_PER_10_MIN = 30;
const BUSINESS_PHONE = (process.env.BUSINESS_PHONE ?? "").replace(/\D/g, "");

const respond = (statusCode, body, headers = {}) => ({ statusCode, headers: { ...SECURITY_HEADERS, vary: "accept-language", ...headers }, body });
const visitorLanguage = (event) => (/^\s*fr\b/i.test(event.headers?.["accept-language"] ?? "") ? "fr" : "en");

const COPY = {
  fr: {
    notFound: ["Page introuvable", "Ce commerce n'existe pas ou n'est plus en ligne."],
    tooLong: ["Commande trop longue", "Réduisez votre commande et réessayez."],
    thanks: ["Merci", "Votre demande a bien été reçue."],
    busy: ["Trop de commandes", "Le commerce reçoit beaucoup de commandes. Réessayez dans quelques minutes."],
    failed: ["Commande non transmise", "Le commerce n'a pas pu être prévenu. Appelez-le pour commander."],
    notAllowed: ["Action impossible", "Cette action n'est pas disponible."],
    home: ["Vitreen", "Envoyez une photo de votre ardoise sur WhatsApp et votre commerce est en ligne en une minute."],
  },
  en: {
    notFound: ["Page not found", "This shop does not exist or is no longer online."],
    tooLong: ["Order too long", "Make your order smaller and try again."],
    thanks: ["Thank you", "Your request has been received."],
    busy: ["Too many orders", "The shop is receiving a lot of orders. Please try again in a few minutes."],
    failed: ["Order not sent", "The shop could not be reached. Please call them to order."],
    notAllowed: ["Not available", "This action is not available."],
    home: ["Vitreen", "Send a photo of your chalkboard on WhatsApp and your shop is online in a minute."],
  },
};
const whatsAppUrl = (shop) => (BUSINESS_PHONE ? `https://wa.me/${BUSINESS_PHONE}?text=${encodeURIComponent(`${shop.name} ${shop.slug}`)}` : "");

async function linkConversation(phone, slug) {
  const conversation = await getConversation(phone);
  await saveConversation(phone, { ...conversation, slug, history: conversation?.slug === slug ? conversation.history ?? [] : [] });
}

function readForm(event) {
  const raw = event.body ? (event.isBase64Encoded ? Buffer.from(event.body, "base64").toString("utf8") : event.body) : "";
  if (Buffer.byteLength(raw) > MAX_BODY_BYTES) return null;
  return Object.fromEntries(new URLSearchParams(raw));
}

export async function handler(event) {
  const method = event.requestContext?.http?.method ?? "GET";
  const path = event.rawPath ?? "/";
  const lang = visitorLanguage(event);
  const say = (key) => renderMessage(...COPY[lang][key], lang);
  const notFound = () => respond(404, say("notFound"));

  if (method === "GET" && path === "/") {
    return respond(200, say("home"));
  }

  const match = path.match(/^\/s\/([^/]+)(?:\/(order|qr))?\/?$/);
  if (!match || !isValidSlug(match[1])) return notFound();
  const shop = await getShop(match[1]);
  if (!shop) return notFound();
  const view = { ...shop, lang };
  const action = match[2];

  if (method === "GET" && action === "qr") {
    const link = whatsAppUrl(shop);
    if (!link) return notFound();
    const svg = await QRCode.toString(link, { type: "svg", errorCorrectionLevel: "M", margin: 1, color: { dark: "#1E1712", light: "#FFFFFF" } });
    return respond(200, renderQrPoster(view, svg));
  }

  const photo = await photoUrl(shop.photoKey);
  if (method === "GET" && !action) {
    return respond(200, renderShop(view, { photoUrl: photo, whatsAppUrl: whatsAppUrl(shop) }), { "cache-control": "public, max-age=30" });
  }

  if (method === "POST" && action === "order") {
    const form = readForm(event);
    if (!form) return respond(413, say("tooLong"));
    if (form.website) return respond(200, say("thanks"));

    const { errors, order } = buildOrder(shop, form);
    if (errors.length) return respond(400, renderShop(view, { photoUrl: photo, whatsAppUrl: whatsAppUrl(shop), errors, values: form }));

    const since = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    if ((await countRecentOrders(shop.slug, since)) >= MAX_ORDERS_PER_10_MIN) {
      return respond(429, say("busy"));
    }

    try {
      const { customerPhone, ...rest } = order;
      await placeOrder(shop, { ...rest, customer: `${order.customer}, ${order.phone}`, customerWaId: customerPhone, lang, channel: "web" });
    } catch (error) {
      console.error(JSON.stringify({ level: "error", slug: shop.slug, name: error.name, error: error.message }));
      return respond(502, say("failed"));
    }
    await linkConversation(order.customerPhone, shop.slug).catch((error) =>
      console.error(JSON.stringify({ level: "warn", event: "conversation_link_failed", slug: shop.slug, name: error.name })),
    );
    const email = (form.email ?? "").trim().toLowerCase();
    if (email && isValidEmail(email)) {
      await sendEmail({ to: email, ...renderReceipt(view, order, PAGE_LABELS[lang].pickup) }).catch((error) =>
        console.error(JSON.stringify({ level: "warn", event: "receipt_failed", slug: shop.slug, name: error.name })),
      );
    }
    return respond(200, renderConfirmation(view, order));
  }

  return respond(405, say("notAllowed"), { allow: "GET, POST" });
}
