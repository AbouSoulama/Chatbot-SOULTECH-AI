const path = require("path");

const SUPPORTED_PROVIDERS = new Set(["groq", "openai", "gemini", "openrouter", "localai"]);

function normalizeProvider(rawProvider) {
  const provider = String(rawProvider || "").toLowerCase().trim();
  return SUPPORTED_PROVIDERS.has(provider) ? provider : "groq";
}

function defaultModelForProvider(provider) {
  switch (provider) {
    case "openai":
      return process.env.OPENAI_MODEL || "gpt-4o-mini";
    case "gemini":
      return process.env.GEMINI_MODEL || "gemini-2.0-flash";
    case "openrouter":
      return process.env.OPENROUTER_MODEL || "openai/gpt-4o-mini";
    case "localai":
      return process.env.LOCALAI_MODEL || "llama-3.1-8b-instruct";
    case "groq":
    default:
      return process.env.GROQ_MODEL || "llama-3.3-70b-versatile";
  }
}

function createRuntimeConfig(baseDir) {
  const PORT = Number(process.env.PORT || 3000);
  const GROQ_API_KEY = process.env.GROQ_API_KEY;
  const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
  const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
  const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
  const LOCALAI_API_KEY = process.env.LOCALAI_API_KEY || "";
  const LOCALAI_BASE_URL = process.env.LOCALAI_BASE_URL || "http://localhost:8080/v1";
  const WA_CLIENT_ID = process.env.WA_CLIENT_ID || "main";
  const SKIP_WHATSAPP_INIT = process.env.SKIP_WHATSAPP_INIT === "1";
  const WA_COUNTRY_CODE = String(process.env.WA_COUNTRY_CODE || "225")
    .replace(/\D/g, "")
    .trim();
  const WA_NOTIFY_COUNSELOR = process.env.WA_NOTIFY_COUNSELOR !== "0";
  const CHROME_EXECUTABLE_PATH = process.env.CHROME_EXECUTABLE_PATH || "";
  const DATA_DIR = path.join(baseDir, "data");
  const UPLOADS_DIR = path.join(DATA_DIR, "uploads");
  const DB_PATH = path.join(DATA_DIR, "bot.db");
  const SESSIONS_DIR = path.join(DATA_DIR, "sessions");
  const SESSION_SECRET = String(process.env.SESSION_SECRET || "").trim();
  const ALLOW_REGISTER = process.env.ALLOW_REGISTER !== "0";
  const DATABASE_URL = String(process.env.DATABASE_URL || "").trim();
  const REDIS_URL = String(process.env.REDIS_URL || "").trim();

  const DEFAULT_PROVIDER = normalizeProvider(process.env.AI_PROVIDER || "groq");
  const DEFAULT_SETTINGS = {
    provider: DEFAULT_PROVIDER,
    model: defaultModelForProvider(DEFAULT_PROVIDER),
    temperature: "0.7",
    system_prompt: [
      "Tu es un assistant consultant professionnel.",
      "Tu réponds en français avec un ton naturel, clair et respectueux.",
      "Tu proposes des conseils concrets, structurés et orientés résultats.",
      "Tu restes bref quand la question est simple, et détaillé quand le besoin est complexe.",
      "Si une information manque, pose une question de clarification utile.",
    ].join("\n"),
    top_k: "4",
    human_delay_min_ms: process.env.HUMAN_DELAY_MIN_MS || "10000",
    human_delay_max_ms: process.env.HUMAN_DELAY_MAX_MS || "15000",
    reply_chunk_min_sentences: process.env.REPLY_CHUNK_MIN_SENTENCES || "2",
    reply_chunk_max_sentences: process.env.REPLY_CHUNK_MAX_SENTENCES || "3",
    reply_chunk_delay_min_ms: process.env.REPLY_CHUNK_DELAY_MIN_MS || "5000",
    reply_chunk_delay_max_ms: process.env.REPLY_CHUNK_DELAY_MAX_MS || "6000",
  };

  return {
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
  };
}

module.exports = {
  createRuntimeConfig,
  normalizeProvider,
  defaultModelForProvider,
  SUPPORTED_PROVIDERS,
};
