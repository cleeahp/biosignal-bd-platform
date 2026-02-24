/**
 * One-time migration: create past_clients table and seed 18 past clients.
 *
 * Run: node scripts/migratePastClients.js
 *
 * If the table does not yet exist, this script will print the DDL SQL
 * to run in the Supabase Dashboard (SQL Editor), then exit.
 * After running the DDL, re-run this script to seed the data.
 */

import { createClient } from '@supabase/supabase-js'
import 'dotenv/config'

const SUPABASE_URL = process.env.SUPABASE_URL
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY env vars')
  process.exit(1)
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

const DDL = `-- Run this in the Supabase Dashboard → SQL Editor
CREATE TABLE IF NOT EXISTS past_clients (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  name text NOT NULL,
  priority_rank integer NOT NULL,
  is_active boolean DEFAULT true,
  created_at timestamptz DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS past_clients_name_idx ON past_clients (lower(trim(name)));
ALTER TABLE past_clients ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow anon read past_clients" ON past_clients FOR SELECT TO anon USING (true);`

// boost_score formula: rank 1 → +15, rank 18 → +10 (linear interpolation)
function boostScore(rank) {
  return Math.round(15 - ((rank - 1) / 17) * 5)
}

const PAST_CLIENTS = [
  { name: 'Alzheon Inc.',                      priority_rank:  1 },
  { name: 'Annexon Inc',                        priority_rank:  2 },
  { name: 'Arcus Biosciences, Inc.',             priority_rank:  3 },
  { name: 'AstraZeneca',                         priority_rank:  4 },
  { name: 'AxoGen Corporation',                  priority_rank:  5 },
  { name: 'BlueRock Therapeutics LP',            priority_rank:  6 },
  { name: 'Celldex Therapeutics, Inc.',          priority_rank:  7 },
  { name: 'Day One Biopharmaceuticals, Inc.',    priority_rank:  8 },
  { name: 'EarliTec Diagnostics, Inc.',          priority_rank:  9 },
  { name: 'Exelixis',                            priority_rank: 10 },
  { name: 'Leo Pharma Inc.',                     priority_rank: 11 },
  { name: 'Prothena Biosciences Inc.',           priority_rank: 12 },
  { name: 'REGENBIO, INC',                       priority_rank: 13 },
  { name: 'Repare Therapeutics',                 priority_rank: 14 },
  { name: 'Spruce Biosciences',                  priority_rank: 15 },
  { name: 'Tagworks Pharmaceuticals B.V.',       priority_rank: 16 },
  { name: 'Terumo Medical Corporation',          priority_rank: 17 },
  { name: 'Teva Pharmaceuticals',                priority_rank: 18 },
]

async function ensureTableExists() {
  // Try a select; Supabase returns a schema-cache error if the table doesn't exist
  const { error } = await supabase.from('past_clients').select('id').limit(1)
  if (!error) return true  // table exists

  const msg = error.message || ''
  const isNotFound =
    msg.includes('does not exist') ||
    msg.includes('schema cache') ||
    msg.includes('relation') ||
    error.code === '42P01' ||
    error.code === 'PGRST116'

  if (!isNotFound) {
    console.error('[migratePastClients] Unexpected error checking table:', msg)
    process.exit(1)
  }

  // Table doesn't exist — try to create it via Supabase's REST SQL endpoint
  console.log('[migratePastClients] Table not found. Attempting DDL via SQL API...')

  const projectRef = SUPABASE_URL.replace(/^https?:\/\//, '').split('.')[0]
  const sqlApiUrl = `${SUPABASE_URL}/pg/query`

  try {
    const resp = await fetch(sqlApiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        'apikey': SUPABASE_SERVICE_ROLE_KEY,
      },
      body: JSON.stringify({ query: DDL.replace(/^-- .+\n/gm, '') }),
    })
    const body = await resp.text()
    if (resp.ok) {
      console.log('[migratePastClients] Table created successfully via SQL API.')
      return true
    }
    console.warn('[migratePastClients] SQL API returned:', resp.status, body.slice(0, 200))
  } catch (fetchErr) {
    console.warn('[migratePastClients] SQL API unavailable:', fetchErr.message)
  }

  // Fall back: print DDL for manual execution
  console.error('\n[migratePastClients] Could not auto-create the table.')
  console.error('Please run the following SQL in your Supabase Dashboard → SQL Editor:')
  console.error('\n' + DDL + '\n')
  console.error('Then re-run this script to seed the data.\n')
  process.exit(1)
}

async function main() {
  console.log('[migratePastClients] Starting...')

  await ensureTableExists()

  // ── Upsert 18 past clients ──────────────────────────────────────────────────
  let inserted = 0
  let updated = 0
  let skipped = 0

  for (const client of PAST_CLIENTS) {
    const { data: existing } = await supabase
      .from('past_clients')
      .select('id, priority_rank')
      .ilike('name', client.name)
      .maybeSingle()

    if (existing) {
      if (existing.priority_rank !== client.priority_rank) {
        await supabase
          .from('past_clients')
          .update({ priority_rank: client.priority_rank, is_active: true })
          .eq('id', existing.id)
        console.log(`  UPDATED  [rank ${client.priority_rank}] ${client.name} (boost: +${boostScore(client.priority_rank)})`)
        updated++
      } else {
        console.log(`  EXISTS   [rank ${client.priority_rank}] ${client.name}`)
        skipped++
      }
      continue
    }

    const { error } = await supabase
      .from('past_clients')
      .insert({ name: client.name, priority_rank: client.priority_rank, is_active: true })

    if (error) {
      console.warn(`  ERROR    ${client.name}: ${error.message}`)
    } else {
      console.log(`  INSERTED [rank ${client.priority_rank}] ${client.name} (boost: +${boostScore(client.priority_rank)})`)
      inserted++
    }
  }

  console.log(`\n[migratePastClients] Done. Inserted: ${inserted}, Updated: ${updated}, Already existed: ${skipped}`)
}

main().catch(err => {
  console.error('[migratePastClients] Fatal:', err.message)
  process.exit(1)
})
