alter table business_sessions add column rotation_nonce text;
alter table business_sessions add column rotation_hash text;
alter table business_sessions add column rotation_expires_at text;
create unique index business_sessions_rotation on business_sessions(rotation_hash);
