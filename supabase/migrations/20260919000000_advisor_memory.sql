-- Optional durable memory for Advisor Brief.
-- Both tables are intentionally service-role only: RLS is enabled and no browser policies are created.

create table if not exists public.advisor_briefings (
  key text primary key,
  ticker text not null,
  generated_at timestamptz not null,
  expires_at timestamptz not null,
  summary jsonb not null default '{}'::jsonb,
  record jsonb not null,
  created_at timestamptz not null default now()
);

create index if not exists advisor_briefings_ticker_generated_idx
  on public.advisor_briefings (ticker, generated_at desc);

create index if not exists advisor_briefings_expires_idx
  on public.advisor_briefings (expires_at);

alter table public.advisor_briefings enable row level security;

create table if not exists public.advisor_conversations (
  session_id text not null,
  ticker text not null,
  turns jsonb not null default '[]'::jsonb,
  updated_at timestamptz not null default now(),
  primary key (session_id, ticker),
  constraint advisor_conversations_turns_array check (jsonb_typeof(turns) = 'array')
);

create index if not exists advisor_conversations_updated_idx
  on public.advisor_conversations (updated_at desc);

alter table public.advisor_conversations enable row level security;

comment on table public.advisor_briefings is
  'Server-only cache of filing-grounded briefings, invalidated by accession-based keys and TTL.';

comment on table public.advisor_conversations is
  'Server-only session memory for grounded follow-up questions; application code caps each thread at 12 turns.';
