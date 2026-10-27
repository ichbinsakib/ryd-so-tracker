-- Password sign-in (admin sets passwords). Passwords are hashed with bcrypt inside Postgres (pgcrypto);
-- the app never stores or logs a plain password. Sessions are random tokens, stored only as SHA-256 hashes.

create extension if not exists pgcrypto with schema extensions;

alter table app_users add column if not exists pw_hash text;
alter table app_users add column if not exists has_password boolean generated always as (pw_hash is not null) stored;

create table if not exists sessions (
  token_hash text primary key,
  email      text not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);
create index if not exists sessions_expires_idx on sessions (expires_at);

create table if not exists login_attempts (
  id    bigint generated always as identity primary key,
  email text not null,
  at    timestamptz not null default now(),
  ok    boolean not null
);
create index if not exists login_attempts_email_idx on login_attempts (email, at);

alter table sessions enable row level security;
alter table login_attempts enable row level security;

create or replace function set_user_password(p_email text, p_password text) returns boolean
language plpgsql as $$
begin
  update app_users set pw_hash = extensions.crypt(p_password, extensions.gen_salt('bf', 10)) where email = lower(p_email);
  return found;
end $$;

create or replace function check_login(p_email text, p_password text) returns boolean
language plpgsql as $$
declare h text;
begin
  select pw_hash into h from app_users where email = lower(p_email) and active;
  if h is null then
    perform extensions.crypt(p_password, extensions.gen_salt('bf', 10));  -- same cost whether or not the user exists
    return false;
  end if;
  return h = extensions.crypt(p_password, h);
end $$;

revoke execute on function set_user_password(text, text) from public, anon, authenticated;
revoke execute on function check_login(text, text) from public, anon, authenticated;

-- The first admin (no password yet: set it with  select set_user_password('<email>', '<password>');  in this SQL editor).
insert into app_users (email, name, role, active, added_by, added_at)
values ('ichbinsakib@gmail.com', 'Sakib', 'admin', true, 'setup', now()::text)
on conflict (email) do update set role = 'admin', active = true;
