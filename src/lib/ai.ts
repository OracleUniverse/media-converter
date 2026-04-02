import { GoogleGenerativeAI, type Part } from "@google/generative-ai";

import { supabase, supabaseAnonKey } from "./supabase";
import { splitPdfIntoImages, renderPageToImage } from "./pdf";
import { shrinkImage } from "./imageOptimization";
import { QuotaMonitor } from "./quotaMonitor";

/**
 * AI CORE ENGINE (ai.ts)
 * ---------------------
 * This file serves as the primary intelligence hub for the application.
 * It manages:
 * 1. Multi-provider API Key Pooling (Google, etc.)
 * 2. Enterprise-grade Rate Limiting (RPM/TPM local & cloud sync)
 * 3. Secure Invocation via Supabase Edge Functions
 * 4. Image Pre-processing & PDF decomposition
 * 5. Robust JSON Repair & Data Normalization
 */

const DEFAULT_API_KEY = (import.meta.env?.VITE_GEMINI_API_KEY) as string || '';
// OpenRouter constants removed

export interface ApiKey {
    id: string;
    key_name?: string;
    key_value: string;
    provider: string;
    pre_scan_model: string;
    extraction_model: string;
    status: 'active' | 'busy' | 'disabled';
    last_used_at?: string;
    cooldown_until?: string | null;
    last_error?: string | null;
    activeUsageId?: string;
    rpm_limit?: number;
    tpm_limit?: number;
}

class LocalRateLimiter {
    private static instance: LocalRateLimiter;
    private requestLog = new Map<string, number[]>(); // keyId -> timestamps
    private tokenLog = new Map<string, { t: number; count: number }[]>(); // keyId -> {timestamp, count}

    private constructor() {}

    /**
     * LocalRateLimiter ensures we don't hit 429 errors by tracking usage locally.
     * It uses a sliding window (60s) for both Requests Per Minute (RPM) and Tokens Per Minute (TPM).
     */
    static getInstance() {
        if (!LocalRateLimiter.instance) LocalRateLimiter.instance = new LocalRateLimiter();
        return LocalRateLimiter.instance;
    }

    async waitForQuota(key: ApiKey, estimatedTokens: number): Promise<void> {
        const rpm = key.rpm_limit || 15;
        const tpm = key.tpm_limit || 1000000;
        const keyId = key.id;

        while (true) {
            const now = Date.now();
            const oneMinAgo = now - 60000;

            // 1. RPM Check
            const lastRequests = (this.requestLog.get(keyId) || []).filter(t => t > oneMinAgo);
            this.requestLog.set(keyId, lastRequests);

            // 2. TPM Check
            const lastTokens = (this.tokenLog.get(keyId) || []).filter(entry => entry.t > oneMinAgo);
            this.tokenLog.set(keyId, lastTokens);
            const currentTokenUsage = lastTokens.reduce((sum, entry) => sum + entry.count, 0);

            if (lastRequests.length < rpm && (currentTokenUsage + estimatedTokens) < tpm) {
                // Quota available
                lastRequests.push(now);
                lastTokens.push({ t: now, count: estimatedTokens });
                return;
            }

            const waitTime = 2000; // Poll every 2s
            console.log(`[RateLimiter] 🚦 Quota full for ${key.key_name}. RPM: ${lastRequests.length}/${rpm}, TPM: ${currentTokenUsage}/${tpm}. Waiting ${waitTime}ms...`);
            await new Promise(r => setTimeout(r, waitTime));
        }
    }

    syncWithHeaders(keyId: string, limits: any): void {
        if (limits.requests_remaining !== null) {
            const remaining = parseInt(limits.requests_remaining);
            const limit = parseInt(limits.requests_limit);
            
            // If API says we have less remaining than our log, adjust
            const currentLog = this.requestLog.get(keyId) || [];
            if (currentLog.length > (limit - remaining)) {
                // Keep only enough timestamps to reflect what's actually remaining
                this.requestLog.set(keyId, currentLog.slice(-(limit - remaining)));
            }
        }

        if (limits.tokens_remaining !== null) {
            const remaining = parseInt(limits.tokens_remaining);
            const limit = parseInt(limits.tokens_limit);
            
            // Similar logic for tokens
            const currentLog = this.tokenLog.get(keyId) || [];
            let sum = currentLog.reduce((s, e) => s + e.count, 0);
            
            while (sum > (limit - remaining) && currentLog.length > 0) {
                const shifted = currentLog.shift();
                if (shifted) sum -= shifted.count;
            }
            this.tokenLog.set(keyId, currentLog);
        }
        
        console.log(`[RateLimiter] 🔄 Key ${keyId} synced with API headers.`);
    }
}

export class KeyPool {
    private keys: ApiKey[] = [];
    private waitingQueue: (() => void)[] = [];
    private pendingLeases = new Map<string, number>();
    private initialized = false;
    private isListening = false;
    public static readonly VIRTUAL_ID = '00000000-0000-0000-0000-000000000000';

    constructor() {
        /**
         * Real-time initialization: listens for DB changes so that if an admin
         * enables a key or a cooldown expires, the pool updates instantly.
         */
        this.initRealtime();
    }

    private async initRealtime() {
        if (this.isListening) return;
        
        // Only listen for key status changes (cooldowns/enabling)
        supabase
            .channel('key-status-changes')
            .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'inv_api_keys' }, () => this.refreshPool())
            .subscribe();
            
        this.isListening = true;
    }

    private async notifyWaiters() {
        if (this.waitingQueue.length === 0) return;
        console.log(`[KeyPool] 🔔 Sync signal received. Notifying ${this.waitingQueue.length} waiter(s).`);
        
        // Just resolve the first waiter, they will re-check in their own loop
        const resolve = this.waitingQueue.shift();
        if (resolve) resolve();
    }

    async refreshPool() {
        const { data, error } = await supabase
            .from('inv_api_keys')
            .select('*')
            .eq('status', 'active');
        
        if (error) {
            console.error("[KeyPool] Failed to fetch keys:", error);
        }

        this.keys = data || [];

        // OpenRouter keys now handled via Supabase Edge Functions or DB.

        // FALLBACK: If no keys in DB, use the .env key if available
        if (this.keys.length === 0 && DEFAULT_API_KEY) {
            console.log("[KeyPool] 🛟 No keys in DB. Using DEFAULT_API_KEY from environment.");
            this.keys = [{
                id: KeyPool.VIRTUAL_ID,
                key_name: 'Environment Default',
                key_value: DEFAULT_API_KEY,
                provider: 'google',
                pre_scan_model: 'google/gemini-2.0-flash-001',
                extraction_model: 'google/gemini-2.0-flash-001',
                status: 'active'
            }];
        }

        this.initialized = true;
        if (this.keys.length > 0) {
            console.log(`[KeyPool] Loaded ${this.keys.length} active key(s) into pool.`);
        } else {
            console.warn("[KeyPool] ⚠️ pool is empty and no fallback key found.");
        }
    }

    private async findAvailableKey(): Promise<ApiKey | null> {
        if (!this.initialized) await this.refreshPool();
        if (this.keys.length === 0) return null;

        const availableKeys = this.keys.filter(k => 
            !k.cooldown_until || new Date(k.cooldown_until) <= new Date()
        );

        if (availableKeys.length === 0) return null;

        // NEW: Check real-time quota for each key
        const monitor = QuotaMonitor.getInstance();
        
        for (const key of availableKeys) {
            // Get real-time usage from Google Cloud Monitoring (Only for Google Keys)
            let usage = 0;
            let limit = 60;

            if (key.provider === 'google' && key.id !== KeyPool.VIRTUAL_ID) {
                const quota = await monitor.getGeminiQuotas(key.extraction_model);
                usage = quota.usage;
                limit = quota.limit;
            }
            
            // Add local pending leases (local race protection)
            const localPending = this.pendingLeases.get(key.id) || 0;
            const totalEffectiveUsage = usage + localPending;

            if (totalEffectiveUsage < limit) {
                console.log(`[KeyPool] Monitoring: ${key.key_name} | Usage: ${usage} | Local: ${localPending} | Limit: ${limit}`);
                return key;
            }
        }

        return null;
    }

    async cleanupMyZombies(): Promise<void> {
        // No longer needed with Cloud Monitoring integration, but keeping as a refresh call
        await this.refreshPool();
    }

    async leaseKey(estimatedTokens = 1000): Promise<ApiKey | null> {
        const jitter = Math.random() * 200; 
        await new Promise(r => setTimeout(r, jitter));

        while (true) {
            const key = await this.findAvailableKey();
            
            if (key) {
                // Wait for RPM/TPM local quota
                await LocalRateLimiter.getInstance().waitForQuota(key, estimatedTokens);
                
                this.pendingLeases.set(key.id, (this.pendingLeases.get(key.id) || 0) + 1);
                return { ...key, activeUsageId: `local-${Math.random().toString(36).substring(7)}` };
            }

            console.log(`[KeyPool] ⏳ Cloud Quota Full. Waiting 10s for monitoring window reset...`);
            await new Promise(resolve => {
                setTimeout(resolve, 10000); // Wait 10s between checks if quota is full
                this.waitingQueue.push(() => resolve(null));
            });
        }
    }

    async releaseKey(keyId: string, _usageId?: string): Promise<void> {
        const current = this.pendingLeases.get(keyId) || 0;
        if (current > 0) {
            if (current <= 1) this.pendingLeases.delete(keyId);
            else this.pendingLeases.set(keyId, current - 1);
        }

        // console.log(`[KeyPool] 🔓 Slot released locally. Crossing fingers for Cloud Monitoring refresh.`);
        this.notifyWaiters();
    }

    async markKeyCooldown(keyId: string, errorMsg: string): Promise<void> {
        if (keyId === KeyPool.VIRTUAL_ID) return;
        console.warn(`[KeyPool] ❄️ Marking key ${keyId} for cooldown. Reason: ${errorMsg}`);
        await supabase.rpc('mark_key_cooldown', { key_id: keyId, error_msg: errorMsg });
        await this.refreshPool(); 
    }

    static getInstance(): KeyPool {
        const globalObj = globalThis as unknown as { __keyPool?: KeyPool };
        if (!globalObj.__keyPool) {
            globalObj.__keyPool = new KeyPool();
        }
        return globalObj.__keyPool;
    }
}

const keyPoolManager = KeyPool.getInstance();

/**
 * SECURE INVOCATION LAYER
 * This sends base64 images to Supabase Edge Functions.
 * All forensic prompts and API keys stay on the server.
 */
async function secureAIInvoke(mode: 'routing' | 'extraction', images: Array<{ inlineData: { data: string, mimeType: string } }>, model?: string, hints?: string, memoryContext?: string, batchMap?: string, keyId?: string) {
    // 0. Diagnostic Setup
    const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
    const projectPart = supabaseAnonKey ? supabaseAnonKey.substring(0, 15) : 'MISSING';
    console.log(`[AI] Project Keys: URL=${supabaseUrl} | KeyPrefix=${projectPart}`);

    // 1. Session check
    let session = (await supabase.auth.getSession()).data.session;
    
    // Recursive Retry Logic
    const attemptInvoke = async (retry = true): Promise<any> => {
        try {
            // A. Proactive Session Refresh (Safety first)
            if (!session || (session.expires_at && session.expires_at < (Date.now() / 1000) + 60)) {
                console.warn("[AI] Session missing or about to expire. Refreshing...");
                const { data: refreshData } = await supabase.auth.refreshSession();
                session = refreshData.session;
            }

            // B. Health Check (Transparent Fetch)
            const healthUrl = `${supabaseUrl}/functions/v1/process-invoice?check=true`;
            const headers: Record<string, string> = {
                'apikey': supabaseAnonKey,
                'Content-Type': 'application/json'
            };
            
            if (session?.access_token) {
                headers['Authorization'] = `Bearer ${session.access_token}`;
            }

            const hResponse = await fetch(healthUrl, {
                method: 'POST',
                headers
            });
            console.log(`[AI] Health Check: Status ${hResponse.status}`);
            
            if (hResponse.status === 401 && retry) {
                console.warn("[AI] Health Check failed with 401. Refreshing session...");
                const { data: refreshData } = await supabase.auth.refreshSession();
                session = refreshData.session;
                
                if (!session) {
                    throw new Error("Your session has expired. Please sign out and sign in again.");
                }
                
                return attemptInvoke(false);
            }

            // C. Main Call
            const invokeHeaders: Record<string, string> = {
                'apikey': supabaseAnonKey
            };
            if (session?.access_token) {
                invokeHeaders['Authorization'] = `Bearer ${session.access_token}`;
            }

            /**
             * The 'process-invoice' Edge Function is our fortress.
             * It contains the system prompts and private API keys (OpenRouter/Google).
             * This prevents leaking expensive API keys or prompt engineering to the browser.
             */
            const { data, error } = await supabase.functions.invoke('process-invoice', {
                headers: invokeHeaders,
                body: {
                    mode,
                    payload: [{
                        role: 'user',
                        content: images.map(p => ({
                            type: 'image_url',
                            image_url: { url: `data:${p.inlineData.mimeType};base64,${p.inlineData.data}` }
                        }))
                    }],
                    model,
                    hints,
                    memoryContext,
                    batchMap
                }
            });

            if (error) {
                // Supabase FunctionsClient might wrap errors
                const isAuthError = (error as any).status === 401 || (error as any).status === 403 || 
                                   error.message?.includes('401') || error.message?.includes('Unauthorized');
                
                if (isAuthError && retry) {
                    console.warn("[AI] Main Invoke failed with 401. Final refresh try...");
                    const { data: refreshData } = await supabase.auth.refreshSession();
                    session = refreshData.session;
                    return attemptInvoke(false);
                }
                throw error;
            }
            
            // Sync rate limits
            if (data?.ratelimits && keyId) {
                LocalRateLimiter.getInstance().syncWithHeaders(keyId, data.ratelimits);
            }

            return data;
        } catch (err: any) {
            console.error(`[AI] Fatal Invoke Failure: ${err.message}`, err);
            throw err;
        }
    };

    return await attemptInvoke();
}

const logPhase = (phase: string, emoji: string, message: string, startTime?: number) => {
    const duration = startTime ? ` (${Math.round(performance.now() - startTime)}ms)` : '';
    const logLine = `${emoji} [AI Phase: ${phase}] ${message}${duration}`;
    console.log(logLine);
    logEvent(logLine);
};

// --- SESSION LOGGING ---
let sessionLogs: string[] = [];

const logEvent = (message: string) => {
    const timestamp = new Date().toLocaleTimeString();
    sessionLogs.push(`[${timestamp}] ${message}`);
};


export interface ExtractionResult {
    vendor: string;
    vendor_address: string | null;
    customer_name: string | null;
    customer_address: string | null;
    invoice_number: string;
    date: string | null;
    due_date: string | null;
    payment_terms: string | null;
    subtotal: number | null;
    tax_amount: number;
    discount_amount: number | null;
    shipping_amount: number | null;
    total_amount: number;
    currency: string;
    vat_number: string | null;
    iban: string | null;
    bank_name: string | null;
    swift_bic: string | null;
    po_number: string | null;
    phone: string | null;
    email: string | null;
    website: string | null;
    notes: string | null;
    status: string | null;
    detected_language: string | null;
    confidence_scores: Record<string, number> | null;
    bounding_boxes: Record<string, number[]> | null;
    is_confident_currency: boolean;
    qr_data: string | null;
    tax_breakdown: Array<{
        label: string;
        rate: number;
        amount: number;
    }> | null;
    items: Array<{
        description: string;
        quantity: number;
        unit_price: number | null;
        tax_rate: number | null;
        tax_amount: number | null;
        total: number;
    }>;
    doc_type?: 'INVOICE' | 'PURCHASE_ORDER' | 'DELIVERY_NOTE' | null;
    confidence?: {
        [key: string]: number;
    };
    math_warnings?: string[];
    original_ai_data?: Record<string, unknown>;
    extraction_time_ms?: number;
    input_tokens?: number;
    output_tokens?: number;
    total_tokens?: number;
    scan_cost?: number;
    is_official_cost?: boolean;
    external_id?: string | null;
    source_file_name?: string;
    page_metrics?: Array<{
        page: number;
        size_bytes: number;
        type: string;
        width?: number;
        height?: number;
        timing_ms?: number;
    }>;
    model_name?: string;
    timing_metrics?: {
        pre_scan_ms?: number;
        extraction_ms?: number;
        base64_encoding_ms?: number;
        ai_generation_ms?: number;
        json_parsing_ms?: number;
        validation_ms?: number;
        ai_correction_ms?: number;
        db_logging_ms?: number;
    };
    input_data_raw?: string;
    output_data_raw?: string;
    available_tokens_limit?: number;
    input_size_bytes?: number;
    output_size_bytes?: number;
    file_path?: string;
    learning_snippet?: string; // Phase-specific knowledge captured
    id?: string;
    has_error?: boolean;
    error_message?: string;
}

/**
 * EXTRACTION DATA CONTRACT
 * Defines the structure of data captured from invoices.
 * Includes confidence scores, math warnings, and detailed timing metrics.
 */

/**
 * UNIVERSAL LEARNING ENGINE
 * Implements Gemini Embeddings and Multi-Stage RAG (Retrieval-Augmented Generation)
 */

export async function embedText(text: string, key: string): Promise<number[]> {
    try {
        // Embeddings REQUIRE a Google API Key. OpenRouter keys won't work here.
        const isOR = key.startsWith('sk-or-');
        const effectiveKey = isOR ? DEFAULT_API_KEY : key;
        
        if (!effectiveKey) return []; // Cannot embed without a Google key

        const genAI = new GoogleGenerativeAI(effectiveKey);
        const model = genAI.getGenerativeModel({ model: "gemini-embedding-001" });
        const result = await model.embedContent(text);
        return result.embedding.values;
    } catch (err) {
        console.error("[Learning] Embedding failed:", err);
        return [];
    }
}

export async function logLearningEvent(
    stage: 'routing' | 'extraction' | 'correction' | 'final_save',
    vendorName: string,
    snippet: string | object,
    metadata: Record<string, any> = {},
    apiKey?: string,
    sourceInvoiceId?: string,
    sourceDocumentId?: string
) {
    // PAUSED PER USER REQUEST
    return;
    try {
        const { data: { session } } = await supabase.auth.getSession();
        
        let embedding: number[] | null = null;
        if (apiKey !== undefined && apiKey !== null) {
            const k = apiKey as string;
            const contextText = (typeof snippet === 'string' ? snippet : JSON.stringify(snippet)) as string;
            embedding = await embedText(contextText, k);
        }
    
        const insertPayload = {
            user_id: session?.user?.id,
            stage,
            vendor_name: vendorName,
            context_snippet: (typeof snippet === 'string' ? snippet : JSON.stringify(snippet)) as string,
            source_invoice_id: sourceInvoiceId,
            source_document_id: sourceDocumentId,
            metadata,
            embedding
        };

        const { error } = await supabase.from('inv_learning_events').insert(insertPayload);
        
        if (error !== null && error !== undefined) {
            console.error(`[Learning] Insert Failed: ${(error as any).message} (${(error as any).code || 'UNKNOWN'})`);
        } else {
            console.log(`[Learning] Stage: ${stage} | Learned for: ${vendorName || 'Global'}`);
        }
    } catch (err) {
        console.error("[Learning] Exception during logging:", err);
    }
}

export async function getMultiStageContext(
    stage: 'routing' | 'extraction' | 'correction' | 'final_save',
    vendorName?: string,
    apiKey?: string,
    globalSearch: boolean = true
): Promise<string> {
    // PAUSED PER USER REQUEST
    return "";
    if (!apiKey) return "";
    try {
        // Query text for embedding
        const queryText = `${stage} knowledge for ${vendorName || 'general invoices'}`;
        // Safe to cast if we already checked !apiKey at the top of the function
        const queryEmbedding = await embedText(queryText, apiKey as string);
        if (queryEmbedding.length === 0) return "";

        const { data, error } = await supabase.rpc('match_learning_events', {
            query_embedding: queryEmbedding,
            match_threshold: 0.35, // Relaxed for global knowledge
            match_count: 5,
            filter_stage: stage,
            filter_vendor: globalSearch ? null : vendorName // If globalSearch is true, we ignore vendor filter
        });

        if (error) {
            console.error("[Learning] RPC Error:", error);
            return "";
        }

        if (!data || data.length === 0) return "";

        console.log(`[Learning] Recalled ${data.length} memories for ${stage}.`);
        return data.map((m: any) => `- [${m.vendor_name || 'System'}] ${m.context_snippet}`).join("\n");
    } catch (err) {
        console.error("[Learning] Recall failed:", err);
        return "";
    }
}

interface AIUsageLog {
    model_name: string;
    input_tokens: number;
    output_tokens: number;
    total_tokens: number;
    status: 'success' | 'quota_exceeded' | 'error' | 'math_correction';
    error_details?: string;
    // New Forensics
    input_size_bytes?: number;
    output_size_bytes?: number;
    available_tokens_limit?: number;
    total_cost?: number;
    is_official_cost?: boolean;
    external_id?: string;
    page_metrics?: Array<{
        page: number;
        size_bytes: number;
        type: string;
        width?: number;
        height?: number;
        timing_ms?: number;
    }>;
}

const MODEL_TOKEN_LIMITS: Record<string, number> = {
    "gemini-2.5-flash": 1048576,
    "gemini-2.5-pro": 2097152,
    "gemini-2.0-flash": 1048576,
    "gemini-2.0-flash-lite": 1048576,
    "gemini-3.1-pro-preview": 2097152,
    "gemini-3-pro-preview": 1048576,
    "gemini-3.1-flash-lite-preview": 1048576,
    "gemini-3-flash-preview": 1048576,
    "gemini-flash-latest": 1048576,
    "gemini-pro-latest": 1048576,
    "google/gemini-3-flash": 1048576,
    "google/gemini-2.0-flash-001": 1048576,
    "default": 1048576
};

/**
 * AI PRICING CONFIGURATION (OpenRouter / Google)
 * Rates are per 1M tokens in USD
 */
const PRICING_CONFIG: Record<string, { input: number; output: number }> = {
    "google/gemini-3-flash": { input: 0.10, output: 0.30 },         // Estimates
    "google/gemini-2.0-flash-001": { input: 0.10, output: 0.30 }, // Official pricing for Flash 2.0
    "gemini-2.5-flash": { input: 0.10, output: 0.30 },
    "gemini-2.0-flash": { input: 0.10, output: 0.30 },
    "gemini-2.0-flash-lite": { input: 0.075, output: 0.225 },
    "gemini-2.0-pro-exp-02-05": { input: 1.25, output: 3.75 },
    "default": { input: 0.10, output: 0.30 }
};

function calculateCost(model: string, inputTokens: number, outputTokens: number): number {
    const rates = PRICING_CONFIG[model] || PRICING_CONFIG["default"];
    const inputCost = (inputTokens / 1_000_000) * rates.input;
    const outputCost = (outputTokens / 1_000_000) * rates.output;
    return Number((inputCost + outputCost).toFixed(8));
}

async function logAIUsage(log: AIUsageLog) {
    try {
        const { data: { session } } = await supabase.auth.getSession();
        if (!session) return;

        await supabase.from('inv_ai_usage').insert({
            user_id: session.user.id,
            model_name: log.model_name,
            input_tokens: log.input_tokens,
            output_tokens: log.output_tokens,
            total_tokens: log.total_tokens,
            status: log.status,
            error_details: log.error_details,
            input_size_bytes: log.input_size_bytes,
            output_size_bytes: log.output_size_bytes,
            available_tokens_limit: log.available_tokens_limit || MODEL_TOKEN_LIMITS[log.model_name] || MODEL_TOKEN_LIMITS["default"],
            total_cost: log.total_cost || calculateCost(log.model_name, log.input_tokens, log.output_tokens),
            is_official_cost: log.is_official_cost || false,
            external_id: log.external_id,
            page_metrics: log.page_metrics || []
        });
    } catch (err) {
        console.error("Failed to log AI usage:", err);
    }
}

/**
 * SURGICAL JSON REPAIR
 * AI models often wrap JSON in markdown or include "hallucinated" control characters.
 * This function handles:
 * 1. Markdown code block stripping
 * 2. Balancing of broken braces/brackets
 * 3. Escaping invalid control characters inside strings
 * 4. Fixing missing commas between fields
 */
function repairJson(str: string): string {
    if (!str) return "[]";
    
    // 0. Locate the actual JSON start (find first [ or {)
    let cleaned = str.trim();
    const firstOpenBracket = cleaned.indexOf('[');
    const firstOpenBrace = cleaned.indexOf('{');
    
    let startIndex = -1;
    if (firstOpenBracket !== -1 && (firstOpenBrace === -1 || firstOpenBracket < firstOpenBrace)) {
        startIndex = firstOpenBracket;
    } else if (firstOpenBrace !== -1) {
        startIndex = firstOpenBrace;
    }
    
    if (startIndex !== -1) {
        cleaned = cleaned.substring(startIndex);
    }

    // 1. Remove markdown code blocks
    cleaned = cleaned.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
    
    // 2. Surgical Repair Loop (Context-Aware)
    // Fixes "Bad control character" only inside strings, and balances braces
    let result = "";
    const stack: string[] = [];
    let inString = false;
    let escaped = false;

    for (let i = 0; i < cleaned.length; i++) {
        const char = cleaned[i];
        
        if (inString) {
            if (char === '"' && !escaped) {
                inString = false;
                result += char;
            } else if (char === '\\' && !escaped) {
                escaped = true;
                result += char;
            } else {
                // If we hit a raw control character INSIDE a string, escape it
                const code = char.charCodeAt(0);
                if (code < 0x20 || code === 0x7F) {
                    switch (char) {
                        case '\n': result += '\\n'; break;
                        case '\r': result += '\\r'; break;
                        case '\t': result += '\\t'; break;
                        case '\b': result += '\\b'; break;
                        case '\f': result += '\\f'; break;
                        default: 
                            result += '\\u' + code.toString(16).padStart(4, '0');
                    }
                } else {
                    result += char;
                }
                escaped = false;
            }
        } else {
            if (char === '"') {
                inString = true;
                result += char;
            } else if (char === '{' || char === '[') {
                stack.push(char);
                result += char;
            } else if (char === '}') {
                if (stack[stack.length - 1] === '{') stack.pop();
                result += char;
            } else if (char === ']') {
                if (stack[stack.length - 1] === '[') stack.pop();
                result += char;
            } else {
                // Outside string, whitespace (SP, LF, CR, TAB) are structural
                result += char;
            }
        }
    }

    // Close unterminated string
    if (inString) result += '"';
    
    // Close remaining objects/arrays in reverse order
    while (stack.length > 0) {
        const open = stack.pop();
        if (open === '{') result += '}';
        if (open === '[') result += ']';
    }

    // Final safety: ensure it's wrapped in an array
    let final = result.trim();
    
    // Fix common missing commas: "prop": "val" "prop2" -> "prop": "val", "prop2"
    final = final.replace(/"\s*"/g, '", "');
    
    if (!final.startsWith('[')) {
        if (final.startsWith('{')) {
            final = '[' + final + ']';
        } else {
            final = '[' + final;
        }
    }
    if (!final.endsWith(']')) final += ']';

    return final;
}

/**
 * Robustly cleans a numeric string (removes commas, currency symbols, spaces).
 * Returns 0 instead of NaN to prevent UI breakage.
 */
function cleanNumber(val: any): number {
    if (val === null || val === undefined || val === '') return 0;
    if (typeof val === 'number') return isNaN(val) ? 0 : val;
    
    // Remove everything except digits, decimal points, and minus signs
    const cleaned = String(val)
        .replace(/[^\d.-]/g, '')
        .trim();
    
    const num = parseFloat(cleaned);
    return isNaN(num) ? 0 : num;
}

/**
 * Normalizes various date formats (DD/MM/YYYY, MM-DD-YYYY, etc.) to browser-standard YYYY-MM-DD.
 */
function normalizeDate(val: any): string | null {
    if (!val || typeof val !== 'string') return null;
    
    const trimmed = val.trim();
    if (!trimmed) return null;

    // Already in YYYY-MM-DD?
    if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return trimmed;

    // Extract just the date part (DD-MM-YYYY or DD/MM/YYYY) anywhere at the start
    const dmyMatch = trimmed.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})/);
    if (dmyMatch) {
        return `${dmyMatch[3]}-${dmyMatch[2].padStart(2, '0')}-${dmyMatch[1].padStart(2, '0')}`;
    }

    // Handle YYYY-MM-DD or YYYY/MM/DD at the start
    const ymdMatch = trimmed.match(/^(\d{4})[/-](\d{1,2})[/-](\d{1,2})/);
    if (ymdMatch) {
        return `${ymdMatch[1]}-${ymdMatch[2].padStart(2, '0')}-${ymdMatch[3].padStart(2, '0')}`;
    }

    // Fallback to JS Date parsing
    const d = new Date(trimmed);
    if (!isNaN(d.getTime())) {
        return d.toISOString().split('T')[0];
    }

    return trimmed; // Return as-is if all else fails, or could return null
}

/**
 * RESULT NORMALIZATION
 * Maps the raw, often flat or inconsistent JSON from different AI models
 * into the structured ExtractionResult interface. 
 * This ensures the rest of the app (UI/DB) always receives predictable data.
 */
function normalizeResult(data: Record<string, any>): ExtractionResult {
    const v = data.vendor || {};
    const m = data.meta || {};
    const f = data.financials || {};
    const c = data.customer || {};
    const b = data.bank_info || {};
    const a = data.audit || {};

    return {
        vendor: v.name || data.vendor_name || data.vendorName || null,
        vendor_address: v.address || data.vendor_address || data.vendorAddress || null,
        customer_name: c.name || data.customer_name || data.customerName || null,
        customer_address: c.address || data.customer_address || data.customerAddress || null,
        invoice_number: m.invoice_number || data.invoice_number || data.invoiceNumber || null,
        date: normalizeDate(m.date || data.date),
        due_date: normalizeDate(m.due_date || data.due_date || data.dueDate) || null,
        payment_terms: m.payment_terms || data.payment_terms || data.paymentTerms || null,
        subtotal: cleanNumber(f.subtotal || data.subtotal || data.subTotal) || 0,
        tax_amount: cleanNumber(f.total_tax || data.tax_amount || data.taxAmount) || 0,
        discount_amount: cleanNumber(f.total_discount || data.discount_amount || data.discountAmount) || 0,
        shipping_amount: cleanNumber(f.shipping || data.shipping_amount || data.shippingAmount) || 0,
        total_amount: cleanNumber(f.grand_total || data.total_amount || data.grandTotal || data.totalAmount) || 0,
        currency: m.currency || data.currency || 'JOD',
        status: m.status || data.status || 'scanned',
        vat_number: v.tax_id || data.vat_number || data.vatNumber || null,
        iban: b.iban || data.iban || null,
        bank_name: b.bank_name || data.bank_name || data.bankName || null,
        swift_bic: b.swift_bic || data.swift_bic || data.swiftBic || null,
        po_number: m.po_number || data.po_number || data.poNumber || null,
        phone: v.phone || data.phone || null,
        email: v.email || data.email || null,
        website: v.website || data.website || null,
        notes: data.notes || null,
        qr_data: data.qr_data || data.qrData || null,
        tax_breakdown: f.tax_breakdown || data.tax_breakdown || data.taxBreakdown || null,
        detected_language: m.language || data.detected_language || data.language || null,
        confidence_scores: {
            global: m.confidence_score || data.confidence_score || 0,
            vendor: v.confidence || 0,
            customer: c.confidence || 0,
            financials: f.confidence || 0,
            meta: m.confidence || {}
        },
        bounding_boxes: {
            vendor: v.bbox || null,
            customer: c.bbox || null,
            financials: f.bbox || null
        },
        is_confident_currency: !!m.currency,
        items: (Array.isArray(data.line_items || data.items || data.lineItems) ? (data.line_items || data.items || data.lineItems) : []).map((item: Record<string, any>) => ({
            description: item.description || null,
            quantity: typeof item.quantity === 'number' ? item.quantity : cleanNumber(item.quantity || item.qty),
            unit_price: typeof item.unit_price === 'number' ? item.unit_price : cleanNumber(item.unit_price || item.unitPrice),
            tax_rate: typeof item.tax_rate === 'number' ? item.tax_rate : cleanNumber(item.tax_rate || item.taxRate),
            tax_amount: typeof item.tax_amount === 'number' ? item.tax_amount : cleanNumber(item.tax_amount || item.taxAmount),
            total: typeof item.total === 'number' ? item.total : cleanNumber(item.total || item.rowTotal || item.amount)
        })),
        confidence: a.confidence || data.confidence || {},
        math_warnings: a.warnings || data.math_warnings || data.mathWarnings || [],
        original_ai_data: data
    };
}

function generateSkeletonResult(fileName: string, errorMessage?: string): ExtractionResult {
    return {
        vendor: 'N/A',
        vendor_address: 'N/A',
        customer_name: 'N/A',
        customer_address: 'N/A',
        invoice_number: 'N/A',
        date: new Date().toISOString().split('T')[0],
        due_date: null,
        payment_terms: null,
        subtotal: 0,
        tax_amount: 0,
        discount_amount: 0,
        shipping_amount: 0,
        total_amount: 0,
        currency: 'JOD',
        vat_number: 'N/A',
        iban: 'N/A',
        bank_name: 'N/A',
        swift_bic: 'N/A',
        po_number: 'N/A',
        phone: 'N/A',
        email: 'N/A',
        website: 'N/A',
        notes: null,
        status: 'scanning_error',
        detected_language: null,
        confidence_scores: null,
        bounding_boxes: null,
        is_confident_currency: false,
        qr_data: null,
        tax_breakdown: null,
        items: [],
        has_error: true,
        error_message: errorMessage || 'AI extraction failed',
        source_file_name: fileName
    };
}

// validateMath removed

interface PageRef {
    file: File;
    originalFile: File;
    pageNumber: number;
    isPdf: boolean;
}

function estimateTokenUsage(images: PageRef[], isPreScan: boolean): number {
    // Estimations based on Google's model info
    // Image: ~258 tokens (standard)
    // Characters: ~4 characters per token
    const IMAGE_TOKENS = 258;
    const PROMPT_TOKENS = isPreScan ? 1000 : 2500;
    
    // In our case, each invoice extraction returns ~1.5KB of JSON text = ~1500 chars = ~400 tokens
    const OUTPUT_PER_DOC = isPreScan ? 150 : 800; 
    
    const input = (images.length * IMAGE_TOKENS) + PROMPT_TOKENS;
    const output = images.length * OUTPUT_PER_DOC;
    
    return input + output;
}

function deduplicateByInvoiceNumber(results: ExtractionResult[]): ExtractionResult[] {
    const map = new Map<string, ExtractionResult>();
    for (const inv of results) {
        // IMPROVED: Use Vendor + Invoice Number as key to prevent merging different vendors' invoices
        const invoiceNum = (inv.invoice_number || '').trim().toLowerCase();
        const vendor = (inv.vendor || '').trim().toLowerCase();
        
        const key = (invoiceNum !== '' || vendor !== '') 
            ? `${vendor}|${invoiceNum}` 
            : `__no_num_${Math.random()}`;
        
        if (map.has(key) && invoiceNum !== '') {
            const existing = map.get(key)!;
            const merged: ExtractionResult = {
                ...existing,
                items: [
                    ...existing.items,
                    ...inv.items.filter(newItem =>
                        !existing.items.some(e => e.description === newItem.description && e.total === newItem.total)
                    )
                ],
                total_amount: Math.max(existing.total_amount || 0, inv.total_amount || 0),
                subtotal: Math.max(existing.subtotal || 0, inv.subtotal || 0),
                tax_amount: Math.max(existing.tax_amount || 0, inv.tax_amount || 0),
                vendor_address: existing.vendor_address || inv.vendor_address,
                customer_name: existing.customer_name || inv.customer_name,
                notes: existing.notes || inv.notes,
                iban: existing.iban || inv.iban,
                due_date: existing.due_date || inv.due_date,
            };
            map.set(key, merged);
        } else {
            map.set(key, inv);
        }
    }
    return Array.from(map.values());
}

/**
 * MAIN EXTRACTION ENGINE (Two-Pass Strategy)
 * ----------------------------------------
 * 1. PHASE 1 & 2 (Routing): Fast, low-res scan of all pages to identify document boundaries.
 * 2. PHASE 3 (Grouping): Logical organization of pages into separate invoices.
 * 3. PHASE 4 (Deep Scan): High-res rendering and detailed extraction of each group.
 * 4. PHASE 5 (Assembly): Final deduplication and result merging.
 */
export async function extractInvoiceDataWithPreScan(
    files: File[], 
    hints?: string,
    onProgress?: (results: ExtractionResult[], fileIndex: number, progress: number, payloadSize?: number, isFinal?: boolean, logs?: string[]) => void
): Promise<ExtractionResult[]> {
    sessionLogs = []; // Reset for new session
    const tOverallStart = performance.now();
    logPhase('Initialization', '🚀', `Processing ${files.length} file(s)...`);

    // --- PHASE 1: SPLIT PDFS (LOW RES FOR ROUTING) ---
    if (onProgress) onProgress([], 0, 5);
    
    const allPageRefs: PageRef[] = [];
    let totalPayloadSize = 0;

    for (const file of files) {
        if (file.type === 'application/pdf') {
            logNarrative(`[AI Two-Pass] Splitting PDF for Routing: ${file.name}`, onProgress, 5, totalPayloadSize);
            const pages = await splitPdfIntoImages(file, 0.75, 0.6);
            pages.forEach((p, idx) => {
                totalPayloadSize += p.size;
                allPageRefs.push({
                    file: p,
                    originalFile: file,
                    pageNumber: idx + 1,
                    isPdf: true
                });
            });
        } else {
            console.log(`[AI Two-Pass] Optimizing Image: ${file.name}`);
            const optimized = await shrinkImage(file);
            totalPayloadSize += optimized.size;
            allPageRefs.push({
                file: optimized,
                originalFile: file,
                pageNumber: 1,
                isPdf: false
            });
        }
    }
    if (onProgress) onProgress([], 0, 15, totalPayloadSize);

    logPhase('Grouping Prep', '📄', `Prepared ${allPageRefs.length} page(s) for pre-scan`, tOverallStart);

    // --- PHASE 2: CONCURRENT PRE-SCAN (BATCHED) ---
    /**
     * Routing: We send low-res images to determine: 
     * - Is this a new document or a continuation?
     * - What is the vendor name and invoice number?
     */
    if (onProgress) onProgress([], 0, 20, totalPayloadSize);
    logPhase('Routing', '🔍', `Starting batched pre-scan on ${allPageRefs.length} pages...`);
    
    const PRE_SCAN_BATCH_SIZE = 10;
    const preScanBatches: PageRef[][] = [];
    for (let i = 0; i < allPageRefs.length; i += PRE_SCAN_BATCH_SIZE) {
        preScanBatches.push(allPageRefs.slice(i, i + PRE_SCAN_BATCH_SIZE));
    }

    const tPreScanStart = performance.now();
    const preScanResults: { ref: PageRef; invoiceNumber: string; vendorName: string; isNewInvoice: boolean; docType: string; reasoning: string }[] = [];

    // Process pre-scan batches in PARALLEL (Max speed)
    const PRE_SCAN_CONCURRENCY = 5;
    for (let i = 0; i < preScanBatches.length; i += PRE_SCAN_CONCURRENCY) {
        const chunk = preScanBatches.slice(i, i + PRE_SCAN_CONCURRENCY);
        const chunkPromises = chunk.map(async (batch: PageRef[], subIdx: number) => {
            const batchIdx = i + subIdx;
            logNarrative(`[AI Pre-scan] 📦 Processing Batch #${batchIdx + 1} (${batch.length} pages)...`, onProgress, 20 + (batchIdx * 2), totalPayloadSize);
            
            let keyRecord: ApiKey | null = null;
            try {
                keyRecord = await keyPoolManager.leaseKey();
                if (!keyRecord) throw new Error("No API keys available in pool.");

                const parts = await Promise.all(batch.map(ref => fileToGenerativePart(ref.file)));
                const safeParts = parts.map(p => ({
                    inlineData: {
                        data: p.inlineData?.data || "",
                        mimeType: p.inlineData?.mimeType || "image/jpeg"
                    }
                }));

                const result = await secureAIInvoke('routing', safeParts, keyRecord.pre_scan_model, undefined, undefined, undefined, keyRecord.id);
                
                if (!result || !result.choices || !result.choices[0]) {
                    throw new Error(`AI Provider Error: No choices returned.`);
                }

                const text = result.choices[0].message.content;
                
                await logAIUsage({
                    model_name: keyRecord.pre_scan_model,
                    input_tokens: result.usage?.prompt_tokens || 0,
                    output_tokens: result.usage?.completion_tokens || 0,
                    total_tokens: result.usage?.total_tokens || 0,
                    status: 'success',
                    input_size_bytes: JSON.stringify(parts).length,
                    output_size_bytes: text.length,
                    external_id: result.id
                });
                
                let parsedBatch: any[] = [];
                try {
                    parsedBatch = JSON.parse(repairJson(text));
                    if (!Array.isArray(parsedBatch)) parsedBatch = [parsedBatch];
                } catch {
                    parsedBatch = batch.map(() => ({ invoice_number: "UNKNOWN", vendor_name: "UNKNOWN", is_new_document: true, reasoning: "JSON Parse Error" }));
                }

                return batch.map((ref, j) => {
                    const p = parsedBatch[j] || { invoice_number: "UNKNOWN", vendor_name: "UNKNOWN", reasoning: "Missing AI response" };
                    return {
                        ref,
                        invoiceNumber: p.invoice_number || "UNKNOWN",
                        vendorName: p.vendor_name || "UNKNOWN",
                        isNewInvoice: p.is_new_document ?? true,
                        docType: p.doc_type || "INVOICE",
                        reasoning: p.reasoning || "No reason provided"
                    };
                });
            } finally {
                if (keyRecord) await keyPoolManager.releaseKey(keyRecord.id, keyRecord.activeUsageId);
            }
        });

        const settledResults = await Promise.allSettled(chunkPromises);
        let failureCount = 0;
        settledResults.forEach((res) => {
            if (res.status === 'fulfilled') {
                preScanResults.push(...(res.value as any[]));
            } else {
                console.error("[AI Pre-scan] Batch failed:", res.reason);
                failureCount++;
            }
        });

        const progressPerChunk = 30 / Math.ceil(preScanBatches.length / PRE_SCAN_CONCURRENCY);
        const currentProgress = 20 + ((i / PRE_SCAN_CONCURRENCY + 1) * progressPerChunk);
        if (onProgress) onProgress([], i, Math.min(50, currentProgress), totalPayloadSize, false);

        if (failureCount === chunk.length && chunk.length > 0) {
            throw new Error("AI Routing failed for this batch. Please check your internet connection and API quotas.");
        }
    }

    const tPreScanEnd = performance.now();
    const preScanTotalTimeMs = Math.round(tPreScanEnd - tPreScanStart);
    logNarrative(`[AI Two-Pass] Batched pre-scan completed in ${preScanTotalTimeMs}ms`, onProgress, 40, totalPayloadSize);

    // CAPTURE METRICS FOR PRE-SCAN
    const preScanMetrics = allPageRefs.map((ref, _idx) => ({
        page: ref.pageNumber,
        size_bytes: ref.file.size,
        type: ref.file.type,
        width: 1024,        height: 1024,
        timing_ms: Math.round(preScanTotalTimeMs / allPageRefs.length)
    }));

    // CAPTURE METRICS FOR PRE-SCAN
    logEvent("\n📊 [AI Usage] Pre-Scan Metrics Breakdown:");
    const preScanTableNarrative = preScanMetrics.map(m => `Page ${m.page}: ${(m.size_bytes / 1024).toFixed(2)}KB (${m.type})`).join('\n');
    logEvent(preScanTableNarrative);

    console.log("\n📊 [AI Usage] Pre-Scan Metrics Breakdown:");
    console.table(preScanMetrics.map(m => ({
        "Page": m.page,
        "Size (KB)": (m.size_bytes / 1024).toFixed(2),
        "Mime": m.type,
        "Est. Max Dim": "1024px"
    })));

    if (onProgress) onProgress([], 0, 40, totalPayloadSize);
    logPhase('Routing', '✅', `Pre-scan completed`, tPreScanStart);

    // --- PHASE 3: ORGANIZE GROUPS ---
    logPhase('Grouping', '📦', 'Organizing pages into logical documents...');
    const groupedRefs: Record<string, PageRef[]> = {};
    
    let groupIdxCount = 0;
    let currentGroupId = "GLOBAL_UNKNOWN_0";
    let lastSeenInvoiceNumber = "UNKNOWN";
    let lastSeenVendor = "UNKNOWN";

    for (let i = 0; i < preScanResults.length; i++) {
        const res = preScanResults[i];
        const isNewInNum = res.invoiceNumber !== "UNKNOWN" && res.invoiceNumber !== lastSeenInvoiceNumber;
        const isNewVendor = res.vendorName !== "UNKNOWN" && res.vendorName !== lastSeenVendor;
        
        // REFINED TRIGGER: 
        // 1. Trust AI's "is_new_document" flag most
        // 2. But also split if identity (Num/Vendor) changes even if AI missed it
        // 3. Keep as continuation if AI says so, OR if current info is UNKNOWN but previous was known
        const triggerNew = i === 0 || 
                           res.isNewInvoice || 
                           isNewInNum || 
                           isNewVendor ||
                           (res.invoiceNumber === "UNKNOWN" && lastSeenInvoiceNumber === "UNKNOWN" && i > 0); 
        
        if (triggerNew) {
            groupIdxCount++;
            // Use a unique ID for every group to prevent accidental merging before deep scan
            currentGroupId = `GRP_${groupIdxCount}_${res.invoiceNumber !== "UNKNOWN" ? res.invoiceNumber : 'UNNAMED'}`;
            
            logNarrative(`[AI Grouping] 📂 Page ${i+1}: New Group "${currentGroupId}" | Reason: ${res.reasoning}`, onProgress, 45, totalPayloadSize);
            
            if (res.invoiceNumber !== "UNKNOWN") lastSeenInvoiceNumber = res.invoiceNumber;
            if (res.vendorName !== "UNKNOWN") lastSeenVendor = res.vendorName;
        }
        
        if (!groupedRefs[currentGroupId]) groupedRefs[currentGroupId] = [];
        groupedRefs[currentGroupId].push(res.ref);
    }

    const uniqueInvoices = Object.keys(groupedRefs);
    logPhase('Grouping', '📊', `Identified ${uniqueInvoices.length} logical documents: ${uniqueInvoices.join(', ')}`);
    
    if (uniqueInvoices.length === 0 && allPageRefs.length > 0) {
        throw new Error("AI Routing failed: No logical documents identified. Please ensure the images are clear and contain invoice data.");
    }

    if (onProgress) onProgress([], 0, 50, totalPayloadSize);

    // --- PHASE 4: GROUP-BASED EXTRACTION (AI-MERGED) ---
    /**
     * Deep Scan: Now that we know which pages belong together,
     * we render them in HIGH-RES and perform the final data extraction.
     */
    logPhase('Extraction', '🔬', `Starting group-based deep scan for ${uniqueInvoices.length} invoices (${allPageRefs.length} pages total)...`);
    
    // Map to store AI-merged results by groupId
    const groupResultsMap: Record<string, ExtractionResult> = {};
    const lastErrorDetails: string[] = [];

    // DYNAMIC BATCHING based on estimated output tokens
    // Gemini 1.5 Flash has 8192 output tokens limit.
    // Each invoice JSON is ~800 tokens. 8192 / 800 ~= 10, but we use a safer limit of 6 per batch
    // to allow for long line items and extra notes.
    const extractionBatches: Array<{ 
        refs: PageRef[]; 
        groupIds: string[];
    }> = [];

    let currentBatchRefs: PageRef[] = [];
    let currentBatchGroupIds: string[] = [];
    let currentBatchEstimatedOutput = 0;
    const MAX_OUTPUT_TOKENS_BATCH = 7000; // Safety margin for 8192 limit
    const ESTIMATED_TOKENS_PER_DOC = 1000; // Pessimistic estimate for output

    uniqueInvoices.forEach(groupId => {
        const groupRefs = groupedRefs[groupId];
        
        // Check if adding this group exceeds our batch output token limit
        if (currentBatchRefs.length > 0 && (currentBatchEstimatedOutput + ESTIMATED_TOKENS_PER_DOC) > MAX_OUTPUT_TOKENS_BATCH) {
            extractionBatches.push({ refs: currentBatchRefs, groupIds: currentBatchGroupIds });
            currentBatchRefs = [];
            currentBatchGroupIds = [];
            currentBatchEstimatedOutput = 0;
        }

        currentBatchRefs.push(...groupRefs);
        currentBatchGroupIds.push(groupId);
        currentBatchEstimatedOutput += ESTIMATED_TOKENS_PER_DOC;

        // Still respect a hard 10-page limit for safety if needed, though tokens is primary trigger
        if (currentBatchRefs.length >= 10) {
            extractionBatches.push({ refs: currentBatchRefs, groupIds: currentBatchGroupIds });
            currentBatchRefs = [];
            currentBatchGroupIds = [];
            currentBatchEstimatedOutput = 0;
        }
    });

    if (currentBatchRefs.length > 0) {
        extractionBatches.push({ refs: currentBatchRefs, groupIds: currentBatchGroupIds });
    }

    logNarrative(`[AI Two-Pass] Dynamic Batching: Packed ${uniqueInvoices.length} groups into ${extractionBatches.length} extraction batches.`, onProgress, 50, totalPayloadSize);

    const DEEP_SCAN_CONCURRENCY = 5;
    for (let i = 0; i < extractionBatches.length; i += DEEP_SCAN_CONCURRENCY) {
        const chunk = extractionBatches.slice(i, i + DEEP_SCAN_CONCURRENCY);
        const chunkPromises = chunk.map(async (batch, subIdx) => {
            const batchIdx = i + subIdx;
            const baseProgress = 50 + ((batchIdx / extractionBatches.length) * 45);
            
            logNarrative(`[AI Deep Scan] 🧪 Extraction Batch #${batchIdx + 1}: Groups [${batch.groupIds.join(', ')}] (${batch.refs.length} pages total)...`, onProgress, baseProgress, totalPayloadSize);
            
            let keyRecord: ApiKey | null = null;
            const startTime = performance.now();
            let extractionModel = 'google/gemini-2.0-flash'; // Fallback

            try {
                if (onProgress) onProgress([], batchIdx, baseProgress, totalPayloadSize);
                
                const estimatedTokens = estimateTokenUsage(batch.refs, false);
                keyRecord = await keyPoolManager.leaseKey(estimatedTokens);
                if (!keyRecord) throw new Error("No API keys available.");

                extractionModel = keyRecord.extraction_model;
                logNarrative(`[AI Provider] Invoking ${extractionModel} for Batch #${batchIdx + 1} (Estimated tokens: ${estimatedTokens})...`, onProgress, baseProgress, totalPayloadSize);
                
                const highResMetrics: any[] = [];
                const highResParts = await Promise.all(batch.refs.map(async (ref, pIdx) => {
                    // Micro-progress for rendering
                    const renderProgress = baseProgress + ((pIdx / batch.refs.length) * 5);
                    if (onProgress) onProgress([], batchIdx, renderProgress, totalPayloadSize);

                    if (ref.isPdf) {
                        logNarrative(`[AI Render] Rendering Page ${ref.pageNumber} for high-res extraction...`, onProgress, renderProgress, totalPayloadSize);
                        const tRenderStart = performance.now();
                        const highResFile = await renderPageToImage(ref.originalFile, ref.pageNumber, 1.0, 1.0);
                        const tRenderEnd = performance.now();
                        
                        const fileToUse = highResFile || ref.file;
                        highResMetrics.push({
                            page: ref.pageNumber,
                            size_bytes: fileToUse.size,
                            type: fileToUse.type,
                            timing_ms: Math.round(tRenderEnd - tRenderStart)
                        });
                        return fileToGenerativePart(fileToUse);
                    }
                    highResMetrics.push({
                        page: ref.pageNumber,
                        size_bytes: ref.file.size,
                        type: ref.file.type
                    });
                    return fileToGenerativePart(ref.file);
                }));

                const safeHighResParts = highResParts.map(p => ({
                    inlineData: {
                        data: p.inlineData?.data || "",
                        mimeType: p.inlineData?.mimeType || "image/jpeg"
                    }
                }));

                const result = await secureAIInvoke('extraction', safeHighResParts, extractionModel, hints, undefined, undefined, keyRecord.id);
                
                if (!result || !result.choices || !result.choices[0]) {
                    throw new Error(`AI Provider Error: No choices returned.`);
                }

                const text = result.choices[0].message.content;
                
                await logAIUsage({
                    model_name: extractionModel,
                    input_tokens: result.usage?.prompt_tokens || 0,
                    output_tokens: result.usage?.completion_tokens || 0,
                    total_tokens: result.usage?.total_tokens || 0,
                    status: 'success',
                    input_size_bytes: JSON.stringify(safeHighResParts).length,
                    output_size_bytes: text.length,
                    external_id: result.id,
                    total_cost: result.total_cost,
                    is_official_cost: true
                });

                const parsedData = JSON.parse(repairJson(text));
                const results = (Array.isArray(parsedData) ? parsedData : [parsedData]);
                
                const batchResults: ExtractionResult[] = [];
                // Map results back to the GroupIds in this batch
                let metricOffset = 0;
                batch.groupIds.forEach((groupId, localIdx) => {
                    const groupRefsCount = groupedRefs[groupId].length;
                    const groupMetrics = highResMetrics.slice(metricOffset, metricOffset + groupRefsCount);
                    metricOffset += groupRefsCount;

                    const groupData = results[localIdx] || {};
                    const resultData: ExtractionResult = {
                        ...normalizeResult(groupData),
                        extraction_time_ms: Math.round(performance.now() - startTime),
                        input_tokens: Math.round((result.usage?.prompt_tokens || 0) / batch.groupIds.length),
                        output_tokens: Math.round((result.usage?.completion_tokens || 0) / batch.groupIds.length),
                        total_tokens: Math.round((result.usage?.total_tokens || 0) / batch.groupIds.length),
                        model_name: extractionModel,
                        scan_cost: (result.total_cost || calculateCost(extractionModel, result.usage?.prompt_tokens || 0, result.usage?.completion_tokens || 0)) / batch.groupIds.length,
                        external_id: result.id,
                        is_official_cost: !!result.total_cost,
                        // Attach global pre-scan timing to the metrics
                        timing_metrics: {
                            pre_scan_ms: preScanTotalTimeMs,
                            extraction_ms: Math.round(performance.now() - startTime)
                        },
                        // Attach page metrics only for pages belonging to THIS group
                        page_metrics: groupMetrics,
                        source_file_name: groupedRefs[groupId][0].originalFile.name
                    };
                    groupResultsMap[groupId] = resultData;
                    batchResults.push(resultData);
                });
                
                logNarrative(`[AI DB] Starting incremental save for ${batchResults.length} items from batch #${batchIdx + 1}...`, onProgress, baseProgress + (45 / extractionBatches.length), totalPayloadSize);
                if (onProgress) onProgress(batchResults, batchIdx, baseProgress + (45 / extractionBatches.length), totalPayloadSize, false);
            } catch (batchErr: any) {
                console.error(`[AI Deep Scan] Batch ${batchIdx} failed:`, batchErr);
                const batchResults: ExtractionResult[] = [];
                batch.groupIds.forEach(groupId => {
                    const fileName = groupedRefs[groupId][0].originalFile.name;
                    const skeleton = generateSkeletonResult(fileName, batchErr.message);
                    skeleton.extraction_time_ms = Math.round(performance.now() - startTime);
                    skeleton.model_name = extractionModel;
                    
                    groupResultsMap[groupId] = skeleton;
                    batchResults.push(skeleton);
                });
                if (onProgress) onProgress(batchResults, batchIdx, baseProgress + (50 / extractionBatches.length), totalPayloadSize);
            } finally {
                if (keyRecord) await keyPoolManager.releaseKey(keyRecord.id, keyRecord.activeUsageId);
            }
        });

        const settledResults = await Promise.allSettled(chunkPromises);
        settledResults.forEach((res, idx) => {
            if (res.status === 'rejected') {
                console.error(`Extraction Batch ${i + idx + 1} failed:`, res.reason);
                lastErrorDetails.push(`Batch ${i + idx + 1} failed: ${res.reason}`);
            }
        });

        if (i + DEEP_SCAN_CONCURRENCY < extractionBatches.length) {
            console.log(`[AI Deep Scan] ⏳ RPM Throttling: Waiting 2s before next chunk...`);
            await new Promise(r => setTimeout(r, 2000));
        }
    }

    // --- PHASE 5: ASSEMBLY (AI-MERGED) ---
    logPhase('Assembly', '🧵', `Assembling ${uniqueInvoices.length} logical documents...`);
    
    const finalResults: ExtractionResult[] = [];

    uniqueInvoices.forEach(groupId => {
        const result = groupResultsMap[groupId];
        if (result) {
            const pagesInGroup = groupedRefs[groupId];
            result.source_file_name = pagesInGroup[0].originalFile.name;
            finalResults.push(result);
        }
    });

    if (onProgress) onProgress(finalResults, allPageRefs.length, 100, totalPayloadSize, true, sessionLogs);
    logPhase('Total', '🏁', `Extraction complete for ${files.length} file(s)`, tOverallStart);

    return deduplicateByInvoiceNumber(finalResults);
}

// Helper to wrap console.log and capture it
const logNarrative = (
    msg: string, 
    onProgress?: (results: any[], index: number, progress: number, size?: number, isFinal?: boolean, logs?: string[]) => void, 
    progress?: number, 
    size?: number
) => {
    console.log(msg);
    logEvent(msg);
    if (onProgress && progress !== undefined) {
        onProgress([], 0, progress, size, false, sessionLogs);
    }
};


async function fileToGenerativePart(file: File): Promise<Part> {
    const base64Promise = new Promise<{ data: string; mimeType: string }>((resolve, reject) => {
        const reader = new FileReader();
        reader.onloadend = () => {
            const result = reader.result?.toString().split(',')[1];
            if (result) {
                resolve({ data: result, mimeType: file.type });
            } else {
                reject(new Error("Failed to read file"));
            }
        };
        reader.onerror = reject;
        reader.readAsDataURL(file);
    });

    const { data, mimeType } = await base64Promise;
    return {
        inlineData: { data, mimeType },
    };
}
// --- END OF AI ENGINE ---
