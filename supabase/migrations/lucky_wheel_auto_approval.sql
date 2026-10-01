-- Explicit audit marker: opening Zalo is sufficient for the owner's auto policy.
-- This does not assert that the Zalo account has followed the OA.
ALTER TABLE public.lucky_spins ADD COLUMN IF NOT EXISTS auto_approved_at timestamptz;
NOTIFY pgrst, 'reload schema';
