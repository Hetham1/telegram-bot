CREATE TABLE users (
  id INTEGER PRIMARY KEY,
  username TEXT NOT NULL DEFAULT '',
  first_name TEXT NOT NULL DEFAULT '',
  is_admin INTEGER NOT NULL DEFAULT 0 CHECK (is_admin IN (0, 1)),
  active INTEGER NOT NULL DEFAULT 0 CHECK (active IN (0, 1)),
  pending_action TEXT,
  pending_until INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX users_recipients ON users(active, is_admin, id);

CREATE TABLE inbox (
  update_id INTEGER PRIMARY KEY,
  payload TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  processed_at INTEGER,
  locked_until INTEGER NOT NULL DEFAULT 0,
  attempts INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX inbox_pending ON inbox(processed_at, locked_until, update_id);

CREATE TABLE prompts (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  date TEXT NOT NULL,
  period TEXT NOT NULL CHECK (period IN ('afternoon', 'evening')),
  created_at INTEGER NOT NULL,
  answer TEXT CHECK (answer IN ('yes', 'no')),
  answer_update_id INTEGER UNIQUE,
  answered_at INTEGER
);
CREATE INDEX prompts_statistics ON prompts(date, period, answer);
CREATE INDEX prompts_user_dose ON prompts(user_id, date, period, answer);

CREATE TABLE reminders (
  user_id INTEGER NOT NULL REFERENCES users(id),
  date TEXT NOT NULL,
  period TEXT NOT NULL CHECK (period IN ('afternoon', 'evening')),
  due_at INTEGER NOT NULL,
  source_update_id INTEGER NOT NULL,
  PRIMARY KEY (user_id, date, period)
);
CREATE INDEX reminders_due ON reminders(due_at);

CREATE TABLE outbox (
  id TEXT PRIMARY KEY,
  chat_id INTEGER NOT NULL,
  method TEXT NOT NULL,
  payload TEXT NOT NULL,
  prompt_id TEXT REFERENCES prompts(id),
  created_at INTEGER NOT NULL,
  due_at INTEGER NOT NULL,
  locked_until INTEGER NOT NULL DEFAULT 0,
  attempts INTEGER NOT NULL DEFAULT 0,
  sent_at INTEGER,
  failed_at INTEGER,
  last_error TEXT
);
CREATE INDEX outbox_pending ON outbox(sent_at, failed_at, due_at, locked_until);
