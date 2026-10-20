import { createOrder, getOrder, moveOrder, sendWhatsAppButtons, sendWhatsAppText } from "./aws.mjs";
import { findShop, mirrorOrder } from "./directory.mjs";
import { t } from "./i18n.mjs";
import { formatPrice, orderLines } from "./shop.mjs";

export async function placeOrder(shop, order) {
  const saved = await createOrder(shop.slug, order);
  await mirrorOrder(shop, saved).catch((error) =>
    console.error(JSON.stringify({ level: "warn", event: "mirror_failed", slug: shop.slug, error: error.message })),
  );
  const m = t(shop.lang);
  await sendWhatsAppButtons(shop.ownerWaId, m.newOrder(shop.name, orderLines(saved), formatPrice(saved.total), saved.customer, saved.pickup || m.asap), [
    { id: `acc:${saved.id}`, title: m.accept },
    { id: `rej:${saved.id}`, title: m.reject },
  ]);
  return saved;
}

const TRANSITIONS = {
  acc: { from: "pending", to: "accepted" },
  rej: { from: "pending", to: "rejected" },
  rdy: { from: "accepted", to: "ready" },
};

export async function handleOrderButton(ownerWaId, buttonId) {
  const [action, id] = String(buttonId).split(":");
  const transition = TRANSITIONS[action];
  if (!transition || !/^[a-f0-9]{10}$/.test(id ?? "")) return false;
  const order = await getOrder(id);
  if (!order) return false;
  const shop = await findShop(order.slug);
  if (!shop || shop.ownerWaId !== ownerWaId) return false;

  const owner = t(shop.lang);
  if (!(await moveOrder(id, transition.from, transition.to))) {
    await sendWhatsAppText(ownerWaId, owner.orderGone);
    return true;
  }
  const customer = t(order.lang ?? shop.lang);
  if (action === "acc") {
    await sendWhatsAppButtons(ownerWaId, owner.ownerAccepted, [{ id: `rdy:${id}`, title: owner.ready }]);
    if (order.customerWaId) await sendWhatsAppText(order.customerWaId, customer.accepted(shop.name, order.pickup || customer.asap));
  } else if (action === "rej") {
    await sendWhatsAppText(ownerWaId, owner.ownerRejected);
    if (order.customerWaId) await sendWhatsAppText(order.customerWaId, customer.rejected(shop.name));
  } else {
    await sendWhatsAppText(ownerWaId, owner.ownerReady);
    if (order.customerWaId) await sendWhatsAppText(order.customerWaId, customer.readyCustomer(shop.name));
  }
  return true;
}
