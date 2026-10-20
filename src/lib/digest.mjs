import { callTool, listDemandSince, listOrdersSince, sendEmail } from "./aws.mjs";
import { escapeHtml } from "./render.mjs";
import { formatPrice, normalizeName } from "./shop.mjs";

const DAYS = 7;

export function summarizeWeek(demand, orders) {
  const counted = orders.filter((o) => o.total !== undefined);
  const waitlist = new Map();
  for (const d of demand.filter((d) => d.kind === "waitlist")) {
    const key = normalizeName(d.detail);
    const entry = waitlist.get(key) ?? { name: d.detail, count: 0 };
    entry.count += 1;
    waitlist.set(key, entry);
  }
  return {
    orders: counted.length,
    revenue: Math.round(counted.reduce((sum, o) => sum + (o.total ?? 0), 0) * 100) / 100,
    viaWhatsApp: counted.filter((o) => o.channel === "whatsapp").length,
    askedFor: [...waitlist.values()].sort((a, b) => b.count - a.count).slice(0, 8),
    questions: demand.filter((d) => d.kind === "question").map((d) => d.detail).slice(0, 40),
  };
}

const insightTool = {
  name: "write_insights",
  description: "Write the owner's weekly insights",
  inputSchema: {
    json: {
      type: "object",
      properties: {
        insights: { type: "array", items: { type: "string" }, description: "Two to four short observations grounded only in the data" },
        suggestion: { type: "string", description: "One concrete action for next week, grounded only in the data, or empty if the data is too thin" },
      },
      required: ["insights", "suggestion"],
    },
  },
};

async function writeInsights(shop, week, lang) {
  if (!week.orders && !week.askedFor.length && !week.questions.length) return { insights: [], suggestion: "" };
  const language = lang === "fr" ? "French" : "English";
  const result = await callTool({
    system: `You help an independent shop owner read what their customers told them this week. Use only the data given. Never invent numbers or products. Write in ${language}, plainly, no jargon.`,
    tool: insightTool,
    content: [{ text: `Shop: ${shop.name}\nWeek data:\n${JSON.stringify(week)}` }],
  });
  return {
    insights: (Array.isArray(result.insights) ? result.insights : []).filter((i) => typeof i === "string").slice(0, 4),
    suggestion: typeof result.suggestion === "string" ? result.suggestion : "",
  };
}

const COPY = {
  fr: {
    subject: (name) => `${name}, ce que vos clients vous ont dit cette semaine`,
    title: "Votre semaine",
    orders: (n, total, wa) => `${n} commande${n > 1 ? "s" : ""} à emporter pour ${total}, dont ${wa} passée${wa > 1 ? "s" : ""} sur WhatsApp.`,
    askedFor: "Demandé alors que c'était épuisé",
    questions: "Questions transmises",
    insights: "Ce qu'on en retient",
    next: "Pour la semaine prochaine",
    empty: "Pas encore de commande ni de demande cette semaine. Collez le QR code en vitrine pour que vos clients vous écrivent.",
    footer: "Envoyé par Vitrine. Répondez « stop rapport » sur WhatsApp pour ne plus le recevoir.",
  },
  en: {
    subject: (name) => `${name}, what your customers told you this week`,
    title: "Your week",
    orders: (n, total, wa) => `${n} pickup order${n > 1 ? "s" : ""} worth ${total}, ${wa} of them on WhatsApp.`,
    askedFor: "Asked for while sold out",
    questions: "Questions passed to you",
    insights: "What stands out",
    next: "For next week",
    empty: "No orders or requests yet this week. Put the QR code in your window so customers can message you.",
    footer: "Sent by Vitrine. Reply “stop report” on WhatsApp to stop receiving it.",
  },
};

export function renderDigest(shop, week, ai, lang) {
  const c = COPY[lang] ?? COPY.en;
  const sections = [];
  const text = [];
  const hasData = week.orders || week.askedFor.length || week.questions.length;
  const add = (title, lines) => {
    if (!lines.length) return;
    sections.push(`<h2 style="font-size:20px;font-weight:500;margin:28px 0 8px">${escapeHtml(title)}</h2>${lines.map((l) => `<p style="margin:4px 0">${escapeHtml(l)}</p>`).join("")}`);
    text.push(title, ...lines, "");
  };
  add(c.title, [hasData ? c.orders(week.orders, formatPrice(week.revenue), week.viaWhatsApp) : c.empty]);
  add(c.askedFor, week.askedFor.map((a) => `${a.name}  ${a.count}`));
  add(c.questions, week.questions.slice(0, 10));
  add(c.insights, ai.insights);
  add(c.next, ai.suggestion ? [ai.suggestion] : []);
  const html = `<!doctype html><html><body style="margin:0;background:#F3ECE0;color:#1E1712;font-family:Inter,Arial,sans-serif;font-size:16px;line-height:1.5"><div style="max-width:560px;margin:0 auto;padding:32px 20px"><h1 style="font-size:36px;font-weight:500;letter-spacing:-0.02em;margin:0">${escapeHtml(shop.name)}</h1>${sections.join("")}<p style="margin-top:40px;font-size:14px">${escapeHtml(c.footer)}</p></div></body></html>`;
  return { subject: c.subject(shop.name), html, text: [shop.name, "", ...text, c.footer].join("\n") };
}

export async function sendDigest(shop) {
  if (!shop.ownerEmail) return false;
  const since = new Date(Date.now() - DAYS * 86400 * 1000).toISOString();
  const [demand, orders] = await Promise.all([listDemandSince(shop.slug, since), listOrdersSince(shop.slug, since)]);
  const week = summarizeWeek(demand, orders);
  const lang = shop.lang ?? "fr";
  const ai = await writeInsights(shop, week, lang);
  await sendEmail({ to: shop.ownerEmail, ...renderDigest(shop, week, ai, lang) });
  return true;
}
