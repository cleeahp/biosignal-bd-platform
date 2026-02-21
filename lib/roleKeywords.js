/**
 * Shared role keyword constants for the BioSignal BD platform.
 * Used across agents and UI components to identify relevant clinical/pharma roles.
 */

// Partial-match strings — any job title containing these (case-insensitive) is a signal.
// These are checked alongside the exact ROLE_KEYWORDS list.
export const PARTIAL_ROLE_KEYWORDS = [
  'Clinical Research',
  'Regulatory',
  'Biostat',
  'Data Management',
  'Clinical Trial',
  'Pharmacovigilance',
  'Drug Safety',
  'Medical Monitor',
  'Medical Affairs',
  'Quality Assurance',
  'Validation',
  'Health Economics',
  'Clinical Operations',
  'Study Manager',
  'Protocol',
];

export const ROLE_KEYWORDS = [
  // Biostatistics
  'Project Biostatistician',
  'DMC Statistician',
  'Principal Biostatistician',
  'Sr. Biostatistician',
  'Senior Biostatistician',
  'Lead Biostatistician',
  'Biostatistician',

  // Data Management
  'Project Data Manager',
  'Lab Data Manager',
  'Clinical Data Coordinator',
  'Clinical Data Manager',
  'Data Manager',

  // Clinical Research Associates / Trial Management
  'Regional Clinical Research Associate',
  'Clinical Research Associate',
  'CRA',
  'Clinical Trial Manager',
  'CTM',
  'Senior Clinical Research Associate',
  'Sr. Clinical Research Associate',
  'Lead CRA',
  'Field CRA',
  'In-House CRA',

  // Clinical Research Coordinators
  'Clinical Research Coordinator',
  'CRC',
  'Study Coordinator',
  'Research Coordinator',

  // Quality / Validation
  'Quality Engineer',
  'Validation Engineer',
  'Quality Assurance Specialist',
  'QA Specialist',
  'Quality Assurance Engineer',
  'Computer System Validation Specialist',
  'CSV Specialist',
  'QA Engineer',

  // Statistical / Clinical Programming
  'Statistical Programmer',
  'Clinical Programmer',
  'Senior Statistical Programmer',
  'Sr. Statistical Programmer',
  'Lead Statistical Programmer',
  'Clinical SAS Programmer',
  'SAS Programmer',

  // SDTM / CDISC Programming
  'Study Data Tabulation Model Programmer',
  'SDTM Programmer',
  'CDISC Programmer',
  'ADaM Programmer',
  'CDISC/SDTM Programmer',

  // EDC Programmers
  'Medidata RAVE Programmer',
  'RAVE Programmer',
  'Inform Programmer',
  'Oracle Clinical Programmer',
  'EDC Programmer',
  'Veeva Vault Programmer',
  'Medidata Rave Developer',

  // Drug Safety / Pharmacovigilance
  'Drug Safety Associate',
  'Pharmacovigilance Physician',
  'PV Scientist',
  'Pharmacovigilance Scientist',
  'Drug Safety Scientist',
  'Pharmacovigilance Associate',
  'PV Associate',
  'Safety Scientist',
  'Safety Associate',
  'Medical Safety Officer',
  'Global Drug Safety Associate',

  // Medical Device / Regulatory Reporting
  'EU Medical Device Reporting Specialist',
  'Complaint Specialist',
  'Medical Device Complaint Specialist',
  'MDR Specialist',
  'Medical Device Reporting Specialist',
  'Post-Market Surveillance Specialist',

  // Regulatory Affairs
  'Regulatory Affairs Specialist',
  'Technical Regulatory Specialist',
  'Regulatory Submissions Specialist',
  'RA Specialist',
  'Regulatory Affairs Manager',
  'Regulatory Affairs Associate',
  'CMC Regulatory Specialist',

  // Safety Submissions / Publications
  'Safety Submissions Specialist',
  'Publications Specialist',
  'Medical Writer',
  'Regulatory Medical Writer',
  'Safety Medical Writer',

  // Real World Evidence / Data Science
  'Real World Evidence Programmer',
  'Data Scientist',
  'RWE Programmer',
  'Real World Evidence Analyst',
  'RWE Analyst',
  'RWE Scientist',

  // Real World Analytics / HEOR
  'Real World Analytics Specialist',
  'HEOR Specialist',
  'Health Economics and Outcomes Research Specialist',
  'HEOR Analyst',
  'Health Economics Specialist',
  'Outcomes Research Specialist',
  'Health Economist',
];

/**
 * Pre-compiled case-insensitive regex that matches any of the role keywords
 * or common abbreviations found in the ROLE_KEYWORDS array.
 *
 * Escape function handles special regex characters in keyword strings.
 */
function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const keywordPatterns = ROLE_KEYWORDS.map(escapeRegex);

// Add standalone abbreviation patterns that must match as whole words
const abbreviationPatterns = [
  '\\bCRA\\b',
  '\\bCTM\\b',
  '\\bCRC\\b',
  '\\bPV\\b',
  '\\bQA\\b',
  '\\bRWE\\b',
  '\\bHEOR\\b',
  '\\bSDTM\\b',
  '\\bADaM\\b',
  '\\bCDISC\\b',
  '\\bMDR\\b',
  '\\bSAS\\b',
  '\\bEDC\\b',
];

const partialPatterns = PARTIAL_ROLE_KEYWORDS.map(escapeRegex);

const allPatterns = [...keywordPatterns, ...abbreviationPatterns, ...partialPatterns];

export const ROLE_KEYWORDS_REGEX = new RegExp(allPatterns.join('|'), 'i');

/**
 * Returns true if the given text contains any of the role keywords
 * or recognized abbreviations.
 *
 * @param {string} text - The text to test (e.g. job title, posting description)
 * @returns {boolean}
 */
export function matchesRoleKeywords(text) {
  if (!text || typeof text !== 'string') return false;
  return ROLE_KEYWORDS_REGEX.test(text);
}
