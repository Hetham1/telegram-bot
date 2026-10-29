ALTER TABLE users ADD COLUMN schedule_initialized INTEGER NOT NULL DEFAULT 0;

CREATE TABLE schedules (
  user_id INTEGER NOT NULL REFERENCES users(id),
  key TEXT NOT NULL,
  time_minutes INTEGER NOT NULL CHECK (time_minutes BETWEEN 0 AND 1439),
  pills TEXT NOT NULL CHECK (length(pills) BETWEEN 1 AND 500),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  deleted INTEGER NOT NULL DEFAULT 0 CHECK (deleted IN (0, 1)),
  revision INTEGER NOT NULL DEFAULT 1,
  effective_date TEXT NOT NULL DEFAULT '0000-00-00',
  last_update_id INTEGER,
  PRIMARY KEY (user_id, key)
);
CREATE UNIQUE INDEX schedules_time ON schedules(user_id, time_minutes) WHERE deleted = 0;
CREATE INDEX schedules_due ON schedules(enabled, deleted, time_minutes);

INSERT INTO schedules(user_id, key, time_minutes, pills)
  SELECT id, 'afternoon', 840, 'اسنترا' FROM users;
INSERT INTO schedules(user_id, key, time_minutes, pills)
  SELECT id, 'evening', 1320, 'اون دوتا' FROM users;
UPDATE users SET schedule_initialized = 1;

ALTER TABLE prompts ADD COLUMN schedule_key TEXT;
ALTER TABLE prompts ADD COLUMN schedule_revision INTEGER NOT NULL DEFAULT 1;
ALTER TABLE prompts ADD COLUMN time_minutes INTEGER;
ALTER TABLE prompts ADD COLUMN pills TEXT;
ALTER TABLE prompts ADD COLUMN canceled_at INTEGER;
UPDATE prompts SET schedule_key = period,
  time_minutes = CASE period WHEN 'afternoon' THEN 840 ELSE 1320 END,
  pills = CASE period WHEN 'afternoon' THEN 'اسنترا' ELSE 'اون دوتا' END;
CREATE INDEX prompts_schedule ON prompts(user_id, schedule_key, canceled_at);

-- The period column now stores the schedule key, including newly created slots.
-- This table has no incoming foreign keys. Preserve every existing snooze.
CREATE TABLE reminders_new (
  user_id INTEGER NOT NULL REFERENCES users(id),
  date TEXT NOT NULL,
  period TEXT NOT NULL,
  due_at INTEGER NOT NULL,
  source_update_id INTEGER NOT NULL,
  PRIMARY KEY (user_id, date, period)
);
INSERT INTO reminders_new SELECT * FROM reminders;
DROP TABLE reminders;
ALTER TABLE reminders_new RENAME TO reminders;
CREATE INDEX reminders_due ON reminders(due_at);

CREATE TABLE schedule_edits (
  user_id INTEGER PRIMARY KEY REFERENCES users(id),
  token TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('add', 'time', 'pills')),
  schedule_key TEXT NOT NULL,
  base_revision INTEGER NOT NULL,
  step TEXT NOT NULL CHECK (step IN ('time', 'pills', 'confirm')),
  time_minutes INTEGER,
  pills TEXT,
  expires_at INTEGER NOT NULL
);
