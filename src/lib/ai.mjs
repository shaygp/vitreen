import { callTool } from "./aws.mjs";

const categoriesSchema = {
  type: "array",
  items: {
    type: "object",
    properties: {
      name: { type: "string" },
      items: {
        type: "array",
        items: {
          type: "object",
          properties: {
            name: { type: "string" },
            price: { type: ["number", "null"], description: "Prix en euros, null si illisible ou absent" },
            available: { type: "boolean" },
          },
          required: ["name", "price", "available"],
        },
      },
    },
    required: ["name", "items"],
  },
};

const detailProperties = {
  name: { type: "string", description: "Nom du commerce, vide si absent" },
  tagline: { type: "string", description: "Une phrase courte et sobre qui décrit le commerce, sans superlatif" },
  hours: { type: "string", description: "Horaires lisibles, vide si absents" },
  address: { type: "string", description: "Adresse lisible, vide si absente" },
};

const READ_SYSTEM = `Tu lis des photos envoyées par des commerçants français indépendants : ardoise, menu imprimé, vitrine ou devanture.
Tu ne transcris que ce qui est réellement lisible sur la photo. Tu n'inventes jamais un produit, un prix, un horaire ni une adresse.
Un prix illisible vaut null. Garde l'orthographe des produits telle qu'elle est écrite, corrige seulement les fautes évidentes.
Regroupe les produits par catégorie quand la photo en montre, sinon une seule catégorie "La carte".`;

const readTool = {
  name: "save_photo",
  description: "Enregistre ce qui est lisible sur la photo",
  inputSchema: {
    json: {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["menu", "storefront", "other"], description: "menu si la photo montre des produits avec ou sans prix, storefront pour une devanture ou un intérieur sans liste de produits" },
        ...detailProperties,
        categories: categoriesSchema,
      },
      required: ["kind", "name", "tagline", "hours", "address", "categories"],
    },
  },
};

const EDIT_SYSTEM = `Tu mets à jour la page en ligne d'un commerce à partir d'un message WhatsApp de la commerçante.
Applique uniquement ce qu'elle demande : ajout, retrait, prix, rupture de stock, horaires, nom, phrase de présentation.
Un produit en rupture garde sa place avec available à false. Ne change rien d'autre et n'invente aucun produit.
Si le message n'est pas une modification, renvoie l'état tel quel, changes vide et une réponse courte dans reply.`;

const editTool = {
  name: "update_shop",
  description: "Renvoie l'état complet de la page après la modification",
  inputSchema: {
    json: {
      type: "object",
      properties: {
        changes: { type: "array", items: { type: "string" }, description: "Chaque changement appliqué en une phrase courte, en français" },
        reply: { type: "string", description: "Réponse si le message n'est pas une modification, sinon vide" },
        ...detailProperties,
        categories: categoriesSchema,
      },
      required: ["changes", "reply", "name", "tagline", "hours", "address", "categories"],
    },
  },
};

const IMAGE_FORMATS = { "image/jpeg": "jpeg", "image/png": "png", "image/webp": "webp", "image/gif": "gif" };

const LANGUAGE_NAMES = { fr: "français", en: "anglais" };
const languageRule = (lang) => `\nLa phrase de présentation et les changements s'écrivent en ${LANGUAGE_NAMES[lang] ?? "anglais"}, les noms de produits restent tels qu'ils sont écrits.`;

export function readPhoto({ bytes, mimeType }, caption, lang) {
  const format = IMAGE_FORMATS[mimeType.split(";")[0].trim()] ?? "jpeg";
  return callTool({
    system: READ_SYSTEM + languageRule(lang),
    tool: readTool,
    content: [
      { image: { format, source: { bytes } } },
      { text: caption ? `Légende envoyée avec la photo : ${caption}` : "Lis cette photo." },
    ],
  });
}

export function editShop(shop, message, lang) {
  const current = {
    name: shop.name,
    tagline: shop.tagline,
    hours: shop.hours,
    address: shop.address,
    categories: shop.menu.map((c) => ({ name: c.name, items: c.items.map(({ name, price, available }) => ({ name, price, available })) })),
  };
  return callTool({
    system: EDIT_SYSTEM + languageRule(lang),
    tool: editTool,
    content: [{ text: `État actuel :\n${JSON.stringify(current)}\n\nMessage de la commerçante :\n${message}` }],
  });
}
