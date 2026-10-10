require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });
const express = require("express");
const cookieParser = require("cookie-parser");
const bcrypt = require("bcryptjs");
const path = require("path");
const fs = require("fs");
const db = require("./db");

const app = express();
const PORT = process.env.PORT || 3000;
const SESSION_COOKIE = "finance_session";
const DEEPSEEK_API_URL = "https://api.deepseek.com/chat/completions";
const DEEPSEEK_MODELS = { "deepseek-reasoner": true, "deepseek-chat": true };

app.use(express.json({ limit: "15mb" }));
app.use(cookieParser());

// CORS для разработки; если фронт и бэк на одном origin, можно упростить
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", req.headers.origin || "*");
  res.header("Access-Control-Allow-Credentials", "true");
  res.header("Access-Control-Allow-Headers", "Content-Type");
  res.header("Access-Control-Allow-Methods", "GET,POST,PUT,OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

// Раздача статики (index.html, app.js)
app.use(express.static(path.join(__dirname, "..")));

function getUserFromReq(req, cb) {
  const login = req.cookies[SESSION_COOKIE];
  if (!login) return cb(null, null);
  db.get("SELECT id, login FROM users WHERE login = ?", [login], (err, row) => {
    if (err) return cb(err);
    cb(null, row || null);
  });
}

app.post("/api/auth/login", (req, res) => {
  const { login, password } = req.body || {};
  if (!login || !password) return res.status(400).json({ error: "Логин и пароль обязательны" });

  db.get("SELECT id, login, password_hash, name FROM users WHERE login = ?", [login], (err, user) => {
    if (err) return res.status(500).json({ error: "DB error" });
    if (!user) return res.status(401).json({ error: "Неверный логин или пароль" });

    if (!bcrypt.compareSync(password, user.password_hash)) {
      return res.status(401).json({ error: "Неверный логин или пароль" });
    }

    res.cookie(SESSION_COOKIE, user.login, {
      httpOnly: true,
      sameSite: "lax",
    });
    res.json({ login: user.login, name: user.name || null });
  });
});

app.post("/api/auth/register", (req, res) => {
  const { login, password, name } = req.body || {};
  if (!login || !password) return res.status(400).json({ error: "Логин и пароль обязательны" });

  db.get("SELECT id FROM users WHERE login = ?", [login], (err, user) => {
    if (err) return res.status(500).json({ error: "DB error" });
    if (user) return res.status(409).json({ error: "Такой логин уже существует" });

    const hash = bcrypt.hashSync(password, 10);
    db.run(
      "INSERT INTO users (login, password_hash, name) VALUES (?, ?, ?)",
      [login, hash, name || null],
      function (err2) {
        if (err2) return res.status(500).json({ error: "DB error" });
        const newUser = { id: this.lastID, login, name: name || null };
        // Не логиним автоматически — пользователь должен войти явно.
        res.json({ login: newUser.login, name: newUser.name });
      },
    );
  });
});

app.post("/api/auth/logout", (req, res) => {
  res.clearCookie(SESSION_COOKIE);
  res.json({ ok: true });
});

app.get("/api/me", (req, res) => {
  getUserFromReq(req, (err, user) => {
    if (err) return res.status(500).json({ error: "DB error" });
    if (!user) return res.json({ login: null, name: null });
    res.json({ login: user.login, name: user.name || null });
  });
});

app.get("/api/state", (req, res) => {
  getUserFromReq(req, (err, user) => {
    if (err) return res.status(500).json({ error: "DB error" });
    if (!user) return res.status(401).json({ error: "Не авторизован" });

    db.get("SELECT state_json FROM user_states WHERE user_id = ?", [user.id], (err2, row) => {
      if (err2) return res.status(500).json({ error: "DB error" });
      if (!row) return res.json(null);
      try {
        res.json(JSON.parse(row.state_json));
      } catch {
        res.json(null);
      }
    });
  });
});

app.put("/api/state", (req, res) => {
  const state = req.body;
  getUserFromReq(req, (err, user) => {
    if (err) return res.status(500).json({ error: "DB error" });
    if (!user) return res.status(401).json({ error: "Не авторизован" });

    const json = JSON.stringify(state || {});
    db.run(
      `
      INSERT INTO user_states (user_id, state_json)
      VALUES (?, ?)
      ON CONFLICT(user_id) DO UPDATE SET state_json = excluded.state_json
    `,
      [user.id, json],
      (err2) => {
        if (err2) return res.status(500).json({ error: "DB error" });
        res.json({ ok: true });
      },
    );
  });
});

async function callDeepSeek(apiKey, model, finalMessages, temp) {
  const startMs = Date.now();
  const response = await fetch(DEEPSEEK_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ model, messages: finalMessages, temperature: temp, stream: false }),
  });
  const data = await response.json();
  console.log(`[DeepSeek] Response received in ${((Date.now() - startMs) / 1000).toFixed(1)}s, model=${model}`);
  return { response, data };
}

function extractAiText(data) {
  const msg = data.choices?.[0]?.message;
  let text = (msg?.content) || "";
  if (text.includes("<think>")) {
    text = text.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
  }
  const reasoning = msg?.reasoning_content || undefined;
  return { text, reasoning };
}

app.post("/api/ai", async (req, res) => {
  const deepseekKey = process.env.DEEPSEEK_API_KEY;
  if (!deepseekKey) {
    return res.status(500).json({ error: "DEEPSEEK_API_KEY не задан на сервере" });
  }

  const { messages, prompt, temperature, model: requestedModel } = req.body || {};

  let finalMessages = Array.isArray(messages) ? messages : null;
  if (!finalMessages || finalMessages.length === 0) {
    if (typeof prompt !== "string" || !prompt.trim()) {
      return res.status(400).json({ error: "Either 'messages' or 'prompt' must be provided" });
    }
    finalMessages = [{ role: "user", content: prompt.trim() }];
  }

  const temp =
    typeof temperature === "number" && Number.isFinite(temperature)
      ? Math.max(0, Math.min(temperature, 1))
      : 0.4;

  const dsModel = typeof requestedModel === "string" && DEEPSEEK_MODELS[requestedModel] ? requestedModel : "deepseek-chat";

  try {
    console.log(`[DeepSeek] Calling model=${dsModel}, msgLen=${JSON.stringify(finalMessages).length}`);
    const { response, data } = await callDeepSeek(deepseekKey, dsModel, finalMessages, temp);

    if (data.error) {
      const errMsg = data.error.message || data.error.type || JSON.stringify(data.error);
      console.error("[DeepSeek] Error:", errMsg);
      return res.status(response.ok ? 502 : response.status).json({
        error: `DeepSeek: ${errMsg}`,
        provider: "deepseek",
      });
    }

    const { text, reasoning } = extractAiText(data);
    const usedModel = data.model || dsModel;
    return res.json({ text, reasoning, model: `deepseek/${usedModel}`, provider: "deepseek", raw: data });
  } catch (err) {
    console.error("[DeepSeek] Request failed:", err.message);
    return res.status(500).json({ error: `DeepSeek API: ${err.message}`, provider: "deepseek" });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});

