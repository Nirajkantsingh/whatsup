const { Client, LocalAuth } = require("whatsapp-web.js");
const qrcode = require("qrcode-terminal");
const QRCode = require("qrcode");
const path = require("path");
const { GoogleGenAI } = require("@google/genai");
require("dotenv").config();

// --- Configuration ---
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const ALLOWED_GROUPS = process.env.ALLOWED_GROUPS
  ? process.env.ALLOWED_GROUPS.split(",").map((id) => id.trim())
  : [];
const SYSTEM_PROMPT =
  process.env.SYSTEM_PROMPT ||
  "You are a helpful WhatsApp group assistant. Keep responses concise.";

if (!GEMINI_API_KEY) {
  console.error("ERROR: Set GEMINI_API_KEY in your .env file.");
  process.exit(1);
}

const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });

// Store recent conversation history per group (keeps last 50 messages for context)
const groupHistory = new Map();
const MAX_HISTORY = 50;
const historyFetched = new Set(); // Track which groups have had history loaded

// --- WhatsApp Client Setup ---
const client = new Client({
  authStrategy: new LocalAuth(),
  puppeteer: {
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  },
});

// Display QR code for authentication and save as image
const QR_IMAGE_PATH = path.join(__dirname, "whatsapp-qr.png");

client.on("qr", async (qr) => {
  console.log("Scan this QR code with WhatsApp on your phone:\n");
  qrcode.generate(qr, { small: true });

  // Save QR code as PNG image
  try {
    await QRCode.toFile(QR_IMAGE_PATH, qr, { width: 512, margin: 2 });
    console.log(`\nQR code image saved to: ${QR_IMAGE_PATH}\n`);
  } catch (err) {
    console.error("Failed to save QR image:", err.message);
  }
});

client.on("authenticated", () => {
  console.log("Authenticated successfully!");
});

client.on("auth_failure", (msg) => {
  console.error("Authentication failed:", msg);
});

client.on("ready", async () => {
  console.log("WhatsApp bot is ready!");
  console.log("Checking for unread messages...\n");

  // Respond to messages received while the bot was offline
  await respondToUnreadMessages();

  console.log("Listening for group messages...\n");
});

// --- Respond to unread messages from all groups ---
async function respondToUnreadMessages() {
  try {
    const chats = await client.getChats();
    const allGroups = chats.filter((chat) => chat.isGroup);
    console.log("All groups:");
    allGroups.forEach((g) => console.log(`  - "${g.name}" => ${g.id._serialized}`));

    const groupChats = allGroups.filter(
      (chat) => chat.unreadCount > 0 && isAllowedGroup(chat.id._serialized)
    );

    console.log(`Found ${groupChats.length} group(s) with unread messages.`);

    for (const chat of groupChats) {
      const groupId = chat.id._serialized;
      const unreadCount = Math.min(chat.unreadCount, 50);

      console.log(`Processing ${unreadCount} unread messages in "${chat.name}"...`);

      const messages = await chat.fetchMessages({ limit: unreadCount });

      // Load messages into history for context
      for (const msg of messages) {
        if (!msg.body || !msg.body.trim()) continue;
        const contact = await msg.getContact();
        const sender = msg.fromMe ? "Bot" : (contact.pushname || contact.number);
        addToHistory(groupId, sender, msg.body);
      }

      // Find the last message that is not from the bot and respond to it
      const lastUserMsg = [...messages].reverse().find(
        (m) => !m.fromMe && m.body && m.body.trim()
      );

      if (lastUserMsg) {
        const contact = await lastUserMsg.getContact();
        const senderName = contact.pushname || contact.number;
        const userMessage = lastUserMsg.body.trim();

        console.log(`Replying to "${senderName}" in "${chat.name}": ${userMessage.substring(0, 50)}...`);

        await chat.sendStateTyping();
        const reply = await getAIResponse(groupId, userMessage, senderName);
        await lastUserMsg.reply(reply);

        console.log(`[BOT -> ${chat.name}]: ${reply.substring(0, 100)}...`);
      }

      // Mark chat as read
      await chat.sendSeen();
    }
  } catch (err) {
    console.error("Error processing unread messages:", err.message);
  }
}

// --- Handle new members joining a group ---
client.on("group_join", async (notification) => {
  try {
    const chat = await notification.getChat();
    const contact = await notification.getRecipientContact?.();
    const name = contact?.pushname || contact?.number || "there";

    console.log(`New member joined group: ${chat.name} (${chat.id._serialized})`);

    if (!isAllowedGroup(chat.id._serialized)) return;

    const welcomeMsg = await getAIResponse(
      chat.id._serialized,
      `A new member named "${name}" just joined the group "${chat.name}". Generate a short, warm welcome message for them.`,
      "system"
    );

    await chat.sendMessage(welcomeMsg);
  } catch (err) {
    console.error("Error handling group join:", err.message);
  }
});

// --- Handle incoming messages ---
client.on("message", async (msg) => {
  try {
    const chat = await msg.getChat();

    // Only respond in group chats
    if (!chat.isGroup) return;

    const groupId = chat.id._serialized;

    // Check if this group is allowed
    if (!isAllowedGroup(groupId)) return;

    // Fetch existing chat history on first encounter with this group
    await fetchGroupHistory(chat);

    const contact = await msg.getContact();
    const senderName = contact.pushname || contact.number;

    console.log(`[${chat.name}] ${senderName}: ${msg.body}`);

    // Store message in history (skip if already loaded from fetch)
    addToHistory(groupId, senderName, msg.body);

    // Skip empty messages
    const userMessage = msg.body.trim();
    if (!userMessage) return;

    // Skip messages sent by the bot itself
    if (msg.fromMe) return;

    // Show typing indicator
    await chat.sendStateTyping();

    const reply = await getAIResponse(groupId, userMessage, senderName);

    await msg.reply(reply);
    console.log(`[BOT -> ${chat.name}]: ${reply.substring(0, 100)}...`);
  } catch (err) {
    console.error("Error handling message:", err.message);
  }
});

// --- AI Response using Gemini ---
async function getAIResponse(groupId, userMessage, senderName) {
  // Build conversation context from history
  const history = groupHistory.get(groupId) || [];
  const chatHistory = history
    .map((entry) => `[${entry.sender}]: ${entry.message}`)
    .join("\n");

  const currentMsg =
    senderName === "system"
      ? userMessage
      : `[${senderName}]: ${userMessage}`;

  const prompt = `${SYSTEM_PROMPT}

Here is the recent conversation history from the group chat:
${chatHistory}

Now respond to this latest message:
${currentMsg}`;

  try {
    const response = await ai.models.generateContent({
      model: process.env.MODEL_NAME || "gemini-3-flash-preview",
      contents: prompt,
    });

    const reply = response.text;

    // Store bot reply in history
    addToHistory(groupId, "Bot", reply);

    return reply;
  } catch (err) {
    console.error("Gemini API error:", err.message);
    return "Sorry, I couldn't process that right now. Try again later.";
  }
}

// --- Fetch existing chat history from a group ---
async function fetchGroupHistory(chat) {
  const groupId = chat.id._serialized;
  if (historyFetched.has(groupId)) return;
  historyFetched.add(groupId);

  try {
    const messages = await chat.fetchMessages({ limit: 50 });
    console.log(`Fetched ${messages.length} previous messages from "${chat.name}"`);

    for (const msg of messages) {
      if (!msg.body || !msg.body.trim()) continue;
      const contact = await msg.getContact();
      const sender = msg.fromMe ? "Bot" : (contact.pushname || contact.number);
      addToHistory(groupId, sender, msg.body);
    }
  } catch (err) {
    console.error(`Failed to fetch history for "${chat.name}":`, err.message);
  }
}

// --- Helpers ---
function isAllowedGroup(groupId) {
  if (ALLOWED_GROUPS.length === 0) return true;
  return ALLOWED_GROUPS.includes(groupId);
}

function addToHistory(groupId, sender, message) {
  if (!groupHistory.has(groupId)) {
    groupHistory.set(groupId, []);
  }
  const history = groupHistory.get(groupId);
  history.push({ sender, message, timestamp: Date.now() });
  if (history.length > MAX_HISTORY) {
    history.shift();
  }
}

// --- Graceful shutdown ---
process.on("SIGINT", async () => {
  console.log("\nShutting down...");
  await client.destroy();
  process.exit(0);
});

// --- Start the bot ---
console.log("Starting WhatsApp bot...");
client.initialize();
