ALTER TABLE user_webauthn_credentials
ADD COLUMN attestation_verification_json TEXT
  CHECK (attestation_verification_json IS NULL OR json_valid(attestation_verification_json));
