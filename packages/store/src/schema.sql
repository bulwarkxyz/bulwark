-- Bulwark guard worker schema. Idempotent: safe to run on every start.

create table if not exists users (
  account           text primary key,
  agent_key_ref     text not null,
  region            text not null check (region in ('allowed', 'guardOff')),
  telegram_chat_id  text,
  kill_switch       boolean not null default false,
  builder_approved  boolean not null default false,
  created_at        bigint not null
);

create table if not exists policies (
  account             text not null references users (account),
  version             integer not null,
  body                jsonb not null,
  hash                text not null,
  signature           text not null,
  signature_verified  boolean not null,
  confirmed_at        bigint not null,
  active              boolean not null default true,
  primary key (account, version)
);
create unique index if not exists policies_one_active on policies (account) where active;

create table if not exists latches (
  account  text primary key,
  keys     jsonb not null
);

create table if not exists baselines (
  account  text not null,
  rule_id  text not null,
  body     jsonb not null,
  primary key (account, rule_id)
);

-- Orders the guard placed itself: the only orders it may ever cancel.
create table if not exists guard_orders (
  account     text not null,
  oid         bigint not null,
  coin        text not null,
  kind        text not null,
  trigger_px  double precision not null,
  size        double precision not null,
  placed_at   bigint not null,
  primary key (account, oid)
);

create table if not exists actions (
  account  text not null,
  at       bigint not null
);
create index if not exists actions_account_at on actions (account, at);

-- Append-only, hash-chained audit log (one chain per account).
create table if not exists audit_log (
  account    text not null,
  seq        integer not null,
  at         bigint not null,
  kind       text not null,
  why        text not null,
  what       text not null,
  proof      jsonb,
  prev_hash  text not null,
  hash       text not null,
  primary key (account, seq)
);

create or replace function audit_log_append_only() returns trigger as $$
begin
  raise exception 'audit_log is append-only';
end
$$ language plpgsql;

drop trigger if exists audit_log_no_change on audit_log;
create trigger audit_log_no_change before update or delete on audit_log
  for each row execute function audit_log_append_only();

-- One-time codes the app shows the user; the bot links a Telegram chat to the account with them.
create table if not exists telegram_links (
  code        text primary key,
  account     text not null references users (account),
  expires_at  bigint not null,
  used_at     bigint
);

-- Signed user commands for the worker to carry out (panic unwind, kill switch, resume).
create table if not exists commands (
  id          bigserial primary key,
  account     text not null references users (account),
  command     text not null check (command in ('unwind', 'stop', 'resume')),
  minutes     integer not null default 0,
  issued_at   bigint not null,
  signature   text not null,
  created_at  bigint not null,
  done_at     bigint,
  result      jsonb
);
create index if not exists commands_pending on commands (created_at) where done_at is null;

alter table users add column if not exists agent_address text;
alter table users add column if not exists residency text;
alter table users add column if not exists citizenship text;

-- Encrypted-at-rest agent keys: AES-256-GCM blobs under a master key that only the signing service holds.
-- `sealed` becomes null when a key is wiped; the row stays as a record.
create table if not exists agent_keys (
  account        text not null references users (account),
  network        text not null,
  address        text not null,
  sealed         text,
  master_key_id  text,
  status         text not null check (status in ('pending', 'active', 'retired', 'wiped')),
  created_at     bigint not null,
  updated_at     bigint not null,
  primary key (account, network, address)
);

-- The API asks for keys here; the signing service creates them. No key material ever passes through.
create table if not exists agent_key_requests (
  id            bigserial primary key,
  account       text not null references users (account),
  network       text not null,
  kind          text not null check (kind in ('create', 'rotate')),
  requested_at  bigint not null,
  done_at       bigint,
  result        jsonb
);
create unique index if not exists agent_key_requests_one_open on agent_key_requests (account, network) where done_at is null;

-- Commands gain 'wipe' (destroy the user's sealed agent key).
alter table commands drop constraint if exists commands_command_check;
alter table commands add constraint commands_command_check check (command in ('unwind', 'stop', 'resume', 'wipe'));

-- Guard orders that did not fully fill, retried while their stage holds (guard-core retry.ts).
alter table latches add column if not exists retries jsonb not null default '[]'::jsonb;

-- What the guard is doing for each account, written by the worker, served by the API.
create table if not exists guard_status (
  account            text primary key,
  state              text not null check (state in ('protected', 'acting', 'at_risk', 'paused', 'stopped', 'no_rules', 'alerts_only')),
  reason             text check (reason in ('stale_data', 'exchange_unreachable', 'signer_error', 'agent_expired')),
  last_evaluated_at  bigint,
  updated_at         bigint not null,
  check ((state = 'paused') = (reason is not null))
);

-- Guard orders: the rule and buffer line each belongs to, and how a backstop was priced.
alter table guard_orders add column if not exists rule_id text;
alter table guard_orders add column if not exists line double precision;
alter table guard_orders add column if not exists pricing text;

-- Keys held in AWS KMS: the key id (no key material), and when the API disabled it and scheduled deletion.
alter table agent_keys add column if not exists kms_key_id text;
alter table agent_keys add column if not exists kms_retired_at bigint;

-- Per-stage repeat choice: prices when "once per breach" stages acted, and action times for limits.
alter table latches add column if not exists breaches jsonb not null default '{}'::jsonb;
alter table latches add column if not exists fires jsonb not null default '{}'::jsonb;

-- In-app alerts preference (alongside Telegram, which is linked separately).
alter table users add column if not exists in_app_alerts boolean not null default true;
