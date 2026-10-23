CREATE TABLE stations (
  kind TEXT NOT NULL CHECK (kind IN ('video', 'playlist')),
  ref TEXT NOT NULL,
  title TEXT NOT NULL,
  keeps INTEGER NOT NULL DEFAULT 0,
  reports INTEGER NOT NULL DEFAULT 0,
  added_at INTEGER NOT NULL,
  PRIMARY KEY (kind, ref)
);
