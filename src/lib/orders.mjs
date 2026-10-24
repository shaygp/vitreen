import { createOrder, getOrder, listOrdersSince, moveOrder, sendTextMessage, sendWhatsAppButtons, sendWhatsAppText, textChannelEnabled } from "./aws.mjs";
import { notifyCustomer } from "./channels.mjs";
import { findShop, mirrorOrder } from "./directory.mjs";
import { t } from "./i18n.mjs";
import { formatPrice, orderLines } from "./shop.mjs";

export async function placeOrder(shop, order) {
  const saved = await createOrder(shop.slug, order);
  await mirrorOrder(shop, saved).catch((error) =>
    console.error(JSON.stringify({ level: "warn", event: "mirror_failed", slug: shop.slug, error: error.message })),
  );
  await askOwner(shop, saved);
  return saved;
}

function askOwner(shop, order) {
  const m = t(shop.lang);
  return sendWhatsAppButtons(shop.ownerWaId, m.newOrder(shop.name, orderLines(order), formatPrice(order.total), order.customer, order.pickup || m.asap), [
    { id: `acc:${order.id}`, title: m.accept },
    { id: `rej:${order.id}`, title: m.reject },
  ]).catch(async (error) => {
    if (!textChannelEnabled()) throw error;
    console.error(JSON.stringify({ level: "warn", event: "owner_whatsapp_failed", slug: shop.slug, name: error.name, error: error.message }));
    await sendTextMessage(shop.ownerWaId, m.newOrderByText(shop.name, formatPrice(order.total), order.customer));
  });
}

export async function resendPendingOrders(shop) {
  const since = new Date(Date.now() - 86400000).toISOString();
  const recent = await listOrdersSince(shop.slug, since);
  const orders = (await Promise.all(recent.slice(-10).map((o) => getOrder(o.id)))).filter((o) => o?.status === "pending");
  for (const order of orders) await askOwner(shop, order);
  return orders.length;
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
    if (order.customerWaId) await notifyCustomer(order.customerWaId, customer.accepted(shop.name, order.pickup || customer.asap));
  } else if (action === "rej") {
    await sendWhatsAppText(ownerWaId, owner.ownerRejected);
    if (order.customerWaId) await notifyCustomer(order.customerWaId, customer.rejected(shop.name));
  } else {
    await sendWhatsAppText(ownerWaId, owner.ownerReady);
    if (order.customerWaId) await notifyCustomer(order.customerWaId, customer.readyCustomer(shop.name));
  }
  return true;
}
