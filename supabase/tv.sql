-- TV remote backend (Supabase project shared with other apps; everything is prefixed tv_).
-- Tables are closed to the public anon key. The website and the TV only talk through the
-- security-definer functions at the bottom, which check a web session or the TV's device token.

create extension if not exists pgcrypto with schema extensions;

create table if not exists tv_device (
  id int primary key default 1 check (id = 1),
  token_hash text not null,               -- sha256 of the TV's device token
  password_hash text,                     -- bcrypt of the website password, null until setup
  setup_code text,                        -- 6 digits shown on the TV until the website password is set
  status jsonb not null default '{}',     -- last status report from the TV
  apps jsonb not null default '[]',       -- launchable apps [{pkg,label}]
  last_seen timestamptz,
  web_active_until timestamptz            -- TV polls fast while someone has the website open
);
create table if not exists tv_settings (
  id int primary key default 1 check (id = 1),
  data jsonb not null default '{}'
);
create table if not exists tv_commands (
  id bigserial primary key,
  cmd jsonb not null,
  created_at timestamptz not null default now()
);
create table if not exists tv_usage (
  day date primary key,                   -- TV's local date
  screen_ms bigint not null default 0,
  apps jsonb not null default '{}',       -- {label: ms}
  updated_at timestamptz not null default now()
);
create table if not exists tv_sessions (
  token_hash text primary key,
  expires_at timestamptz not null
);
create table if not exists tv_auth_fail (at timestamptz not null default now());

do $$ declare t text; begin
  foreach t in array array['tv_device','tv_settings','tv_commands','tv_usage','tv_sessions','tv_auth_fail'] loop
    execute format('alter table %I enable row level security', t);
    execute format('revoke all on %I from anon, authenticated', t);
  end loop;
end $$;
revoke all on sequence tv_commands_id_seq from anon, authenticated;

insert into tv_settings (id, data) values (1, jsonb_build_object(
  'minutes', 20,
  'show', jsonb_build_object('id', 'PLdm4JCUOHx8701zpqOlb016MkKs7Gg-2d', 'title', 'Upin & Ipin · Full episodes')
)) on conflict (id) do nothing;
update tv_settings set data = data || '{"subs": "ms"}' where id = 1 and not data ? 'subs';   -- Malay subtitles by default

-- ---------- internal helpers (not callable by anon) ----------
create or replace function tv_sha(t text) returns text language sql immutable
set search_path = public, extensions as $$ select encode(extensions.digest(t, 'sha256'), 'hex') $$;

create or replace function tv_auth(p_session text) returns void language plpgsql security definer
set search_path = public, extensions as $$
begin
  if p_session is null or not exists (
    select 1 from tv_sessions where token_hash = tv_sha(p_session) and expires_at > now()) then
    raise exception 'Signed out. Sign in again.' using errcode = '28000';
  end if;
  update tv_device set web_active_until = now() + interval '45 seconds' where id = 1;
end $$;

create or replace function tv_new_session() returns text language plpgsql security definer
set search_path = public, extensions as $$
declare t text := encode(extensions.gen_random_bytes(32), 'hex');
begin
  delete from tv_sessions where expires_at < now();
  insert into tv_sessions values (tv_sha(t), now() + interval '30 days');
  return t;
end $$;

create or replace function tv_too_many() returns boolean language plpgsql security definer
set search_path = public, extensions as $$
begin
  delete from tv_auth_fail where at < now() - interval '15 minutes';
  return (select count(*) from tv_auth_fail) >= 10;
end $$;

-- ---------- website ----------
create or replace function tv_setup_status() returns jsonb language sql security definer
set search_path = public, extensions as $$
  select jsonb_build_object('password_set', password_hash is not null, 'tv_seen', last_seen is not null)
  from tv_device where id = 1
$$;

create or replace function tv_setup(p_code text, p_password text) returns jsonb language plpgsql security definer
set search_path = public, extensions as $$
begin
  if tv_too_many() then return jsonb_build_object('ok', false, 'error', 'Too many tries. Wait 15 minutes.'); end if;
  if length(coalesce(p_password, '')) < 8 then
    return jsonb_build_object('ok', false, 'error', 'Use at least 8 characters.');
  end if;
  if exists (select 1 from tv_device where id = 1 and password_hash is not null) then
    return jsonb_build_object('ok', false, 'error', 'Already set up. Sign in instead.');
  end if;
  if not exists (select 1 from tv_device where id = 1 and setup_code is not null and setup_code = p_code) then
    insert into tv_auth_fail default values;
    return jsonb_build_object('ok', false, 'error', 'That code doesn''t match the one on the TV.');
  end if;
  update tv_device set password_hash = extensions.crypt(p_password, extensions.gen_salt('bf', 10)), setup_code = null where id = 1;
  return jsonb_build_object('ok', true, 'session', tv_new_session());
end $$;

create or replace function tv_login(p_password text) returns jsonb language plpgsql security definer
set search_path = public, extensions as $$
declare h text;
begin
  if tv_too_many() then return jsonb_build_object('ok', false, 'error', 'Too many tries. Wait 15 minutes.'); end if;
  select password_hash into h from tv_device where id = 1;
  if h is null then return jsonb_build_object('ok', false, 'error', 'Not set up yet.'); end if;
  if extensions.crypt(coalesce(p_password, ''), h) <> h then
    insert into tv_auth_fail default values;
    return jsonb_build_object('ok', false, 'error', 'Wrong password.');
  end if;
  return jsonb_build_object('ok', true, 'session', tv_new_session());
end $$;

create or replace function tv_logout(p_session text) returns void language sql security definer
set search_path = public, extensions as $$ delete from tv_sessions where token_hash = tv_sha(p_session) $$;

create or replace function tv_change_password(p_session text, p_old text, p_new text) returns jsonb language plpgsql security definer
set search_path = public, extensions as $$
declare h text;
begin
  perform tv_auth(p_session);
  if tv_too_many() then return jsonb_build_object('ok', false, 'error', 'Too many tries. Wait 15 minutes.'); end if;
  select password_hash into h from tv_device where id = 1;
  if extensions.crypt(coalesce(p_old, ''), h) <> h then
    insert into tv_auth_fail default values;
    return jsonb_build_object('ok', false, 'error', 'Current password is wrong.');
  end if;
  if length(coalesce(p_new, '')) < 8 then return jsonb_build_object('ok', false, 'error', 'Use at least 8 characters.'); end if;
  update tv_device set password_hash = extensions.crypt(p_new, extensions.gen_salt('bf', 10)) where id = 1;
  delete from tv_sessions where token_hash <> tv_sha(p_session);   -- sign out other devices
  return jsonb_build_object('ok', true);
end $$;

create or replace function tv_state(p_session text) returns jsonb language plpgsql security definer
set search_path = public, extensions as $$
begin
  perform tv_auth(p_session);
  return (select jsonb_build_object(
    'now', now(),
    'last_seen', d.last_seen,
    'status', d.status,
    'apps', d.apps,
    'settings', (select data - 'pin_hash' || jsonb_build_object('pin_set', data ? 'pin_hash') from tv_settings where id = 1),
    'usage', coalesce((select jsonb_agg(jsonb_build_object('day', u.day, 'screen_ms', u.screen_ms, 'apps', u.apps) order by u.day desc)
                       from tv_usage u where u.day >= current_date - 7), '[]'),
    'pending', (select count(*) from tv_commands))
  from tv_device d where d.id = 1);
end $$;

create or replace function tv_command(p_session text, p_cmd jsonb) returns void language plpgsql security definer
set search_path = public, extensions as $$
begin
  perform tv_auth(p_session);
  if not (p_cmd->>'type' in ('open_app', 'volume', 'key', 'lock_start', 'lock_end', 'reset_watched')) then
    raise exception 'Unknown command';
  end if;
  if (select count(*) from tv_commands) > 50 then raise exception 'Too many queued commands'; end if;
  insert into tv_commands (cmd) values (p_cmd);
end $$;

create or replace function tv_save_settings(p_session text, p_patch jsonb) returns jsonb language plpgsql security definer
set search_path = public, extensions as $$
declare clean jsonb := '{}';
begin
  perform tv_auth(p_session);
  if p_patch ? 'minutes' then
    if jsonb_typeof(p_patch->'minutes') <> 'number' or (p_patch->>'minutes')::numeric not between 1 and 180 then
      raise exception 'Minutes must be 1 to 180';
    end if;
    clean := clean || jsonb_build_object('minutes', round((p_patch->>'minutes')::numeric)::int);
  end if;
  if p_patch ? 'show' then
    if coalesce(p_patch->'show'->>'id', '') !~ '^[A-Za-z0-9_-]{10,64}$' then raise exception 'Not a YouTube playlist'; end if;
    clean := clean || jsonb_build_object('show', jsonb_build_object(
      'id', p_patch->'show'->>'id', 'title', left(coalesce(p_patch->'show'->>'title', 'Playlist'), 80)));
  end if;
  if p_patch ? 'subs' then
    if not (p_patch->>'subs' in ('off', 'ms', 'en', 'zh-Hans')) then raise exception 'Unknown subtitle language'; end if;
    clean := clean || jsonb_build_object('subs', p_patch->>'subs');
  end if;
  if p_patch ? 'pin_hash' then
    if coalesce(p_patch->>'pin_hash', '') !~ '^[0-9a-f]{64}$' then raise exception 'Bad PIN'; end if;
    clean := clean || jsonb_build_object('pin_hash', p_patch->>'pin_hash');
  end if;
  update tv_settings set data = data || clean where id = 1;
  return (select data - 'pin_hash' || jsonb_build_object('pin_set', data ? 'pin_hash') from tv_settings where id = 1);
end $$;

-- ---------- TV ----------
create or replace function tv_sync(p_token text, p_report jsonb) returns jsonb language plpgsql security definer
set search_path = public, extensions as $$
declare d tv_device; cmds jsonb;
begin
  select * into d from tv_device where id = 1;
  if d.token_hash is null or d.token_hash <> tv_sha(coalesce(p_token, '')) then raise exception 'Unknown device'; end if;

  update tv_device set
    status = coalesce(p_report->'status', status),
    apps = coalesce(p_report->'apps', apps),
    last_seen = now(),
    setup_code = case when password_hash is null then coalesce(p_report->>'setup_code', setup_code) else null end
  where id = 1;

  if jsonb_typeof(p_report->'usage') = 'array' then
    insert into tv_usage (day, screen_ms, apps, updated_at)
    select (u->>'day')::date, (u->>'screen_ms')::bigint, coalesce(u->'apps', '{}'), now()
    from jsonb_array_elements(p_report->'usage') u
    on conflict (day) do update set screen_ms = excluded.screen_ms, apps = excluded.apps, updated_at = now();
    delete from tv_usage where day < current_date - 60;
  end if;

  delete from tv_commands where created_at < now() - interval '2 minutes';   -- never run stale commands
  with taken as (delete from tv_commands where id > 0 returning id, cmd)
  select coalesce(jsonb_agg(cmd order by id), '[]') into cmds from taken;

  return jsonb_build_object(
    'settings', (select data from tv_settings where id = 1),
    'commands', cmds,
    'password_set', d.password_hash is not null,
    'fast', coalesce(d.web_active_until > now(), false));
end $$;

-- ---------- permissions ----------
revoke execute on function tv_sha(text), tv_auth(text), tv_new_session(), tv_too_many(),
  tv_setup_status(), tv_setup(text, text), tv_login(text), tv_logout(text), tv_change_password(text, text, text),
  tv_state(text), tv_command(text, jsonb), tv_save_settings(text, jsonb), tv_sync(text, jsonb)
  from public, anon, authenticated;
grant execute on function tv_setup_status(), tv_setup(text, text), tv_login(text), tv_logout(text),
  tv_change_password(text, text, text), tv_state(text), tv_command(text, jsonb), tv_save_settings(text, jsonb),
  tv_sync(text, jsonb) to anon;
