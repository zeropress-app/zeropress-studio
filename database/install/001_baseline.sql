-- ZeroPress Studio fresh-install baseline.
-- This artifact is executed by the Studio lifecycle runner.
-- Do not use it with `wrangler d1 migrations`.

CREATE TABLE zeropress_schema_state (
  id INTEGER PRIMARY KEY
    CHECK (id = 1),
  schema_version INTEGER NOT NULL
    CHECK (schema_version >= 0),
  lifecycle_state TEXT NOT NULL
    CHECK (lifecycle_state IN ('ready', 'installing', 'upgrading', 'failed')),
  target_schema_version INTEGER
    CHECK (target_schema_version IS NULL OR target_schema_version > 0),
  active_operation_id TEXT
    CHECK (
      active_operation_id IS NULL
      OR (
        length(active_operation_id) BETWEEN 1 AND 128
        AND active_operation_id = trim(active_operation_id)
      )
    ),
  updated_at_iso TEXT NOT NULL,
  CHECK (
    (
      lifecycle_state = 'ready'
      AND target_schema_version IS NULL
      AND active_operation_id IS NULL
    )
    OR (
      lifecycle_state IN ('installing', 'upgrading')
      AND target_schema_version IS NOT NULL
      AND active_operation_id IS NOT NULL
    )
    OR lifecycle_state = 'failed'
  )
);

CREATE TABLE auth_rate_limits (
  scope TEXT NOT NULL
    CHECK (scope IN ('login_account', 'login_ip', 'totp_account')),
  subject_hash TEXT NOT NULL
    CHECK (length(subject_hash) = 64 AND subject_hash NOT GLOB '*[^0-9a-f]*'),
  attempt_count INTEGER NOT NULL
    CHECK (attempt_count >= 1),
  reset_at INTEGER NOT NULL
    CHECK (reset_at >= 0),
  PRIMARY KEY (scope, subject_hash)
);

CREATE INDEX idx_auth_rate_limits_reset_at
  ON auth_rate_limits(reset_at);

CREATE TABLE users (
  id TEXT PRIMARY KEY
    CHECK (
      length(id) = 32
      AND id NOT GLOB '*[^0-9a-f]*'
    ),
  email TEXT NOT NULL UNIQUE
    CHECK (
      email = lower(email)
      AND email = trim(email)
      AND length(email) BETWEEN 3 AND 254
    ),
  password_hash TEXT NOT NULL
    CHECK (length(password_hash) BETWEEN 1 AND 2048),
  auth_revision TEXT NOT NULL DEFAULT (lower(hex(randomblob(16))))
    CHECK (
      length(auth_revision) = 32
      AND auth_revision NOT GLOB '*[^0-9a-f]*'
    ),
  name TEXT NOT NULL
    CHECK (
      name = trim(name)
      AND length(name) BETWEEN 2 AND 100
    ),
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'inactive', 'pending')),
  email_verified INTEGER NOT NULL DEFAULT 0
    CHECK (email_verified IN (0, 1)),
  failed_login_attempts INTEGER NOT NULL DEFAULT 0
    CHECK (failed_login_attempts >= 0),
  locked_until TEXT,
  created_at_iso TEXT NOT NULL,
  updated_at_iso TEXT NOT NULL
);

CREATE INDEX idx_users_status
  ON users(status);

CREATE TABLE authors (
  id TEXT PRIMARY KEY
    CHECK (
      length(id) BETWEEN 1 AND 512
      AND id NOT GLOB '*[^A-Za-z0-9_-]*'
    ),
  user_id TEXT UNIQUE
    REFERENCES users(id) ON DELETE SET NULL,
  display_name TEXT NOT NULL
    CHECK (
      display_name = trim(display_name)
      AND length(display_name) BETWEEN 1 AND 200
    ),
  revision TEXT NOT NULL DEFAULT (lower(hex(randomblob(16))))
    CHECK (
      length(revision) = 32
      AND revision NOT GLOB '*[^0-9a-f]*'
    ),
  created_at_iso TEXT NOT NULL,
  updated_at_iso TEXT NOT NULL,
  CHECK (created_at_iso <= updated_at_iso)
);

CREATE INDEX idx_authors_display_name
  ON authors(display_name COLLATE NOCASE, id);

CREATE TABLE categories (
  id TEXT PRIMARY KEY
    CHECK (
      length(id) = 32
      AND id NOT GLOB '*[^0-9a-f]*'
    ),
  name TEXT NOT NULL
    CHECK (
      name = trim(name)
      AND length(name) BETWEEN 1 AND 200
    ),
  slug TEXT NOT NULL UNIQUE
    CHECK (
      slug = trim(slug)
      AND length(slug) BETWEEN 1 AND 200
      AND slug != '.'
      AND slug != '..'
      AND substr(slug, 1, 1) != '.'
      AND substr(slug, -1, 1) != '.'
      AND instr(slug, '..') = 0
      AND instr(slug, '/') = 0
      AND instr(slug, char(92)) = 0
      AND instr(slug, '%') = 0
    ),
  description TEXT NOT NULL DEFAULT ''
    CHECK (
      description = trim(description)
      AND length(description) <= 10000
    ),
  revision TEXT NOT NULL DEFAULT (lower(hex(randomblob(16))))
    CHECK (
      length(revision) = 32
      AND revision NOT GLOB '*[^0-9a-f]*'
    ),
  created_at_iso TEXT NOT NULL,
  updated_at_iso TEXT NOT NULL,
  CHECK (created_at_iso <= updated_at_iso)
);

CREATE INDEX idx_categories_name
  ON categories(name COLLATE NOCASE, slug, id);

CREATE TABLE tags (
  id TEXT PRIMARY KEY
    CHECK (
      length(id) = 32
      AND id NOT GLOB '*[^0-9a-f]*'
    ),
  name TEXT NOT NULL
    CHECK (
      name = trim(name)
      AND length(name) BETWEEN 1 AND 200
    ),
  slug TEXT NOT NULL UNIQUE
    CHECK (
      slug = trim(slug)
      AND length(slug) BETWEEN 1 AND 200
      AND slug != '.'
      AND slug != '..'
      AND substr(slug, 1, 1) != '.'
      AND substr(slug, -1, 1) != '.'
      AND instr(slug, '..') = 0
      AND instr(slug, '/') = 0
      AND instr(slug, char(92)) = 0
      AND instr(slug, '%') = 0
    ),
  description TEXT NOT NULL DEFAULT ''
    CHECK (
      description = trim(description)
      AND length(description) <= 10000
    ),
  revision TEXT NOT NULL DEFAULT (lower(hex(randomblob(16))))
    CHECK (
      length(revision) = 32
      AND revision NOT GLOB '*[^0-9a-f]*'
    ),
  created_at_iso TEXT NOT NULL,
  updated_at_iso TEXT NOT NULL,
  CHECK (created_at_iso <= updated_at_iso)
);

CREATE INDEX idx_tags_name
  ON tags(name COLLATE NOCASE, slug, id);

CREATE TABLE content_public_id_counters (
  content_type TEXT NOT NULL PRIMARY KEY
    CHECK (content_type IN ('post', 'page')),
  last_public_id INTEGER NOT NULL
    CHECK (
      last_public_id BETWEEN 100000000000 AND 9007199254740991
    )
);

INSERT INTO content_public_id_counters (content_type, last_public_id)
VALUES
  ('post', 100000000000),
  ('page', 100000000000);

CREATE TABLE media_collections (
  id TEXT PRIMARY KEY
    CHECK (
      length(id) = 32
      AND id NOT GLOB '*[^0-9a-f]*'
    ),
  name TEXT NOT NULL
    CHECK (
      name = trim(name)
      AND length(name) BETWEEN 1 AND 100
    ),
  revision TEXT NOT NULL DEFAULT (lower(hex(randomblob(16))))
    CHECK (
      length(revision) = 32
      AND revision NOT GLOB '*[^0-9a-f]*'
    ),
  created_at_iso TEXT NOT NULL,
  updated_at_iso TEXT NOT NULL,
  CHECK (created_at_iso <= updated_at_iso)
);

CREATE UNIQUE INDEX idx_media_collections_name
  ON media_collections(name COLLATE NOCASE);

CREATE TABLE media (
  id TEXT PRIMARY KEY
    CHECK (
      length(id) = 32
      AND id NOT GLOB '*[^0-9a-f]*'
    ),
  kind TEXT NOT NULL
    CHECK (kind IN ('image', 'video', 'audio', 'document', 'archive', 'other')),
  filename TEXT NOT NULL
    CHECK (
      filename = trim(filename)
      AND length(filename) BETWEEN 1 AND 255
      AND instr(filename, '/') = 0
      AND instr(filename, char(92)) = 0
    ),
  mime_type TEXT NOT NULL
    CHECK (
      mime_type = lower(trim(mime_type))
      AND length(mime_type) BETWEEN 3 AND 255
      AND instr(mime_type, '/') > 1
      AND instr(mime_type, ';') = 0
    ),
  storage_type TEXT NOT NULL
    CHECK (storage_type IN ('r2', 'external')),
  storage_key TEXT
    CHECK (
      storage_key IS NULL
      OR (
        storage_key = trim(storage_key)
        AND length(storage_key) BETWEEN 1 AND 1024
        AND substr(storage_key, 1, 1) != '/'
        AND substr(storage_key, -1, 1) != '/'
        AND instr(storage_key, '//') = 0
        AND instr(storage_key, char(92)) = 0
        AND instr(storage_key, '?') = 0
        AND instr(storage_key, '#') = 0
      )
    ),
  external_url TEXT
    CHECK (
      external_url IS NULL
      OR (
        external_url = trim(external_url)
        AND length(external_url) BETWEEN 9 AND 2048
        AND instr(external_url, char(92)) = 0
      )
    ),
  size_bytes INTEGER
    CHECK (size_bytes IS NULL OR size_bytes BETWEEN 0 AND 9007199254740991),
  width INTEGER
    CHECK (width IS NULL OR width BETWEEN 1 AND 100000),
  height INTEGER
    CHECK (height IS NULL OR height BETWEEN 1 AND 100000),
  duration_ms INTEGER
    CHECK (duration_ms IS NULL OR duration_ms BETWEEN 0 AND 9007199254740991),
  alt TEXT NOT NULL DEFAULT ''
    CHECK (
      alt = trim(alt)
      AND length(alt) <= 1000
    ),
  revision TEXT NOT NULL DEFAULT (lower(hex(randomblob(16))))
    CHECK (
      length(revision) = 32
      AND revision NOT GLOB '*[^0-9a-f]*'
    ),
  created_at_iso TEXT NOT NULL,
  updated_at_iso TEXT NOT NULL,
  CHECK (
    (storage_type = 'r2' AND storage_key IS NOT NULL AND external_url IS NULL)
    OR
    (storage_type = 'external' AND storage_key IS NULL AND external_url IS NOT NULL)
  ),
  CHECK ((width IS NULL) = (height IS NULL)),
  CHECK (kind IN ('image', 'video') OR width IS NULL),
  CHECK (kind IN ('audio', 'video') OR duration_ms IS NULL),
  CHECK (kind = 'image' OR alt = ''),
  CHECK (kind != 'image' OR substr(mime_type, 1, 6) = 'image/'),
  CHECK (kind != 'video' OR substr(mime_type, 1, 6) = 'video/'),
  CHECK (kind != 'audio' OR substr(mime_type, 1, 6) = 'audio/'),
  CHECK (created_at_iso <= updated_at_iso)
);

-- Keep collection identity outside public Media contracts.
ALTER TABLE media ADD COLUMN collection_id TEXT
  REFERENCES media_collections(id) ON DELETE RESTRICT;

-- It is a single-source WXR reconciliation identity, not a public Media ID.
ALTER TABLE media ADD COLUMN external_id INTEGER
  CHECK (
    external_id IS NULL
    OR external_id BETWEEN 1 AND 99999999999
  );

-- AI generation provenance is private Media information, not list metadata.
ALTER TABLE media ADD COLUMN ai_generation_json TEXT
  CHECK (
    ai_generation_json IS NULL
    OR (
      kind = 'image'
      AND storage_type = 'r2'
      AND length(ai_generation_json) BETWEEN 2 AND 16384
      AND json_valid(ai_generation_json)
      AND json_type(ai_generation_json) = 'object'
    )
  );

CREATE INDEX idx_media_updated
  ON media(updated_at_iso DESC, id);

CREATE UNIQUE INDEX idx_media_external_url_unique
  ON media(external_url)
  WHERE storage_type = 'external';

CREATE UNIQUE INDEX idx_media_storage_key_unique
  ON media(storage_key)
  WHERE storage_type = 'r2';

CREATE UNIQUE INDEX idx_media_external_id_unique
  ON media(external_id)
  WHERE external_id IS NOT NULL;

CREATE INDEX idx_media_kind_updated
  ON media(kind, updated_at_iso DESC, id);

CREATE INDEX idx_media_collection_updated
  ON media(collection_id, updated_at_iso DESC, id);

-- Author avatar selection is an optional restrictive image reference.
ALTER TABLE authors ADD COLUMN avatar_media_id TEXT
  REFERENCES media(id) ON DELETE RESTRICT;

CREATE INDEX idx_authors_avatar_media_id
  ON authors(avatar_media_id)
  WHERE avatar_media_id IS NOT NULL;

CREATE TRIGGER trg_authors_avatar_media_insert
BEFORE INSERT ON authors
WHEN NEW.avatar_media_id IS NOT NULL
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM media
    WHERE id = NEW.avatar_media_id
      AND kind = 'image'
  ) THEN RAISE(ABORT, 'author avatar must reference image media') END;
END;

CREATE TRIGGER trg_authors_avatar_media_update
BEFORE UPDATE OF avatar_media_id ON authors
WHEN NEW.avatar_media_id IS NOT NULL
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM media
    WHERE id = NEW.avatar_media_id
      AND kind = 'image'
  ) THEN RAISE(ABORT, 'author avatar must reference image media') END;
END;

CREATE TRIGGER trg_media_preserve_author_avatar_shape
BEFORE UPDATE OF kind, mime_type ON media
WHEN EXISTS (
  SELECT 1 FROM authors WHERE avatar_media_id = OLD.id
) AND (
  NEW.kind != 'image'
  OR substr(NEW.mime_type, 1, 6) != 'image/'
)
BEGIN
  SELECT RAISE(ABORT, 'referenced author avatar must remain image media');
END;

CREATE TABLE site_assets (
  slot TEXT PRIMARY KEY
    CHECK (slot IN ('favicon', 'favicon_dark', 'apple_touch_icon', 'logo')),
  media_id TEXT NOT NULL
    REFERENCES media(id) ON DELETE RESTRICT,
  alt_text TEXT
    CHECK (
      alt_text IS NULL
      OR (
        slot = 'logo'
        AND alt_text = trim(alt_text)
        AND length(alt_text) BETWEEN 1 AND 500
      )
    ),
  updated_by TEXT
    REFERENCES users(id) ON DELETE SET NULL,
  updated_at_iso TEXT NOT NULL,
  CHECK (slot = 'logo' OR alt_text IS NULL)
);

CREATE INDEX idx_site_assets_media_id
  ON site_assets(media_id);

CREATE TRIGGER trg_site_assets_media_insert
BEFORE INSERT ON site_assets
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM media
    WHERE id = NEW.media_id
      AND kind = 'image'
      AND (
        NEW.slot = 'logo'
        OR mime_type IN (
          'image/png',
          'image/svg+xml',
          'image/x-icon',
          'image/vnd.microsoft.icon'
        )
      )
  ) THEN RAISE(ABORT, 'site asset must reference compatible image media') END;
END;

CREATE TRIGGER trg_site_assets_media_update
BEFORE UPDATE OF slot, media_id ON site_assets
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM media
    WHERE id = NEW.media_id
      AND kind = 'image'
      AND (
        NEW.slot = 'logo'
        OR mime_type IN (
          'image/png',
          'image/svg+xml',
          'image/x-icon',
          'image/vnd.microsoft.icon'
        )
      )
  ) THEN RAISE(ABORT, 'site asset must reference compatible image media') END;
END;

CREATE TRIGGER trg_media_preserve_site_asset_shape
BEFORE UPDATE OF kind, mime_type ON media
WHEN EXISTS (
  SELECT 1 FROM site_assets WHERE media_id = OLD.id
) AND (
  NEW.kind != 'image'
  OR (
    EXISTS (
      SELECT 1
      FROM site_assets
      WHERE media_id = OLD.id AND slot != 'logo'
    )
    AND NEW.mime_type NOT IN (
      'image/png',
      'image/svg+xml',
      'image/x-icon',
      'image/vnd.microsoft.icon'
    )
  )
)
BEGIN
  SELECT RAISE(ABORT, 'referenced site asset must remain a compatible image');
END;

CREATE TABLE media_upload_intents (
  id TEXT PRIMARY KEY
    CHECK (
      length(id) = 32
      AND id NOT GLOB '*[^0-9a-f]*'
    ),
  media_id TEXT NOT NULL UNIQUE
    CHECK (
      length(media_id) = 32
      AND media_id NOT GLOB '*[^0-9a-f]*'
    ),
  user_id TEXT NOT NULL
    REFERENCES users(id) ON DELETE CASCADE,
  filename TEXT NOT NULL
    CHECK (
      filename = trim(filename)
      AND length(filename) BETWEEN 1 AND 255
      AND instr(filename, '/') = 0
      AND instr(filename, char(92)) = 0
    ),
  kind TEXT NOT NULL
    CHECK (kind IN ('image', 'video', 'audio', 'document', 'archive')),
  mime_type TEXT NOT NULL
    CHECK (
      mime_type = lower(trim(mime_type))
      AND length(mime_type) BETWEEN 3 AND 255
      AND instr(mime_type, '/') > 1
      AND instr(mime_type, ';') = 0
    ),
  extension TEXT NOT NULL
    CHECK (
      extension = lower(trim(extension))
      AND length(extension) BETWEEN 1 AND 8
      AND extension NOT GLOB '*[^a-z0-9]*'
    ),
  signature TEXT NOT NULL
    CHECK (signature IN (
      'jpeg', 'png', 'gif', 'webp', 'avif', 'mp4', 'quicktime', 'webm',
      'mp3', 'aac', 'ogg', 'wav', 'flac', 'pdf', 'text', 'zip', 'tar',
      'gzip', 'seven_zip'
    )),
  disposition TEXT NOT NULL
    CHECK (disposition IN ('inline', 'attachment')),
  storage_key TEXT NOT NULL UNIQUE
    CHECK (
      storage_key = trim(storage_key)
      AND length(storage_key) BETWEEN 1 AND 1024
      AND substr(storage_key, 1, 8) = 'uploads/'
      AND substr(storage_key, -1, 1) != '/'
      AND instr(storage_key, '//') = 0
      AND instr(storage_key, char(92)) = 0
      AND instr(storage_key, '?') = 0
      AND instr(storage_key, '#') = 0
    ),
  size_bytes INTEGER NOT NULL
    CHECK (size_bytes BETWEEN 1 AND 67108864),
  width INTEGER
    CHECK (width IS NULL OR width BETWEEN 1 AND 100000),
  height INTEGER
    CHECK (height IS NULL OR height BETWEEN 1 AND 100000),
  duration_ms INTEGER
    CHECK (duration_ms IS NULL OR duration_ms BETWEEN 0 AND 9007199254740991),
  alt TEXT NOT NULL DEFAULT ''
    CHECK (
      alt = trim(alt)
      AND length(alt) <= 1000
    ),
  created_at_iso TEXT NOT NULL,
  expires_at_iso TEXT NOT NULL,
  CHECK ((width IS NULL) = (height IS NULL)),
  CHECK (kind = 'image' OR alt = ''),
  CHECK (kind IN ('image', 'video') OR width IS NULL),
  CHECK (kind IN ('audio', 'video') OR duration_ms IS NULL),
  CHECK (
    kind != 'image'
    OR (
      width IS NOT NULL
      AND width <= 32768
      AND height <= 32768
      AND width * height <= 100000000
    )
  ),
  CHECK (created_at_iso < expires_at_iso)
);

CREATE INDEX idx_media_upload_intents_expiry
  ON media_upload_intents(expires_at_iso, id);

CREATE INDEX idx_media_upload_intents_user
  ON media_upload_intents(user_id, created_at_iso DESC, id);

CREATE TABLE "media_object_deletions" (
  storage_key TEXT PRIMARY KEY
    CHECK (
      storage_key = trim(storage_key)
      AND length(storage_key) BETWEEN 1 AND 1024
      AND (
        substr(storage_key, 1, 8) = 'uploads/'
        OR substr(storage_key, 1, 9) = 'imported/'
      )
      AND substr(storage_key, -1, 1) != '/'
      AND instr(storage_key, '//') = 0
      AND instr(storage_key, char(92)) = 0
      AND instr(storage_key, '?') = 0
      AND instr(storage_key, '#') = 0
    ),
  attempt_count INTEGER NOT NULL DEFAULT 0
    CHECK (attempt_count >= 0),
  created_at_iso TEXT NOT NULL,
  last_attempt_at_iso TEXT,
  CHECK (
    last_attempt_at_iso IS NULL
    OR created_at_iso <= last_attempt_at_iso
  )
);

CREATE INDEX idx_media_object_deletions_attempt
  ON media_object_deletions(last_attempt_at_iso, created_at_iso, storage_key);

CREATE TABLE posts (
  id TEXT PRIMARY KEY
    CHECK (
      length(id) = 32
      AND id NOT GLOB '*[^0-9a-f]*'
    ),
  public_id INTEGER NOT NULL UNIQUE
    CHECK (public_id BETWEEN 1 AND 9007199254740991),
  title TEXT NOT NULL
    CHECK (
      title = trim(title)
      AND length(title) BETWEEN 1 AND 200
    ),
  slug TEXT NOT NULL UNIQUE
    CHECK (
      slug = trim(slug)
      AND length(slug) BETWEEN 1 AND 200
      AND slug != '.'
      AND slug != '..'
      AND substr(slug, 1, 1) != '.'
      AND substr(slug, -1, 1) != '.'
      AND instr(slug, '..') = 0
      AND instr(slug, '/') = 0
      AND instr(slug, char(92)) = 0
      AND instr(slug, '%') = 0
    ),
  content TEXT NOT NULL DEFAULT ''
    CHECK (length(content) <= 2000000),
  document_type TEXT NOT NULL DEFAULT 'markdown'
    CHECK (document_type IN ('plaintext', 'markdown', 'html')),
  excerpt TEXT NOT NULL DEFAULT ''
    CHECK (
      excerpt = trim(excerpt)
      AND length(excerpt) <= 500
    ),
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'published', 'trash')),
  author_id TEXT NOT NULL
    REFERENCES authors(id) ON DELETE RESTRICT,
  discoverability TEXT NOT NULL DEFAULT 'default'
    CHECK (discoverability IN ('default', 'noindex', 'delist')),
  allow_comments INTEGER NOT NULL DEFAULT 1
    CHECK (allow_comments IN (0, 1)),
  featured_image_id TEXT
    REFERENCES media(id) ON DELETE RESTRICT,
  published_at_iso TEXT,
  revision TEXT NOT NULL DEFAULT (lower(hex(randomblob(16))))
    CHECK (
      length(revision) = 32
      AND revision NOT GLOB '*[^0-9a-f]*'
    ),
  created_at_iso TEXT NOT NULL,
  updated_at_iso TEXT NOT NULL,
  editor_profile TEXT
    CHECK (editor_profile IS NULL OR editor_profile = 'tiptap-v1'),
  editor_mode TEXT NOT NULL DEFAULT 'source'
    CHECK (
    (editor_mode = 'source' AND editor_profile IS NULL)
    OR (
      editor_mode = 'visual'
      AND document_type = 'html'
      AND editor_profile = 'tiptap-v1'
      AND length(content) <= 131072
    )
  ),
  CHECK (created_at_iso <= updated_at_iso),
  CHECK (status != 'published' OR published_at_iso IS NOT NULL)
);

CREATE INDEX idx_posts_author
  ON posts(author_id, updated_at_iso DESC, id);

CREATE INDEX idx_posts_status_updated
  ON posts(status, updated_at_iso DESC, id);

CREATE INDEX idx_posts_featured_image
  ON posts(featured_image_id, id)
  WHERE featured_image_id IS NOT NULL;

CREATE INDEX idx_posts_published
  ON posts(published_at_iso DESC, public_id DESC)
  WHERE status = 'published';

CREATE TABLE post_categories (
  post_id TEXT NOT NULL
    REFERENCES posts(id) ON DELETE CASCADE,
  category_id TEXT NOT NULL
    REFERENCES categories(id) ON DELETE RESTRICT,
  PRIMARY KEY (post_id, category_id)
);

CREATE INDEX idx_post_categories_category
  ON post_categories(category_id, post_id);

CREATE TABLE post_tags (
  post_id TEXT NOT NULL
    REFERENCES posts(id) ON DELETE CASCADE,
  tag_id TEXT NOT NULL
    REFERENCES tags(id) ON DELETE RESTRICT,
  sort_order INTEGER NOT NULL
    CHECK (sort_order >= 0),
  PRIMARY KEY (post_id, tag_id),
  UNIQUE (post_id, sort_order)
);

CREATE INDEX idx_post_tags_tag
  ON post_tags(tag_id, post_id);

CREATE TABLE pages (
  id TEXT PRIMARY KEY
    CHECK (
      length(id) = 32
      AND id NOT GLOB '*[^0-9a-f]*'
    ),
  public_id INTEGER NOT NULL UNIQUE
    CHECK (public_id BETWEEN 1 AND 9007199254740991),
  parent_id TEXT
    REFERENCES pages(id) ON DELETE RESTRICT,
  title TEXT NOT NULL
    CHECK (
      title = trim(title)
      AND length(title) BETWEEN 1 AND 200
    ),
  slug TEXT NOT NULL
    CHECK (
      slug = trim(slug)
      AND length(slug) BETWEEN 1 AND 200
      AND slug != '.'
      AND slug != '..'
      AND substr(slug, 1, 1) != '.'
      AND substr(slug, -1, 1) != '.'
      AND instr(slug, '..') = 0
      AND instr(slug, '/') = 0
      AND instr(slug, char(92)) = 0
      AND instr(slug, '%') = 0
    ),
  content TEXT NOT NULL DEFAULT ''
    CHECK (length(content) <= 2000000),
  document_type TEXT NOT NULL DEFAULT 'markdown'
    CHECK (document_type IN ('plaintext', 'markdown', 'html')),
  excerpt TEXT NOT NULL DEFAULT ''
    CHECK (
      excerpt = trim(excerpt)
      AND length(excerpt) <= 500
    ),
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'published', 'trash')),
  discoverability TEXT NOT NULL DEFAULT 'default'
    CHECK (discoverability IN ('default', 'noindex', 'delist')),
  allow_comments INTEGER NOT NULL DEFAULT 0
    CHECK (allow_comments IN (0, 1)),
  featured_image_id TEXT
    REFERENCES media(id) ON DELETE RESTRICT,
  revision TEXT NOT NULL DEFAULT (lower(hex(randomblob(16))))
    CHECK (
      length(revision) = 32
      AND revision NOT GLOB '*[^0-9a-f]*'
    ),
  created_at_iso TEXT NOT NULL,
  updated_at_iso TEXT NOT NULL,
  editor_profile TEXT
    CHECK (editor_profile IS NULL OR editor_profile = 'tiptap-v1'),
  editor_mode TEXT NOT NULL DEFAULT 'source'
    CHECK (
    (editor_mode = 'source' AND editor_profile IS NULL)
    OR (
      editor_mode = 'visual'
      AND document_type = 'html'
      AND editor_profile = 'tiptap-v1'
      AND length(content) <= 131072
    )
  ),
  CHECK (parent_id IS NULL OR parent_id != id),
  CHECK (created_at_iso <= updated_at_iso)
);

CREATE UNIQUE INDEX idx_pages_root_slug_unique
  ON pages(slug)
  WHERE parent_id IS NULL;

CREATE UNIQUE INDEX idx_pages_sibling_slug_unique
  ON pages(parent_id, slug)
  WHERE parent_id IS NOT NULL;

CREATE INDEX idx_pages_parent
  ON pages(parent_id, title COLLATE NOCASE, id);

CREATE INDEX idx_pages_status_updated
  ON pages(status, updated_at_iso DESC, id);

CREATE INDEX idx_pages_featured_image
  ON pages(featured_image_id, id)
  WHERE featured_image_id IS NOT NULL;

CREATE TABLE post_autosaves (
  user_id TEXT NOT NULL
    REFERENCES users(id) ON DELETE CASCADE,
  draft_id TEXT NOT NULL
    CHECK (
      length(draft_id) = 32
      AND draft_id NOT GLOB '*[^0-9a-f]*'
    ),
  post_id TEXT
    REFERENCES posts(id) ON DELETE CASCADE,
  base_revision TEXT
    CHECK (
      base_revision IS NULL
      OR (
        length(base_revision) = 32
        AND base_revision NOT GLOB '*[^0-9a-f]*'
      )
    ),
  snapshot_version INTEGER NOT NULL
    CHECK (snapshot_version IN (1, 2)),
  snapshot_json TEXT NOT NULL
    CHECK (json_valid(snapshot_json)),
  snapshot_sha256 TEXT NOT NULL
    CHECK (
      length(snapshot_sha256) = 64
      AND snapshot_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  created_at_iso TEXT NOT NULL,
  updated_at_iso TEXT NOT NULL,
  expires_at_iso TEXT,
  PRIMARY KEY (user_id, draft_id),
  CHECK ((post_id IS NULL) = (base_revision IS NULL)),
  CHECK (created_at_iso <= updated_at_iso),
  CHECK (
    (
      post_id IS NULL
      AND expires_at_iso IS NOT NULL
      AND updated_at_iso < expires_at_iso
    )
    OR (post_id IS NOT NULL AND expires_at_iso IS NULL)
  )
);

CREATE UNIQUE INDEX idx_post_autosaves_user_post
  ON post_autosaves(user_id, post_id)
  WHERE post_id IS NOT NULL;

CREATE INDEX idx_post_autosaves_expires
  ON post_autosaves(expires_at_iso, user_id, draft_id)
  WHERE expires_at_iso IS NOT NULL;

CREATE TABLE page_autosaves (
  user_id TEXT NOT NULL
    REFERENCES users(id) ON DELETE CASCADE,
  draft_id TEXT NOT NULL
    CHECK (
      length(draft_id) = 32
      AND draft_id NOT GLOB '*[^0-9a-f]*'
    ),
  page_id TEXT
    REFERENCES pages(id) ON DELETE CASCADE,
  base_revision TEXT
    CHECK (
      base_revision IS NULL
      OR (
        length(base_revision) = 32
        AND base_revision NOT GLOB '*[^0-9a-f]*'
      )
    ),
  snapshot_version INTEGER NOT NULL
    CHECK (snapshot_version IN (1, 2)),
  snapshot_json TEXT NOT NULL
    CHECK (json_valid(snapshot_json)),
  snapshot_sha256 TEXT NOT NULL
    CHECK (
      length(snapshot_sha256) = 64
      AND snapshot_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  created_at_iso TEXT NOT NULL,
  updated_at_iso TEXT NOT NULL,
  expires_at_iso TEXT,
  PRIMARY KEY (user_id, draft_id),
  CHECK ((page_id IS NULL) = (base_revision IS NULL)),
  CHECK (created_at_iso <= updated_at_iso),
  CHECK (
    (
      page_id IS NULL
      AND expires_at_iso IS NOT NULL
      AND updated_at_iso < expires_at_iso
    )
    OR (page_id IS NOT NULL AND expires_at_iso IS NULL)
  )
);

CREATE UNIQUE INDEX idx_page_autosaves_user_page
  ON page_autosaves(user_id, page_id)
  WHERE page_id IS NOT NULL;

CREATE INDEX idx_page_autosaves_expires
  ON page_autosaves(expires_at_iso, user_id, draft_id)
  WHERE expires_at_iso IS NOT NULL;

CREATE TABLE post_revisions (
  post_id TEXT NOT NULL
    REFERENCES posts(id) ON DELETE CASCADE,
  revision_id TEXT NOT NULL
    CHECK (
      length(revision_id) = 32
      AND revision_id NOT GLOB '*[^0-9a-f]*'
    ),
  snapshot_version INTEGER NOT NULL
    CHECK (snapshot_version IN (1, 2)),
  snapshot_json TEXT NOT NULL
    CHECK (json_valid(snapshot_json)),
  snapshot_sha256 TEXT NOT NULL
    CHECK (
      length(snapshot_sha256) = 64
      AND snapshot_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  saved_at_iso TEXT NOT NULL,
  archived_at_iso TEXT NOT NULL,
  PRIMARY KEY (post_id, revision_id)
);

CREATE INDEX idx_post_revisions_history
  ON post_revisions(post_id, archived_at_iso DESC, revision_id DESC);

CREATE TABLE page_revisions (
  page_id TEXT NOT NULL
    REFERENCES pages(id) ON DELETE CASCADE,
  revision_id TEXT NOT NULL
    CHECK (
      length(revision_id) = 32
      AND revision_id NOT GLOB '*[^0-9a-f]*'
    ),
  snapshot_version INTEGER NOT NULL
    CHECK (snapshot_version IN (1, 2)),
  snapshot_json TEXT NOT NULL
    CHECK (json_valid(snapshot_json)),
  snapshot_sha256 TEXT NOT NULL
    CHECK (
      length(snapshot_sha256) = 64
      AND snapshot_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  saved_at_iso TEXT NOT NULL,
  archived_at_iso TEXT NOT NULL,
  PRIMARY KEY (page_id, revision_id)
);

CREATE INDEX idx_page_revisions_history
  ON page_revisions(page_id, archived_at_iso DESC, revision_id DESC);

CREATE TRIGGER trg_posts_featured_image_insert
BEFORE INSERT ON posts
WHEN NEW.featured_image_id IS NOT NULL
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM media
    WHERE id = NEW.featured_image_id
      AND kind = 'image'
      AND width IS NOT NULL
      AND height IS NOT NULL
  ) THEN RAISE(ABORT, 'featured image must reference dimensioned image media') END;
END;

CREATE TRIGGER trg_posts_featured_image_update
BEFORE UPDATE OF featured_image_id ON posts
WHEN NEW.featured_image_id IS NOT NULL
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM media
    WHERE id = NEW.featured_image_id
      AND kind = 'image'
      AND width IS NOT NULL
      AND height IS NOT NULL
  ) THEN RAISE(ABORT, 'featured image must reference dimensioned image media') END;
END;

CREATE TRIGGER trg_pages_featured_image_insert
BEFORE INSERT ON pages
WHEN NEW.featured_image_id IS NOT NULL
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM media
    WHERE id = NEW.featured_image_id
      AND kind = 'image'
      AND width IS NOT NULL
      AND height IS NOT NULL
  ) THEN RAISE(ABORT, 'featured image must reference dimensioned image media') END;
END;

CREATE TRIGGER trg_pages_featured_image_update
BEFORE UPDATE OF featured_image_id ON pages
WHEN NEW.featured_image_id IS NOT NULL
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM media
    WHERE id = NEW.featured_image_id
      AND kind = 'image'
      AND width IS NOT NULL
      AND height IS NOT NULL
  ) THEN RAISE(ABORT, 'featured image must reference dimensioned image media') END;
END;

CREATE TRIGGER trg_posts_document_type_change
BEFORE UPDATE OF document_type ON posts
WHEN OLD.document_type != NEW.document_type
  AND (OLD.content != '' OR NEW.content != '')
BEGIN
  SELECT RAISE(ABORT, 'non-empty Post document type cannot change');
END;

CREATE TRIGGER trg_pages_document_type_change
BEFORE UPDATE OF document_type ON pages
WHEN OLD.document_type != NEW.document_type
  AND (OLD.content != '' OR NEW.content != '')
BEGIN
  SELECT RAISE(ABORT, 'non-empty Page document type cannot change');
END;

-- Search is a derived projection. The Worker owns visible-text extraction and
-- updates these contentful FTS5 tables in the same batch as canonical writes.
CREATE VIRTUAL TABLE post_search_fts USING fts5(
  revision UNINDEXED,
  title,
  slug,
  excerpt,
  body,
  tokenize='trigram case_sensitive 0 remove_diacritics 1'
);

CREATE VIRTUAL TABLE page_search_fts USING fts5(
  revision UNINDEXED,
  title,
  slug,
  excerpt,
  body,
  tokenize='trigram case_sensitive 0 remove_diacritics 1'
);

CREATE TRIGGER trg_posts_search_delete
AFTER DELETE ON posts
BEGIN
  DELETE FROM post_search_fts WHERE rowid = OLD.public_id;
END;

CREATE TRIGGER trg_pages_search_delete
AFTER DELETE ON pages
BEGIN
  DELETE FROM page_search_fts WHERE rowid = OLD.public_id;
END;

CREATE TABLE content_search_index_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  state TEXT NOT NULL
    CHECK (state IN (
      'ready',
      'rebuild_required',
      'in_progress',
      'recovery_required'
    )),
  reason TEXT
    CHECK (reason IS NULL OR reason IN (
      'schema_upgrade',
      'database_restore',
      'manual_rebuild',
      'integrity_failure'
    )),
  phase TEXT
    CHECK (phase IS NULL OR phase IN ('posts', 'pages', 'verify')),
  operation_id TEXT
    CHECK (
      operation_id IS NULL
      OR (
        length(operation_id) = 32
        AND operation_id NOT GLOB '*[^0-9a-f]*'
      )
    ),
  post_public_id_cursor INTEGER NOT NULL DEFAULT 0
    CHECK (post_public_id_cursor >= 0),
  page_public_id_cursor INTEGER NOT NULL DEFAULT 0
    CHECK (page_public_id_cursor >= 0),
  processed_posts INTEGER NOT NULL DEFAULT 0
    CHECK (processed_posts >= 0),
  processed_pages INTEGER NOT NULL DEFAULT 0
    CHECK (processed_pages >= 0),
  total_posts INTEGER NOT NULL DEFAULT 0
    CHECK (total_posts >= 0),
  total_pages INTEGER NOT NULL DEFAULT 0
    CHECK (total_pages >= 0),
  started_at_iso TEXT,
  initiated_by_user_id TEXT,
  initiated_by_user_email TEXT,
  updated_at_iso TEXT NOT NULL,
  CHECK (
    (
      state = 'in_progress'
      AND reason IS NOT NULL
      AND phase IS NOT NULL
      AND operation_id IS NOT NULL
      AND started_at_iso IS NOT NULL
      AND initiated_by_user_id IS NOT NULL
      AND initiated_by_user_email IS NOT NULL
    )
    OR (
      state != 'in_progress'
      AND phase IS NULL
      AND operation_id IS NULL
      AND started_at_iso IS NULL
      AND initiated_by_user_id IS NULL
      AND initiated_by_user_email IS NULL
    )
  ),
  CHECK (
    initiated_by_user_id IS NULL
    OR (
      length(initiated_by_user_id) = 32
      AND initiated_by_user_id NOT GLOB '*[^0-9a-f]*'
    )
  ),
  CHECK (
    initiated_by_user_email IS NULL
    OR (
      initiated_by_user_email = lower(trim(initiated_by_user_email))
      AND length(initiated_by_user_email) BETWEEN 3 AND 254
    )
  )
);

CREATE TRIGGER trg_media_preserve_featured_image_shape
BEFORE UPDATE OF kind, width, height, mime_type ON media
WHEN (
  EXISTS (SELECT 1 FROM posts WHERE featured_image_id = OLD.id)
  OR EXISTS (SELECT 1 FROM pages WHERE featured_image_id = OLD.id)
) AND (
  NEW.kind != 'image'
  OR NEW.width IS NULL
  OR NEW.height IS NULL
  OR substr(NEW.mime_type, 1, 6) != 'image/'
)
BEGIN
  SELECT RAISE(ABORT, 'referenced featured image must remain a dimensioned image');
END;

CREATE TABLE menus (
  menu_id TEXT PRIMARY KEY
    CHECK (
      length(menu_id) BETWEEN 1 AND 64
      AND menu_id GLOB '[a-z]*'
      AND menu_id NOT GLOB '*[^a-z0-9_-]*'
    ),
  name TEXT NOT NULL
    CHECK (
      name = trim(name)
      AND length(name) BETWEEN 1 AND 120
    ),
  enabled INTEGER NOT NULL DEFAULT 1
    CHECK (enabled IN (0, 1)),
  items TEXT NOT NULL DEFAULT '[]'
    CHECK (
      length(items) <= 1048576
      AND json_valid(items)
      AND json_type(items) = 'array'
    ),
  revision TEXT NOT NULL DEFAULT (lower(hex(randomblob(16))))
    CHECK (
      length(revision) = 32
      AND revision NOT GLOB '*[^0-9a-f]*'
    ),
  created_at_iso TEXT NOT NULL,
  updated_at_iso TEXT NOT NULL,
  CHECK (created_at_iso <= updated_at_iso)
);

CREATE INDEX idx_menus_name
  ON menus(name COLLATE NOCASE, menu_id);

CREATE TABLE widget_areas (
  widget_area_id TEXT PRIMARY KEY
    CHECK (
      length(widget_area_id) BETWEEN 1 AND 64
      AND widget_area_id GLOB '[a-z]*'
      AND widget_area_id NOT GLOB '*[^a-z0-9_-]*'
    ),
  name TEXT NOT NULL
    CHECK (
      name = trim(name)
      AND length(name) BETWEEN 1 AND 120
    ),
  enabled INTEGER NOT NULL DEFAULT 1
    CHECK (enabled IN (0, 1)),
  items TEXT NOT NULL DEFAULT '[]'
    CHECK (
      length(items) <= 1048576
      AND json_valid(items)
      AND json_type(items) = 'array'
    ),
  revision TEXT NOT NULL DEFAULT (lower(hex(randomblob(16))))
    CHECK (
      length(revision) = 32
      AND revision NOT GLOB '*[^0-9a-f]*'
    ),
  created_at_iso TEXT NOT NULL,
  updated_at_iso TEXT NOT NULL,
  CHECK (created_at_iso <= updated_at_iso)
);

CREATE INDEX idx_widget_areas_name
  ON widget_areas(name COLLATE NOCASE, widget_area_id);

CREATE TABLE user_mfa_factors (
  id TEXT PRIMARY KEY
    CHECK (
      length(id) = 32
      AND id NOT GLOB '*[^0-9a-f]*'
    ),
  user_id TEXT NOT NULL
    REFERENCES users(id) ON DELETE CASCADE,
  factor_type TEXT NOT NULL
    CHECK (factor_type = 'totp'),
  secret_ciphertext TEXT NOT NULL
    CHECK (length(secret_ciphertext) BETWEEN 16 AND 4096),
  secret_iv TEXT NOT NULL
    CHECK (length(secret_iv) BETWEEN 16 AND 128),
  last_used_step INTEGER NOT NULL DEFAULT -1
    CHECK (last_used_step >= -1),
  created_at_iso TEXT NOT NULL,
  verified_at_iso TEXT NOT NULL,
  UNIQUE (user_id, factor_type)
);

CREATE TABLE user_webauthn_credentials (
  id TEXT PRIMARY KEY
    CHECK (
      length(id) = 32
      AND id NOT GLOB '*[^0-9a-f]*'
    ),
  user_id TEXT NOT NULL
    REFERENCES users(id) ON DELETE CASCADE,
  credential_id TEXT NOT NULL UNIQUE
    CHECK (
      length(credential_id) BETWEEN 1 AND 2048
      AND credential_id NOT GLOB '*[^A-Za-z0-9_-]*'
    ),
  public_key TEXT NOT NULL
    CHECK (
      length(public_key) BETWEEN 1 AND 4096
      AND public_key NOT GLOB '*[^A-Za-z0-9_-]*'
    ),
  signature_counter INTEGER NOT NULL DEFAULT 0
    CHECK (
      typeof(signature_counter) = 'integer'
      AND signature_counter >= 0
    ),
  display_name TEXT NOT NULL
    CHECK (
      display_name = trim(display_name)
      AND length(display_name) BETWEEN 1 AND 100
    ),
  rp_id TEXT NOT NULL
    CHECK (
      rp_id = lower(rp_id)
      AND rp_id = trim(rp_id)
      AND length(rp_id) BETWEEN 1 AND 253
    ),
  transports TEXT NOT NULL DEFAULT '[]'
    CHECK (
      json_valid(transports)
      AND json_type(transports) = 'array'
    ),
  credential_device_type TEXT NOT NULL
    CHECK (credential_device_type IN ('singleDevice', 'multiDevice')),
  backed_up INTEGER NOT NULL DEFAULT 0
    CHECK (backed_up IN (0, 1)),
  attestation_format TEXT NOT NULL
    CHECK (
      attestation_format IN (
        'fido-u2f',
        'packed',
        'android-safetynet',
        'android-key',
        'tpm',
        'apple',
        'none'
      )
    ),
  aaguid TEXT
    CHECK (
      aaguid IS NULL
      OR (
        aaguid = lower(aaguid)
        AND length(aaguid) = 32
        AND aaguid NOT GLOB '*[^0-9a-f]*'
        AND aaguid != '00000000000000000000000000000000'
      )
    ),
  created_at_iso TEXT NOT NULL,
  updated_at_iso TEXT NOT NULL,
  last_used_at_iso TEXT,
  CHECK (created_at_iso <= updated_at_iso)
);

CREATE INDEX idx_user_webauthn_credentials_user_rp_created
  ON user_webauthn_credentials(user_id, rp_id, created_at_iso, id);

CREATE UNIQUE INDEX idx_user_webauthn_credentials_user_name
  ON user_webauthn_credentials(user_id, display_name COLLATE NOCASE);

CREATE TABLE roles (
  key TEXT PRIMARY KEY
    CHECK (
      length(key) BETWEEN 1 AND 64
      AND key NOT GLOB '*[^a-z0-9._-]*'
    ),
  name TEXT NOT NULL
    CHECK (length(trim(name)) BETWEEN 1 AND 100),
  description TEXT NOT NULL DEFAULT '',
  is_system INTEGER NOT NULL DEFAULT 0
    CHECK (is_system IN (0, 1)),
  created_at_iso TEXT NOT NULL,
  updated_at_iso TEXT NOT NULL
);

CREATE TABLE user_roles (
  user_id TEXT NOT NULL
    REFERENCES users(id) ON DELETE CASCADE,
  role_key TEXT NOT NULL
    REFERENCES roles(key) ON DELETE CASCADE,
  created_at_iso TEXT NOT NULL,
  PRIMARY KEY (user_id, role_key)
);

CREATE INDEX idx_user_roles_role_key
  ON user_roles(role_key);

CREATE TABLE user_setup_tokens (
  id TEXT PRIMARY KEY
    CHECK (
      length(id) = 32
      AND id NOT GLOB '*[^0-9a-f]*'
    ),
  user_id TEXT NOT NULL UNIQUE
    REFERENCES users(id) ON DELETE CASCADE,
  purpose TEXT NOT NULL
    CHECK (purpose IN ('invitation', 'credential_recovery')),
  secret_digest TEXT NOT NULL UNIQUE
    CHECK (
      length(secret_digest) = 64
      AND secret_digest NOT GLOB '*[^0-9a-f]*'
    ),
  created_by TEXT
    REFERENCES users(id) ON DELETE SET NULL,
  pending_password_hash TEXT
    CHECK (
      pending_password_hash IS NULL
      OR length(pending_password_hash) BETWEEN 1 AND 2048
    ),
  setup_nonce TEXT
    CHECK (
      setup_nonce IS NULL
      OR (
        length(setup_nonce) = 32
        AND setup_nonce NOT GLOB '*[^0-9a-f]*'
      )
    ),
  setup_at_iso TEXT,
  created_at_iso TEXT NOT NULL,
  expires_at_iso TEXT NOT NULL,
  consumed_at_iso TEXT,
  CHECK (created_at_iso < expires_at_iso),
  CHECK (
    (
      pending_password_hash IS NULL
      AND setup_nonce IS NULL
      AND setup_at_iso IS NULL
    )
    OR (
      pending_password_hash IS NOT NULL
      AND setup_nonce IS NOT NULL
      AND setup_at_iso IS NOT NULL
      AND consumed_at_iso IS NULL
    )
  ),
  CHECK (
    consumed_at_iso IS NULL
    OR consumed_at_iso >= created_at_iso
  )
);

CREATE INDEX idx_user_setup_tokens_expires
  ON user_setup_tokens(expires_at_iso);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY
    CHECK (
      length(id) = 32
      AND id NOT GLOB '*[^0-9a-f]*'
    ),
  user_id TEXT NOT NULL
    REFERENCES users(id) ON DELETE CASCADE,
  secret_digest TEXT NOT NULL
    CHECK (
      length(secret_digest) = 64
      AND secret_digest NOT GLOB '*[^0-9a-f]*'
    ),
  auth_revision TEXT NOT NULL
    CHECK (
      length(auth_revision) = 32
      AND auth_revision NOT GLOB '*[^0-9a-f]*'
    ),
  ip_address TEXT NOT NULL
    CHECK (
      ip_address = trim(ip_address)
      AND length(ip_address) BETWEEN 1 AND 64
    ),
  user_agent TEXT
    CHECK (
      user_agent IS NULL
      OR (
        user_agent = trim(user_agent)
        AND length(user_agent) BETWEEN 1 AND 1024
      )
    ),
  asn INTEGER
    CHECK (
      asn IS NULL
      OR (
        typeof(asn) = 'integer'
        AND asn > 0
      )
    ),
  as_organization TEXT
    CHECK (
      as_organization IS NULL
      OR (
        as_organization = trim(as_organization)
        AND length(as_organization) BETWEEN 1 AND 255
      )
    ),
  country_code TEXT
    CHECK (
      country_code IS NULL
      OR (
        country_code = upper(country_code)
        AND length(country_code) BETWEEN 2 AND 8
        AND country_code NOT GLOB '*[^A-Z0-9]*'
      )
    ),
  created_at_iso TEXT NOT NULL,
  last_seen_at_iso TEXT NOT NULL,
  idle_expires_at_iso TEXT NOT NULL,
  absolute_expires_at_iso TEXT NOT NULL,
  mfa_verified_at_iso TEXT NOT NULL,
  CHECK (created_at_iso <= last_seen_at_iso),
  CHECK (last_seen_at_iso < idle_expires_at_iso),
  CHECK (idle_expires_at_iso <= absolute_expires_at_iso)
);

CREATE INDEX idx_sessions_user_last_seen
  ON sessions(user_id, last_seen_at_iso, id);

CREATE INDEX idx_sessions_idle_expires
  ON sessions(idle_expires_at_iso);

CREATE INDEX idx_sessions_absolute_expires
  ON sessions(absolute_expires_at_iso);

CREATE TABLE webauthn_challenges (
  id TEXT PRIMARY KEY
    CHECK (
      length(id) = 32
      AND id NOT GLOB '*[^0-9a-f]*'
    ),
  user_id TEXT NOT NULL
    REFERENCES users(id) ON DELETE CASCADE,
  session_id TEXT
    REFERENCES sessions(id) ON DELETE CASCADE,
  auth_revision TEXT NOT NULL
    CHECK (
      length(auth_revision) = 32
      AND auth_revision NOT GLOB '*[^0-9a-f]*'
    ),
  purpose TEXT NOT NULL
    CHECK (
      purpose IN (
        'login',
        'management_step_up',
        'registration'
      )
    ),
  operation TEXT
    CHECK (
      operation IS NULL
      OR (
        operation = trim(operation)
        AND length(operation) BETWEEN 1 AND 64
        AND operation NOT GLOB '*[^a-z0-9_]*'
      )
    ),
  target_id TEXT
    CHECK (
      target_id IS NULL
      OR (
        length(target_id) = 32
        AND target_id NOT GLOB '*[^0-9a-f]*'
      )
    ),
  challenge TEXT NOT NULL
    CHECK (
      length(challenge) BETWEEN 32 AND 1024
      AND challenge NOT GLOB '*[^A-Za-z0-9_-]*'
    ),
  origin TEXT NOT NULL
    CHECK (
      origin = trim(origin)
      AND length(origin) BETWEEN 8 AND 2048
    ),
  rp_id TEXT NOT NULL
    CHECK (
      rp_id = lower(rp_id)
      AND rp_id = trim(rp_id)
      AND length(rp_id) BETWEEN 1 AND 253
    ),
  consumed_by TEXT
    CHECK (
      consumed_by IS NULL
      OR (
        length(consumed_by) = 32
        AND consumed_by NOT GLOB '*[^0-9a-f]*'
      )
    ),
  created_at_iso TEXT NOT NULL,
  expires_at_iso TEXT NOT NULL,
  CHECK (created_at_iso < expires_at_iso),
  CHECK (
    (
      purpose = 'login'
      AND session_id IS NULL
      AND operation IS NULL
      AND target_id IS NULL
    )
    OR (
      purpose IN ('management_step_up', 'registration')
      AND session_id IS NOT NULL
      AND operation IS NOT NULL
    )
  )
);

CREATE INDEX idx_webauthn_challenges_expires
  ON webauthn_challenges(expires_at_iso);

CREATE INDEX idx_webauthn_challenges_user_purpose
  ON webauthn_challenges(user_id, purpose, expires_at_iso);

CREATE TABLE webauthn_discovery_challenges (
  id TEXT PRIMARY KEY
    CHECK (
      length(id) = 32
      AND id NOT GLOB '*[^0-9a-f]*'
    ),
  challenge TEXT NOT NULL
    CHECK (
      length(challenge) BETWEEN 32 AND 1024
      AND challenge NOT GLOB '*[^A-Za-z0-9_-]*'
    ),
  origin TEXT NOT NULL
    CHECK (
      origin = trim(origin)
      AND length(origin) BETWEEN 8 AND 2048
    ),
  rp_id TEXT NOT NULL
    CHECK (
      rp_id = lower(rp_id)
      AND rp_id = trim(rp_id)
      AND length(rp_id) BETWEEN 1 AND 253
    ),
  consumed_by TEXT
    CHECK (
      consumed_by IS NULL
      OR (
        length(consumed_by) = 32
        AND consumed_by NOT GLOB '*[^0-9a-f]*'
      )
    ),
  created_at_iso TEXT NOT NULL,
  expires_at_iso TEXT NOT NULL,
  CHECK (created_at_iso < expires_at_iso)
);

CREATE INDEX idx_webauthn_discovery_challenges_expires
  ON webauthn_discovery_challenges(expires_at_iso);

CREATE TABLE site_settings (
  key TEXT PRIMARY KEY
    CHECK (
      length(key) BETWEEN 1 AND 128
      AND key NOT GLOB '*[^a-z0-9._-]*'
    ),
  value TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'string'
    CHECK (type IN ('string', 'number', 'boolean', 'json')),
  updated_by TEXT
    REFERENCES users(id) ON DELETE SET NULL,
  updated_at_iso TEXT NOT NULL
);

CREATE TABLE studio_settings (
  key TEXT PRIMARY KEY
    CHECK (
      length(key) BETWEEN 1 AND 128
      AND key NOT GLOB '*[^a-z0-9._-]*'
    ),
  value TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'string'
    CHECK (type IN ('string', 'number', 'boolean', 'json')),
  updated_by TEXT
    REFERENCES users(id) ON DELETE SET NULL,
  updated_at_iso TEXT NOT NULL
);

CREATE TABLE edge_comment_target_projection_outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL UNIQUE
    CHECK (
      length(event_id) = 32
      AND event_id NOT GLOB '*[^0-9a-f]*'
    ),
  target_type TEXT NOT NULL
    CHECK (target_type IN ('post', 'page')),
  target_public_id INTEGER NOT NULL
    CHECK (target_public_id > 0),
  operation TEXT NOT NULL
    CHECK (operation IN ('upsert', 'delete')),
  status TEXT
    CHECK (status IS NULL OR status IN ('draft', 'published', 'trash')),
  allow_comments INTEGER
    CHECK (allow_comments IS NULL OR allow_comments IN (0, 1)),
  created_at_iso TEXT NOT NULL,
  attempt_count INTEGER NOT NULL DEFAULT 0
    CHECK (attempt_count >= 0),
  last_attempt_at_iso TEXT,
  lease_id TEXT
    CHECK (
      lease_id IS NULL
      OR (
        length(lease_id) = 32
        AND lease_id NOT GLOB '*[^0-9a-f]*'
      )
    ),
  lease_expires_at_iso TEXT,
  CHECK (
    (operation = 'upsert' AND status IS NOT NULL AND allow_comments IS NOT NULL)
    OR (operation = 'delete' AND status IS NULL AND allow_comments IS NULL)
  ),
  CHECK (
    (lease_id IS NULL AND lease_expires_at_iso IS NULL)
    OR (lease_id IS NOT NULL AND lease_expires_at_iso IS NOT NULL)
  )
);

CREATE INDEX idx_edge_comment_target_projection_outbox_target
  ON edge_comment_target_projection_outbox(
    target_type, target_public_id, id
  );

CREATE INDEX idx_edge_comment_target_projection_outbox_lease
  ON edge_comment_target_projection_outbox(
    lease_expires_at_iso, id
  );

CREATE TABLE edge_comment_target_reconciliation_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  operation_id TEXT NOT NULL UNIQUE
    CHECK (
      length(operation_id) = 32
      AND operation_id NOT GLOB '*[^0-9a-f]*'
    ),
  phase TEXT NOT NULL
    CHECK (
      phase IN (
        'drain_outbox',
        'sync_posts',
        'sync_pages',
        'scan_orphans',
        'orphan_review'
      )
    ),
  cursor_public_id INTEGER NOT NULL DEFAULT 0
    CHECK (cursor_public_id >= 0),
  edge_cursor_id INTEGER NOT NULL DEFAULT 0
    CHECK (edge_cursor_id >= 0),
  synced_posts INTEGER NOT NULL DEFAULT 0 CHECK (synced_posts >= 0),
  synced_pages INTEGER NOT NULL DEFAULT 0 CHECK (synced_pages >= 0),
  scanned_targets INTEGER NOT NULL DEFAULT 0 CHECK (scanned_targets >= 0),
  started_at_iso TEXT NOT NULL,
  updated_at_iso TEXT NOT NULL,
  initiated_by_user_id TEXT NOT NULL
    CHECK (
      length(initiated_by_user_id) = 32
      AND initiated_by_user_id NOT GLOB '*[^0-9a-f]*'
    ),
  initiated_by_user_email TEXT NOT NULL
    CHECK (
      length(initiated_by_user_email) BETWEEN 3 AND 254
      AND initiated_by_user_email = lower(initiated_by_user_email)
      AND initiated_by_user_email = trim(initiated_by_user_email)
    )
);

CREATE TABLE edge_comment_target_reconciliation_orphans (
  operation_id TEXT NOT NULL
    REFERENCES edge_comment_target_reconciliation_state(operation_id)
    ON DELETE CASCADE,
  target_id INTEGER NOT NULL CHECK (target_id > 0),
  target_type TEXT NOT NULL CHECK (target_type IN ('post', 'page')),
  public_id INTEGER NOT NULL CHECK (public_id > 0),
  status TEXT NOT NULL
    CHECK (status IN ('draft', 'published', 'scheduled', 'archived', 'trash')),
  allow_comments INTEGER NOT NULL CHECK (allow_comments IN (0, 1)),
  comments_cache_revision TEXT NOT NULL
    CHECK (
      length(comments_cache_revision) = 32
      AND comments_cache_revision NOT GLOB '*[^0-9a-f]*'
    ),
  comment_count INTEGER NOT NULL CHECK (comment_count >= 0),
  discovered_at_iso TEXT NOT NULL,
  PRIMARY KEY (operation_id, target_id),
  UNIQUE (operation_id, target_type, public_id)
);

CREATE INDEX idx_edge_comment_target_reconciliation_orphans_page
  ON edge_comment_target_reconciliation_orphans(
    operation_id, target_type, public_id, target_id
  );

CREATE TRIGGER trg_posts_edge_projection_insert
AFTER INSERT ON posts
WHEN EXISTS (
  SELECT 1 FROM studio_settings
  WHERE key = 'edge_integration_mode' AND type = 'string' AND value = 'enabled'
)
BEGIN
  INSERT INTO edge_comment_target_projection_outbox (
    event_id, target_type, target_public_id, operation,
    status, allow_comments, created_at_iso
  ) VALUES (
    lower(hex(randomblob(16))), 'post', NEW.public_id, 'upsert',
    NEW.status, NEW.allow_comments, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  );
END;

CREATE TRIGGER trg_posts_edge_projection_update
AFTER UPDATE OF revision ON posts
WHEN OLD.revision != NEW.revision
AND EXISTS (
  SELECT 1 FROM studio_settings
  WHERE key = 'edge_integration_mode' AND type = 'string' AND value = 'enabled'
)
BEGIN
  INSERT INTO edge_comment_target_projection_outbox (
    event_id, target_type, target_public_id, operation,
    status, allow_comments, created_at_iso
  ) VALUES (
    lower(hex(randomblob(16))), 'post', NEW.public_id, 'upsert',
    NEW.status, NEW.allow_comments, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  );
END;

CREATE TRIGGER trg_posts_edge_projection_delete
AFTER DELETE ON posts
WHEN EXISTS (
  SELECT 1 FROM studio_settings
  WHERE key = 'edge_integration_mode' AND type = 'string' AND value = 'enabled'
)
BEGIN
  INSERT INTO edge_comment_target_projection_outbox (
    event_id, target_type, target_public_id, operation,
    status, allow_comments, created_at_iso
  ) VALUES (
    lower(hex(randomblob(16))), 'post', OLD.public_id, 'delete',
    NULL, NULL, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  );
END;

CREATE TRIGGER trg_pages_edge_projection_insert
AFTER INSERT ON pages
WHEN EXISTS (
  SELECT 1 FROM studio_settings
  WHERE key = 'edge_integration_mode' AND type = 'string' AND value = 'enabled'
)
BEGIN
  INSERT INTO edge_comment_target_projection_outbox (
    event_id, target_type, target_public_id, operation,
    status, allow_comments, created_at_iso
  ) VALUES (
    lower(hex(randomblob(16))), 'page', NEW.public_id, 'upsert',
    NEW.status, NEW.allow_comments, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  );
END;

CREATE TRIGGER trg_pages_edge_projection_update
AFTER UPDATE OF revision ON pages
WHEN OLD.revision != NEW.revision
AND EXISTS (
  SELECT 1 FROM studio_settings
  WHERE key = 'edge_integration_mode' AND type = 'string' AND value = 'enabled'
)
BEGIN
  INSERT INTO edge_comment_target_projection_outbox (
    event_id, target_type, target_public_id, operation,
    status, allow_comments, created_at_iso
  ) VALUES (
    lower(hex(randomblob(16))), 'page', NEW.public_id, 'upsert',
    NEW.status, NEW.allow_comments, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  );
END;

CREATE TRIGGER trg_pages_edge_projection_delete
AFTER DELETE ON pages
WHEN EXISTS (
  SELECT 1 FROM studio_settings
  WHERE key = 'edge_integration_mode' AND type = 'string' AND value = 'enabled'
)
BEGIN
  INSERT INTO edge_comment_target_projection_outbox (
    event_id, target_type, target_public_id, operation,
    status, allow_comments, created_at_iso
  ) VALUES (
    lower(hex(randomblob(16))), 'page', OLD.public_id, 'delete',
    NULL, NULL, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  );
END;

CREATE TABLE site_custom_code (
  id INTEGER PRIMARY KEY
    CHECK (id = 1),
  custom_css_enabled INTEGER NOT NULL
    CHECK (custom_css_enabled IN (0, 1)),
  custom_css_content TEXT NOT NULL,
  head_end_enabled INTEGER NOT NULL
    CHECK (head_end_enabled IN (0, 1)),
  head_end_content TEXT NOT NULL
    CHECK (length(head_end_content) <= 65536),
  body_end_enabled INTEGER NOT NULL
    CHECK (body_end_enabled IN (0, 1)),
  body_end_content TEXT NOT NULL
    CHECK (length(body_end_content) <= 65536),
  revision TEXT NOT NULL
    CHECK (
      length(revision) = 32
      AND revision NOT GLOB '*[^0-9a-f]*'
    ),
  updated_by TEXT
    REFERENCES users(id) ON DELETE SET NULL,
  updated_at_iso TEXT NOT NULL
);

CREATE TABLE audit_logs (
  id TEXT PRIMARY KEY NOT NULL,
  occurred_at TEXT NOT NULL,
  action TEXT NOT NULL,
  category TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('success', 'failed', 'partial', 'unchanged', 'unknown')),
  actor_kind TEXT NOT NULL CHECK (actor_kind IN ('user', 'operations')),
  actor_id TEXT,
  actor_name TEXT,
  actor_email TEXT,
  target_type TEXT NOT NULL,
  target_id TEXT,
  target_label TEXT,
  metadata_json TEXT NOT NULL,
  ip_address TEXT,
  ip_recorded_at TEXT,
  ip_hash TEXT,
  user_agent TEXT,
  country TEXT,
  region TEXT,
  city TEXT,
  timezone TEXT,
  asn INTEGER,
  organization TEXT
);
CREATE INDEX audit_logs_time_idx ON audit_logs (occurred_at DESC, id DESC);
CREATE INDEX audit_logs_actor_idx ON audit_logs (actor_id, occurred_at DESC, id DESC);
CREATE INDEX audit_logs_ip_idx ON audit_logs (ip_hash, occurred_at DESC, id DESC);
CREATE INDEX audit_logs_raw_ip_idx ON audit_logs (ip_recorded_at) WHERE ip_address IS NOT NULL;
