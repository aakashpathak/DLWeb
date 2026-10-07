-- ProductClips schema (spec section 8). The app currently runs on the local
-- filesystem store (src/lib/store.ts); these tables mirror its records 1:1 so
-- a Supabase adapter is a drop-in replacement of that module.

create table projects (
  id text primary key,
  url text not null,
  status text not null default 'new' check (status in ('new','running','ready','error','blocked')),
  authorized boolean not null default false,
  instruction text,
  created_at timestamptz not null default now()
);

create table extractions (
  project_id text primary key references projects(id) on delete cascade,
  product_json jsonb not null,
  brand_kit_json jsonb,
  screenshots jsonb not null default '[]',
  raw_html_path text,
  plan_json jsonb,             -- last creative plan, reused for scene regeneration
  updated_at timestamptz not null default now()
);

create table assets (
  id text primary key,
  project_id text not null references projects(id) on delete cascade,
  storage_path text not null,
  source_url text,
  width int not null,
  height int not null,
  kind text not null default 'image',
  analysis_json jsonb,
  phash text
);
create index on assets(project_id);

create table storyboards (
  id bigserial primary key,
  project_id text not null references projects(id) on delete cascade,
  version int not null,
  json jsonb not null,
  qa_report jsonb not null default '[]',
  created_by text not null check (created_by in ('ai','user','heuristic')),
  note text,
  created_at timestamptz not null default now(),
  unique (project_id, version)
);

create table renders (
  id text primary key,
  project_id text not null references projects(id) on delete cascade,
  storyboard_version int not null,
  status text not null check (status in ('queued','rendering','done','error')),
  progress real not null default 0,
  mp4_path text, poster_path text, gif_path text,
  duration real, lufs real, error text,
  created_at timestamptz not null default now()
);

create table music_tracks (
  id text primary key,
  title text not null,
  bpm real not null,
  mood text not null,
  energy int not null,
  tones text[] not null default '{}',
  beat_grid_json jsonb not null,   -- { offsetSec, beatsPerBar }
  storage_path text not null,
  license text not null
);

create table pipeline_steps (
  project_id text not null references projects(id) on delete cascade,
  step text not null check (step in ('ingest','brand','analyze','storyboard','render')),
  status text not null,
  note text, error text,
  started_at timestamptz, finished_at timestamptz,
  primary key (project_id, step)
);

-- Storage buckets: assets (images, screenshots, logos, fonts), renders (mp4/poster/gif), music.
insert into storage.buckets (id, name, public) values ('assets','assets',false), ('renders','renders',false), ('music','music',false)
  on conflict do nothing;
