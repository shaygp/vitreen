import { getConversation, sendTextMessage, sendWhatsAppText, textChannelEnabled } from "./aws.mjs";

const WHATSAPP_WINDOW_MS = 23 * 3600 * 1000;

export const insideWhatsAppWindow = (conversation, now = Date.now()) =>
  conversation?.channel === "whatsapp" && Boolean(conversation.lastInboundAt) && now - Date.parse(conversation.lastInboundAt) < WHATSAPP_WINDOW_MS;

export const reply = (message, body) => (message.channel === "rcs" ? sendTextMessage(message.from, body) : sendWhatsAppText(message.from, body));

export function pickChannel(conversation, now = Date.now()) {
  if (insideWhatsAppWindow(conversation, now)) return "whatsapp";
  if (textChannelEnabled()) return "rcs";
  return conversation?.channel === "whatsapp" ? "whatsapp" : null;
}

export async function notifyCustomer(phone, body) {
  const channel = pickChannel(await getConversation(phone));
  if (!channel) {
    console.warn(JSON.stringify({ level: "warn", event: "customer_unreachable" }));
    return null;
  }
  try {
    await (channel === "whatsapp" ? sendWhatsAppText(phone, body) : sendTextMessage(phone, body));
    console.log(JSON.stringify({ level: "info", event: "customer_notified", channel }));
    return channel;
  } catch (error) {
    console.error(JSON.stringify({ level: "warn", event: "customer_notify_failed", channel, name: error.name, error: error.message }));
    return null;
  }
}
