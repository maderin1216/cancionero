-- Un audio corto (hasta 30 segundos) por canción. Se guarda aparte para no mandarlo en cada sincronización.
CREATE TABLE song_audio (
  song_id INTEGER PRIMARY KEY REFERENCES songs(id),
  mime TEXT NOT NULL,
  data BLOB NOT NULL,
  duration REAL NOT NULL,
  size INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  updated_by INTEGER REFERENCES users(id)
);
