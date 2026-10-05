import { createClient } from '@supabase/supabase-js';

const proxyPath = process.env.NEXT_PUBLIC_SUPABASE_PROXY_PATH;
const useProxy = process.env.NEXT_PUBLIC_APP_ENV !== 'dev' && proxyPath && typeof window !== 'undefined'
  && !['localhost', '127.0.0.1', '[::1]'].includes(window.location.hostname);
const supabaseUrl = useProxy
  ? `${window.location.origin}${proxyPath}`
  : process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

export const supabase = createClient(supabaseUrl, supabaseAnonKey);
