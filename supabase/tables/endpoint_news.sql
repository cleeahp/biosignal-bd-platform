-- endpoint_news: articles scraped from Endpoints News
-- Populated by scripts/endpointsScan.js (daily + manual workflows)
-- No date column — source uses relative dates ("2 hours ago") that aren't
-- reliably parseable; dedup by article_url only.

create table if not exists public.endpoint_news (
  id            uuid primary key default gen_random_uuid(),
  title         text not null,
  article_url   text not null,
  created_at    timestamptz not null default now()
);

create unique index if not exists endpoint_news_article_url_idx
  on public.endpoint_news (article_url);

alter table public.endpoint_news enable row level security;

create policy "Allow anon read on endpoint_news"
  on public.endpoint_news
  for select
  to anon
  using (true);
