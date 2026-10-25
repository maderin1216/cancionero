-- Fecha en que se agregó cada canción. Para las que ya existían: la versión más vieja que se conoce.
-- (Las importadas de Word se corrigen después con la fecha de cada archivo.)
ALTER TABLE songs ADD COLUMN created_at INTEGER;
UPDATE songs SET created_at = MIN(updated_at, COALESCE((SELECT MIN(h.updated_at) FROM song_history h WHERE h.song_id = songs.id), updated_at));

-- Enlaces públicos para compartir una canción (cualquiera con el enlace la ve, sin usuario).
CREATE TABLE song_shares (
  token TEXT PRIMARY KEY,
  song_id INTEGER NOT NULL UNIQUE REFERENCES songs(id),
  created_by INTEGER REFERENCES users(id),
  created_at INTEGER NOT NULL
);
