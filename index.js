require("dotenv").config();

const path = require("path");
const fs = require("fs/promises");
const fsSync = require("fs");
const express = require("express");
const session = require("express-session");
const FileStoreFactory = require("session-file-store");
const multer = require("multer");
const qrcode = require("qrcode-terminal");
const QRCode = require("qrcode");
const Groq = require("groq-sdk");
const bcrypt = require("bcryptjs");
const { Client, LocalAuth, MessageMedia } = require("whatsapp-web.js");
const { open } = require("sqlite");
const sqlite3 = require("sqlite3");
const cheerio = require("cheerio");
const mammoth = require("mammoth");
const { PDFParse } = require("pdf-parse");
const Tesseract = require("tesseract.js");
const { Pool } = require("pg");
let Redis = null;
try {
  Redis = require("ioredis");
} catch (_error) {
  Redis = null;
}
const {
  createRuntimeConfig,
  normalizeProvider,
  defaultModelForProvider,
  SUPPORTED_PROVIDERS,
} = require("./src/config/runtime");
const { mountStatusRoute } = require("./src/api/routes/status");

const runtime = createRuntimeConfig(__dirname);
const {
  PORT,
  GROQ_API_KEY,
  OPENAI_API_KEY,
  GEMINI_API_KEY,
  OPENROUTER_API_KEY,
  LOCALAI_API_KEY,
  LOCALAI_BASE_URL,
  WA_CLIENT_ID,
  SKIP_WHATSAPP_INIT,
  WA_COUNTRY_CODE,
  WA_NOTIFY_COUNSELOR,
  CHROME_EXECUTABLE_PATH,
  DATA_DIR,
  UPLOADS_DIR,
  DB_PATH,
  SESSIONS_DIR,
  SESSION_SECRET,
  ALLOW_REGISTER,
  DATABASE_URL,
  REDIS_URL,
  DEFAULT_PROVIDER,
  DEFAULT_SETTINGS,
} = runtime;

function hasUsableApiKey(value) {
  const key = String(value || "").trim();
  if (!key) return false;
  if (key.startsWith("your_")) return false;
  return true;
}

const logs = [];
let whatsappReady = false;
let whatsappAuthenticated = false;
let latestQr = null;
let latestQrImage = null;
let latestQrAt = null;
let latestWhatsAppInitError = "";
let db;
let pgPool = null;
let activeDbDialect = "sqlite";
let redisClient = null;
const MAX_HISTORY_MESSAGES = 12;
const RECENT_MESSAGE_TTL_MS = 5 * 60 * 1000;
const processedMessageIds = new Map();
const activeChatReplies = new Set();
const WHATSAPP_INIT_MAX_ATTEMPTS = 4;
const WHATSAPP_INIT_RETRY_DELAY_MS = 5000;
let whatsappReinitTimer = null;

const DEFAULT_ORGANIZATION_NAME = "Default workspace";
const DEFAULT_PLAN = "starter";

function currentIsoDateSql() {
  return activeDbDialect === "postgres" ? "NOW()" : "datetime('now')";
}

function toPostgresSql(sql) {
  let idx = 0;
  return String(sql || "")
    .replace(/\?/g, () => {
      idx += 1;
      return `$${idx}`;
    })
    .replace(/datetime\('now'\)/g, "NOW()");
}

async function dbGet(sql, params = []) {
  if (activeDbDialect === "postgres") {
    const result = await pgPool.query(toPostgresSql(sql), params);
    return result.rows[0] || null;
  }
  return db.get(sql, params);
}

async function dbAll(sql, params = []) {
  if (activeDbDialect === "postgres") {
    const result = await pgPool.query(toPostgresSql(sql), params);
    return result.rows;
  }
  return db.all(sql, params);
}

async function dbRun(sql, params = []) {
  if (activeDbDialect === "postgres") {
    const result = await pgPool.query(toPostgresSql(sql), params);
    return {
      changes: result.rowCount || 0,
      lastID: result.rows?.[0]?.id,
    };
  }
  return db.run(sql, params);
}

const groq = GROQ_API_KEY ? new Groq({ apiKey: GROQ_API_KEY }) : null;
const SUPPORTED_FILE_EXTENSIONS = new Set([
  ".txt",
  ".md",
  ".csv",
  ".json",
  ".pdf",
  ".docx",
  ".doc",
  ".png",
  ".jpg",
  ".jpeg",
  ".webp",
  ".bmp",
  ".tif",
  ".tiff",
]);
const IMAGE_FILE_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".webp",
  ".bmp",
  ".tif",
  ".tiff",
]);
const SOCIAL_HOST_KEYWORDS = [
  "tiktok.com",
  "instagram.com",
  "facebook.com",
  "youtube.com",
  "youtu.be",
  "linkedin.com",
  "x.com",
  "twitter.com",
];

function addLog(level, message, meta = {}) {
  const entry = {
    ts: new Date().toISOString(),
    level,
    message,
    meta,
  };
  logs.unshift(entry);
  if (logs.length > 200) logs.pop();
  if (level === "error") {
    console.error(message, meta);
  } else {
    console.log(message, meta);
  }
}

function keywordScore(query, content) {
  const tokenize = (text) =>
    (text || "")
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .match(/[a-z0-9]{3,}/g) || [];
  const qTokens = tokenize(query);
  const cTokens = tokenize(content);
  if (!qTokens.length || !cTokens.length) return 0;
  const qSet = new Set(qTokens);
  const cSet = new Set(cTokens);
  let overlap = 0;
  for (const token of qSet) {
    if (cSet.has(token)) overlap += 1;
  }
  const base = overlap / qSet.size;
  const normalizedQuery = (query || "").toLowerCase();
  const normalizedContent = (content || "").toLowerCase();
  const phraseBoost =
    normalizedQuery.length >= 8 && normalizedContent.includes(normalizedQuery)
      ? 0.35
      : 0;
  return Math.min(1, base + phraseBoost);
}

function splitIntoChunks(text, chunkSize = 1200, overlap = 150) {
  const clean = (text || "").replace(/\s+/g, " ").trim();
  if (!clean) return [];
  const chunks = [];
  let i = 0;
  while (i < clean.length) {
    const end = Math.min(clean.length, i + chunkSize);
    chunks.push(clean.slice(i, end));
    if (end >= clean.length) break;
    i = end - overlap;
  }
  return chunks;
}

function sanitizeText(rawText) {
  return (rawText || "")
    .replace(/\u0000/g, "")
    .replace(/[^\x09\x0A\x0D\x20-\x7E\u00A0-\u024F]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isLikelyBinary(text) {
  if (!text) return true;
  const sample = text.slice(0, 200);
  const nonPrintable = (sample.match(/[^\x09\x0A\x0D\x20-\x7E\u00A0-\u024F]/g) || [])
    .length;
  return sample.startsWith("\u0089PNG") || nonPrintable > Math.max(8, sample.length * 0.2);
}

function isSocialUrl(rawUrl) {
  try {
    const hostname = new URL(rawUrl).hostname.toLowerCase();
    return SOCIAL_HOST_KEYWORDS.some((domain) => hostname.includes(domain));
  } catch (_error) {
    return false;
  }
}

function normalizeUrl(rawUrl) {
  const parsed = new URL(rawUrl);
  parsed.hash = "";
  return parsed.toString();
}

function makeSafeFileName(fileName) {
  const ext = path.extname(fileName || "");
  const base = path.basename(fileName || "file", ext);
  const safeBase = base.replace(/[^a-zA-Z0-9-_]+/g, "_").slice(0, 80) || "file";
  return `${Date.now()}-${safeBase}${ext}`.slice(0, 140);
}

async function extractTextFromFile(file) {
  const ext = path.extname(file.originalname || "").toLowerCase();
  const mime = file.mimetype || "";
  if (!SUPPORTED_FILE_EXTENSIONS.has(ext)) {
    throw new Error(
      "Format non supporté. Utilise texte/markdown/csv/json/pdf/docx ou une image (png/jpg/webp)."
    );
  }
  if (mime.startsWith("image/") || IMAGE_FILE_EXTENSIONS.has(ext)) {
    try {
      const ocrLang = process.env.OCR_LANG || "fra+eng";
      const result = await Tesseract.recognize(file.buffer, ocrLang);
      const text = sanitizeText(result?.data?.text || "");
      if (text.length < 30) {
        throw new Error(
          "Image importée mais texte insuffisant détecté. Vérifie la lisibilité ou la qualité de l'image."
        );
      }
      return text;
    } catch (error) {
      throw new Error(`OCR image impossible: ${error.message}`);
    }
  }
  if (mime.includes("pdf") || ext === ".pdf") {
    try {
      const parser = new PDFParse({ data: file.buffer });
      const parsed = await parser.getText();
      await parser.destroy();
      const text = sanitizeText(parsed?.text || "");
      if (text.length < 40) {
        throw new Error(
          "Le PDF semble vide ou scanné en image. Utilise un PDF texte (OCR) ou exporte en texte."
        );
      }
      return text;
    } catch (error) {
      throw new Error(`Lecture PDF impossible: ${error.message}`);
    }
  }
  if (
    mime.includes("wordprocessingml") ||
    ext === ".docx" ||
    ext === ".doc"
  ) {
    const parsed = await mammoth.extractRawText({ buffer: file.buffer });
    return sanitizeText(parsed.value || "");
  }
  const decoded = sanitizeText(file.buffer.toString("utf-8"));
  if (isLikelyBinary(decoded)) {
    throw new Error(
      "Le fichier ne contient pas de texte exploitable. Évite les images ou formats binaires."
    );
  }
  return decoded;
}

async function extractTextFromUrl(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`URL inaccessible (${response.status})`);
  }
  const html = await response.text();
  const $ = cheerio.load(html);
  $("script, style, noscript").remove();
  const title =
    $("meta[property='og:title']").attr("content")?.trim() ||
    $("meta[name='twitter:title']").attr("content")?.trim() ||
    $("title").first().text().trim();
  const description =
    $("meta[property='og:description']").attr("content")?.trim() ||
    $("meta[name='description']").attr("content")?.trim() ||
    $("meta[name='twitter:description']").attr("content")?.trim() ||
    "";
  const bodyText = $("body").text().replace(/\s+/g, " ").trim();
  const links = Array.from($("a[href]"))
    .map((el) => $(el).attr("href"))
    .filter(Boolean)
    .slice(0, 40);
  const merged = sanitizeText(
    [title, description, bodyText, `URL: ${url}`, links.join(" ")]
      .filter(Boolean)
      .join("\n\n")
  );
  const socialFallback = sanitizeText(
    [
      title || "Contenu réseau social",
      description || "",
      `Lien source: ${url}`,
      "Le contenu complet est potentiellement dynamique et peut nécessiter une consultation directe du lien.",
    ].join("\n")
  );
  if (merged.length < 60 && isSocialUrl(url)) {
    return { title: title || url, text: socialFallback };
  }
  if (merged.length < 30) {
    return {
      title: title || url,
      text: sanitizeText(`Source web enregistrée: ${url}`),
    };
  }
  return { title: title || url, text: merged };
}

async function crawlWebsite(baseUrl, maxPages = 12) {
  const start = normalizeUrl(baseUrl);
  const startHost = new URL(start).hostname;
  const queue = [start];
  const visited = new Set();
  const pages = [];

  while (queue.length && pages.length < maxPages) {
    const current = queue.shift();
    if (!current || visited.has(current)) continue;
    visited.add(current);
    try {
      const response = await fetch(current);
      if (!response.ok) continue;
      const html = await response.text();
      const $ = cheerio.load(html);
      $("script, style, noscript").remove();
      const title = $("title").first().text().trim() || current;
      const text = sanitizeText($("body").text());
      if (text.length > 20) {
        pages.push({
          url: current,
          title,
          text: sanitizeText(`${title}\n${text}`),
        });
      }
      $("a[href]").each((_idx, el) => {
        const href = $(el).attr("href");
        if (!href) return;
        try {
          const next = normalizeUrl(new URL(href, current).toString());
          const parsed = new URL(next);
          if (parsed.hostname !== startHost) return;
          if (visited.has(next)) return;
          if (/\.(pdf|jpg|jpeg|png|gif|zip|mp4|mp3|webp)$/i.test(parsed.pathname)) return;
          queue.push(next);
        } catch (_error) {
          // Ignore malformed link.
        }
      });
    } catch (_error) {
      // Ignore pages that cannot be fetched during crawl.
    }
  }

  return pages;
}

async function getSettings(organizationId = 1) {
  const rows = await dbAll(
    "SELECT key, value FROM settings WHERE organization_id = ?",
    [organizationId]
  );
  const values = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  const provider = normalizeProvider(values.provider || DEFAULT_SETTINGS.provider);
  const model = values.model || defaultModelForProvider(provider);
  return {
    provider,
    model,
    temperature: Number(values.temperature || DEFAULT_SETTINGS.temperature),
    system_prompt: values.system_prompt || DEFAULT_SETTINGS.system_prompt,
    top_k: Number(values.top_k || DEFAULT_SETTINGS.top_k),
    human_delay_min_ms: Number(
      values.human_delay_min_ms || DEFAULT_SETTINGS.human_delay_min_ms
    ),
    human_delay_max_ms: Number(
      values.human_delay_max_ms || DEFAULT_SETTINGS.human_delay_max_ms
    ),
    reply_chunk_min_sentences: Number(
      values.reply_chunk_min_sentences ?? DEFAULT_SETTINGS.reply_chunk_min_sentences
    ),
    reply_chunk_max_sentences: Number(
      values.reply_chunk_max_sentences ?? DEFAULT_SETTINGS.reply_chunk_max_sentences
    ),
    reply_chunk_delay_min_ms: Number(
      values.reply_chunk_delay_min_ms ?? DEFAULT_SETTINGS.reply_chunk_delay_min_ms
    ),
    reply_chunk_delay_max_ms: Number(
      values.reply_chunk_delay_max_ms ?? DEFAULT_SETTINGS.reply_chunk_delay_max_ms
    ),
  };
}

async function setSettings(nextValues, organizationId = 1) {
  for (const [key, value] of Object.entries(nextValues)) {
    if (activeDbDialect === "postgres") {
      await dbRun(
        "INSERT INTO settings(organization_id, key, value) VALUES (?, ?, ?) ON CONFLICT(organization_id, key) DO UPDATE SET value = excluded.value",
        [organizationId, key, String(value)]
      );
    } else {
      await dbRun(
        "INSERT INTO settings(organization_id, key, value) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        [organizationId, key, String(value)]
      );
    }
  }
}

async function seedDefaultSettingsIfMissing() {
  const orgId = await ensureDefaultOrganization();
  for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
    if (activeDbDialect === "postgres") {
      await dbRun(
        "INSERT INTO settings(organization_id, key, value) VALUES (?, ?, ?) ON CONFLICT (organization_id, key) DO NOTHING",
        [orgId, key, String(value)]
      );
    } else {
      await dbRun(
        "INSERT OR IGNORE INTO settings(organization_id, key, value) VALUES (?, ?, ?)",
        [orgId, key, String(value)]
      );
    }
  }
}

async function ensureDefaultOrganization() {
  const existing = await dbGet("SELECT id FROM organizations ORDER BY id ASC LIMIT 1");
  if (existing?.id) return Number(existing.id);
  if (activeDbDialect === "postgres") {
    const inserted = await dbRun(
      `INSERT INTO organizations(name, plan, created_at) VALUES (?, ?, ${currentIsoDateSql()}) RETURNING id`,
      [DEFAULT_ORGANIZATION_NAME, DEFAULT_PLAN]
    );
    if (inserted?.lastID) return Number(inserted.lastID);
  } else {
    const inserted = await dbRun(
      `INSERT INTO organizations(name, plan, created_at) VALUES (?, ?, ${currentIsoDateSql()})`,
      [DEFAULT_ORGANIZATION_NAME, DEFAULT_PLAN]
    );
    if (inserted?.lastID) return Number(inserted.lastID);
  }
  const fallback = await dbGet("SELECT id FROM organizations ORDER BY id ASC LIMIT 1");
  return Number(fallback?.id || 1);
}

async function backfillTenantColumns() {
  const orgId = await ensureDefaultOrganization();
  const statements = [
    ["UPDATE settings SET organization_id = ? WHERE organization_id IS NULL", [orgId]],
    ["UPDATE documents SET organization_id = ? WHERE organization_id IS NULL", [orgId]],
    ["UPDATE chunks SET organization_id = ? WHERE organization_id IS NULL", [orgId]],
    ["UPDATE conversation_messages SET organization_id = ? WHERE organization_id IS NULL", [orgId]],
    ["UPDATE knowledge_assets SET organization_id = ? WHERE organization_id IS NULL", [orgId]],
  ];
  for (const [sql, params] of statements) {
    try {
      await dbRun(sql, params);
    } catch (_error) {
      // Legacy DBs may not require backfill.
    }
  }
}

async function runSqliteColumnMigrations() {
  if (activeDbDialect !== "sqlite") return;
  const alterStatements = [
    "ALTER TABLE settings ADD COLUMN organization_id INTEGER NOT NULL DEFAULT 1",
    "ALTER TABLE documents ADD COLUMN organization_id INTEGER NOT NULL DEFAULT 1",
    "ALTER TABLE chunks ADD COLUMN organization_id INTEGER NOT NULL DEFAULT 1",
    "ALTER TABLE conversation_messages ADD COLUMN organization_id INTEGER NOT NULL DEFAULT 1",
    "ALTER TABLE knowledge_assets ADD COLUMN organization_id INTEGER NOT NULL DEFAULT 1",
  ];
  for (const sql of alterStatements) {
    try {
      await db.exec(sql);
    } catch (_error) {
      // Column probably already exists in existing or fresh schema.
    }
  }
}

async function addConversationMessage(chatId, role, content, organizationId = 1) {
  const cleanContent = sanitizeText(content || "");
  if (!chatId || !role || !cleanContent) return;
  await dbRun(
    `INSERT INTO conversation_messages(organization_id, chat_id, role, content, created_at)
     VALUES (?, ?, ?, ?, ${currentIsoDateSql()})`,
    [organizationId, chatId, role, cleanContent]
  );
}

async function getConversationHistory(chatId, limit = MAX_HISTORY_MESSAGES, organizationId = 1) {
  if (!chatId) return [];
  const rows = await dbAll(
    `SELECT role, content
     FROM conversation_messages
     WHERE organization_id = ?
       AND chat_id = ?
     ORDER BY id DESC
     LIMIT ?`,
    [organizationId, chatId, Math.max(1, limit)]
  );
  return rows.reverse();
}

async function createKnowledgeAsset({
  organizationId = 1,
  documentId,
  assetType,
  title,
  source,
  mimeType = "",
  filePath = "",
}) {
  await dbRun(
    `INSERT INTO knowledge_assets(organization_id, document_id, asset_type, title, source, mime_type, file_path, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ${currentIsoDateSql()})`,
    [organizationId, documentId, assetType, title, source, mimeType, filePath]
  );
}

async function findShareableAssets(query, limit = 5, organizationId = 1) {
  const rows = await dbAll(
    `SELECT ka.id, ka.asset_type, ka.title, ka.source, ka.mime_type, ka.file_path
     FROM knowledge_assets ka
     WHERE ka.organization_id = ?`,
    [organizationId]
  );
  const scored = rows
    .map((row) => ({
      ...row,
      score: keywordScore(query, `${row.title} ${row.source}`),
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.max(1, limit));
  const useful = scored.filter((row) => row.score > 0.03);
  return useful.length ? useful : scored.slice(0, Math.min(3, scored.length));
}

async function findFileAssetsForShare(query, limit = 3, organizationId = 1) {
  const rows = await dbAll(
    `SELECT id, asset_type, title, source, mime_type, file_path, created_at
     FROM knowledge_assets
     WHERE organization_id = ?
       AND asset_type = 'file'
     ORDER BY created_at DESC`,
    [organizationId]
  );
  if (!rows.length) return [];
  const scored = rows
    .map((row) => ({
      ...row,
      score: keywordScore(query, `${row.title} ${row.source}`),
    }))
    .sort((a, b) => b.score - a.score);
  const useful = scored.filter((row) => row.score > 0.02);
  const pool = useful.length ? useful : scored;
  return pool.slice(0, Math.max(1, limit));
}

async function findOrCreateContactByPhone(phone, organizationId = 1) {
  if (!phone) return null;
  const normalized = String(phone || "").replace(/[^\d+]/g, "");
  if (!normalized) return null;
  let contact = await dbGet(
    "SELECT id, phone, name, status, tags, notes, created_at FROM contacts WHERE organization_id = ? AND phone = ?",
    [organizationId, normalized]
  );
  if (contact) return contact;
  await dbRun(
    `INSERT INTO contacts(organization_id, phone, status, created_at)
     VALUES(?, ?, 'new', ${currentIsoDateSql()})`,
    [organizationId, normalized]
  );
  contact = await dbGet(
    "SELECT id, phone, name, status, tags, notes, created_at FROM contacts WHERE organization_id = ? AND phone = ?",
    [organizationId, normalized]
  );
  return contact;
}

async function syncLeadFromConversation(chatId, organizationId = 1) {
  const digits = String(chatId || "").replace(/\D/g, "");
  if (!digits) return null;
  const contact = await findOrCreateContactByPhone(digits, organizationId);
  if (!contact) return null;
  await dbRun(
    "UPDATE contacts SET last_message_at = " +
      currentIsoDateSql() +
      " WHERE organization_id = ? AND id = ?",
    [organizationId, contact.id]
  );
  const existingDeal = await dbGet(
    "SELECT id FROM deals WHERE organization_id = ? AND contact_id = ? ORDER BY id ASC LIMIT 1",
    [organizationId, contact.id]
  );
  if (!existingDeal) {
    await dbRun(
      `INSERT INTO deals(organization_id, contact_id, pipeline_stage, note, created_at)
       VALUES(?, ?, 'Nouveau lead', 'Lead créé automatiquement depuis WhatsApp', ${currentIsoDateSql()})`,
      [organizationId, contact.id]
    );
  }
  return contact;
}

function isFileShareIntent(userText) {
  const text = (userText || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return false;

  if (/(sans lien|ne .*pas .*lien|pas de lien|n'envoie rien|n envoie rien)/.test(text)) {
    return false;
  }

  const asksToSend =
    /\b(envoie|envoyer|partage|partager|donne|donner|fournis|fournir|transmets|transmettre|joindre|joint)\b/.test(
      text
    );
  const asksForFileType =
    /\b(document|documents|fichier|fichiers|pdf|docx|image|images|photo|photos|affiche|affiches|flyer|flyers|brochure|brochures|catalogue|catalogues|programme|programmes|fiche|fiches)\b/.test(
      text
    );
  const directPatterns = [
    /peux[- ]?tu .*?(m'?envoyer|partager|donner|transmettre)/,
    /tu peux .*?(m'?envoyer|partager|donner|transmettre)/,
    /j(?:e|')aimerais .*?(un|des) (document|fichier|pdf|image|affiche|flyer|brochure|catalogue)/,
    /envoie[- ]?moi .*?(document|fichier|pdf|image|affiche|flyer|brochure|catalogue)/,
  ];
  if (directPatterns.some((pattern) => pattern.test(text))) return true;

  return asksToSend && asksForFileType;
}

function shouldShareAssets(userText) {
  const text = (userText || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return false;

  // Respect explicit user opt-out, even when a resource keyword exists.
  if (/(sans lien|ne .*pas .*lien|pas de lien|n'envoie rien|n envoie rien)/.test(text)) {
    return false;
  }

  const asksToSend = /\b(envoie|envoyer|partage|partager|donne|donner|fournis|fournir|transmets|transmettre)\b/.test(
    text
  );
  const asksForResourceType =
    /\b(lien|liens|url|source|sources|document|documents|fichier|fichiers|pdf|docx|image|images|photo|photos)\b/.test(
      text
    );
  const directPatterns = [
    /peux[- ]?tu .*?(m'?envoyer|partager|donner)/,
    /tu peux .*?(m'?envoyer|partager|donner)/,
    /j(?:e|')aimerais .*?(un|des) (lien|liens|document|documents|fichier|fichiers|pdf)/,
    /donne[- ]?moi .*?(lien|liens|source|sources|document|documents|fichier|fichiers|pdf)/,
    /envoie[- ]?moi .*?(lien|liens|document|documents|fichier|fichiers|pdf)/,
  ];
  if (directPatterns.some((pattern) => pattern.test(text))) return true;

  return asksToSend && asksForResourceType;
}

async function sendKnowledgeAssets(client, chatId, assets) {
  const sent = [];
  for (const asset of assets.slice(0, 3)) {
    if (asset.asset_type === "url") {
      await client.sendMessage(chatId, `Lien utile: ${asset.source}`);
      sent.push({ id: asset.id, type: "url", value: asset.source });
      continue;
    }
    if (asset.asset_type === "file" && asset.file_path) {
      try {
        const absolutePath = path.isAbsolute(asset.file_path)
          ? asset.file_path
          : path.join(__dirname, asset.file_path);
        const fileExists = fsSync.existsSync(absolutePath);
        if (!fileExists) {
          addLog("error", "Fichier knowledge introuvable sur disque.", {
            assetId: asset.id,
            path: absolutePath,
          });
          continue;
        }
        const media = MessageMedia.fromFilePath(absolutePath);
        const sendAsDocument = !String(asset.mime_type || "").startsWith("image/");
        await client.sendMessage(chatId, media, {
          caption: asset.title || "Document demandé",
          sendMediaAsDocument: sendAsDocument,
        });
        sent.push({ id: asset.id, type: "file", value: absolutePath });
      } catch (error) {
        addLog("error", "Impossible d'envoyer un fichier demandé.", {
          assetId: asset.id,
          error: error.message,
        });
      }
    }
  }
  return sent;
}

function extractLikelyPhoneNumbers(text) {
  const source = String(text || "");
  const regex = /(\+?\d[\d\s().-]{7,}\d)/g;
  const matches = source.match(regex) || [];
  const normalized = matches
    .map((raw) => raw.replace(/[^\d+]/g, ""))
    .map((raw) => (raw.startsWith("+") ? raw : raw))
    .filter((raw) => raw.replace(/\D/g, "").length >= 8);
  return [...new Set(normalized)];
}

function phoneToChatId(rawPhone) {
  const digits = String(rawPhone || "").replace(/\D/g, "");
  if (!digits) return null;
  if (String(rawPhone || "").trim().startsWith("+")) {
    return `${digits}@c.us`;
  }
  if (digits.length <= 10 && WA_COUNTRY_CODE) {
    return `${WA_COUNTRY_CODE}${digits}@c.us`;
  }
  return `${digits}@c.us`;
}

function shouldNotifyCounselor(userText, assistantReply) {
  const text = `${userText || ""} ${assistantReply || ""}`
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
  const referralIntent =
    /\b(conseiller|agent|commercial|responsable|service client|support|contact)\b/.test(text) &&
    /\b(numero|num|telephone|tel|contacter|joindre|appeler)\b/.test(text);
  return referralIntent;
}

async function notifyCounselorIfNeeded(client, chatId, userText, assistantReply) {
  if (!WA_NOTIFY_COUNSELOR) return null;
  if (!shouldNotifyCounselor(userText, assistantReply)) return null;
  const numbers = extractLikelyPhoneNumbers(assistantReply);
  if (!numbers.length) return null;

  const customerDigits = String(chatId || "").replace(/\D/g, "");
  for (const number of numbers.slice(0, 2)) {
    const counselorChatId = phoneToChatId(number);
    if (!counselorChatId) continue;
    const counselorDigits = counselorChatId.replace(/\D/g, "");
    if (customerDigits && counselorDigits.endsWith(customerDigits)) {
      continue;
    }
    try {
      await client.sendMessage(
        counselorChatId,
        [
          "Bonjour,",
          "Le bot vient de transmettre votre numéro à un client.",
          `Client: ${chatId}`,
          "Le client pourrait vous contacter bientôt.",
        ].join("\n")
      );
      return counselorChatId;
    } catch (error) {
      addLog("error", "Impossible de notifier le conseiller.", {
        counselorChatId,
        error: error.message,
      });
    }
  }
  return null;
}

async function notifyCounselorFromContextIfNeeded(
  client,
  chatId,
  userText,
  assistantReply,
  ragResults = []
) {
  const base = await notifyCounselorIfNeeded(client, chatId, userText, assistantReply);
  if (base) return base;
  if (!WA_NOTIFY_COUNSELOR) return null;
  if (!shouldNotifyCounselor(userText, assistantReply)) return null;
  const contextText = ragResults.map((r) => r?.content || "").join("\n");
  const numbers = extractLikelyPhoneNumbers(contextText);
  if (!numbers.length) return null;
  for (const number of numbers.slice(0, 2)) {
    const counselorChatId = phoneToChatId(number);
    if (!counselorChatId) continue;
    try {
      await client.sendMessage(
        counselorChatId,
        [
          "Bonjour,",
          "Le bot a partagé votre numéro à un client.",
          `Client: ${chatId}`,
          "Le client peut vous joindre sous peu.",
        ].join("\n")
      );
      return counselorChatId;
    } catch (error) {
      addLog("error", "Impossible de notifier le conseiller (contexte).", {
        counselorChatId,
        error: error.message,
      });
    }
  }
  return null;
}

function requireApiKey(provider) {
  if (provider === "groq" && !hasUsableApiKey(GROQ_API_KEY)) {
    throw new Error("GROQ_API_KEY manquant dans .env");
  }
  if (provider === "openai" && !hasUsableApiKey(OPENAI_API_KEY)) {
    throw new Error("OPENAI_API_KEY manquant dans .env");
  }
  if (provider === "gemini" && !hasUsableApiKey(GEMINI_API_KEY)) {
    throw new Error("GEMINI_API_KEY manquant dans .env");
  }
  if (provider === "openrouter" && !hasUsableApiKey(OPENROUTER_API_KEY)) {
    throw new Error("OPENROUTER_API_KEY manquant dans .env");
  }
}

function validateModelForProvider(provider, model) {
  const m = String(model || "").toLowerCase();
  if (provider === "gemini" && !m.includes("gemini")) {
    throw new Error(
      "Le modèle sélectionné n'est pas compatible Gemini. Choisis un modèle Gemini (ex: gemini-1.5-flash)."
    );
  }
  if (provider === "groq" && m.includes("gemini")) {
    throw new Error("Le modèle sélectionné n'est pas compatible Groq.");
  }
}

async function callOpenAICompatibleApi({
  provider,
  baseUrl,
  apiKey,
  model,
  temperature,
  messages,
  extraHeaders = {},
}) {
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      ...extraHeaders,
    },
    body: JSON.stringify({
      model,
      temperature,
      messages,
    }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(
      `${provider.toUpperCase()} API erreur (${response.status}): ${data?.error?.message || "réponse invalide"}`
    );
  }
  const text = data?.choices?.[0]?.message?.content?.trim();
  if (!text) {
    throw new Error(`${provider.toUpperCase()} API: réponse vide`);
  }
  return text;
}

async function callGeminiApi({ model, temperature, messages }) {
  const systemMessages = messages
    .filter((m) => m.role === "system")
    .map((m) => m.content)
    .join("\n\n");
  const contents = messages
    .filter((m) => m.role !== "system")
    .map((m) => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: m.content }],
    }));
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_API_KEY}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        systemInstruction: systemMessages
          ? { parts: [{ text: systemMessages }] }
          : undefined,
        contents: contents.length ? contents : [{ role: "user", parts: [{ text: "Bonjour" }] }],
        generationConfig: { temperature },
      }),
    }
  );
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(
      `GEMINI API erreur (${response.status}): ${data?.error?.message || "réponse invalide"}`
    );
  }
  const text = (data?.candidates?.[0]?.content?.parts || [])
    .map((p) => p?.text || "")
    .join("")
    .trim();
  if (!text) {
    throw new Error("GEMINI API: réponse vide");
  }
  return text;
}

async function generateChatCompletion({ provider, model, temperature, messages }) {
  requireApiKey(provider);
  validateModelForProvider(provider, model);
  if (provider === "groq") {
    if (!groq) throw new Error("Client Groq indisponible");
    const completion = await groq.chat.completions.create({
      model,
      temperature,
      messages,
    });
    const text = completion?.choices?.[0]?.message?.content?.trim();
    if (!text) throw new Error("GROQ API: réponse vide");
    return text;
  }
  if (provider === "openai") {
    return callOpenAICompatibleApi({
      provider,
      baseUrl: "https://api.openai.com/v1",
      apiKey: OPENAI_API_KEY,
      model,
      temperature,
      messages,
    });
  }
  if (provider === "openrouter") {
    return callOpenAICompatibleApi({
      provider,
      baseUrl: "https://openrouter.ai/api/v1",
      apiKey: OPENROUTER_API_KEY,
      model,
      temperature,
      messages,
      extraHeaders: {
        "HTTP-Referer": "http://localhost:3000",
        "X-Title": "Chatbot H-H",
      },
    });
  }
  if (provider === "localai") {
    return callOpenAICompatibleApi({
      provider,
      baseUrl: LOCALAI_BASE_URL.replace(/\/+$/, ""),
      apiKey: LOCALAI_API_KEY,
      model,
      temperature,
      messages,
    });
  }
  if (provider === "gemini") {
    return callGeminiApi({ model, temperature, messages });
  }
  throw new Error(`Provider IA non supporté: ${provider}`);
}

async function generateAssistantResponse(userText, chatId, organizationId = 1) {
  const settings = await getSettings(organizationId);
  const conversationHistory = await getConversationHistory(chatId, MAX_HISTORY_MESSAGES, organizationId);
  let ragResults = [];
  let shareableAssets = [];
  try {
    ragResults = await retrieveContext(userText, settings.top_k, organizationId);
    shareableAssets = await findShareableAssets(userText, 6, organizationId);
  } catch (ragError) {
    addLog("error", "RAG indisponible, fallback sans contexte.", {
      error: ragError.message,
    });
  }
  const assetsContext = shareableAssets.length
    ? shareableAssets
        .map(
          (asset, idx) =>
            `[Ressource ${idx + 1}] type=${asset.asset_type} | titre=${asset.title} | source=${asset.source}`
        )
        .join("\n")
    : "Aucune ressource de partage correspondante trouvée.";
  const ragContext = buildRagContext(ragResults);
  const contextInstruction = ragContext
    ? [
        "Connaissance interne disponible (prioritaire):",
        ragContext,
        "",
        "Consignes strictes:",
        "- Utilise d'abord ces informations avant toute supposition.",
        "- Si la réponse n'est pas dans ce contexte, dis-le clairement et pose une question de précision.",
        "- N'invente jamais une information absente de la base.",
      ].join("\n")
    : "Aucune connaissance interne n'a été trouvée pour cette question.";
  const assetsInstruction = [
    "Ressources partageables disponibles:",
    assetsContext,
    "",
    "Consignes de partage:",
    "- Si l'utilisateur demande un lien ou un fichier, mentionne uniquement des ressources présentes ci-dessus.",
    "- N'invente jamais un lien.",
  ].join("\n");
  const executionRules = [
    "Règles d'exécution:",
    "- Respecte strictement le System Prompt défini par l'utilisateur.",
    "- Réponds en français de façon professionnelle et naturelle.",
    "- Quand un contexte interne est fourni, appuie-toi dessus explicitement.",
    "- Vérifie d'abord les faits dans la base de connaissance avant d'affirmer une information.",
    "- Si l'information n'est pas vérifiable dans le contexte fourni, dis-le clairement.",
    "- Tiens compte de l'historique de conversation pour rester cohérent.",
    "- Ne recommence pas la présentation/salutation complète à chaque message.",
    "- Pour une salutation simple, réponds brièvement puis pose une seule question utile.",
  ].join("\n");
  const messages = [
    { role: "system", content: settings.system_prompt },
    { role: "system", content: executionRules },
    { role: "system", content: contextInstruction },
    { role: "system", content: assetsInstruction },
    ...conversationHistory.map((entry) => ({
      role: entry.role,
      content: entry.content,
    })),
    { role: "user", content: userText },
  ];

  const assistantReply = await generateChatCompletion({
    provider: settings.provider,
    model: settings.model,
    temperature: settings.temperature,
    messages,
  });
  if (!assistantReply) {
    throw new Error("Réponse vide générée par le modèle.");
  }
  return { assistantReply, ragResults, shareableAssets, settings };
}

async function indexDocument({
  organizationId = 1,
  title,
  sourceType,
  source,
  content,
  asset = null,
}) {
  const trimmed = sanitizeText(content || "");
  if (!trimmed) throw new Error("Contenu vide, indexation impossible.");
  if (isLikelyBinary(trimmed)) {
    throw new Error("Contenu invalide: données binaires détectées.");
  }
  const insertDoc = await dbRun(
    `INSERT INTO documents(organization_id, title, source_type, source, content, created_at)
     VALUES (?, ?, ?, ?, ?, ${currentIsoDateSql()}) RETURNING id`,
    [organizationId, title, sourceType, source, trimmed]
  );
  const docId =
    Number(insertDoc?.lastID) ||
    Number((await dbGet("SELECT id FROM documents WHERE organization_id = ? ORDER BY id DESC LIMIT 1", [organizationId]))?.id);
  const chunks = splitIntoChunks(trimmed);
  for (const chunk of chunks) {
    await dbRun(
      "INSERT INTO chunks(organization_id, document_id, content, embedding) VALUES (?, ?, ?, ?)",
      [organizationId, docId, chunk, "[]"]
    );
  }
  if (asset) {
    await createKnowledgeAsset({
      organizationId,
      documentId: docId,
      assetType: asset.assetType,
      title: asset.title || title,
      source: asset.source || source,
      mimeType: asset.mimeType || "",
      filePath: asset.filePath || "",
    });
  }
  return { docId, chunksCount: chunks.length };
}

async function retrieveContext(query, topK, organizationId = 1) {
  const rows = await dbAll(
    `SELECT c.id, c.document_id, c.content, c.embedding, d.title
     FROM chunks c
     JOIN documents d ON d.id = c.document_id
     WHERE c.organization_id = ?`,
    [organizationId]
  );
  const scored = rows
    .map((r) => ({
      score: keywordScore(query, r.content),
      content: r.content,
      title: r.title,
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.max(1, topK));
  const useful = scored.filter((s) => s.score > 0.05);
  if (useful.length > 0) return useful;
  return scored.slice(0, Math.min(2, scored.length));
}

async function initDb() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.mkdir(UPLOADS_DIR, { recursive: true });
  await fs.mkdir(SESSIONS_DIR, { recursive: true });
  if (DATABASE_URL) {
    activeDbDialect = "postgres";
    pgPool = new Pool({ connectionString: DATABASE_URL });
    db = {
      get: dbGet,
      all: dbAll,
      run: dbRun,
      exec: async (sql) => {
        await pgPool.query(sql);
      },
    };
    await pgPool.query(`
      CREATE TABLE IF NOT EXISTS organizations (
        id BIGSERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        plan TEXT NOT NULL DEFAULT 'starter',
        brand_name TEXT,
        brand_primary_color TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS users (
        id BIGSERIAL PRIMARY KEY,
        email TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        name TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS organization_members (
        id BIGSERIAL PRIMARY KEY,
        user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        organization_id BIGINT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        role TEXT NOT NULL DEFAULT 'owner',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE(user_id, organization_id)
      );
      CREATE TABLE IF NOT EXISTS settings (
        organization_id BIGINT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        PRIMARY KEY (organization_id, key)
      );
      CREATE TABLE IF NOT EXISTS documents (
        id BIGSERIAL PRIMARY KEY,
        organization_id BIGINT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        source_type TEXT NOT NULL,
        source TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS chunks (
        id BIGSERIAL PRIMARY KEY,
        organization_id BIGINT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        document_id BIGINT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
        content TEXT NOT NULL,
        embedding TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS conversation_messages (
        id BIGSERIAL PRIMARY KEY,
        organization_id BIGINT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        chat_id TEXT NOT NULL,
        role TEXT NOT NULL CHECK(role IN ('user', 'assistant')),
        content TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS knowledge_assets (
        id BIGSERIAL PRIMARY KEY,
        organization_id BIGINT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        document_id BIGINT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
        asset_type TEXT NOT NULL CHECK(asset_type IN ('url', 'file')),
        title TEXT NOT NULL,
        source TEXT NOT NULL,
        mime_type TEXT,
        file_path TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS contacts (
        id BIGSERIAL PRIMARY KEY,
        organization_id BIGINT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        phone TEXT NOT NULL,
        name TEXT,
        status TEXT NOT NULL DEFAULT 'new',
        tags TEXT NOT NULL DEFAULT '',
        notes TEXT,
        last_message_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE(organization_id, phone)
      );
      CREATE TABLE IF NOT EXISTS deals (
        id BIGSERIAL PRIMARY KEY,
        organization_id BIGINT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        contact_id BIGINT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
        pipeline_stage TEXT NOT NULL DEFAULT 'Nouveau lead',
        value_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
        currency TEXT NOT NULL DEFAULT 'USD',
        note TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS subscriptions (
        id BIGSERIAL PRIMARY KEY,
        organization_id BIGINT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        provider TEXT NOT NULL,
        external_customer_id TEXT,
        external_subscription_id TEXT,
        plan_code TEXT NOT NULL DEFAULT 'starter',
        status TEXT NOT NULL DEFAULT 'trialing',
        renews_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS payment_events (
        id BIGSERIAL PRIMARY KEY,
        organization_id BIGINT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        provider TEXT NOT NULL,
        event_type TEXT NOT NULL,
        payload TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS appointments (
        id BIGSERIAL PRIMARY KEY,
        organization_id BIGINT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        contact_id BIGINT REFERENCES contacts(id) ON DELETE SET NULL,
        title TEXT NOT NULL,
        starts_at TIMESTAMPTZ NOT NULL,
        ends_at TIMESTAMPTZ,
        status TEXT NOT NULL DEFAULT 'booked',
        notes TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS campaigns (
        id BIGSERIAL PRIMARY KEY,
        organization_id BIGINT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        segment_tag TEXT,
        message_template TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'draft',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
  } else {
    activeDbDialect = "sqlite";
    db = await open({
      filename: DB_PATH,
      driver: sqlite3.Database,
    });
    await db.exec(`
      CREATE TABLE IF NOT EXISTS organizations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        plan TEXT NOT NULL DEFAULT 'starter',
        brand_name TEXT,
        brand_primary_color TEXT,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        email TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        name TEXT,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS organization_members (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        organization_id INTEGER NOT NULL,
        role TEXT NOT NULL DEFAULT 'owner',
        created_at TEXT NOT NULL,
        UNIQUE(user_id, organization_id),
        FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
        FOREIGN KEY(organization_id) REFERENCES organizations(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS settings (
        organization_id INTEGER NOT NULL DEFAULT 1,
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        PRIMARY KEY (organization_id, key)
      );
      CREATE TABLE IF NOT EXISTS documents (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        organization_id INTEGER NOT NULL DEFAULT 1,
        title TEXT NOT NULL,
        source_type TEXT NOT NULL,
        source TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY(organization_id) REFERENCES organizations(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS chunks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        organization_id INTEGER NOT NULL DEFAULT 1,
        document_id INTEGER NOT NULL,
        content TEXT NOT NULL,
        embedding TEXT NOT NULL,
        FOREIGN KEY(document_id) REFERENCES documents(id) ON DELETE CASCADE,
        FOREIGN KEY(organization_id) REFERENCES organizations(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS conversation_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        organization_id INTEGER NOT NULL DEFAULT 1,
        chat_id TEXT NOT NULL,
        role TEXT NOT NULL CHECK(role IN ('user', 'assistant')),
        content TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY(organization_id) REFERENCES organizations(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS knowledge_assets (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        organization_id INTEGER NOT NULL DEFAULT 1,
        document_id INTEGER NOT NULL,
        asset_type TEXT NOT NULL CHECK(asset_type IN ('url', 'file')),
        title TEXT NOT NULL,
        source TEXT NOT NULL,
        mime_type TEXT,
        file_path TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY(document_id) REFERENCES documents(id) ON DELETE CASCADE,
        FOREIGN KEY(organization_id) REFERENCES organizations(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS contacts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        organization_id INTEGER NOT NULL DEFAULT 1,
        phone TEXT NOT NULL,
        name TEXT,
        status TEXT NOT NULL DEFAULT 'new',
        tags TEXT NOT NULL DEFAULT '',
        notes TEXT,
        last_message_at TEXT,
        created_at TEXT NOT NULL,
        UNIQUE(organization_id, phone),
        FOREIGN KEY(organization_id) REFERENCES organizations(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS deals (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        organization_id INTEGER NOT NULL DEFAULT 1,
        contact_id INTEGER NOT NULL,
        pipeline_stage TEXT NOT NULL DEFAULT 'Nouveau lead',
        value_amount REAL NOT NULL DEFAULT 0,
        currency TEXT NOT NULL DEFAULT 'USD',
        note TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY(organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
        FOREIGN KEY(contact_id) REFERENCES contacts(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS subscriptions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        organization_id INTEGER NOT NULL,
        provider TEXT NOT NULL,
        external_customer_id TEXT,
        external_subscription_id TEXT,
        plan_code TEXT NOT NULL DEFAULT 'starter',
        status TEXT NOT NULL DEFAULT 'trialing',
        renews_at TEXT,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS payment_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        organization_id INTEGER NOT NULL,
        provider TEXT NOT NULL,
        event_type TEXT NOT NULL,
        payload TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS appointments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        organization_id INTEGER NOT NULL,
        contact_id INTEGER,
        title TEXT NOT NULL,
        starts_at TEXT NOT NULL,
        ends_at TEXT,
        status TEXT NOT NULL DEFAULT 'booked',
        notes TEXT,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS campaigns (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        organization_id INTEGER NOT NULL,
        name TEXT NOT NULL,
        segment_tag TEXT,
        message_template TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'draft',
        created_at TEXT NOT NULL
      );
    `);
  }
  await runSqliteColumnMigrations();
  await ensureDefaultOrganization();
  await backfillTenantColumns();
  await seedDefaultSettingsIfMissing();
  await dbRun(
    `DELETE FROM chunks
     WHERE document_id IN (
       SELECT id FROM documents
       WHERE length(content) < 12
          OR content LIKE '%PNG%'
          OR content LIKE '%JFIF%'
     )`
  );
  await dbRun(
    `DELETE FROM documents
     WHERE length(content) < 12
        OR content LIKE '%PNG%'
        OR content LIKE '%JFIF%'`
  );
}

function safePublicUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    email: row.email,
    name: row.name || "",
    created_at: row.created_at,
  };
}

function requireAuth(req, res, next) {
  if (req?.session?.userId) return next();
  return res.status(401).json({ error: "Non authentifié." });
}

function getTenantIdFromRequest(req) {
  const tenant = Number(req?.session?.organizationId || 0);
  if (tenant > 0) return tenant;
  return 1;
}

async function ensureSessionTenant(req) {
  if (req?.session?.organizationId) return Number(req.session.organizationId);
  const orgId = await ensureDefaultOrganization();
  if (req?.session) req.session.organizationId = orgId;
  return orgId;
}

async function requireTenant(req, res, next) {
  if (!req?.session?.userId) return res.status(401).json({ error: "Non authentifié." });
  const orgId = await ensureSessionTenant(req);
  if (!orgId) return res.status(403).json({ error: "Tenant introuvable." });
  req.tenantId = orgId;
  return next();
}

async function startServer(waRef) {
  const app = express();
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

  app.use(express.json({ limit: "2mb" }));
  const FileStore = FileStoreFactory(session);
  app.use(
    session({
      name: "soultech.sid",
      secret: SESSION_SECRET || "dev-insecure-secret-change-me",
      resave: false,
      saveUninitialized: false,
      rolling: true,
      cookie: {
        httpOnly: true,
        sameSite: "lax",
        secure: false,
        maxAge: 1000 * 60 * 60 * 24 * 7,
      },
      store: new FileStore({
        path: SESSIONS_DIR,
        retries: 0,
        ttl: 60 * 60 * 24 * 7,
      }),
    })
  );

  const publicDir = path.join(__dirname, "public");
  app.use(express.static(publicDir, { index: false }));

  app.get("/", (req, res) => {
    if (!req?.session?.userId) return res.redirect("/login");
    return res.sendFile(path.join(publicDir, "index.html"));
  });

  app.get("/index.html", (req, res) => {
    if (!req?.session?.userId) return res.redirect("/login");
    return res.sendFile(path.join(publicDir, "index.html"));
  });

  app.get("/login", (_req, res) => {
    return res.sendFile(path.join(publicDir, "login.html"));
  });

  app.get("/register", (_req, res) => {
    return res.sendFile(path.join(publicDir, "register.html"));
  });

  app.get("/api/auth/me", async (req, res) => {
    if (!req?.session?.userId) return res.json({ ok: true, user: null });
    const row = await dbGet("SELECT id, email, name, created_at FROM users WHERE id = ?", [
      req.session.userId,
    ]);
    const organizations = await dbAll(
      `SELECT o.id, o.name, o.plan, om.role
       FROM organizations o
       JOIN organization_members om ON om.organization_id = o.id
       WHERE om.user_id = ?
       ORDER BY o.id ASC`,
      [req.session.userId]
    );
    if (!req.session.organizationId && organizations.length) {
      req.session.organizationId = Number(organizations[0].id);
    }
    return res.json({
      ok: true,
      user: safePublicUser(row),
      organizationId: Number(req.session.organizationId || 0) || null,
      organizations,
    });
  });

  app.post("/api/auth/logout", (req, res) => {
    req.session?.destroy(() => {
      res.json({ ok: true });
    });
  });

  app.post("/api/auth/login", async (req, res) => {
    const email = String(req.body?.email || "").trim().toLowerCase();
    const password = String(req.body?.password || "");
    if (!email || !password) {
      return res.status(400).json({ error: "Email et mot de passe requis." });
    }
    const row = await dbGet(
      "SELECT id, email, password_hash, name, created_at FROM users WHERE email = ?",
      [email]
    );
    if (!row) return res.status(401).json({ error: "Identifiants invalides." });
    const ok = await bcrypt.compare(password, row.password_hash);
    if (!ok) return res.status(401).json({ error: "Identifiants invalides." });
    req.session.userId = row.id;
    const membership = await dbGet(
      "SELECT organization_id FROM organization_members WHERE user_id = ? ORDER BY id ASC LIMIT 1",
      [row.id]
    );
    req.session.organizationId = Number(membership?.organization_id || (await ensureDefaultOrganization()));
    return res.json({
      ok: true,
      user: safePublicUser(row),
      organizationId: req.session.organizationId,
    });
  });

  app.post("/api/auth/register", async (req, res) => {
    if (!ALLOW_REGISTER) {
      return res.status(403).json({ error: "Création de compte désactivée." });
    }
    const email = String(req.body?.email || "").trim().toLowerCase();
    const password = String(req.body?.password || "");
    const name = String(req.body?.name || "").trim();
    if (!email || !password) {
      return res.status(400).json({ error: "Email et mot de passe requis." });
    }
    if (password.length < 8) {
      return res.status(400).json({ error: "Mot de passe trop court (8 caractères min)." });
    }
    const existing = await dbGet("SELECT id FROM users WHERE email = ?", [email]);
    if (existing) {
      return res.status(409).json({ error: "Un compte existe déjà avec cet email." });
    }
    const passwordHash = await bcrypt.hash(password, 10);
    const result = await dbRun(
      `INSERT INTO users(email, password_hash, name, created_at) VALUES(?, ?, ?, ${currentIsoDateSql()}) RETURNING id`,
      [email, passwordHash, name || null]
    );
    const userId =
      Number(result?.lastID) ||
      Number(
        (
          await dbGet("SELECT id FROM users WHERE email = ?", [email])
        )?.id
      );
    const organizationResult = await dbRun(
      `INSERT INTO organizations(name, plan, created_at) VALUES(?, ?, ${currentIsoDateSql()}) RETURNING id`,
      [name || email.split("@")[0] || "Entreprise", DEFAULT_PLAN]
    );
    const organizationId =
      Number(organizationResult?.lastID) ||
      Number((await dbGet("SELECT id FROM organizations ORDER BY id DESC LIMIT 1"))?.id);
    await dbRun(
      `INSERT INTO organization_members(user_id, organization_id, role, created_at)
       VALUES(?, ?, ?, ${currentIsoDateSql()})`,
      [userId, organizationId, "owner"]
    );
    req.session.userId = userId;
    req.session.organizationId = organizationId;
    const user = await dbGet("SELECT id, email, name, created_at FROM users WHERE id = ?", [
      userId,
    ]);
    return res.json({ ok: true, user: safePublicUser(user), organizationId });
  });

  mountStatusRoute(app, {
    dbGet,
    getRuntimeStatus: () => ({
      whatsappReady,
      whatsappAuthenticated,
      hasQr: Boolean(latestQr),
      whatsappLastError: latestWhatsAppInitError,
      dbDialect: activeDbDialect,
      waMode: process.env.WA_MULTI_TENANT_MODE || "single-session",
      hasRedis: Boolean(REDIS_URL),
    }),
  });

  app.get("/api/whatsapp/qr", requireTenant, (_req, res) => {
    res.json({
      ok: true,
      qr: latestQr,
      qrImage: latestQrImage,
      qrUpdatedAt: latestQrAt,
      whatsappReady,
      whatsappAuthenticated,
      lastInitError: latestWhatsAppInitError,
    });
  });

  app.post("/api/whatsapp/restart-qr", requireTenant, async (_req, res) => {
    try {
      try {
        await waRef.current?.destroy();
      } catch (_e) {
        // Ignore if already destroyed.
      }
      whatsappReady = false;
      whatsappAuthenticated = false;
      latestQr = null;
      latestQrImage = null;
      latestQrAt = null;
      waRef.current?.initialize();
      addLog("info", "Régénération du QR demandée depuis le dashboard.");
      res.json({ ok: true });
    } catch (error) {
      addLog("error", "Erreur lors de la régénération du QR.", {
        error: error.message,
      });
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/whatsapp/disconnect", requireTenant, async (_req, res) => {
    try {
      try {
        await waRef.current?.logout();
      } catch (_e) {
        // Ignore logout errors when session is already closed.
      }
      try {
        await waRef.current?.destroy();
      } catch (_e) {
        // Ignore destroy errors and continue restart flow.
      }
      whatsappReady = false;
      whatsappAuthenticated = false;
      latestQr = null;
      latestQrImage = null;
      latestQrAt = null;
      waRef.current?.initialize();
      addLog("info", "Déconnexion WhatsApp demandée depuis le dashboard.");
      res.json({ ok: true });
    } catch (error) {
      addLog("error", "Erreur lors de la déconnexion WhatsApp.", {
        error: error.message,
      });
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/logs", requireTenant, (_req, res) => {
    res.json(logs.slice(0, 100));
  });

  app.get("/api/settings", requireTenant, async (req, res) => {
    res.json(await getSettings(getTenantIdFromRequest(req)));
  });

  app.put("/api/settings", requireTenant, async (req, res) => {
    const payload = req.body || {};
    const safe = {};
    if (payload.provider !== undefined) {
      safe.provider = normalizeProvider(payload.provider);
    }
    if (payload.model) safe.model = payload.model;
    if (payload.system_prompt) safe.system_prompt = payload.system_prompt;
    if (payload.temperature !== undefined) safe.temperature = payload.temperature;
    if (payload.top_k !== undefined) safe.top_k = payload.top_k;
    if (payload.human_delay_min_ms !== undefined) {
      safe.human_delay_min_ms = payload.human_delay_min_ms;
    }
    if (payload.human_delay_max_ms !== undefined) {
      safe.human_delay_max_ms = payload.human_delay_max_ms;
    }
    if (payload.reply_chunk_min_sentences !== undefined) {
      safe.reply_chunk_min_sentences = payload.reply_chunk_min_sentences;
    }
    if (payload.reply_chunk_max_sentences !== undefined) {
      safe.reply_chunk_max_sentences = payload.reply_chunk_max_sentences;
    }
    if (payload.reply_chunk_delay_min_ms !== undefined) {
      safe.reply_chunk_delay_min_ms = payload.reply_chunk_delay_min_ms;
    }
    if (payload.reply_chunk_delay_max_ms !== undefined) {
      safe.reply_chunk_delay_max_ms = payload.reply_chunk_delay_max_ms;
    }
    await setSettings(safe, getTenantIdFromRequest(req));
    addLog("info", "Paramètres mis à jour.");
    res.json(await getSettings(getTenantIdFromRequest(req)));
  });

  app.get("/api/documents", requireTenant, async (req, res) => {
    const tenantId = getTenantIdFromRequest(req);
    const docs = await dbAll(
      "SELECT id, title, source_type, source, created_at FROM documents WHERE organization_id = ? ORDER BY id DESC",
      [tenantId]
    );
    res.json(docs);
  });

  app.get("/api/conversations", requireTenant, async (req, res) => {
    const tenantId = getTenantIdFromRequest(req);
    const rows = await dbAll(
      `SELECT chat_id, COUNT(*) AS messages, MAX(created_at) AS last_message_at
       FROM conversation_messages
       WHERE organization_id = ?
       GROUP BY chat_id
       ORDER BY last_message_at DESC`,
      [tenantId]
    );
    res.json(rows);
  });

  app.delete("/api/conversations", requireTenant, async (req, res) => {
    const tenantId = getTenantIdFromRequest(req);
    const result = await dbRun("DELETE FROM conversation_messages WHERE organization_id = ?", [
      tenantId,
    ]);
    addLog("info", "Historique conversations vidé (global).", {
      deleted: result.changes || 0,
    });
    res.json({ ok: true, deleted: result.changes || 0 });
  });

  app.delete("/api/conversations/:chatId", requireTenant, async (req, res) => {
    const chatId = (req.params.chatId || "").trim();
    if (!chatId) {
      return res.status(400).json({ error: "chatId manquant." });
    }
    const tenantId = getTenantIdFromRequest(req);
    const result = await dbRun(
      "DELETE FROM conversation_messages WHERE organization_id = ? AND chat_id = ?",
      [tenantId, chatId]
    );
    addLog("info", "Historique conversation vidé (contact).", {
      chatId,
      deleted: result.changes || 0,
    });
    res.json({ ok: true, chatId, deleted: result.changes || 0 });
  });

  app.delete("/api/documents/:id", requireTenant, async (req, res) => {
    const id = Number(req.params.id);
    const tenantId = getTenantIdFromRequest(req);
    const fileAssets = await dbAll(
      "SELECT file_path FROM knowledge_assets WHERE organization_id = ? AND document_id = ? AND asset_type = 'file'",
      [tenantId, id]
    );
    await dbRun("DELETE FROM knowledge_assets WHERE organization_id = ? AND document_id = ?", [
      tenantId,
      id,
    ]);
    await dbRun("DELETE FROM chunks WHERE organization_id = ? AND document_id = ?", [tenantId, id]);
    await dbRun("DELETE FROM documents WHERE organization_id = ? AND id = ?", [tenantId, id]);
    for (const asset of fileAssets) {
      if (!asset.file_path) continue;
      try {
        await fs.unlink(asset.file_path);
      } catch (_error) {
        // Ignore missing files.
      }
    }
    addLog("info", "Document supprimé.", { id });
    res.json({ ok: true });
  });

  app.post("/api/ingest/url", requireTenant, async (req, res) => {
    try {
      const { url } = req.body || {};
      if (!url) return res.status(400).json({ error: "URL manquante." });
      const normalizedUrl = normalizeUrl(url);
      const extracted = await extractTextFromUrl(normalizedUrl);
      const result = await indexDocument({
        organizationId: getTenantIdFromRequest(req),
        title: extracted.title,
        sourceType: "url",
        source: normalizedUrl,
        content: extracted.text,
        asset: {
          assetType: "url",
          title: extracted.title,
          source: normalizedUrl,
        },
      });
      addLog("info", "URL indexée.", { url, chunks: result.chunksCount });
      res.json({ ok: true, ...result });
    } catch (error) {
      addLog("error", "Erreur ingestion URL.", { error: error.message });
      res.status(400).json({ error: error.message });
    }
  });

  app.post("/api/ingest/site", requireTenant, async (req, res) => {
    try {
      const { url, maxPages } = req.body || {};
      if (!url) return res.status(400).json({ error: "URL du site manquante." });
      const max = Math.min(Math.max(Number(maxPages) || 12, 1), 40);
      const pages = await crawlWebsite(url, max);
      if (!pages.length) {
        return res.status(400).json({ error: "Aucune page exploitable trouvée sur ce site." });
      }
      const indexed = [];
      for (const page of pages) {
        const result = await indexDocument({
          organizationId: getTenantIdFromRequest(req),
          title: page.title,
          sourceType: "site",
          source: page.url,
          content: page.text,
          asset: {
            assetType: "url",
            title: page.title,
            source: page.url,
          },
        });
        indexed.push({ url: page.url, docId: result.docId });
      }
      addLog("info", "Site indexé.", { baseUrl: url, pages: indexed.length });
      res.json({ ok: true, pagesIndexed: indexed.length, indexed });
    } catch (error) {
      addLog("error", "Erreur ingestion site.", { error: error.message });
      res.status(400).json({ error: error.message });
    }
  });

  app.post("/api/ingest/file", requireTenant, upload.single("file"), async (req, res) => {
    try {
      if (!req.file) return res.status(400).json({ error: "Fichier manquant." });
      const text = await extractTextFromFile(req.file);
      const storedName = makeSafeFileName(req.file.originalname);
      const storedPath = path.join(UPLOADS_DIR, storedName);
      await fs.writeFile(storedPath, req.file.buffer);
      const result = await indexDocument({
        organizationId: getTenantIdFromRequest(req),
        title: req.file.originalname,
        sourceType: "file",
        source: req.file.originalname,
        content: text,
        asset: {
          assetType: "file",
          title: req.file.originalname,
          source: req.file.originalname,
          mimeType: req.file.mimetype || "",
          filePath: storedPath,
        },
      });
      addLog("info", "Fichier indexé.", {
        file: req.file.originalname,
        chunks: result.chunksCount,
      });
      res.json({ ok: true, ...result });
    } catch (error) {
      addLog("error", "Erreur ingestion fichier.", { error: error.message });
      res.status(400).json({ error: error.message });
    }
  });

  app.post("/api/send", requireTenant, async (req, res) => {
    try {
      const { to, text } = req.body || {};
      if (!to || !text) return res.status(400).json({ error: "to et text requis." });
      await waRef.current?.sendMessage(to, text);
      res.json({ ok: true });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/sandbox/history", requireTenant, async (req, res) => {
    const tenantId = getTenantIdFromRequest(req);
    const chatId = `sandbox:${tenantId}:dashboard`;
    const history = await getConversationHistory(chatId, 60, tenantId);
    res.json({ ok: true, chatId, history });
  });

  app.delete("/api/sandbox/history", requireTenant, async (req, res) => {
    const tenantId = getTenantIdFromRequest(req);
    const chatId = `sandbox:${tenantId}:dashboard`;
    const result = await dbRun(
      "DELETE FROM conversation_messages WHERE organization_id = ? AND chat_id = ?",
      [tenantId, chatId]
    );
    res.json({ ok: true, deleted: result.changes || 0 });
  });

  app.post("/api/sandbox/chat", requireTenant, async (req, res) => {
    try {
      const tenantId = getTenantIdFromRequest(req);
      const chatId = `sandbox:${tenantId}:dashboard`;
      const userText = sanitizeText(req.body?.text || "");
      if (!userText) {
        return res.status(400).json({ error: "Message vide." });
      }
      await addConversationMessage(chatId, "user", userText, tenantId);
      const result = await generateAssistantResponse(userText, chatId, tenantId);
      await addConversationMessage(chatId, "assistant", result.assistantReply, tenantId);
      const shareable = result.shareableAssets.slice(0, 5).map((asset) => ({
        type: asset.asset_type,
        title: asset.title,
        source: asset.source,
      }));
      addLog("info", "Sandbox dashboard: réponse générée.", {
        withContext: Boolean(result.ragResults.length),
        resources: shareable.length,
      });
      res.json({
        ok: true,
        reply: result.assistantReply,
        resources: shareable,
      });
    } catch (error) {
      addLog("error", "Erreur sandbox dashboard.", { error: error.message });
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/tenants/me", requireTenant, async (req, res) => {
    const userId = Number(req.session.userId);
    const currentOrganizationId = getTenantIdFromRequest(req);
    const organizations = await dbAll(
      `SELECT o.id, o.name, o.plan, o.brand_name, o.brand_primary_color, om.role
       FROM organizations o
       JOIN organization_members om ON om.organization_id = o.id
       WHERE om.user_id = ?
       ORDER BY o.id ASC`,
      [userId]
    );
    res.json({ ok: true, currentOrganizationId, organizations });
  });

  app.post("/api/tenants/switch", requireTenant, async (req, res) => {
    const requested = Number(req.body?.organizationId || 0);
    if (!requested) return res.status(400).json({ error: "organizationId requis." });
    const allowed = await dbGet(
      "SELECT id FROM organization_members WHERE user_id = ? AND organization_id = ?",
      [req.session.userId, requested]
    );
    if (!allowed) return res.status(403).json({ error: "Accès refusé à cette organisation." });
    req.session.organizationId = requested;
    return res.json({ ok: true, organizationId: requested });
  });

  app.get("/api/whatsapp/strategy", requireTenant, async (req, res) => {
    const tenantId = getTenantIdFromRequest(req);
    const mode = String(process.env.WA_MULTI_TENANT_MODE || "single-session");
    const sessionNamespace =
      mode === "worker-per-tenant" ? `tenant-${tenantId}` : String(WA_CLIENT_ID || "main");
    return res.json({
      ok: true,
      mode,
      tenantId,
      sessionNamespace,
      queue: REDIS_URL ? "redis-ready" : "memory-fallback",
      cloudApiRoadmap: true,
    });
  });

  app.get("/api/crm/contacts", requireTenant, async (req, res) => {
    const tenantId = getTenantIdFromRequest(req);
    const rows = await dbAll(
      `SELECT id, phone, name, status, tags, notes, last_message_at, created_at
       FROM contacts
       WHERE organization_id = ?
       ORDER BY COALESCE(last_message_at, created_at) DESC
       LIMIT 200`,
      [tenantId]
    );
    res.json({ ok: true, contacts: rows });
  });

  app.post("/api/crm/contacts", requireTenant, async (req, res) => {
    const tenantId = getTenantIdFromRequest(req);
    const phone = String(req.body?.phone || "").trim();
    if (!phone) return res.status(400).json({ error: "phone requis." });
    const normalized = phone.replace(/[^\d+]/g, "");
    const name = String(req.body?.name || "").trim() || null;
    const tags = String(req.body?.tags || "").trim();
    const status = String(req.body?.status || "new").trim();
    const notes = String(req.body?.notes || "").trim() || null;
    await dbRun(
      `INSERT INTO contacts(organization_id, phone, name, status, tags, notes, created_at)
       VALUES(?, ?, ?, ?, ?, ?, ${currentIsoDateSql()})`,
      [tenantId, normalized, name, status, tags, notes]
    );
    const created = await dbGet(
      "SELECT id, phone, name, status, tags, notes, created_at FROM contacts WHERE organization_id = ? AND phone = ?",
      [tenantId, normalized]
    );
    return res.json({ ok: true, contact: created });
  });

  app.put("/api/crm/contacts/:id", requireTenant, async (req, res) => {
    const tenantId = getTenantIdFromRequest(req);
    const contactId = Number(req.params.id || 0);
    if (!contactId) return res.status(400).json({ error: "id invalide." });

    const existing = await dbGet(
      "SELECT id FROM contacts WHERE organization_id = ? AND id = ?",
      [tenantId, contactId]
    );
    if (!existing) return res.status(404).json({ error: "Contact introuvable." });

    const phoneRaw = String(req.body?.phone || "").trim();
    const phone = phoneRaw.replace(/[^\d+]/g, "");
    if (!phone) return res.status(400).json({ error: "phone requis." });

    const name = String(req.body?.name || "").trim() || null;
    const tags = String(req.body?.tags || "").trim();
    const status = String(req.body?.status || "new").trim() || "new";
    const notes = String(req.body?.notes || "").trim() || null;

    const duplicated = await dbGet(
      "SELECT id FROM contacts WHERE organization_id = ? AND phone = ? AND id <> ?",
      [tenantId, phone, contactId]
    );
    if (duplicated) {
      return res.status(409).json({ error: "Ce numéro existe déjà dans vos contacts." });
    }

    await dbRun(
      `UPDATE contacts
       SET phone = ?, name = ?, status = ?, tags = ?, notes = ?
       WHERE organization_id = ? AND id = ?`,
      [phone, name, status, tags, notes, tenantId, contactId]
    );
    const updated = await dbGet(
      "SELECT id, phone, name, status, tags, notes, last_message_at, created_at FROM contacts WHERE organization_id = ? AND id = ?",
      [tenantId, contactId]
    );
    return res.json({ ok: true, contact: updated });
  });

  app.delete("/api/crm/contacts/:id", requireTenant, async (req, res) => {
    const tenantId = getTenantIdFromRequest(req);
    const contactId = Number(req.params.id || 0);
    if (!contactId) return res.status(400).json({ error: "id invalide." });
    const result = await dbRun("DELETE FROM contacts WHERE organization_id = ? AND id = ?", [
      tenantId,
      contactId,
    ]);
    if (!result.changes) return res.status(404).json({ error: "Contact introuvable." });
    return res.json({ ok: true, deleted: result.changes || 0 });
  });

  app.get("/api/crm/pipeline", requireTenant, async (req, res) => {
    const tenantId = getTenantIdFromRequest(req);
    const rows = await dbAll(
      `SELECT d.id, d.pipeline_stage, d.value_amount, d.currency, d.note, d.created_at,
              c.id AS contact_id, c.phone, c.name, c.status
       FROM deals d
       JOIN contacts c ON c.id = d.contact_id
       WHERE d.organization_id = ?
       ORDER BY d.id DESC`,
      [tenantId]
    );
    res.json({ ok: true, deals: rows });
  });

  app.put("/api/crm/deals/:id", requireTenant, async (req, res) => {
    const tenantId = getTenantIdFromRequest(req);
    const dealId = Number(req.params.id || 0);
    if (!dealId) return res.status(400).json({ error: "id invalide." });
    const stage = String(req.body?.pipeline_stage || "").trim();
    const note = String(req.body?.note || "").trim();
    if (!stage) return res.status(400).json({ error: "pipeline_stage requis." });
    await dbRun(
      "UPDATE deals SET pipeline_stage = ?, note = ? WHERE organization_id = ? AND id = ?",
      [stage, note || null, tenantId, dealId]
    );
    return res.json({ ok: true });
  });

  app.get("/api/billing/subscription", requireTenant, async (req, res) => {
    const tenantId = getTenantIdFromRequest(req);
    const sub = await dbGet(
      `SELECT id, provider, external_customer_id, external_subscription_id, plan_code, status, renews_at, created_at
       FROM subscriptions
       WHERE organization_id = ?
       ORDER BY id DESC
       LIMIT 1`,
      [tenantId]
    );
    const payments = await dbAll(
      `SELECT id, provider, event_type, created_at
       FROM payment_events
       WHERE organization_id = ?
       ORDER BY id DESC
       LIMIT 10`,
      [tenantId]
    );
    return res.json({ ok: true, subscription: sub, recentEvents: payments });
  });

  app.post("/api/billing/subscribe", requireTenant, async (req, res) => {
    const tenantId = getTenantIdFromRequest(req);
    const provider = String(req.body?.provider || "stripe").trim().toLowerCase();
    const planCode = String(req.body?.planCode || "starter").trim().toLowerCase();
    await dbRun(
      `INSERT INTO subscriptions(organization_id, provider, plan_code, status, created_at)
       VALUES(?, ?, ?, 'active', ${currentIsoDateSql()})`,
      [tenantId, provider, planCode]
    );
    await dbRun(
      `INSERT INTO payment_events(organization_id, provider, event_type, payload, created_at)
       VALUES(?, ?, 'subscription_created', ?, ${currentIsoDateSql()})`,
      [tenantId, provider, JSON.stringify({ planCode })]
    );
    return res.json({ ok: true, provider, planCode });
  });

  app.post("/api/billing/webhooks/:provider", async (req, res) => {
    const provider = String(req.params.provider || "").toLowerCase();
    const tenantId = Number(req.body?.organizationId || 1);
    const eventType = String(req.body?.type || "unknown_event");
    await dbRun(
      `INSERT INTO payment_events(organization_id, provider, event_type, payload, created_at)
       VALUES(?, ?, ?, ?, ${currentIsoDateSql()})`,
      [tenantId, provider, eventType, JSON.stringify(req.body || {})]
    );
    return res.json({ ok: true });
  });

  app.get("/api/appointments", requireTenant, async (req, res) => {
    const tenantId = getTenantIdFromRequest(req);
    const appointments = await dbAll(
      `SELECT id, contact_id, title, starts_at, ends_at, status, notes, created_at
       FROM appointments
       WHERE organization_id = ?
       ORDER BY starts_at ASC
       LIMIT 200`,
      [tenantId]
    );
    return res.json({ ok: true, appointments });
  });

  app.post("/api/appointments", requireTenant, async (req, res) => {
    const tenantId = getTenantIdFromRequest(req);
    const title = String(req.body?.title || "").trim();
    const startsAt = String(req.body?.starts_at || "").trim();
    const endsAt = String(req.body?.ends_at || "").trim() || null;
    const notes = String(req.body?.notes || "").trim() || null;
    const contactId = Number(req.body?.contact_id || 0) || null;
    if (!title || !startsAt) {
      return res.status(400).json({ error: "title et starts_at requis." });
    }
    await dbRun(
      `INSERT INTO appointments(organization_id, contact_id, title, starts_at, ends_at, notes, created_at)
       VALUES(?, ?, ?, ?, ?, ?, ${currentIsoDateSql()})`,
      [tenantId, contactId, title, startsAt, endsAt, notes]
    );
    return res.json({ ok: true });
  });

  app.get("/api/campaigns", requireTenant, async (req, res) => {
    const tenantId = getTenantIdFromRequest(req);
    const campaigns = await dbAll(
      `SELECT id, name, segment_tag, message_template, status, created_at
       FROM campaigns
       WHERE organization_id = ?
       ORDER BY id DESC`,
      [tenantId]
    );
    return res.json({ ok: true, campaigns });
  });

  app.post("/api/campaigns", requireTenant, async (req, res) => {
    const tenantId = getTenantIdFromRequest(req);
    const name = String(req.body?.name || "").trim();
    const segmentTag = String(req.body?.segment_tag || "").trim() || null;
    const messageTemplate = String(req.body?.message_template || "").trim();
    if (!name || !messageTemplate) {
      return res.status(400).json({ error: "name et message_template requis." });
    }
    await dbRun(
      `INSERT INTO campaigns(organization_id, name, segment_tag, message_template, status, created_at)
       VALUES(?, ?, ?, ?, 'draft', ${currentIsoDateSql()})`,
      [tenantId, name, segmentTag, messageTemplate]
    );
    return res.json({ ok: true });
  });

  app.post("/api/voice/transcribe", requireTenant, upload.single("audio"), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: "Fichier audio manquant." });
    return res.json({
      ok: true,
      transcript:
        "Transcription placeholder: branche STT prête. Connecter Whisper/OpenAI/Groq pour la production.",
    });
  });

  app.get("/api/analytics/overview", requireTenant, async (req, res) => {
    const tenantId = getTenantIdFromRequest(req);
    const [docs, conversations, contacts, deals, campaigns] = await Promise.all([
      dbGet("SELECT COUNT(*) AS count FROM documents WHERE organization_id = ?", [tenantId]),
      dbGet("SELECT COUNT(*) AS count FROM conversation_messages WHERE organization_id = ?", [tenantId]),
      dbGet("SELECT COUNT(*) AS count FROM contacts WHERE organization_id = ?", [tenantId]),
      dbGet("SELECT COUNT(*) AS count FROM deals WHERE organization_id = ?", [tenantId]),
      dbGet("SELECT COUNT(*) AS count FROM campaigns WHERE organization_id = ?", [tenantId]),
    ]);
    return res.json({
      ok: true,
      tenantId,
      metrics: {
        documents: Number(docs?.count || 0),
        messages: Number(conversations?.count || 0),
        contacts: Number(contacts?.count || 0),
        deals: Number(deals?.count || 0),
        campaigns: Number(campaigns?.count || 0),
      },
    });
  });

  app.use("/api", (_req, res) => {
    res.status(404).json({ error: "Route API introuvable." });
  });

  app.use((error, _req, res, _next) => {
    addLog("error", "Erreur serveur API.", { error: error.message });
    res.status(500).json({ error: "Erreur serveur interne." });
  });

  app.listen(PORT, () => {
    addLog("info", `Dashboard disponible sur http://localhost:${PORT}`);
  });
}

function buildRagContext(results) {
  if (!results.length) return "";
  return results
    .map(
      (r, idx) =>
        `[Source ${idx + 1}: ${r.title} | score=${r.score.toFixed(3)}]\n${r.content}`
    )
    .join("\n\n");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function splitIntoSentences(text) {
  const raw = sanitizeText(text || "");
  if (!raw) return [];
  const parts = raw.split(/(?<=[.!?…])\s+/u);
  const sentences = parts.map((s) => s.trim()).filter(Boolean);
  if (sentences.length > 1) return sentences;
  if (sentences.length === 1) return sentences;
  const byNl = raw.split(/\n+/).map((s) => s.trim()).filter(Boolean);
  return byNl.length > 1 ? byNl : raw ? [raw] : [];
}

function splitAssistantReplyIntoChunks(text, minS, maxS) {
  const min = Math.max(1, Math.min(Number(minS) || 2, 20));
  const max = Math.max(min, Math.min(Number(maxS) || 3, 20));
  const sentences = splitIntoSentences(text);
  if (!sentences.length) return text.trim() ? [text.trim()] : [];
  const chunks = [];
  let i = 0;
  const n = sentences.length;
  while (i < n) {
    const left = n - i;
    let take = Math.min(max, left);
    if (left > max) {
      const after = left - take;
      if (after > 0 && after < min) {
        take = left - min;
        take = Math.max(min, Math.min(max, take));
      }
    }
    chunks.push(sentences.slice(i, i + take).join(" ").trim());
    i += take;
  }
  return chunks.filter(Boolean);
}

function normalizeChunkDelayRange(settings) {
  const min = Number(settings.reply_chunk_delay_min_ms ?? 5000);
  const max = Number(settings.reply_chunk_delay_max_ms ?? 6000);
  const safeMin = Math.max(0, min);
  const safeMax = Math.max(safeMin, max);
  return { min: safeMin, max: safeMax };
}

function pickChunkDelayMs(settings) {
  const { min, max } = normalizeChunkDelayRange(settings);
  if (max <= min) return min;
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

async function sendWhatsAppReplyInChunks(client, message, chatId, fullText, settings) {
  const minS = settings.reply_chunk_min_sentences;
  const maxS = settings.reply_chunk_max_sentences;
  const chunks = splitAssistantReplyIntoChunks(fullText, minS, maxS);
  if (!chunks.length) return 0;
  for (let idx = 0; idx < chunks.length; idx += 1) {
    if (idx > 0) {
      await sleep(pickChunkDelayMs(settings));
    }
    if (idx === 0) {
      await message.reply(chunks[idx]);
    } else {
      await client.sendMessage(chatId, chunks[idx]);
    }
  }
  return chunks.length;
}

function getMessageUniqueId(message) {
  return (
    message?.id?._serialized ||
    [
      message?.from || "",
      message?.timestamp || "",
      sanitizeText(message?.body || "").slice(0, 80),
    ].join(":")
  );
}

function cleanupProcessedMessageIds() {
  const now = Date.now();
  for (const [id, ts] of processedMessageIds.entries()) {
    if (now - ts > RECENT_MESSAGE_TTL_MS) {
      processedMessageIds.delete(id);
    }
  }
}

function hasRecentlyProcessedMessage(messageId) {
  cleanupProcessedMessageIds();
  return processedMessageIds.has(messageId);
}

function markMessageAsProcessed(messageId) {
  cleanupProcessedMessageIds();
  processedMessageIds.set(messageId, Date.now());
}

function normalizeDelayRange(settings) {
  const min = Number(settings.human_delay_min_ms) || 0;
  const max = Number(settings.human_delay_max_ms) || 0;
  const safeMin = Math.max(0, min);
  const safeMax = Math.max(safeMin, max);
  return { min: safeMin, max: safeMax };
}

function pickHumanDelayMs(settings) {
  const { min, max } = normalizeDelayRange(settings);
  if (max <= min) return min;
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function isTransientWhatsAppInitError(error) {
  const message = String(error?.message || "").toLowerCase();
  return (
    message.includes("execution context was destroyed") ||
    message.includes("target closed") ||
    message.includes("session closed") ||
    message.includes("frame was detached") ||
    message.includes("context destroyed")
  );
}

function detectChromeExecutablePath() {
  const candidates = [
    CHROME_EXECUTABLE_PATH,
    process.env.PUPPETEER_EXECUTABLE_PATH,
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    path.join(process.env.LOCALAPPDATA || "", "Google\\Chrome\\Application\\chrome.exe"),
    path.join(process.env.PROGRAMFILES || "", "Google\\Chrome\\Application\\chrome.exe"),
    path.join(process.env["PROGRAMFILES(X86)"] || "", "Google\\Chrome\\Application\\chrome.exe"),
    path.join(process.env.LOCALAPPDATA || "", "Chromium\\Application\\chrome.exe"),
  ]
    .filter(Boolean)
    .map((p) => p.trim());
  for (const candidate of candidates) {
    if (candidate && fsSync.existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

function buildWhatsAppClient(clientId) {
  const executablePath = detectChromeExecutablePath();
  return new Client({
    authStrategy: new LocalAuth({ clientId }),
    puppeteer: {
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
      ...(executablePath ? { executablePath } : {}),
    },
  });
}

function attachWhatsAppHandlers(client, waRef) {
  client.on("qr", (qr) => {
    latestQr = qr;
    latestQrAt = new Date().toISOString();
    whatsappReady = false;
    addLog("info", "QR reçu. Scanne-le avec WhatsApp.");
    qrcode.generate(qr, { small: true });
    QRCode.toDataURL(qr, {
      width: 420,
      margin: 2,
      errorCorrectionLevel: "M",
    })
      .then((img) => {
        latestQrImage = img;
      })
      .catch((error) => {
        addLog("error", "Erreur génération image QR.", { error: error.message });
      });
  });

  client.on("authenticated", () => {
    whatsappAuthenticated = true;
    latestWhatsAppInitError = "";
    addLog("info", "Authentification WhatsApp réussie.");
  });

  client.on("auth_failure", (message) => {
    whatsappReady = false;
    whatsappAuthenticated = false;
    addLog("error", "Échec d'authentification WhatsApp.", { message });
    if (waRef) scheduleWhatsAppReinitialize(waRef);
  });

  client.on("ready", () => {
    whatsappReady = true;
    latestWhatsAppInitError = "";
    latestQr = null;
    latestQrImage = null;
    latestQrAt = null;
    if (whatsappReinitTimer) {
      clearTimeout(whatsappReinitTimer);
      whatsappReinitTimer = null;
    }
    addLog("info", "Bot WhatsApp prêt.");
  });

  client.on("disconnected", (reason) => {
    whatsappReady = false;
    whatsappAuthenticated = false;
    addLog("error", "WhatsApp déconnecté.", { reason });
    if (waRef) scheduleWhatsAppReinitialize(waRef);
  });

  client.on("message", async (message) => {
    const messageId = getMessageUniqueId(message);
    const chatId = message?.from;
    try {
      if (message.fromMe) return;
      if (message.from === "status@broadcast") return;
      if (!chatId) return;
      if (hasRecentlyProcessedMessage(messageId)) {
        addLog("info", "Message dupliqué ignoré.", { from: chatId, messageId });
        return;
      }
      if (activeChatReplies.has(chatId)) {
        addLog("info", "Message ignoré car une réponse est déjà en cours pour ce contact.", {
          from: chatId,
          messageId,
        });
        return;
      }
      activeChatReplies.add(chatId);
      markMessageAsProcessed(messageId);

      const userText = (message.body || "").trim();
      if (!userText) return;
      const organizationId = await ensureDefaultOrganization();

      await addConversationMessage(chatId, "user", userText, organizationId);
      await syncLeadFromConversation(chatId, organizationId);
      const result = await generateAssistantResponse(userText, chatId, organizationId);
      const assistantReply = result.assistantReply;
      const shareableAssets = result.shareableAssets;
      const fileShareCandidates = await findFileAssetsForShare(userText, 3, organizationId);
      const humanDelayMs = pickHumanDelayMs(result.settings);
      if (humanDelayMs > 0) {
        addLog("info", "Délai humain avant réponse.", {
          from: chatId,
          messageId,
          delayMs: humanDelayMs,
        });
        await sleep(humanDelayMs);
      }
      const chunkCount = await sendWhatsAppReplyInChunks(
        client,
        message,
        chatId,
        assistantReply,
        result.settings
      );
      let sentAssets = [];
      const wantsAssets = shouldShareAssets(userText) || isFileShareIntent(userText);
      if (wantsAssets && shareableAssets.length) {
        if (chunkCount > 0) {
          await sleep(pickChunkDelayMs(result.settings));
        }
        sentAssets = await sendKnowledgeAssets(client, chatId, shareableAssets);
      }
      if (wantsAssets && sentAssets.length === 0 && fileShareCandidates.length) {
        sentAssets = await sendKnowledgeAssets(client, chatId, fileShareCandidates);
      }
      const counselorNotified = await notifyCounselorFromContextIfNeeded(
        client,
        chatId,
        userText,
        assistantReply,
        result.ragResults
      );
      await addConversationMessage(chatId, "assistant", assistantReply, organizationId);
      addLog("info", "Réponse envoyée.", {
        from: chatId,
        messageId,
        delayMs: humanDelayMs,
        chunks: chunkCount,
        assetsSent: sentAssets.length,
        counselorNotified: counselorNotified || null,
        withContext: Boolean(result.ragResults.length),
      });
    } catch (error) {
      addLog("error", "Erreur lors du traitement du message.", {
        error: error.message,
      });
      await message.reply(
        "Désolé, je rencontre un souci technique temporaire. Réessaie dans un instant."
      );
    } finally {
      if (chatId) {
        activeChatReplies.delete(chatId);
      }
    }
  });
}

async function initializeWhatsAppWithFallback(waRef) {
  let lastError = null;

  for (let attempt = 1; attempt <= WHATSAPP_INIT_MAX_ATTEMPTS; attempt += 1) {
    const isLastAttempt = attempt === WHATSAPP_INIT_MAX_ATTEMPTS;
    const clientId =
      attempt === 1 ? WA_CLIENT_ID : `${WA_CLIENT_ID}-recovery-${Date.now()}-${attempt}`;
    const client = buildWhatsAppClient(clientId);
    attachWhatsAppHandlers(client, waRef);
    waRef.current = client;

    try {
      addLog("info", "Initialisation WhatsApp...", { attempt, clientId });
      await client.initialize();
      addLog("info", "Initialisation WhatsApp lancée avec succès.", {
        attempt,
        clientId,
      });
      return;
    } catch (error) {
      lastError = error;
      const message = String(error?.message || "");
      const alreadyRunning = message.includes("already running");
      const retryable = alreadyRunning || isTransientWhatsAppInitError(error);
      latestWhatsAppInitError = message;

      addLog("error", "Échec initialisation WhatsApp.", {
        attempt,
        clientId,
        retryable,
        error: message,
      });

      try {
        await client.destroy();
      } catch (_destroyError) {
        // Ignore cleanup errors before retry.
      }

      if (!retryable || isLastAttempt) {
        break;
      }

      await sleep(WHATSAPP_INIT_RETRY_DELAY_MS);
    }
  }

  throw lastError;
}

function scheduleWhatsAppReinitialize(waRef, delayMs = 15000) {
  if (whatsappReinitTimer) return;
  whatsappReinitTimer = setTimeout(async () => {
    whatsappReinitTimer = null;
    try {
      await initializeWhatsAppWithFallback(waRef);
    } catch (error) {
      addLog("error", "Nouvelle tentative WhatsApp échouée.", {
        error: error.message,
      });
      scheduleWhatsAppReinitialize(waRef, delayMs);
    }
  }, delayMs);
  addLog("info", "Nouvelle tentative WhatsApp programmée.", { delayMs });
}

async function start() {
  await initDb();
  if (REDIS_URL && Redis) {
    try {
      redisClient = new Redis(REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 2 });
      await redisClient.connect();
      addLog("info", "Redis connecté pour la file multi-tenant.");
    } catch (error) {
      addLog("error", "Redis indisponible, fallback mémoire.", { error: error.message });
      redisClient = null;
    }
  }
  const waRef = { current: null };
  await startServer(waRef);
  if (SKIP_WHATSAPP_INIT) {
    addLog("info", "Initialisation WhatsApp ignorée (SKIP_WHATSAPP_INIT=1).");
    return;
  }
  try {
    await initializeWhatsAppWithFallback(waRef);
  } catch (error) {
    addLog("error", "WhatsApp non initialisé au démarrage, le serveur reste actif.", {
      error: error.message,
    });
    scheduleWhatsAppReinitialize(waRef);
  }
}

start().catch((error) => {
  console.error("Erreur critique au démarrage:", error);
  process.exit(1);
});
