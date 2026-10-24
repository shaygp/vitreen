import { PAGE_LABELS } from "./i18n.mjs";
import { formatPrice } from "./shop.mjs";

export const escapeHtml = (value) =>
  String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

export const SECURITY_HEADERS = {
  "content-type": "text/html; charset=utf-8",
  "content-security-policy":
    "default-src 'none'; img-src https: data:; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
};

const STYLES = `
:root{--cream:#FBF6EE;--ink:#1E1712;--paper:#F3ECE0;--accent:#B5531E;--line:#1E171233}
*{box-sizing:border-box;margin:0;padding:0}
body{background:var(--paper);color:var(--ink);font-family:Inter,system-ui,sans-serif;font-size:17px;line-height:1.5;-webkit-font-smoothing:antialiased}
a{color:inherit}
.hero{position:relative;min-height:100svh;display:flex;flex-direction:column;justify-content:space-between;padding:20px;color:var(--cream);background:var(--ink) center/cover no-repeat}
.hero::before{content:"";position:absolute;inset:0;background:linear-gradient(180deg,#1E171299 0%,#1E171222 40%,#1E1712bb 100%)}
.hero>*{position:relative}
.bar{display:flex;justify-content:space-between;align-items:center;gap:12px}
.box{border:1px solid var(--cream);padding:8px 14px;font-size:15px;text-decoration:none;border-radius:2px}
.name{font-size:clamp(56px,13vw,148px);font-weight:500;letter-spacing:-0.04em;line-height:.92;max-width:12ch;hyphens:none;overflow-wrap:break-word}
.tagline{font-size:22px;max-width:30ch;margin-top:20px}
.ctas{display:flex;flex-wrap:wrap;gap:12px;margin-top:28px}
.cta{display:inline-flex;text-decoration:none;color:var(--cream)}
.cta span{border:1px solid var(--cream);padding:12px 18px;border-radius:2px}
.cta span+span{border-left:0;width:48px;text-align:center}
main{max-width:1080px;margin:0 auto;padding:96px 20px}
.cat{display:grid;grid-template-columns:1fr 2fr;gap:32px;padding:40px 0;border-top:1px solid var(--line)}
.cat h2{font-size:clamp(32px,5vw,56px);font-weight:500;letter-spacing:-0.03em;line-height:1}
.num{font-size:15px;margin-bottom:12px}
.item{display:grid;grid-template-columns:auto 1fr auto 72px;align-items:baseline;gap:12px;padding:12px 0}
.item .rule{border-bottom:1px solid var(--line);transform:translateY(-4px)}
.item.off{text-decoration:line-through}
.item input{width:72px;font:inherit;padding:6px 8px;border:1px solid var(--ink);background:var(--cream);border-radius:2px;color:var(--ink)}
.order{margin-top:64px;padding:32px;border:1px solid var(--ink);background:var(--cream);border-radius:2px}
.order h2{font-size:32px;font-weight:500;letter-spacing:-0.02em;margin-bottom:20px}
.fields{display:grid;grid-template-columns:repeat(2,1fr);gap:16px;margin-bottom:24px}
.fields label{display:flex;flex-direction:column;gap:6px;font-size:15px}
.fields input{font:inherit;padding:12px;border:1px solid var(--ink);background:var(--paper);border-radius:2px;color:var(--ink)}
.trap{position:absolute;left:-9999px}
button{font:inherit;background:var(--ink);color:var(--cream);border:0;padding:14px 22px;border-radius:2px;cursor:pointer}
.errors{border:1px solid var(--accent);color:var(--accent);padding:12px 16px;margin-bottom:20px;border-radius:2px}
.info{display:grid;grid-template-columns:1fr 1fr;gap:32px;margin-top:96px;padding-top:40px;border-top:1px solid var(--line)}
.info h3{font-size:22px;font-weight:500;margin-bottom:8px}
footer{padding:40px 20px;text-align:center;font-size:15px}
.simple{min-height:100svh;display:flex;flex-direction:column;justify-content:center;padding:20px;max-width:720px;margin:0 auto}
.simple h1{font-size:clamp(40px,8vw,80px);font-weight:500;letter-spacing:-0.04em;line-height:1;margin-bottom:20px}
.poster{min-height:100svh;display:flex;flex-direction:column;justify-content:center;align-items:center;text-align:center;padding:32px 20px;max-width:640px;margin:0 auto;gap:20px}
.poster-name{font-size:28px;font-weight:500}
.poster h1{font-size:clamp(40px,8vw,72px);font-weight:500;letter-spacing:-0.04em;line-height:1}
.qr{width:min(80vw,360px);border:1px solid var(--ink);padding:16px;background:#fff;border-radius:2px}
.qr svg{display:block;width:100%;height:auto}
@media print{.poster{min-height:auto}}
@media (max-width:720px){.cat{grid-template-columns:1fr;gap:12px}.fields,.info{grid-template-columns:1fr}.item{grid-template-columns:1fr auto 64px}.item .rule{display:none}main{padding:64px 16px}}
`;

const page = (title, body, lang = "fr") => `<!doctype html><html lang="${lang === "en" ? "en" : "fr"}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title><link rel="preconnect" href="https://fonts.googleapis.com"><link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500&display=swap" rel="stylesheet"><style>${STYLES}</style></head><body>${body}</body></html>`;

function renderItem(item, l) {
  const orderable = item.available && item.price !== null;
  const qty = orderable
    ? `<input type="number" name="q_${escapeHtml(item.id)}" min="0" max="50" value="0" inputmode="numeric" aria-label="${escapeHtml(l.quantity)} ${escapeHtml(item.name)}">`
    : "<span></span>";
  return `<div class="item${item.available ? "" : " off"}"><span>${escapeHtml(item.name)}</span><span class="rule"></span><span>${escapeHtml(formatPrice(item.price))}</span>${qty}</div>`;
}

const labelsFor = (shop) => PAGE_LABELS[shop.lang] ?? PAGE_LABELS.fr;

export function renderShop(shop, { photoUrl = "", whatsAppUrl = "", errors = [], values = {} } = {}) {
  const l = labelsFor(shop);
  const total = shop.menu.length;
  const categories = shop.menu
    .map(
      (c, i) =>
        `<section class="cat"><div><p class="num">${String(i + 1).padStart(2, "0")} / ${String(total).padStart(2, "0")}</p><h2>${escapeHtml(c.name)}</h2></div><div>${c.items.map((item) => renderItem(item, l)).join("")}</div></section>`,
    )
    .join("");
  const errorBox = errors.length ? `<div class="errors" role="alert">${errors.map((e) => escapeHtml(l.errors[e] ?? e)).join("<br>")}</div>` : "";
  const heroStyle = photoUrl ? ` style="background-image:url('${escapeHtml(photoUrl)}')"` : "";
  const whatsApp = whatsAppUrl ? `<a class="cta" href="${escapeHtml(whatsAppUrl)}"><span>${escapeHtml(l.orderWhatsApp)}</span><span aria-hidden="true">&#8599;</span></a>` : "";
  const body = `
<header class="hero"${heroStyle}>
  <div class="bar"><a class="box" href="#carte">${escapeHtml(l.menu)}</a><a class="box" href="#commander">${escapeHtml(l.order)}</a></div>
  <div>
    <h1 class="name">${escapeHtml(shop.name)}</h1>
    ${shop.tagline ? `<p class="tagline">${escapeHtml(shop.tagline)}</p>` : ""}
    <div class="ctas"><a class="cta" href="#carte"><span>${escapeHtml(l.seeMenu)}</span><span aria-hidden="true">&#8595;</span></a>${whatsApp}</div>
  </div>
</header>
<main>
  <form method="post" action="/s/${escapeHtml(shop.slug)}/order#commander">
    <div id="carte">${categories || `<p>${escapeHtml(l.menuSoon)}</p>`}</div>
    <section class="order" id="commander">
      <h2>${escapeHtml(l.order)}</h2>
      ${errorBox}
      <div class="fields">
        <label>${escapeHtml(l.firstName)}<input name="name" maxlength="60" autocomplete="given-name" required value="${escapeHtml(values.name)}"></label>
        <label>${escapeHtml(l.phone)}<input name="phone" maxlength="20" type="tel" autocomplete="tel" required value="${escapeHtml(values.phone)}"></label>
        <label>${escapeHtml(l.pickup)}<input name="pickup" maxlength="40" placeholder="${escapeHtml(l.pickupHint)}" value="${escapeHtml(values.pickup)}"></label>
        <label>${escapeHtml(l.email)}<input name="email" maxlength="254" type="email" autocomplete="email" value="${escapeHtml(values.email)}"></label>
      </div>
      <input class="trap" name="website" tabindex="-1" autocomplete="off" aria-hidden="true">
      <button type="submit">${escapeHtml(l.send)}</button>
    </section>
  </form>
  <section class="info">
    <div><h3>${escapeHtml(l.hours)}</h3><p>${escapeHtml(shop.hours || l.soon)}</p></div>
    <div><h3>${escapeHtml(l.address)}</h3><p>${escapeHtml(shop.address || l.soon)}</p></div>
  </section>
</main>
<footer>${escapeHtml(l.footer)}</footer>`;
  return page(shop.name, body, shop.lang);
}

export function renderConfirmation(shop, order) {
  const l = labelsFor(shop);
  const lines = order.lines.map((line) => `${line.qty} x ${escapeHtml(line.name)}`).join("<br>");
  return page(
    `${l.sent}, ${shop.name}`,
    `<div class="simple"><h1>${escapeHtml(l.sent)}</h1><p>${lines}</p><p>Total : ${escapeHtml(formatPrice(order.total))}</p><p>${escapeHtml(l.sentText(shop.name))}</p><p><a href="/s/${escapeHtml(shop.slug)}">${escapeHtml(l.back)}</a></p></div>`,
    shop.lang,
  );
}

export function renderReceipt(shop, order, pickupLabel) {
  const l = labelsFor(shop);
  const rows = order.lines.map((line) => `${line.qty} x ${line.name}  ${formatPrice(line.price * line.qty)}`);
  const text = [l.receiptIntro(shop.name), "", ...rows, `Total : ${formatPrice(order.total)}`, order.pickup ? `${pickupLabel} : ${order.pickup}` : "", "", shop.address].filter((x) => x !== undefined).join("\n");
  const html = `<!doctype html><html><body style="margin:0;background:#F3ECE0;color:#1E1712;font-family:Inter,Arial,sans-serif;font-size:16px;line-height:1.5"><div style="max-width:560px;margin:0 auto;padding:32px 20px"><h1 style="font-size:32px;font-weight:500;margin:0 0 16px">${escapeHtml(shop.name)}</h1><p>${escapeHtml(l.receiptIntro(shop.name))}</p>${rows.map((r) => `<p style="margin:4px 0">${escapeHtml(r)}</p>`).join("")}<p style="margin-top:12px">Total : ${escapeHtml(formatPrice(order.total))}</p>${order.pickup ? `<p>${escapeHtml(pickupLabel)} : ${escapeHtml(order.pickup)}</p>` : ""}<p>${escapeHtml(shop.address ?? "")}</p></div></body></html>`;
  return { subject: l.receiptSubject(shop.name), html, text };
}

export function renderQrPoster(shop, qrSvg) {
  const l = labelsFor(shop);
  return page(
    `${l.qrTitle}, ${shop.name}`,
    `<div class="poster"><p class="poster-name">${escapeHtml(shop.name)}</p><div class="qr">${qrSvg}</div><h1>${escapeHtml(l.qrTitle)}</h1><p>${escapeHtml(l.qrText)}</p></div>`,
    shop.lang,
  );
}

export const renderMessage = (title, text, lang = "fr") => page(title, `<div class="simple"><h1>${escapeHtml(title)}</h1><p>${escapeHtml(text)}</p></div>`, lang);
