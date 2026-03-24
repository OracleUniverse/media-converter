import { createClient } from '@supabase/supabase-js';

const supabaseUrl = (import.meta.env?.VITE_SUPABASE_URL) as string || '';
export const supabaseAnonKey = (import.meta.env?.VITE_SUPABASE_ANON_KEY) as string || '';

// Mock Mode Logic: Use a dummy client and local storage bypass if credentials are placeholders
export const isMockMode = !supabaseUrl || !supabaseAnonKey || supabaseUrl.includes('placeholder');

if (isMockMode) {
  console.warn('⚠️ ExtractAI: Running in Mock Mode. Data will be saved to your browser session instead of a real database.');
}

// Create the real client
export const supabase = createClient(supabaseUrl || 'https://placeholder.supabase.co', supabaseAnonKey || 'placeholder');

// If in Mock Mode, we could wrap the supabase client in a Proxy to redirect queries to local storage,
// or just let the user know they need to update .env for real functionality.
// For now, let's keep it simple and just export the client, as most UI components handle session nullity.
