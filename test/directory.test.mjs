import assert from "node:assert/strict";
import { test } from "node:test";
import { hoursText, pickupIso, toAgentShop } from "../src/lib/directory.mjs";
import { buildOrderFromItems, extractShopCode } from "../src/lib/shop.mjs";

test("reads shop codes from the web page links", () => {
  assert.equal(extractShopCode("Taqueria Nopal taqueria-nopal"), "taqueria-nopal");
  assert.equal(extractShopCode("Le Comptoir du Canal comptoir-du-canal\nCommande n°0042 : 2 x Flat white"), "comptoir-du-canal");
  assert.equal(extractShopCode("Boulangerie Martin boulangerie-martin-ab12"), "boulangerie-martin-ab12");
  assert.equal(extractShopCode("bonjour vous êtes ouverts ?"), null);
});

test("maps a published shop to the agent format with orderable ids", () => {
  const shop = toAgentShop(
    { id: "s1", slug: "fromagerie-lucie", name: "Fromagerie Lucie", description: "Fromages fermiers", address: "7 rue des Martyrs" },
    [{ id: "c1", name: "Fromages" }],
    [{ id: "p1", category_id: "c1", name: "Comté 24 mois", description: "Les 200 g", price_cents: 780, is_available: true }],
    [{ day_of_week: 1, is_closed: true }, { day_of_week: 2, opens_at: "09:30:00", closes_at: "19:30:00", is_closed: false }],
  );
  assert.equal(shop.menu[0].items[0].price, 7.8);
  assert.equal(shop.source, "directory");
  assert.match(shop.hours, /lundi fermé, mardi 09h30 à 19h30/);
  const order = buildOrderFromItems(shop, [{ id: "p1", qty: 2 }]);
  assert.deepEqual(order.lines[0], { id: "p1", name: "Comté 24 mois", price: 7.8, qty: 2 });
  assert.equal(order.total, 15.6);
});

test("turns a spoken pickup time into a Paris timestamp in the future", () => {
  const now = new Date("2026-10-20T08:00:00Z");
  assert.equal(pickupIso("18h", now), "2026-10-20T16:00:00.000Z");
  assert.equal(pickupIso("vers 9h30", now), "2026-10-21T07:30:00.000Z");
  assert.equal(pickupIso("dès que possible", now), "2026-10-20T08:30:00.000Z");
  assert.equal(hoursText([], "en").split(", ")[0], "Monday closed");
});

test("ignores hyphenated words that are not a shop code", () => {
  assert.equal(extractShopCode("email not-an-email"), null);
  assert.equal(extractShopCode("La Cave de Jules cave-de-jules"), "cave-de-jules");
  assert.equal(extractShopCode("Chez Léa chez-lea-2"), "chez-lea-2");
});
