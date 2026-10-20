import { runCustomerAgent } from "./lib/agent.mjs";
import { editShop, readPhoto } from "./lib/ai.mjs";
import {
  addToWaitlist,
  claimMessage,
  createShop,
  downloadWhatsAppImage,
  getConversation,
  getShop,
  getShopByOwner,
  recordDemand,
  saveConversation,
  saveShop,
  sendWhatsAppText,
  takeWaitlist,
} from "./lib/aws.mjs";
import { parseWhatsAppMessages } from "./lib/events.mjs";
import { languageFor, t } from "./lib/i18n.mjs";
import { handleOrderButton, placeOrder } from "./lib/orders.mjs";
import { buildOrderFromItems, clean, extractShopCode, itemsBackInStock, normalizeName, sanitizeDetails, sanitizeMenu, slugify } from "./lib/shop.mjs";

const baseUrl = () => process.env.PAGE_URL.replace(/\/$/, "");
const pageUrl = (slug) => `${baseUrl()}/s/${slug}`;
const qrUrl = (slug) => `${baseUrl()}/s/${slug}/qr`;
const MAX_IMAGE_BYTES = 3_750_000;
const TIME_ZONES = { fr: "Europe/Paris", en: "America/New_York" };

const snapshot = ({ name, tagline, hours, address, menu, photoKey }) => ({ name, tagline, hours, address, menu, photoKey });
const productCount = (menu) => menu.reduce((sum, c) => sum + c.items.length, 0);

async function notifyWaitlist(shop, names) {
  const m = t(shop.lang);
  const notes = [];
  for (const name of names.slice(0, 20)) {
    const waiting = await takeWaitlist(shop.slug, normalizeName(name));
    for (const entry of waiting) {
      await sendWhatsAppText(entry.waId, t(entry.lang ?? shop.lang).backInStock(name, shop.name, pageUrl(shop.slug))).catch((error) =>
        console.error(JSON.stringify({ level: "warn", event: "waitlist_send_failed", name: error.name })),
      );
    }
    if (waiting.length) notes.push(m.waitlistNotified(waiting.length, name));
  }
  return notes;
}

async function handleOwnerImage(message, shop, lang) {
  const m = t(lang);
  const key = `shops/${message.from}/${message.id}`;
  const image = await downloadWhatsAppImage(message.imageId, key);
  if (image.bytes.length > MAX_IMAGE_BYTES) return sendWhatsAppText(message.from, m.tooHeavy);

  const reading = await readPhoto(image, message.caption, lang);
  const details = sanitizeDetails(reading);
  const menu = sanitizeMenu(reading.categories, shop?.menu, m.defaultCategory);

  if (!shop) {
    const name = details.name || m.defaultName;
    const created = {
      slug: slugify(name),
      ownerWaId: message.from,
      lang,
      timeZone: TIME_ZONES[lang],
      ...details,
      name,
      menu: reading.kind === "menu" ? menu : [],
      photoKey: reading.kind === "storefront" ? key : null,
      createdAt: new Date().toISOString(),
    };
    await createShop(created);
    const count = productCount(created.menu);
    const first = count ? m.created(count, pageUrl(created.slug)) : m.createdEmpty(pageUrl(created.slug));
    return sendWhatsAppText(message.from, `${first}\n\n${m.howTo(qrUrl(created.slug))}`);
  }

  const updated = { ...shop, previous: snapshot(shop) };
  if (reading.kind === "menu" && menu.length) {
    updated.menu = menu;
    for (const field of ["hours", "address"]) if (details[field]) updated[field] = details[field];
  } else if (reading.kind === "storefront") {
    updated.photoKey = key;
  } else {
    return sendWhatsAppText(message.from, m.notRecognised);
  }
  await saveShop(updated);
  const notes = reading.kind === "menu" ? await notifyWaitlist(updated, itemsBackInStock(shop.menu, updated.menu)) : [];
  const what = reading.kind === "menu" ? m.menuUpdated(productCount(menu)) : m.photoAdded;
  return sendWhatsAppText(message.from, [what, ...notes, pageUrl(shop.slug)].join("\n"));
}

async function handleOwnerText(message, shop, lang) {
  const m = t(lang);
  const text = message.text.trim();
  if (/^(annuler|annule|undo)\b/i.test(text)) {
    if (!shop.previous) return sendWhatsAppText(message.from, m.nothingToUndo);
    await saveShop({ ...shop, ...shop.previous, previous: null });
    return sendWhatsAppText(message.from, m.undone(pageUrl(shop.slug)));
  }
  if (/^(lien|page|link)\b/i.test(text)) return sendWhatsAppText(message.from, pageUrl(shop.slug));
  if (/^(qr|qr code)\b/i.test(text)) return sendWhatsAppText(message.from, qrUrl(shop.slug));

  const result = await editShop(shop, text.slice(0, 1500), lang);
  const changes = Array.isArray(result.changes) ? result.changes.filter((c) => typeof c === "string" && c.trim()).slice(0, 10) : [];
  if (!changes.length) return sendWhatsAppText(message.from, result.reply?.trim() || m.noChange);

  const details = sanitizeDetails(result);
  const updated = {
    ...shop,
    previous: snapshot(shop),
    name: details.name || shop.name,
    tagline: details.tagline,
    hours: details.hours,
    address: details.address,
    menu: sanitizeMenu(result.categories, shop.menu, m.defaultCategory),
  };
  await saveShop(updated);
  const notes = await notifyWaitlist(updated, itemsBackInStock(shop.menu, updated.menu));
  const summary = changes.map((c) => `- ${c}`).join("\n") + (notes.length ? `\n${notes.join("\n")}` : "");
  return sendWhatsAppText(message.from, m.done(summary, pageUrl(shop.slug)));
}

async function handleCustomer(message, slug, conversation) {
  const shop = await getShop(slug);
  if (!shop) {
    await saveConversation(message.from, { slug: null, history: [] });
    return sendWhatsAppText(message.from, t(languageFor(message.from)).welcome);
  }
  const lang = languageFor(message.from);
  const history = conversation?.slug === slug ? conversation.history ?? [] : [];
  const now = new Intl.DateTimeFormat("en-GB", { timeZone: shop.timeZone ?? "Europe/Paris", weekday: "long", hour: "2-digit", minute: "2-digit" }).format(new Date());
  const userText = message.type === "text" ? message.text.slice(0, 1500) : "(the customer sent a message that is not text)";

  const { reply, history: nextHistory } = await runCustomerAgent({
    shop,
    history,
    userText,
    now,
    handlers: {
      place_order: async ({ items, customer_name, pickup_time }) => {
        const { lines, unavailable, total } = buildOrderFromItems(shop, items);
        if (!lines.length) return { error: "no orderable items", unavailable };
        const order = await placeOrder(shop, {
          lines,
          total,
          customer: clean(customer_name, 60) || message.contactName || "Client",
          pickup: clean(pickup_time, 40),
          customerWaId: message.from,
          lang,
          channel: "whatsapp",
        });
        return { status: "sent to the shop, waiting for the owner to accept", total: order.total, unavailable };
      },
      notify_when_available: async ({ product }) => {
        const name = clean(product, 80);
        if (!name) return { error: "missing product" };
        await addToWaitlist(shop.slug, normalizeName(name), name, message.from, lang);
        await recordDemand(shop.slug, "waitlist", name);
        return { status: "customer will get a WhatsApp message when it is back" };
      },
      pass_question_to_shop: async ({ question }) => {
        const detail = clean(question, 300);
        await recordDemand(shop.slug, "question", detail);
        await sendWhatsAppText(shop.ownerWaId, t(shop.lang).customerQuestion(message.contactName || message.from, detail));
        return { status: "passed to the owner, who will reply on WhatsApp" };
      },
    },
  });
  await saveConversation(message.from, { slug, history: nextHistory });
  if (reply) await sendWhatsAppText(message.from, reply);
}

async function route(message) {
  const lang = languageFor(message.from);
  if (message.buttonId) {
    if (await handleOrderButton(message.from, message.buttonId)) return;
  }
  const code = message.type === "text" ? extractShopCode(message.text) : null;
  const ownShop = await getShopByOwner(message.from);
  if (ownShop && (!code || code === ownShop.slug)) {
    const ownerLang = ownShop.lang ?? lang;
    if (message.type === "image" && message.imageId) return handleOwnerImage(message, ownShop, ownerLang);
    if (message.type === "text") return handleOwnerText(message, ownShop, ownerLang);
    return sendWhatsAppText(message.from, t(ownerLang).voice);
  }
  if (code) return handleCustomer(message, code, await getConversation(message.from));
  const conversation = await getConversation(message.from);
  if (conversation?.slug && message.type !== "image") return handleCustomer(message, conversation.slug, conversation);
  if (message.type === "image" && message.imageId) return handleOwnerImage(message, null, lang);
  if (message.type === "audio") return sendWhatsAppText(message.from, t(lang).voice);
  return sendWhatsAppText(message.from, t(lang).welcome);
}

export async function handler(event) {
  for (const message of parseWhatsAppMessages(event)) {
    if (!(await claimMessage(message.id))) continue;
    try {
      await route(message);
    } catch (error) {
      console.error(JSON.stringify({ level: "error", messageId: message.id, name: error.name, error: error.message }));
      await sendWhatsAppText(message.from, t(languageFor(message.from)).error).catch(() => {});
    }
  }
}
