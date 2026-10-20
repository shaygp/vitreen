import assert from "node:assert/strict";
import { beforeEach, mock, test } from "node:test";

process.env.PAGE_URL = "https://pages.example/";

const db = new Map();
const sent = [];
let modelScript = [];

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
  recordDemand: async () => {},
  claimMessage: async (id) => {
    if (db.has(`MSG#${id}`)) return false;
    db.set(`MSG#${id}`, true);
    return true;
  },
  sendWhatsAppText: async (to, body) => sent.push({ to, body }),
  sendWhatsAppButtons: async (to, body, buttons) => sent.push({ to, body, buttons }),
  downloadWhatsAppImage: async () => ({ bytes: new Uint8Array(10), mimeType: "image/jpeg" }),
  photoUrl: async () => "",
  countRecentOrders: async () => 0,
  converse: async () => modelScript.shift(),
  callTool: async () => modelScript.shift(),
};

mock.module("../src/lib/aws.mjs", { namedExports: awsMock });
const { handler } = await import("../src/inbound.mjs");

const OWNER = "33600000001";
const CUSTOMER = "15550000002";
let counter = 0;
const message = (from, payload) => ({
  Records: [{ Sns: { Message: JSON.stringify({ whatsAppWebhookEntry: JSON.stringify({ changes: [{ value: { messages: [{ id: `w${++counter}`, from, ...payload }] } }] }) }) } }],
});
const toolCall = (name, input) => ({ stopReason: "tool_use", output: { message: { role: "assistant", content: [{ toolUse: { toolUseId: `t${counter}`, name, input } }] } } });
const say = (text) => ({ stopReason: "end_turn", output: { message: { role: "assistant", content: [{ text }] } } });

beforeEach(() => {
  sent.length = 0;
  modelScript = [];
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
