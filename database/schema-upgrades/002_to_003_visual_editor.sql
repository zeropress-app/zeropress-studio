-- Replace the visual editor contract without rewriting authored HTML or saved snapshots.
-- Existing documents open in source mode; visual conversion requires explicit review.

DROP TRIGGER trg_posts_featured_image_insert;

DROP TRIGGER trg_posts_featured_image_update;

DROP TRIGGER trg_pages_featured_image_insert;

DROP TRIGGER trg_pages_featured_image_update;

DROP TRIGGER trg_posts_document_type_change;

DROP TRIGGER trg_pages_document_type_change;

DROP TRIGGER trg_posts_search_delete;

DROP TRIGGER trg_pages_search_delete;

DROP TRIGGER trg_media_preserve_featured_image_shape;

DROP TRIGGER trg_posts_edge_projection_insert;

DROP TRIGGER trg_posts_edge_projection_update;

DROP TRIGGER trg_posts_edge_projection_delete;

DROP TRIGGER trg_pages_edge_projection_insert;

DROP TRIGGER trg_pages_edge_projection_update;

DROP TRIGGER trg_pages_edge_projection_delete;

CREATE TABLE posts_new (
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
    CHECK (editor_profile IS NULL OR editor_profile = 'suneditor-v1'),
  editor_mode TEXT NOT NULL DEFAULT 'source'
    CHECK (
    (editor_mode = 'source' AND editor_profile IS NULL)
    OR (
      editor_mode = 'visual'
      AND document_type = 'html'
      AND editor_profile = 'suneditor-v1'
      AND length(content) <= 131072
    )
  ),
  CHECK (created_at_iso <= updated_at_iso),
  CHECK (status != 'published' OR published_at_iso IS NOT NULL)
);

INSERT INTO posts_new (rowid, id, public_id, title, slug, content, document_type, excerpt, status, author_id, discoverability, allow_comments, featured_image_id, published_at_iso, revision, created_at_iso, updated_at_iso, editor_profile, editor_mode)
SELECT rowid, id, public_id, title, slug, content, document_type, excerpt, status, author_id, discoverability, allow_comments, featured_image_id, published_at_iso, revision, created_at_iso, updated_at_iso, NULL, 'source' FROM posts;

CREATE TABLE pages_new (
  id TEXT PRIMARY KEY
    CHECK (
      length(id) = 32
      AND id NOT GLOB '*[^0-9a-f]*'
    ),
  public_id INTEGER NOT NULL UNIQUE
    CHECK (public_id BETWEEN 1 AND 9007199254740991),
  parent_id TEXT
    REFERENCES pages_new(id) ON DELETE RESTRICT,
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
    CHECK (editor_profile IS NULL OR editor_profile = 'suneditor-v1'),
  editor_mode TEXT NOT NULL DEFAULT 'source'
    CHECK (
    (editor_mode = 'source' AND editor_profile IS NULL)
    OR (
      editor_mode = 'visual'
      AND document_type = 'html'
      AND editor_profile = 'suneditor-v1'
      AND length(content) <= 131072
    )
  ),
  CHECK (parent_id IS NULL OR parent_id != id),
  CHECK (created_at_iso <= updated_at_iso)
);

INSERT INTO pages_new (rowid, id, public_id, parent_id, title, slug, content, document_type, excerpt, status, discoverability, allow_comments, featured_image_id, revision, created_at_iso, updated_at_iso, editor_profile, editor_mode)
SELECT rowid, id, public_id, parent_id, title, slug, content, document_type, excerpt, status, discoverability, allow_comments, featured_image_id, revision, created_at_iso, updated_at_iso, NULL, 'source' FROM pages;

CREATE TABLE post_categories_new (
  post_id TEXT NOT NULL
    REFERENCES posts_new(id) ON DELETE CASCADE,
  category_id TEXT NOT NULL
    REFERENCES categories(id) ON DELETE RESTRICT,
  PRIMARY KEY (post_id, category_id)
);

INSERT INTO post_categories_new (rowid, post_id, category_id)
SELECT rowid, post_id, category_id FROM post_categories;

CREATE TABLE post_tags_new (
  post_id TEXT NOT NULL
    REFERENCES posts_new(id) ON DELETE CASCADE,
  tag_id TEXT NOT NULL
    REFERENCES tags(id) ON DELETE RESTRICT,
  sort_order INTEGER NOT NULL
    CHECK (sort_order >= 0),
  PRIMARY KEY (post_id, tag_id),
  UNIQUE (post_id, sort_order)
);

INSERT INTO post_tags_new (rowid, post_id, tag_id, sort_order)
SELECT rowid, post_id, tag_id, sort_order FROM post_tags;

CREATE TABLE post_autosaves_new (
  user_id TEXT NOT NULL
    REFERENCES users(id) ON DELETE CASCADE,
  draft_id TEXT NOT NULL
    CHECK (
      length(draft_id) = 32
      AND draft_id NOT GLOB '*[^0-9a-f]*'
    ),
  post_id TEXT
    REFERENCES posts_new(id) ON DELETE CASCADE,
  base_revision TEXT
    CHECK (
      base_revision IS NULL
      OR (
        length(base_revision) = 32
        AND base_revision NOT GLOB '*[^0-9a-f]*'
      )
    ),
  snapshot_version INTEGER NOT NULL
    CHECK (snapshot_version IN (1, 2, 3)),
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

INSERT INTO post_autosaves_new (rowid, user_id, draft_id, post_id, base_revision, snapshot_version, snapshot_json, snapshot_sha256, created_at_iso, updated_at_iso, expires_at_iso)
SELECT rowid, user_id, draft_id, post_id, base_revision, snapshot_version, snapshot_json, snapshot_sha256, created_at_iso, updated_at_iso, expires_at_iso FROM post_autosaves;

CREATE TABLE page_autosaves_new (
  user_id TEXT NOT NULL
    REFERENCES users(id) ON DELETE CASCADE,
  draft_id TEXT NOT NULL
    CHECK (
      length(draft_id) = 32
      AND draft_id NOT GLOB '*[^0-9a-f]*'
    ),
  page_id TEXT
    REFERENCES pages_new(id) ON DELETE CASCADE,
  base_revision TEXT
    CHECK (
      base_revision IS NULL
      OR (
        length(base_revision) = 32
        AND base_revision NOT GLOB '*[^0-9a-f]*'
      )
    ),
  snapshot_version INTEGER NOT NULL
    CHECK (snapshot_version IN (1, 2, 3)),
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

INSERT INTO page_autosaves_new (rowid, user_id, draft_id, page_id, base_revision, snapshot_version, snapshot_json, snapshot_sha256, created_at_iso, updated_at_iso, expires_at_iso)
SELECT rowid, user_id, draft_id, page_id, base_revision, snapshot_version, snapshot_json, snapshot_sha256, created_at_iso, updated_at_iso, expires_at_iso FROM page_autosaves;

CREATE TABLE post_revisions_new (
  post_id TEXT NOT NULL
    REFERENCES posts_new(id) ON DELETE CASCADE,
  revision_id TEXT NOT NULL
    CHECK (
      length(revision_id) = 32
      AND revision_id NOT GLOB '*[^0-9a-f]*'
    ),
  snapshot_version INTEGER NOT NULL
    CHECK (snapshot_version IN (1, 2, 3)),
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

INSERT INTO post_revisions_new (rowid, post_id, revision_id, snapshot_version, snapshot_json, snapshot_sha256, saved_at_iso, archived_at_iso)
SELECT rowid, post_id, revision_id, snapshot_version, snapshot_json, snapshot_sha256, saved_at_iso, archived_at_iso FROM post_revisions;

CREATE TABLE page_revisions_new (
  page_id TEXT NOT NULL
    REFERENCES pages_new(id) ON DELETE CASCADE,
  revision_id TEXT NOT NULL
    CHECK (
      length(revision_id) = 32
      AND revision_id NOT GLOB '*[^0-9a-f]*'
    ),
  snapshot_version INTEGER NOT NULL
    CHECK (snapshot_version IN (1, 2, 3)),
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

INSERT INTO page_revisions_new (rowid, page_id, revision_id, snapshot_version, snapshot_json, snapshot_sha256, saved_at_iso, archived_at_iso)
SELECT rowid, page_id, revision_id, snapshot_version, snapshot_json, snapshot_sha256, saved_at_iso, archived_at_iso FROM page_revisions;

DROP TABLE page_revisions;

DROP TABLE post_revisions;

DROP TABLE page_autosaves;

DROP TABLE post_autosaves;

DROP TABLE post_tags;

DROP TABLE post_categories;

DROP TABLE pages;

DROP TABLE posts;

ALTER TABLE posts_new RENAME TO posts;

ALTER TABLE pages_new RENAME TO pages;

ALTER TABLE post_categories_new RENAME TO post_categories;

ALTER TABLE post_tags_new RENAME TO post_tags;

ALTER TABLE post_autosaves_new RENAME TO post_autosaves;

ALTER TABLE page_autosaves_new RENAME TO page_autosaves;

ALTER TABLE post_revisions_new RENAME TO post_revisions;

ALTER TABLE page_revisions_new RENAME TO page_revisions;

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

CREATE INDEX idx_post_categories_category
  ON post_categories(category_id, post_id);

CREATE INDEX idx_post_tags_tag
  ON post_tags(tag_id, post_id);

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

CREATE UNIQUE INDEX idx_post_autosaves_user_post
  ON post_autosaves(user_id, post_id)
  WHERE post_id IS NOT NULL;

CREATE INDEX idx_post_autosaves_expires
  ON post_autosaves(expires_at_iso, user_id, draft_id)
  WHERE expires_at_iso IS NOT NULL;

CREATE UNIQUE INDEX idx_page_autosaves_user_page
  ON page_autosaves(user_id, page_id)
  WHERE page_id IS NOT NULL;

CREATE INDEX idx_page_autosaves_expires
  ON page_autosaves(expires_at_iso, user_id, draft_id)
  WHERE expires_at_iso IS NOT NULL;

CREATE INDEX idx_post_revisions_history
  ON post_revisions(post_id, archived_at_iso DESC, revision_id DESC);

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
