import assert from "node:assert/strict";
import { beforeEach, mock, test } from "node:test";

process.env.PAGE_URL = "https://pages.example/";

const db = new Map();
const sent = [];
const demand = [];
const emails = [];
const texts = [];
let modelScript = [];
let textEnabled = false;
let transcript = "";
const whatsAppClosedFor = new Set();
const testers = new Map();
let rcsAgent = "";

const awsMock = {
  getShop: async (slug) => db.get(`SHOP#${slug}`) ?? null,
  getShopByOwner: async (waId) => {
    const slug = db.get(`OWNER#${waId}`);
    return slug ? db.get(`SHOP#${slug}`) : null;
  },
  createShop: async (shop) => {
    db.set(`SHOP#${shop.slug}`, shop);
    db.set(`OWNER#${shop.ownerWaId}`, shop.slug);
  },
  saveShop: async (shop) => db.set(`SHOP#${shop.slug}`, shop),
  createOrder: async (slug, order) => {
    const item = { ...order, id: "a1b2c3d4e5", slug, status: "pending" };
    db.set("ORDER#a1b2c3d4e5", item);
    return item;
  },
  getOrder: async (id) => db.get(`ORDER#${id}`) ?? null,
  moveOrder: async (id, from, to) => {
    const order = db.get(`ORDER#${id}`);
    if (!order || order.status !== from) return false;
    order.status = to;
    return true;
  },
  getConversation: async (waId) => db.get(`CONV#${waId}`) ?? null,
  saveConversation: async (waId, c) => db.set(`CONV#${waId}`, c),
  addToWaitlist: async (slug, key, name, waId, lang) => db.set(`WAIT#${slug}#${key}#${waId}`, { itemName: name, waId, lang }),
  takeWaitlist: async (slug, key) => {
    const prefix = `WAIT#${slug}#${key}#`;
    const found = [...db.entries()].filter(([k]) => k.startsWith(prefix));
    for (const [k] of found) db.delete(k);
    return found.map(([, v]) => v);
  },
  recordDemand: async (slug, kind, detail) => demand.push({ slug, kind, detail }),
  registerDigest: async (slug) => db.set(`DIGEST#${slug}`, true),
  listDemandSince: async (slug) => demand.filter((d) => d.slug === slug),
  listOrdersSince: async () => [{ id: "a1b2c3d4e5", total: 9, channel: "whatsapp" }],
  sendEmail: async (email) => emails.push(email),
  claimMessage: async (id) => {
    if (db.has(`MSG#${id}`)) return false;
    db.set(`MSG#${id}`, true);
    return true;
  },
  sendWhatsAppText: async (to, body) => sent.push({ to, body }),
  sendWhatsAppButtons: async (to, body, buttons) => {
    if (whatsAppClosedFor.has(to)) throw Object.assign(new Error("Re-engagement message"), { name: "ValidationException" });
    sent.push({ to, body, buttons });
  },
  sendTextMessage: async (to, body) => texts.push({ to, body }),
  textChannelEnabled: () => textEnabled,
  rcsAgentId: () => rcsAgent,
  rcsTesterStatus: async (phone) => testers.get(phone) ?? null,
  inviteRcsTester: async (phone) => {
    testers.set(phone, "PENDING");
    return "PENDING";
  },
  saveWhatsAppMedia: async () => ({ mimeType: "audio/ogg; codecs=opus", fileSize: 12000 }),
  transcribeAudio: async () => transcript,
  downloadWhatsAppImage: async () => ({ bytes: new Uint8Array(10), mimeType: "image/jpeg" }),
  photoUrl: async () => "",
  countRecentOrders: async () => 0,
  converse: async () => modelScript.shift(),
  callTool: async () => modelScript.shift(),
};

mock.module("../src/lib/aws.mjs", { namedExports: awsMock });
const { handler } = await import("../src/inbound.mjs");
const { handler: pageHandler } = await import("../src/page.mjs");

const OWNER = "33600000001";
const CUSTOMER = "15550000002";
let counter = 0;
const message = (from, payload) => ({
  Records: [{ Sns: { Message: JSON.stringify({ whatsAppWebhookEntry: JSON.stringify({ changes: [{ value: { messages: [{ id: `w${++counter}`, from, ...payload }] } }] }) }) } }],
});
const toolCall = (name, input) => ({ stopReason: "tool_use", output: { message: { role: "assistant", content: [{ toolUse: { toolUseId: `t${counter}`, name, input } }] } } });
const say = (text) => ({ stopReason: "end_turn", output: { message: { role: "assistant", content: [{ text }] } } });

const textMessage = (from, body, extra = {}) => ({
  Records: [{ Sns: { Message: JSON.stringify({ originationNumber: `+${from}`, destinationNumber: "rcs-agent", messageBody: body, inboundMessageId: `r${++counter}`, ...extra }) } }],
});

beforeEach(() => {
  sent.length = 0;
  texts.length = 0;
  modelScript = [];
  textEnabled = false;
  transcript = "";
  whatsAppClosedFor.clear();
  rcsAgent = "";
});

test("a shop owner creates her page from one photo", async () => {
  modelScript = [
    {
      kind: "menu",
      name: "Boulangerie Martin",
      tagline: "Pain au levain",
      hours: "7h-20h",
      address: "",
      categories: [{ name: "Viennoiseries", items: [{ name: "Croissant", price: 1.2, available: true }, { name: "Flan pistache", price: 4.5, available: false }] }],
    },
  ];
  await handler(message(OWNER, { type: "image", image: { id: "media1", mime_type: "image/jpeg" } }));
  assert.equal(sent.length, 1);
  assert.match(sent[0].body, /J'ai lu 2 produits/);
  assert.match(sent[0].body, /\/qr/);
});

test("a customer scans the QR code, asks for a sold out product and joins the waitlist", async () => {
  const slug = db.get(`OWNER#${OWNER}`);
  modelScript = [toolCall("notify_when_available", { product: "Flan pistache" }), say("The pistachio flan is sold out today. I'll message you when it's back.")];
  await handler(message(CUSTOMER, { type: "text", text: { body: `Boulangerie Martin ${slug}\nDo you have pistachio flan?` } }));
  assert.equal(sent.at(-1).to, CUSTOMER);
  assert.match(sent.at(-1).body, /sold out/);
  assert.equal(db.get(`CONV#${CUSTOMER}`).slug, slug);
});

test("the owner says the flan is back and the waiting customer is notified", async () => {
  const shop = db.get(`SHOP#${db.get(`OWNER#${OWNER}`)}`);
  modelScript = [
    {
      changes: ["Flan pistache de retour"],
      reply: "",
      name: shop.name,
      tagline: shop.tagline,
      hours: shop.hours,
      address: shop.address,
      categories: [{ name: "Viennoiseries", items: [{ name: "Croissant", price: 1.2, available: true }, { name: "Flan pistache", price: 4.5, available: true }] }],
    },
  ];
  await handler(message(OWNER, { type: "text", text: { body: "le flan pistache est de retour" } }));
  const toCustomer = sent.find((s) => s.to === CUSTOMER);
  assert.match(toCustomer.body, /Good news: Flan pistache is back/);
  assert.match(sent.find((s) => s.to === OWNER).body, /1 client attendait Flan pistache/);
});

test("the customer orders, the owner accepts then marks it ready", async () => {
  const shop = db.get(`SHOP#${db.get(`OWNER#${OWNER}`)}`);
  const flanId = shop.menu[0].items.find((i) => i.name === "Flan pistache").id;
  modelScript = [toolCall("place_order", { items: [{ id: flanId, qty: 2 }], customer_name: "Sam", pickup_time: "6pm" }), say("Sent to the shop, 9.00 € to pay at pickup.")];
  await handler(message(CUSTOMER, { type: "text", text: { body: "Yes, 2 flans for Sam at 6pm" } }));
  const toOwner = sent.find((s) => s.to === OWNER);
  assert.match(toOwner.body, /2 x Flan pistache/);
  assert.deepEqual(toOwner.buttons.map((b) => b.id), ["acc:a1b2c3d4e5", "rej:a1b2c3d4e5"]);

  sent.length = 0;
  await handler(message(OWNER, { type: "interactive", interactive: { type: "button_reply", button_reply: { id: "acc:a1b2c3d4e5" } } }));
  assert.match(sent.find((s) => s.to === CUSTOMER).body, /accepted your order/);

  sent.length = 0;
  await handler(message(OWNER, { type: "interactive", interactive: { type: "button_reply", button_reply: { id: "rdy:a1b2c3d4e5" } } }));
  assert.match(sent.find((s) => s.to === CUSTOMER).body, /is ready/);
});

test("a stranger cannot accept someone else's order", async () => {
  db.get("ORDER#a1b2c3d4e5").status = "pending";
  modelScript = [say("Hi!")];
  await handler(message("15550000099", { type: "interactive", interactive: { type: "button_reply", button_reply: { id: "acc:a1b2c3d4e5" } } }));
  assert.equal(db.get("ORDER#a1b2c3d4e5").status, "pending");
  assert.ok(!sent.some((s) => s.to === CUSTOMER));
});

test("the same WhatsApp message delivered twice is handled once", async () => {
  const event = message(CUSTOMER, { type: "text", text: { body: "hello" } });
  modelScript = [say("Hello!"), say("Hello again!")];
  await handler(event);
  await handler(event);
  assert.equal(sent.length, 1);
});

test("the owner registers her email and gets the weekly report on demand", async () => {
  modelScript = [];
  await handler(message(OWNER, { type: "text", text: { body: "email not-an-email" } }));
  assert.match(sent.at(-1).body, /pas reconnu/);

  await handler(message(OWNER, { type: "text", text: { body: "email Marie@Boulangerie.fr" } }));
  assert.match(sent.at(-1).body, /marie@boulangerie.fr/);

  modelScript = [{ insights: ["Le flan pistache a été demandé alors qu'il était épuisé."], suggestion: "Prévoir plus de flans le samedi." }];
  await handler(message(OWNER, { type: "text", text: { body: "rapport" } }));
  assert.equal(emails.length, 1);
  assert.equal(emails[0].to, "marie@boulangerie.fr");
  assert.match(emails[0].text, /Flan pistache  1/);
  assert.match(emails[0].text, /Prévoir plus de flans/);
  assert.match(sent.at(-1).body, /Rapport envoyé/);
});

test("a customer who went quiet on WhatsApp for two days is told over RCS that the order is ready", async () => {
  textEnabled = true;
  const conversation = db.get(`CONV#${CUSTOMER}`);
  conversation.lastInboundAt = new Date(Date.now() - 2 * 86400000).toISOString();
  db.get("ORDER#a1b2c3d4e5").status = "accepted";
  await handler(message(OWNER, { type: "interactive", interactive: { type: "button_reply", button_reply: { id: "rdy:a1b2c3d4e5" } } }));
  assert.ok(!sent.some((s) => s.to === CUSTOMER));
  assert.equal(texts.length, 1);
  assert.equal(texts[0].to, CUSTOMER);
  assert.match(texts[0].body, /is ready/);
});

test("the customer answers the RCS message and the agent picks up the same conversation", async () => {
  textEnabled = true;
  const slug = db.get(`OWNER#${OWNER}`);
  modelScript = [say("Yes, there are still pistachio flans today.")];
  await handler(textMessage(CUSTOMER, "Any flan left?"));
  assert.equal(sent.length, 0);
  assert.match(texts.at(-1).body, /pistachio flans/);
  const conversation = db.get(`CONV#${CUSTOMER}`);
  assert.equal(conversation.slug, slug);
  assert.equal(conversation.channel, "rcs");
  assert.ok(conversation.history.some((h) => h.text === "Any flan left?"));
});

test("RCS typing notifications are not treated as messages", async () => {
  await handler(textMessage(CUSTOMER, JSON.stringify({ type: "RCS_TYPING", receivedAt: "2026-10-24T10:00:00Z" })));
  assert.equal(texts.length, 0);
  assert.equal(sent.length, 0);
});

test("a web order with a French mobile number is followed up over RCS", async () => {
  textEnabled = true;
  const shop = db.get(`SHOP#${db.get(`OWNER#${OWNER}`)}`);
  const croissant = shop.menu[0].items.find((i) => i.name === "Croissant");
  const body = new URLSearchParams({ [`q_${croissant.id}`]: "3", name: "Léa", phone: "06 12 34 56 78", pickup: "8h" }).toString();
  const response = await pageHandler({ requestContext: { http: { method: "POST" } }, headers: { "accept-language": "fr-FR,fr;q=0.9" }, rawPath: `/s/${shop.slug}/order`, body });
  assert.equal(response.statusCode, 200);
  assert.match(response.body, /Commande envoyée/);
  assert.match(sent.find((s) => s.to === OWNER).body, /3 x Croissant/);
  assert.equal(db.get("CONV#33612345678").slug, shop.slug);

  await handler(message(OWNER, { type: "interactive", interactive: { type: "button_reply", button_reply: { id: "acc:a1b2c3d4e5" } } }));
  assert.equal(texts.at(-1).to, "33612345678");
  assert.match(texts.at(-1).body, /a accepté votre commande/);
});

test("the owner updates her page with a voice note", async () => {
  transcript = "plus de croissants aujourd'hui";
  const shop = db.get(`SHOP#${db.get(`OWNER#${OWNER}`)}`);
  modelScript = [
    {
      changes: ["Croissant en rupture"],
      reply: "",
      name: shop.name,
      tagline: shop.tagline,
      hours: shop.hours,
      address: shop.address,
      categories: [{ name: "Viennoiseries", items: [{ name: "Croissant", price: 1.2, available: false }, { name: "Flan pistache", price: 4.5, available: true }] }],
    },
  ];
  await handler(message(OWNER, { type: "audio", audio: { id: "voice1", mime_type: "audio/ogg; codecs=opus" } }));
  const answer = sent.at(-1).body;
  assert.match(answer, /J'ai entendu : « plus de croissants aujourd'hui »/);
  assert.match(answer, /Croissant en rupture/);
  assert.equal(db.get(`SHOP#${shop.slug}`).menu[0].items[0].available, false);
});

test("a voice note that cannot be understood gets a clear answer", async () => {
  transcript = "";
  await handler(message(OWNER, { type: "audio", audio: { id: "voice2", mime_type: "audio/ogg" } }));
  assert.match(sent.at(-1).body, /pas réussi à écouter/);
});

test("an owner silent for a day gets the new order by text, then accepts it from WhatsApp", async () => {
  textEnabled = true;
  whatsAppClosedFor.add(OWNER);
  const shop = db.get(`SHOP#${db.get(`OWNER#${OWNER}`)}`);
  const flan = shop.menu[0].items.find((i) => i.name === "Flan pistache");
  const body = new URLSearchParams({ [`q_${flan.id}`]: "1", name: "Noé", phone: "+33 7 00 00 00 01" }).toString();
  const response = await pageHandler({ requestContext: { http: { method: "POST" } }, rawPath: `/s/${shop.slug}/order`, body });
  assert.equal(response.statusCode, 200);
  assert.equal(texts.at(-1).to, OWNER);
  assert.match(texts.at(-1).body, /écrivez "commandes"/);

  whatsAppClosedFor.clear();
  await handler(message(OWNER, { type: "text", text: { body: "commandes" } }));
  const resent = sent.find((s) => s.to === OWNER && s.buttons);
  assert.deepEqual(resent.buttons.map((b) => b.id), ["acc:a1b2c3d4e5", "rej:a1b2c3d4e5"]);
});

test("an English speaking visitor sees the Paris shop page in English", async () => {
  const shop = db.get(`SHOP#${db.get(`OWNER#${OWNER}`)}`);
  const response = await pageHandler({ requestContext: { http: { method: "GET" } }, headers: { "accept-language": "en-US,en;q=0.9" }, rawPath: `/s/${shop.slug}` });
  assert.equal(response.statusCode, 200);
  assert.match(response.body, /<html lang="en">/);
  assert.match(response.body, /Order for pickup/);
  assert.match(response.body, /Croissant/);
});

test("a judge writes RCS on WhatsApp, accepts the tester invitation and the conversation moves to RCS", async () => {
  rcsAgent = "rcs-abc123";
  textEnabled = true;
  const judge = "15550000077";
  const slug = db.get(`OWNER#${OWNER}`);
  modelScript = [say("Hi! What can I get you?")];
  await handler(message(judge, { type: "text", text: { body: `Boulangerie Martin ${slug}` } }));
  await handler(message(judge, { type: "text", text: { body: "RCS" } }));
  assert.equal(testers.get(judge), "PENDING");
  assert.match(sent.at(-1).body, /Make me a tester/);
  assert.equal(texts.length, 0);
  testers.set(judge, "VERIFIED");
  await handler(message(judge, { type: "text", text: { body: "rcs" } }));
  assert.equal(texts.at(-1).to, judge);
  assert.match(texts.at(-1).body, /Boulangerie Martin/);
  assert.match(sent.at(-1).body, /over RCS/);
  modelScript = [say("Yes, we have croissants today.")];
  await handler(textMessage(judge, "Any croissants left?"));
  assert.match(texts.at(-1).body, /croissants today/);
});

test("the RCS command is ignored when no RCS agent is configured", async () => {
  const stranger = "15550000088";
  await handler(message(stranger, { type: "text", text: { body: "RCS" } }));
  assert.equal(testers.has(stranger), false);
});
