import { createClient } from '@supabase/supabase-js';
import AsyncStorage from '@react-native-async-storage/async-storage';

const SUPABASE_URL = 'https://wglhqlrumieujmugpxel.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6IndnbGhxbHJ1bWlldWptdWdweGVsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzM3NjE0MzMsImV4cCI6MjA4OTMzNzQzM30.mE5UgQAVM1Egifh2hcyYVXx2SIWC_21Xpg0MjsqTEHE';

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    storage: AsyncStorage,
    autoRefreshToken: true,
    persistSession: true,
    detectSessionInUrl: false,
  },
});
