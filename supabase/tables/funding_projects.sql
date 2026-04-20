-- funding_projects: NIH RePORTER funded projects, matched against companies_directory
-- Populated by scripts/nihFundingScan.js (daily + manual workflows)

create table if not exists public.funding_projects (
  id                      uuid primary key default gen_random_uuid(),
  appl_id                 text not null,
  project_num             text,
  project_title           text,
  org_name                text,
  org_city                text,
  org_state               text,
  award_amount            numeric,
  public_health_relevance text,
  fiscal_year             integer,
  award_notice_date       date,
  date_added              date,
  matched_name            text,
  company_size            text,
  matched_via             text,
  created_at              timestamptz not null default now()
);

create unique index if not exists funding_projects_appl_id_idx
  on public.funding_projects (appl_id);

alter table public.funding_projects enable row level security;

create policy "Allow anon read on funding_projects"
  on public.funding_projects
  for select
  to anon
  using (true);
