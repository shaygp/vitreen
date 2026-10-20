import assert from "node:assert/strict";
import { test } from "node:test";
import { parseWhatsAppMessages } from "../src/lib/events.mjs";
import { escapeHtml, renderShop } from "../src/lib/render.mjs";
import { buildOrder, buildOrderFromItems, cleanPrice, extractShopCode, isValidSlug, itemsBackInStock, sanitizeMenu, slugify } from "../src/lib/shop.mjs";

const snsEvent = (entry) => ({
  Records: [{ Sns: { Message: JSON.stringify({ context: {}, whatsAppWebhookEntry: JSON.stringify(entry) }) } }],
});

test("parses text and image messages from the SNS payload", () => {
  const event = snsEvent({
    changes: [
      {
        value: {
          messages: [
            { id: "wamid.1", from: "33612345678", type: "text", text: { body: "plus de croissants" } },
            { id: "wamid.2", from: "+33 6 12 34 56 78", type: "image", image: { id: "m1", mime_type: "image/jpeg", caption: "ardoise" } },
          ],
        },
      },
    ],
  });
  const [text, image] = parseWhatsAppMessages(event);
  assert.equal(text.text, "plus de croissants");
  assert.equal(image.from, "33612345678");
  assert.equal(image.imageId, "m1");
});

test("ignores malformed records and status updates", () => {
  assert.deepEqual(parseWhatsAppMessages({ Records: [{ Sns: { Message: "not json" } }] }), []);
  assert.deepEqual(parseWhatsAppMessages(snsEvent({ changes: [{ value: { statuses: [{ id: "x" }] } }] })), []);
});

test("cleans prices written the French way", () => {
  assert.equal(cleanPrice("4,50 €"), 4.5);
  assert.equal(cleanPrice(1.2), 1.2);
  assert.equal(cleanPrice(null), null);
  assert.equal(cleanPrice(-3), null);
  assert.equal(cleanPrice("illisible"), null);
});

test("keeps item ids stable across menu updates", () => {
  const first = sanitizeMenu([{ name: "Viennoiseries", items: [{ name: "Croissant", price: 1.2, available: true }] }]);
  const second = sanitizeMenu([{ name: "Viennoiseries", items: [{ name: "croissant", price: 1.3, available: false }] }], first);
  assert.equal(second[0].items[0].id, first[0].items[0].id);
  assert.equal(second[0].items[0].available, false);
});

test("drops empty items and categories", () => {
  assert.deepEqual(sanitizeMenu([{ name: "Vide", items: [{ name: "  " }] }]), []);
  assert.deepEqual(sanitizeMenu("nope"), []);
});

test("slugs are url safe and validated", () => {
  const slug = slugify("Boulangerie Émile & Fils");
  assert.match(slug, /^boulangerie-emile-fils-[a-f0-9]{4}$/);
  assert.ok(isValidSlug(slug));
  assert.ok(!isValidSlug("../etc/passwd"));
});

const shop = {
  slug: "boulangerie-martin-ab12",
  name: "Boulangerie <Martin>",
  tagline: "",
  hours: "",
  address: "",
  menu: [
    {
      name: "Pains",
      items: [
        { id: "a1", name: "Baguette", price: 1.2, available: true },
        { id: "b2", name: "Flan", price: 3.5, available: false },
        { id: "c3", name: "Pain du jour", price: null, available: true },
      ],
    },
  ],
};

test("computes orders from server prices only", () => {
  const { errors, order } = buildOrder(shop, { q_a1: "3", q_b2: "2", q_c3: "1", name: "Léa", phone: "06 12 34 56 78" });
  assert.deepEqual(errors, []);
  assert.equal(order.lines.length, 1);
  assert.equal(order.total, 3.6);
});

test("rejects incomplete orders", () => {
  const { errors } = buildOrder(shop, { q_a1: "0", name: "", phone: "12" });
  assert.equal(errors.length, 3);
});

test("caps quantities", () => {
  const { order } = buildOrder(shop, { q_a1: "9999", name: "Léa", phone: "0612345678" });
  assert.equal(order.lines[0].qty, 50);
});

test("escapes everything shop owners or customers control", () => {
  assert.equal(escapeHtml(`<img src=x onerror="a">`), "&lt;img src=x onerror=&quot;a&quot;&gt;");
  const html = renderShop(shop, { errors: ["<b>"], values: { name: `"><script>` } });
  assert.ok(!html.includes("<Martin>"));
  assert.ok(!html.includes("<script>"));
  assert.ok(html.includes('name="q_a1"'));
  assert.ok(!html.includes('name="q_b2"'));
});

test("finds the shop code in a wa.me prefilled message", () => {
  assert.equal(extractShopCode("Boulangerie Martin boulangerie-martin-ab12"), "boulangerie-martin-ab12");
  assert.equal(extractShopCode("hello, are you open?"), null);
});

test("orders from the agent only keep orderable items", () => {
  const result = buildOrderFromItems(shop, [{ id: "a1", qty: 2 }, { id: "b2", qty: 1 }, { id: "zz", qty: 1 }, { id: "a1", qty: -3 }]);
  assert.equal(result.lines.length, 1);
  assert.equal(result.total, 2.4);
  assert.deepEqual(result.unavailable, ["Flan"]);
});

test("detects products that come back in stock", () => {
  const before = [{ name: "P", items: [{ name: "Flan pistache", available: false }, { name: "Croissant", available: true }] }];
  const after = [{ name: "P", items: [{ name: "Flan Pistache", available: true }, { name: "Croissant", available: true }, { name: "Kouign-amann", available: true }] }];
  assert.deepEqual(itemsBackInStock(before, after), ["Flan Pistache", "Kouign-amann"]);
});

test("parses button replies", () => {
  const [m] = parseWhatsAppMessages(
    snsEvent({ changes: [{ value: { contacts: [{ wa_id: "336", profile: { name: "Léa" } }], messages: [{ id: "w3", from: "336", type: "interactive", interactive: { type: "button_reply", button_reply: { id: "acc:0123456789", title: "Accepter" } } }] } }] }),
  );
  assert.equal(m.buttonId, "acc:0123456789");
  assert.equal(m.contactName, "Léa");
});
