-- fiercebio_news: articles scraped from FierceBiotech cell/gene therapy keyword feed
-- Populated by scripts/fierceBioScan.js (daily + manual workflows)

create table if not exists public.fiercebio_news (
  id            uuid primary key default gen_random_uuid(),
  title         text not null,
  article_url   text not null,
  article_date  date,
  created_at    timestamptz not null default now()
);

create unique index if not exists fiercebio_news_article_url_idx
  on public.fiercebio_news (article_url);

alter table public.fiercebio_news enable row level security;

create policy "Allow anon read on fiercebio_news"
  on public.fiercebio_news
  for select
  to anon
  using (true);
