-- Esquema inicial del Cancionero 2.0

CREATE TABLE users (
  id INTEGER PRIMARY KEY,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT NOT NULL,
  pass_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin', 'editor', 'reader')),
  disabled INTEGER NOT NULL DEFAULT 0,
  failed INTEGER NOT NULL DEFAULT 0,       -- intentos fallidos seguidos
  locked_until INTEGER NOT NULL DEFAULT 0, -- bloqueo temporal tras muchos intentos
  created_at INTEGER NOT NULL
);

-- Sesiones: se guarda sólo el hash del token, nunca el token.
CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX sessions_user ON sessions(user_id);

-- Canciones en formato ChordPro. Borrar = marcar deleted (para que los celulares se enteren).
CREATE TABLE songs (
  id INTEGER PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  text TEXT NOT NULL,
  rev INTEGER NOT NULL DEFAULT 1,
  deleted INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  updated_by INTEGER REFERENCES users(id)
);
CREATE INDEX songs_updated ON songs(updated_at);

-- Cada versión anterior de una canción, para poder volver atrás.
CREATE TABLE song_history (
  id INTEGER PRIMARY KEY,
  song_id INTEGER NOT NULL REFERENCES songs(id),
  text TEXT NOT NULL,
  rev INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  updated_by INTEGER REFERENCES users(id)
);
CREATE INDEX song_history_song ON song_history(song_id);

-- Listas. items = JSON [{id, song, label}]. share_all: 0 = privada, 1 = todo el coro la ve, 2 = todos la editan.
CREATE TABLE lists (
  id INTEGER PRIMARY KEY,
  owner_id INTEGER NOT NULL REFERENCES users(id),
  name TEXT NOT NULL,
  date TEXT,
  items TEXT NOT NULL DEFAULT '[]',
  share_all INTEGER NOT NULL DEFAULT 0,
  rev INTEGER NOT NULL DEFAULT 1,
  deleted INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);

-- Con quién se comparte cada lista y si puede editarla.
CREATE TABLE list_shares (
  list_id INTEGER NOT NULL REFERENCES lists(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  can_edit INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (list_id, user_id)
);
CREATE INDEX list_shares_user ON list_shares(user_id);

-- El tono de cada canción de una lista es personal: JSON {itemId: semitonos}.
CREATE TABLE list_semis (
  list_id INTEGER NOT NULL REFERENCES lists(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  semis TEXT NOT NULL DEFAULT '{}',
  PRIMARY KEY (list_id, user_id)
);
