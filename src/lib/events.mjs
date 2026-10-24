const parseJson = (value) => {
  if (typeof value !== "string") return value ?? null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
};

function parseTextMessage(payload) {
  if (typeof payload?.originationNumber !== "string" || typeof payload.messageBody !== "string" || typeof payload.inboundMessageId !== "string") return null;
  const body = parseJson(payload.messageBody);
  if (body && typeof body === "object" && typeof body.type === "string" && body.type.startsWith("RCS_")) return null;
  return {
    id: `rcs-${payload.inboundMessageId}`,
    from: payload.originationNumber.replace(/\D/g, ""),
    type: "text",
    text: payload.messageBody,
    imageId: null,
    audioId: null,
    caption: "",
    mimeType: "",
    buttonId: null,
    contactName: "",
    channel: "rcs",
  };
}

export function parseInboundMessages(event) {
  const messages = [];
  for (const record of event?.Records ?? []) {
    const payload = parseJson(record?.Sns?.Message);
    const text = parseTextMessage(payload);
    if (text) {
      messages.push(text);
      continue;
    }
    const entry = parseJson(payload?.whatsAppWebhookEntry);
    for (const change of entry?.changes ?? []) {
      for (const m of change?.value?.messages ?? []) {
        if (typeof m?.id !== "string" || typeof m?.from !== "string") continue;
        messages.push({
          id: m.id,
          from: m.from.replace(/\D/g, ""),
          type: m.type,
          text: m.text?.body ?? "",
          imageId: m.image?.id ?? null,
          audioId: m.audio?.id ?? null,
          caption: m.image?.caption ?? "",
          mimeType: m.image?.mime_type ?? m.audio?.mime_type ?? "",
          buttonId: m.interactive?.button_reply?.id ?? m.button?.payload ?? null,
          contactName: change.value.contacts?.find((c) => c?.wa_id === m.from)?.profile?.name ?? "",
          channel: "whatsapp",
        });
      }
    }
  }
  return messages;
}
