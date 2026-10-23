-- Sổ tay: ghi mọi thay đổi của một thao tác (trả nợ, chuyển tiền dư, trả chủ, sửa, xoá)
-- trong MỘT giao dịch. Mỗi phiếu bị đổi chỉ được ghi khi updated_at còn đúng như lúc
-- máy chủ đọc; bấm 2 lần cùng lúc thì lần sau báo "note_changed" và không ghi gì.
-- Chạy lại được nhiều lần.
CREATE OR REPLACE FUNCTION public.staff_notes_commit(p jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path = public, pg_temp AS $$
DECLARE
  u jsonb;
  created public.staff_notes;
BEGIN
  FOR u IN SELECT * FROM jsonb_array_elements(coalesce(p->'updates', '[]'::jsonb)) LOOP
    UPDATE public.staff_notes SET
      content = coalesce(u->>'content', content),
      note_type = coalesce(u->>'note_type', note_type),
      amount = coalesce((u->>'amount')::int, amount),
      debt = coalesce((u->>'debt')::int, debt),
      paid_debt = coalesce((u->>'paid_debt')::int, paid_debt),
      updated_at = clock_timestamp()
    WHERE id = (u->>'id')::uuid AND updated_at IS NOT DISTINCT FROM (u->>'expect')::timestamptz;
    IF NOT FOUND THEN RAISE EXCEPTION 'note_changed'; END IF;
  END LOOP;

  IF p ? 'delete' THEN
    DELETE FROM public.staff_notes
    WHERE id = (p->'delete'->>'id')::uuid AND updated_at IS NOT DISTINCT FROM (p->'delete'->>'expect')::timestamptz;
    IF NOT FOUND THEN RAISE EXCEPTION 'note_changed'; END IF;
  END IF;

  DELETE FROM public.staff_note_payments
  WHERE id IN (SELECT value::uuid FROM jsonb_array_elements_text(coalesce(p->'delete_payments', '[]'::jsonb)));

  IF p ? 'insert' THEN
    INSERT INTO public.staff_notes (id, staff_id, note_type, content, amount, debt, status)
    VALUES ((p->'insert'->>'id')::uuid, (p->'insert'->>'staff_id')::uuid, p->'insert'->>'note_type', p->'insert'->>'content',
            (p->'insert'->>'amount')::int, (p->'insert'->>'debt')::int, coalesce(p->'insert'->>'status', 'approved'))
    RETURNING * INTO created;
  END IF;

  INSERT INTO public.staff_note_payments (note_id, item_index, amount, paid_from_note_id, staff_id, created_by_name)
  SELECT (x->>'note_id')::uuid, (x->>'item_index')::int, (x->>'amount')::int, (x->>'paid_from_note_id')::uuid,
         (x->>'staff_id')::uuid, x->>'created_by_name'
  FROM jsonb_array_elements(coalesce(p->'payments', '[]'::jsonb)) x;

  RETURN CASE WHEN created.id IS NULL THEN NULL ELSE to_jsonb(created) END;
END $$;

REVOKE ALL ON FUNCTION public.staff_notes_commit(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.staff_notes_commit(jsonb) TO service_role;
