import { supabase } from './supabase.js'

/**
 * Load all dismissal rules where auto_exclude = true.
 * Returns a Map keyed by signal_type, with each value being an array of { rule_type, rule_value }.
 */
export async function loadDismissalRules() {
  const rules = new Map()
  try {
    const { data, error } = await supabase
      .from('dismissal_rules')
      .select('rule_type, rule_value, signal_type')
      .eq('auto_exclude', true)

    if (error) {
      console.error('[dismissalRules] Error loading rules:', error.message)
      return rules
    }

    for (const row of data || []) {
      if (!rules.has(row.signal_type)) {
        rules.set(row.signal_type, [])
      }
      rules.get(row.signal_type).push({
        rule_type: row.rule_type,
        rule_value: row.rule_value.toLowerCase(),
      })
    }
  } catch (err) {
    console.error('[dismissalRules] Failed to load:', err.message)
  }
  return rules
}

/**
 * Check if a signal should be auto-excluded based on active dismissal rules.
 *
 * @param {Map} rules - Map from loadDismissalRules()
 * @param {string} signalType - The signal_type to check
 * @param {{ company?: string, role_title?: string, location?: string }} values - Values to check against rules
 * @returns {{ excluded: boolean, rule_type?: string, rule_value?: string }}
 */
export function checkDismissalExclusion(rules, signalType, values) {
  const typeRules = rules.get(signalType)
  if (!typeRules || typeRules.length === 0) return { excluded: false }

  for (const rule of typeRules) {
    const checkValue = values[rule.rule_type]
    if (checkValue && checkValue.toLowerCase() === rule.rule_value) {
      return { excluded: true, rule_type: rule.rule_type, rule_value: rule.rule_value }
    }
  }
  return { excluded: false }
}
