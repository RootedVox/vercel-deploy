-- createSession writes id_token_raw so logout can pass it as the OIDC
-- id_token_hint to the provider. 0001 never declared the column, so D1 mode
-- (AUTH_STORE=d1, also the default when unset) failed every sign-in with
-- "table business_sessions has no column named id_token_raw".
alter table business_sessions add column id_token_raw text;
