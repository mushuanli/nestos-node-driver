import {FSError} from '@itookit/vfs-core';
import type {HarnessCommandQuery, HarnessCommandRecord, HarnessCommandResult} from './contracts';
import {validateCommandResult, validateCommandReceipts} from './commands';

interface QueryStorage {
    records(): readonly HarnessCommandRecord[];
    commit(record: HarnessCommandRecord): Promise<void>;
}

/** Read observations have independent durable reports, never an execution admission barrier. */
export class HarnessCommandQueries {
    private readonly active = new Map<string, {identity: string; work: Promise<void>}>();
    private readonly unconfirmed = new Map<string, HarnessCommandRecord>();
    constructor(private readonly storage: QueryStorage) {}
    pendingReports(): string[] {return [...this.unconfirmed.keys()];}
    receipts(): Array<{id: string; status: 'accepted'}> {
        return this.storage.records().flatMap(row => row.query && !this.unconfirmed.has(row.query.id)
            ? [{id: row.query.id, status: 'accepted' as const}] : []);
    }
    async execute(query: HarnessCommandQuery, run: () => Promise<HarnessCommandResult>): Promise<void> {
        query = normalizeQuery(query);
        const identity = JSON.stringify(query), active = this.active.get(query.id);
        const prior = this.unconfirmed.get(query.id) ?? this.storage.records().find(row => row.query?.id === query.id);
        assertQueryIdentity(prior, active, identity);
        if (active) return active.work;
        if (prior && !this.unconfirmed.has(query.id)) return;
        if (!prior && this.active.size + this.unconfirmed.size >= 64)
            throw Object.assign(new FSError('EBUSY', 'Too many unresolved query reports'), {outcome: 'not-committed'});
        const work = prior ? this.persist(prior) : this.observe(query, run);
        this.active.set(query.id, {identity, work});
        try {await work;} finally {if (this.active.get(query.id)?.work === work) this.active.delete(query.id);}
    }
    async reconcile(id: string): Promise<boolean> {
        const active = this.active.get(id);
        if (active) await active.work;
        const record = this.unconfirmed.get(id) ?? this.storage.records().find(row => row.query?.id === id);
        if (!record) return false;
        if (this.unconfirmed.has(id)) await this.persist(record);
        return true;
    }
    private async observe(query: HarnessCommandQuery, run: () => Promise<HarnessCommandResult>): Promise<void> {
        const started = Date.now();
        let result: HarnessCommandResult;
        try {
            result = validateCommandResult(await run());
            if (result.commandId !== query.id || result.turnId || result.status !== 'completed')
                throw new FSError('EIO', 'Invalid read-only command observation');
        } catch (error) {
            queryFailure(query.id, 'read', error, started);
            if (error && typeof error === 'object') Object.assign(error, {outcome: 'not-committed'});
            throw error;
        }
        await this.persist({...result, output: result.output ?? '', query});
    }
    private async persist(record: HarnessCommandRecord): Promise<void> {
        const id = record.query!.id, started = Date.now();
        this.unconfirmed.set(id, record);
        try {await this.storage.commit(record);}
        catch (error) {
            if ((error as {outcome?: string})?.outcome === 'not-committed') this.unconfirmed.delete(id);
            queryFailure(id, 'persist', error, started); throw error;
        }
        this.unconfirmed.delete(id);
    }
}

function normalizeQuery(query: HarnessCommandQuery): HarnessCommandQuery {
    try {return validateCommandReceipts([{commandId: query.id, output: '', status: 'completed', query}])[0].query!;}
    catch (error) {if (error && typeof error === 'object') Object.assign(error, {outcome: 'not-committed'}); throw error;}
}
function assertQueryIdentity(prior: HarnessCommandRecord | undefined, active: {identity: string} | undefined, identity: string): void {
    if (prior && JSON.stringify(prior.query) !== identity || active && active.identity !== identity)
        throw Object.assign(new FSError('ECONFLICT', 'Query identity already belongs to another observation'), {outcome: 'not-committed'});
}

function queryFailure(operationId: string, stage: string, error: unknown, started: number): void {
    const failure = error as {remoteCode?: unknown; code?: unknown};
    const raw = failure?.remoteCode ?? failure?.code;
    const code = typeof raw === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(raw) ? raw : stage === 'persist' ? 'QUERY_REPORT_STORAGE' : 'QUERY_READ_FAILED';
    console.warn('[Harness] Command query failed', {operation: 'harness.query', operationId, stage, outcome: 'failure', code, durationMs: Date.now() - started});
}
