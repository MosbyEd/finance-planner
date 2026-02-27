const express = require("express");
const cookieParser = require("cookie-parser");
const bcrypt = require("bcryptjs");
const path = require("path");
const db = require("./db");

const app = express();
const PORT = process.env.PORT || 3000;
const SESSION_COOKIE = "finance_session";

app.use(express.json());
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

  db.get("SELECT id, login, password_hash FROM users WHERE login = ?", [login], (err, user) => {
    if (err) return res.status(500).json({ error: "DB error" });

    const finishLogin = (userRow) => {
      res.cookie(SESSION_COOKIE, userRow.login, {
        httpOnly: true,
        sameSite: "lax",
      });
      res.json({ login: userRow.login });
    };

    if (!user) {
      const hash = bcrypt.hashSync(password, 10);
      db.run(
        "INSERT INTO users (login, password_hash) VALUES (?, ?)",
        [login, hash],
        function (err2) {
          if (err2) return res.status(500).json({ error: "DB error" });
          finishLogin({ id: this.lastID, login });
        },
      );
    } else {
      if (!bcrypt.compareSync(password, user.password_hash)) {
        return res.status(401).json({ error: "Неверный логин или пароль" });
      }
      finishLogin(user);
    }
  });
});

app.post("/api/auth/logout", (req, res) => {
  res.clearCookie(SESSION_COOKIE);
  res.json({ ok: true });
});

app.get("/api/me", (req, res) => {
  getUserFromReq(req, (err, user) => {
    if (err) return res.status(500).json({ error: "DB error" });
    if (!user) return res.json({ login: null });
    res.json({ login: user.login });
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

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});

