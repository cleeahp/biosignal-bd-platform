-- biospace_news: articles scraped from BioSpace drug-development feed
-- Populated by scripts/biospaceScan.js (daily + manual workflows)

create table if not exists public.biospace_news (
  id            uuid primary key default gen_random_uuid(),
  title         text not null,
  article_url   text not null,
  article_date  date,
  created_at    timestamptz not null default now()
);

create unique index if not exists biospace_news_article_url_idx
  on public.biospace_news (article_url);

alter table public.biospace_news enable row level security;

create policy "Allow anon read on biospace_news"
  on public.biospace_news
  for select
  to anon
  using (true);
