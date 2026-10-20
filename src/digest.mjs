import { getShop, listDigestSlugs } from "./lib/aws.mjs";
import { sendDigest } from "./lib/digest.mjs";

export async function handler() {
  let sent = 0;
  for (const slug of await listDigestSlugs()) {
    try {
      const shop = await getShop(slug);
      if (shop && shop.digest !== false && (await sendDigest(shop))) sent += 1;
    } catch (error) {
      console.error(JSON.stringify({ level: "error", slug, name: error.name, error: error.message }));
    }
  }
  console.log(JSON.stringify({ level: "info", event: "digest_run", sent }));
  return { sent };
}
