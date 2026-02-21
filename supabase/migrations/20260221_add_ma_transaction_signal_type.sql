-- Migration: add ma_transaction to signals_signal_type_check constraint
-- Run this in the Supabase SQL editor before deploying the fundingMaAgent M&A changes.
--
-- Background: the fundingMaAgent was updated to emit a single 'ma_transaction'
-- signal per EDGAR filing (replacing the old dual ma_acquirer + ma_acquired pair).
-- The check constraint must be updated to allow the new signal type.

ALTER TABLE signals DROP CONSTRAINT signals_signal_type_check;

ALTER TABLE signals ADD CONSTRAINT signals_signal_type_check
CHECK (signal_type IN (
  'clinical_trial_phase_transition',
  'clinical_trial_new_ind',
  'clinical_trial_site_activation',
  'clinical_trial_completion',
  'funding_new_award',
  'funding_renewal',
  'ma_acquirer',
  'ma_acquired',
  'ma_transaction',
  'competitor_job_posting',
  'stale_job_posting'
));
