const parseJson = (value) => {
  if (typeof value !== "string") return value ?? null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
};

export function parseWhatsAppMessages(event) {
  const messages = [];
  for (const record of event?.Records ?? []) {
    const payload = parseJson(record?.Sns?.Message);
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
          caption: m.image?.caption ?? "",
          mimeType: m.image?.mime_type ?? "",
          buttonId: m.interactive?.button_reply?.id ?? m.button?.payload ?? null,
          contactName: change.value.contacts?.find((c) => c?.wa_id === m.from)?.profile?.name ?? "",
        });
      }
    }
  }
  return messages;
}
