/**
 * Quota Monitor Service
 * Fetches real-time OpenRouter usage/limit data via Supabase Edge Function
 */
export class QuotaMonitor {
    private static instance: QuotaMonitor;
    private static hasMonitoringError = false;

    private constructor() {}

    static getInstance() {
        if (!QuotaMonitor.instance) {
            QuotaMonitor.instance = new QuotaMonitor();
        }
        return QuotaMonitor.instance;
    }

    /**
     * Fetches real-time OpenRouter metrics via the Edge Function
     * Returns usage (in USD or tokens depending on provider) and limit
     */
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    async getGeminiQuotas(_modelName: string): Promise<{ usage: number; limit: number }> {
        if (QuotaMonitor.hasMonitoringError) return { usage: 0, limit: Number.POSITIVE_INFINITY };

        try {
            const { supabase } = await import('./supabase');
            const { data, error } = await supabase.functions.invoke('process-invoice', {
                body: { mode: 'metrics' }
            });

            if (error) throw error;

            // Handle OpenRouter /auth/key response
            const metrics = data?.data || {};
            const usage = metrics.usage || 0;
            const limitValue = metrics.limit;
            const limit = (limitValue === null || limitValue === undefined) ? Number.POSITIVE_INFINITY : limitValue;

            console.log(`[QuotaMonitor] OpenRouter | Usage: ${usage} | Limit: ${limit}`);
            return { usage, limit };
        } catch (err) {
            console.error("[QuotaMonitor] Error fetching OpenRouter metrics:", err);
            // Don't permanently disable, as Edge Functions might recover or network might blink
            return { usage: 0, limit: Number.POSITIVE_INFINITY }; 
        }
    }
}
