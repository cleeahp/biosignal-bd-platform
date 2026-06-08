// Specialty categorization for clay job titles.
//
// Exports `matchSpecialties(jobTitle, overrides)` where `overrides` is an optional
// Map<jobTitleLowerStripped, string[]>. If the (lowercased, parens-stripped)
// title matches an override, the override array is returned directly and keyword
// matching is skipped. Otherwise keyword rules below run and may return multiple
// specialties. If no rule matches, returns ["Other"].

const SPECIALTY_RULES = [
  { name: 'Biostatistics',       keywords: ['statistician', 'biostatistician', 'biostatistics'] },
  { name: 'Biometrics',          keywords: ['biometrics'] },
  { name: 'Data Management',     keywords: ['data manager', 'data coordinator', 'data management', 'clinical data'] },
  { name: 'Clinical Monitoring', keywords: ['clinical research', 'clinical trial', 'clinical project', 'research associate', 'clinical operations', 'clinical monitoring'] },
  { name: 'Quality Assurance',   keywords: ['quality', 'compliance', 'validation'] },
  { name: 'IT/EDC Programming',  keywords: ['programmer', 'programming'] },
  { name: 'Pharmacovigilance',   keywords: ['pharmacovigilance', 'drug safety'], wholeWord: ['pv'] },
  { name: 'Regulatory Affairs',  keywords: ['regulatory affairs', 'complaint'] },
  { name: 'Medical Writing',     keywords: ['writer', 'writing', 'submission', 'publication'] },
  { name: 'Real World Evidence', keywords: ['real world evidence', 'real-world evidence', 'heor', 'health economics', 'outcomes research'], wholeWord: ['rwe'] },
]

export const SPECIALTY_OPTIONS = SPECIALTY_RULES.map(r => r.name).concat(['Other'])

export function cleanJobTitle(jobTitle) {
  if (!jobTitle) return ''
  return String(jobTitle).toLowerCase().replace(/\([^)]*\)/g, '')
}

function hasWholeWord(text, word) {
  const re = new RegExp(`(^|[^a-z0-9])${word}([^a-z0-9]|$)`, 'i')
  return re.test(text)
}

export function matchSpecialties(jobTitle, overrides) {
  const cleaned = cleanJobTitle(jobTitle)
  if (!cleaned.trim()) return ['Other']

  if (overrides instanceof Map) {
    const key = cleaned.trim()
    if (overrides.has(key)) {
      const val = overrides.get(key)
      if (Array.isArray(val) && val.length > 0) return val
    }
  }

  const matches = []
  for (const rule of SPECIALTY_RULES) {
    const hit = rule.keywords.some(k => cleaned.includes(k))
      || (rule.wholeWord || []).some(w => hasWholeWord(cleaned, w))
    if (hit) matches.push(rule.name)
  }
  return matches.length > 0 ? matches : ['Other']
}
