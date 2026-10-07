import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import baseline from '../../../database/install/001_baseline.sql?raw';
import schema1 from '../audit/fixtures/schema-1.sql?raw';
import { STUDIO_SCHEMA_UPGRADE_ARTIFACTS } from './schema-upgrade-artifacts';
import { sqliteD1 } from '../test-helpers/sqlite-d1';
import { listUserWebAuthnCredentials } from '../auth/webauthn-repository';

describe('passkey attestation schema 3 to 4', () => {
  it('preserves existing credentials as unevaluated and matches the fresh-install column contract', async () => {
    const db = new DatabaseSync(':memory:'); const fresh = new DatabaseSync(':memory:');
    try {
      db.exec(schema1); db.exec(STUDIO_SCHEMA_UPGRADE_ARTIFACTS[0].sql); db.exec(STUDIO_SCHEMA_UPGRADE_ARTIFACTS[1].sql);
      const user = '1'.repeat(32), revision = '2'.repeat(32), time = '2026-10-01T00:00:00.000Z';
      db.prepare('INSERT INTO users (id,email,password_hash,name,auth_revision,created_at_iso,updated_at_iso) VALUES (?,?,?,?,?,?,?)').run(user,'owner@example.test','synthetic','Owner',revision,time,time);
      db.prepare(`INSERT INTO user_webauthn_credentials (id,user_id,credential_id,public_key,signature_counter,display_name,rp_id,transports,credential_device_type,backed_up,attestation_format,created_at_iso,updated_at_iso)
        VALUES (?,?,?, ?,0,'Existing','studio.example.test','[]','multiDevice',1,'none',?,?)`).run('3'.repeat(32),user,'credential','AQID',time,time);
      db.exec(STUDIO_SCHEMA_UPGRADE_ARTIFACTS[2].sql); fresh.exec(baseline);
      expect(db.prepare('PRAGMA table_xinfo(user_webauthn_credentials)').all()).toEqual(fresh.prepare('PRAGMA table_xinfo(user_webauthn_credentials)').all());
      expect((await listUserWebAuthnCredentials({ db: sqliteD1(db), userId: user, authRevision: revision }))[0]).toMatchObject({ attestation_verification: { state: 'not_evaluated', snapshot_id: null } });
      expect(db.prepare('SELECT public_key FROM user_webauthn_credentials').get()).toEqual({ public_key: 'AQID' });
      expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    } finally { db.close(); fresh.close(); }
  });
});
