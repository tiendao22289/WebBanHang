ALTER TABLE public.orders
ADD COLUMN IF NOT EXISTS customer_rating INTEGER CHECK (customer_rating BETWEEN 1 AND 5);

ALTER TABLE public.orders
ADD COLUMN IF NOT EXISTS customer_feedback TEXT;

CREATE TABLE IF NOT EXISTS public.customer_reviews (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  order_id UUID REFERENCES public.orders(id) ON DELETE SET NULL,
  table_id UUID REFERENCES public.tables(id) ON DELETE SET NULL,
  customer_name TEXT,
  customer_phone TEXT,
  rating INTEGER CHECK (rating BETWEEN 1 AND 5),
  feedback TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE public.customer_reviews ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Allow insert customer reviews" ON public.customer_reviews;
CREATE POLICY "Allow insert customer reviews"
ON public.customer_reviews
FOR INSERT
TO anon, authenticated
WITH CHECK (true);

DROP POLICY IF EXISTS "Allow read customer reviews" ON public.customer_reviews;
CREATE POLICY "Allow read customer reviews"
ON public.customer_reviews
FOR SELECT
TO anon, authenticated
USING (true);

NOTIFY pgrst, 'reload schema';
