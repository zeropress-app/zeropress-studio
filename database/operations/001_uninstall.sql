DROP TABLE audit_logs;
-- ZeroPress Studio application-schema removal artifact.
-- This drops Studio-owned objects, not the Cloudflare D1 resource itself.
-- Keep zeropress_schema_state last so an all-or-nothing D1 batch is the only
-- path from an installed schema to the uninstalled state.

DROP TABLE auth_rate_limits;
DROP TABLE webauthn_discovery_challenges;
DROP TABLE webauthn_challenges;
DROP TABLE sessions;
DROP TABLE user_webauthn_credentials;
DROP TABLE user_mfa_factors;
DROP TABLE user_setup_tokens;
DROP TABLE user_roles;
DROP TABLE roles;
DROP TABLE site_custom_code;
DROP TABLE content_search_index_state;
DROP TABLE post_search_fts;
DROP TABLE page_search_fts;
DROP TABLE edge_comment_target_reconciliation_orphans;
DROP TABLE edge_comment_target_reconciliation_state;
DROP TABLE edge_comment_target_projection_outbox;
DROP TABLE studio_settings;
DROP TABLE site_settings;
DROP TABLE site_assets;
DROP TABLE post_tags;
DROP TABLE post_categories;
DROP TABLE post_autosaves;
DROP TABLE page_autosaves;
DROP TABLE post_revisions;
DROP TABLE page_revisions;
DROP TABLE widget_areas;
DROP TABLE menus;
DROP TABLE posts;
DROP TABLE pages;
DROP TABLE authors;
DROP TABLE media_upload_intents;
DROP TABLE media_object_deletions;
DROP TABLE media;
DROP TABLE media_collections;
DROP TABLE content_public_id_counters;
DROP TABLE tags;
DROP TABLE categories;
DROP TABLE users;
DROP TABLE zeropress_schema_state;
