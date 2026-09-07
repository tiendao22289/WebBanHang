-- The slot mutation accepts server-computed amounts and must not be callable
-- with the public browser key. Apply before deploying the reward hardening.
BEGIN;
REVOKE ALL ON FUNCTION public.claim_lucky_wheel_slot(uuid, uuid, uuid[], uuid, text, integer, integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_lucky_wheel_slot(uuid, uuid, uuid[], uuid, text, integer, integer)
  TO service_role;
COMMIT;
