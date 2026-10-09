-- Cada canción tiene dueño y una visibilidad elegida por él:
--   private = sólo el dueño · title = los demás ven el título y piden una copia · public = todos la ven (sólo lectura)
-- Las canciones que ya estaban pasan a ser del primer administrador.
ALTER TABLE songs ADD COLUMN owner_id INTEGER REFERENCES users(id);
ALTER TABLE songs ADD COLUMN visibility TEXT NOT NULL DEFAULT 'private';
ALTER TABLE songs ADD COLUMN copied_from INTEGER;
UPDATE songs SET owner_id = (SELECT id FROM users WHERE role = 'admin' ORDER BY id LIMIT 1) WHERE owner_id IS NULL;
CREATE INDEX songs_owner ON songs(owner_id);

-- Ya no hay "lectores": todos pueden tener sus propias canciones (el rol 'editor' se muestra como "Usuario").
UPDATE users SET role = 'editor' WHERE role = 'reader';

-- Pedidos de copia de una canción con visibilidad "title".
CREATE TABLE song_requests (
  id INTEGER PRIMARY KEY,
  song_id INTEGER NOT NULL REFERENCES songs(id),
  requester_id INTEGER NOT NULL REFERENCES users(id),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'denied')),
  created_at INTEGER NOT NULL,
  resolved_at INTEGER,
  copy_slug TEXT
);
CREATE INDEX song_requests_song ON song_requests(song_id);
CREATE INDEX song_requests_requester ON song_requests(requester_id);
