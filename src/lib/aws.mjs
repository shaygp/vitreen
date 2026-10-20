import { BedrockRuntimeClient, ConverseCommand } from "@aws-sdk/client-bedrock-runtime";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { GetWhatsAppMessageMediaCommand, SendWhatsAppMessageCommand, SocialMessagingClient } from "@aws-sdk/client-socialmessaging";
import { randomBytes } from "node:crypto";

const { TABLE_NAME, BUCKET_NAME, PHONE_NUMBER_ID, MODEL_ID, META_API_VERSION = "v20.0" } = process.env;

const db = DynamoDBDocumentClient.from(new DynamoDBClient({}), { marshallOptions: { removeUndefinedValues: true } });
const s3 = new S3Client({});
const social = new SocialMessagingClient({});
const bedrock = new BedrockRuntimeClient({});

const DAY = 86400;
const epoch = () => Math.floor(Date.now() / 1000);
const shopKey = (slug) => ({ pk: `SHOP#${slug}`, sk: "META" });

export async function getShop(slug) {
  const { Item } = await db.send(new GetCommand({ TableName: TABLE_NAME, Key: shopKey(slug) }));
  return Item ?? null;
}

export async function getShopByOwner(waId) {
  const { Item } = await db.send(new GetCommand({ TableName: TABLE_NAME, Key: { pk: `OWNER#${waId}`, sk: "SHOP" } }));
  return Item ? getShop(Item.slug) : null;
}

export async function createShop(shop) {
  await db.send(
    new TransactWriteCommand({
      TransactItems: [
        { Put: { TableName: TABLE_NAME, Item: { ...shopKey(shop.slug), ...shop }, ConditionExpression: "attribute_not_exists(pk)" } },
        { Put: { TableName: TABLE_NAME, Item: { pk: `OWNER#${shop.ownerWaId}`, sk: "SHOP", slug: shop.slug }, ConditionExpression: "attribute_not_exists(pk)" } },
      ],
    }),
  );
}

export async function saveShop(shop) {
  await db.send(new PutCommand({ TableName: TABLE_NAME, Item: { ...shopKey(shop.slug), ...shop, updatedAt: new Date().toISOString() } }));
}

export async function createOrder(slug, order) {
  const id = randomBytes(5).toString("hex");
  const createdAt = new Date().toISOString();
  const item = { ...order, id, slug, status: "pending", createdAt };
  await db.send(
    new TransactWriteCommand({
      TransactItems: [
        { Put: { TableName: TABLE_NAME, Item: { pk: `ORDER#${id}`, sk: "META", ...item } } },
        { Put: { TableName: TABLE_NAME, Item: { pk: `SHOP#${slug}`, sk: `ORDER#${createdAt}#${id}`, id, total: order.total, channel: order.channel } } },
      ],
    }),
  );
  return item;
}

export async function getOrder(id) {
  const { Item } = await db.send(new GetCommand({ TableName: TABLE_NAME, Key: { pk: `ORDER#${id}`, sk: "META" } }));
  return Item ?? null;
}

export async function moveOrder(id, from, to) {
  try {
    await db.send(
      new UpdateCommand({
        TableName: TABLE_NAME,
        Key: { pk: `ORDER#${id}`, sk: "META" },
        UpdateExpression: "SET #s = :to, updatedAt = :now",
        ConditionExpression: "#s = :from",
        ExpressionAttributeNames: { "#s": "status" },
        ExpressionAttributeValues: { ":to": to, ":from": from, ":now": new Date().toISOString() },
      }),
    );
    return true;
  } catch (error) {
    if (error.name === "ConditionalCheckFailedException") return false;
    throw error;
  }
}

export async function countRecentOrders(slug, sinceIso) {
  const { Count } = await db.send(
    new QueryCommand({
      TableName: TABLE_NAME,
      KeyConditionExpression: "pk = :pk AND sk > :since",
      ExpressionAttributeValues: { ":pk": `SHOP#${slug}`, ":since": `ORDER#${sinceIso}` },
      Select: "COUNT",
    }),
  );
  return Count ?? 0;
}

export async function getConversation(waId) {
  const { Item } = await db.send(new GetCommand({ TableName: TABLE_NAME, Key: { pk: `CONV#${waId}`, sk: "META" } }));
  return Item ?? null;
}

export async function saveConversation(waId, conversation) {
  await db.send(
    new PutCommand({ TableName: TABLE_NAME, Item: { pk: `CONV#${waId}`, sk: "META", ...conversation, ttl: epoch() + 30 * DAY } }),
  );
}

export async function addToWaitlist(slug, itemKey, itemName, waId, lang) {
  await db.send(
    new PutCommand({
      TableName: TABLE_NAME,
      Item: { pk: `WAIT#${slug}`, sk: `${itemKey}#${waId}`, itemName, waId, lang, createdAt: new Date().toISOString(), ttl: epoch() + 14 * DAY },
    }),
  );
}

export async function takeWaitlist(slug, itemKey) {
  const { Items = [] } = await db.send(
    new QueryCommand({
      TableName: TABLE_NAME,
      KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
      ExpressionAttributeValues: { ":pk": `WAIT#${slug}`, ":prefix": `${itemKey}#` },
    }),
  );
  await Promise.all(Items.map((i) => db.send(new DeleteCommand({ TableName: TABLE_NAME, Key: { pk: i.pk, sk: i.sk } }))));
  return Items;
}

export async function recordDemand(slug, kind, detail) {
  const at = new Date().toISOString();
  await db.send(
    new PutCommand({
      TableName: TABLE_NAME,
      Item: { pk: `DEMAND#${slug}`, sk: `${at}#${randomBytes(3).toString("hex")}`, kind, detail, at, ttl: epoch() + 90 * DAY },
    }),
  );
}

export async function claimMessage(messageId) {
  try {
    await db.send(
      new PutCommand({
        TableName: TABLE_NAME,
        Item: { pk: `MSG#${messageId}`, sk: "SEEN", ttl: epoch() + 7 * DAY },
        ConditionExpression: "attribute_not_exists(pk)",
      }),
    );
    return true;
  } catch (error) {
    if (error.name === "ConditionalCheckFailedException") return false;
    throw error;
  }
}

async function sendWhatsApp(payload) {
  await social.send(
    new SendWhatsAppMessageCommand({
      originationPhoneNumberId: PHONE_NUMBER_ID,
      message: new TextEncoder().encode(JSON.stringify({ messaging_product: "whatsapp", recipient_type: "individual", ...payload })),
      metaApiVersion: META_API_VERSION,
    }),
  );
}

export const sendWhatsAppText = (to, body) => sendWhatsApp({ to, type: "text", text: { preview_url: true, body: body.slice(0, 4000) } });

export const sendWhatsAppButtons = (to, body, buttons) =>
  sendWhatsApp({
    to,
    type: "interactive",
    interactive: {
      type: "button",
      body: { text: body.slice(0, 1024) },
      action: { buttons: buttons.slice(0, 3).map((b) => ({ type: "reply", reply: { id: b.id.slice(0, 256), title: b.title.slice(0, 20) } })) },
    },
  });

export async function downloadWhatsAppImage(mediaId, key) {
  const media = await social.send(
    new GetWhatsAppMessageMediaCommand({
      mediaId,
      originationPhoneNumberId: PHONE_NUMBER_ID,
      destinationS3File: { bucketName: BUCKET_NAME, key },
    }),
  );
  const object = await s3.send(new GetObjectCommand({ Bucket: BUCKET_NAME, Key: key }));
  const bytes = await object.Body.transformToByteArray();
  return { bytes, mimeType: media.mimeType ?? object.ContentType ?? "image/jpeg" };
}

export const photoUrl = (key) => (key ? getSignedUrl(s3, new GetObjectCommand({ Bucket: BUCKET_NAME, Key: key }), { expiresIn: 3600 }) : "");

export const converse = (input) =>
  bedrock.send(new ConverseCommand({ modelId: MODEL_ID, inferenceConfig: { maxTokens: 2000, temperature: 0.2 }, ...input }));

export async function callTool({ system, content, tool }) {
  const response = await converse({
    system: [{ text: system }],
    messages: [{ role: "user", content }],
    toolConfig: { tools: [{ toolSpec: tool }], toolChoice: { tool: { name: tool.name } } },
    inferenceConfig: { maxTokens: 4000, temperature: 0 },
  });
  const toolUse = response.output?.message?.content?.find((block) => block.toolUse)?.toolUse;
  if (!toolUse) throw new Error("model returned no tool call");
  return toolUse.input;
}
