import {FSError} from '@itookit/vfs-core';
import {requestId} from '../files/request-id';
import type {HarnessReceipt} from './contracts';

export interface HarnessInterruptRequest {sessionId: string; turnId: string; operationId?: string}
export interface HarnessControlRecord {
    requestId: string; epoch: string; sessionId: string; turnId: string;
    receipt: 'pending' | 'accepted' | 'rejected'; code?: string;
    /** Native terminal observation; never inferred from interrupt acknowledgement. */
    terminal?: 'completed' | 'failed' | 'cancelled';
}
export interface HarnessControlProjection {
    operationId: string; sessionId: string; turnId: string;
    receipt: 'unknown' | 'accepted' | 'rejected'; code?: string;
    effect: 'unconfirmed' | 'completed' | 'failed' | 'cancelled';
}
interface Ports {
    before(): Promise<string>;
    call(record: HarnessControlRecord): Promise<void>;
    query(record: HarnessControlRecord): Promise<HarnessReceipt>;
    save(): Promise<void>;
    completion(turnId: string): Exclude<HarnessControlProjection['effect'], 'unconfirmed'> | undefined;
    changed(): void;
    closed(): boolean;
}
const identity = (value: unknown): value is string => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(value);
const targetKey = (target: HarnessInterruptRequest) => JSON.stringify([target.sessionId, target.turnId]);
const codeOf = (error: unknown): string => {
    const value = error as {remoteCode?: string; code?: string} | undefined;
    const code = value?.remoteCode ?? value?.code;
    return code && /^[A-Z][A-Z0-9_]{0,79}$/.test(code) ? code : 'CONTROL_OPERATION_FAILED';
};
function validControlTarget(row: HarnessControlRecord): boolean {
    return identity(row.requestId) && typeof row.epoch === 'string' && !!row.epoch && row.epoch.length <= 1024
        && [row.sessionId, row.turnId].every(id => typeof id === 'string' && id.length > 0 && id.length <= 4096);
}
function validControlFacts(row: HarnessControlRecord): boolean {
    return ['pending', 'accepted', 'rejected'].includes(row.receipt)
        && (row.terminal === undefined || ['completed', 'failed', 'cancelled'].includes(row.terminal))
        && (row.code === undefined || typeof row.code === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(row.code));
}
export function validateControls(value: unknown = []): HarnessControlRecord[] {
    if (!Array.isArray(value) || value.length > 64) throw new FSError('EINVAL', 'Invalid native control records');
    const ids = new Set<string>();
    for (const row of value) {
        if (!row || ids.has(row.requestId) || !validControlTarget(row) || !validControlFacts(row))
            throw new FSError('EINVAL', 'Invalid native control record');
        ids.add(row.requestId);
    }
    return value.map(row => ({...row}));
}

/** A cancellation receipt is independent of both input admission and actual termination. */
export class HarnessControlLedger {
    private rows: HarnessControlRecord[] = [];
    private readonly attempts = new Map<string, {target: string; phase: 'prepare' | 'sent'}>();
    private readonly dirty = new Set<string>();
    private readonly receiptDirty = new Set<string>();
    private readonly revisions = new Map<string, number>();
    private readonly saves = new Map<string, Promise<void>>();
    private readonly lastQueries = new Map<string, number>();
    private readonly queries = new Map<string, Promise<void>>();
    constructor(private readonly ports: Ports) {}
    restore(value: unknown): void {this.rows = validateControls(value);}
    records(): HarnessControlRecord[] {return this.rows.map(row => ({...row}));}
    has(id: string): boolean {return this.rows.some(row => row.requestId === id);}
    projection(): HarnessControlProjection[] {
        return this.rows.map(row => ({operationId: row.requestId, sessionId: row.sessionId, turnId: row.turnId,
            receipt: this.uncertain(row) ? 'unknown' : row.receipt as 'accepted' | 'rejected', code: row.code,
            effect: row.terminal ?? this.ports.completion(row.turnId) ?? 'unconfirmed'}));
    }
    get pending(): boolean {
        return [...this.attempts.values()].some(row => row.phase === 'prepare') || this.rows.some(row => this.uncertain(row));
    }
    get blocksDispatch(): boolean {
        return this.pending || !!this.dirty.size || this.rows.some(row => row.receipt === 'accepted' && !(row.terminal ?? this.ports.completion(row.turnId)));
    }
    canStart(target: HarnessInterruptRequest): boolean {
        const key = targetKey(target);
        return ![...this.attempts.values()].some(row => row.target === key && row.phase === 'prepare')
            && !this.rows.some(row => targetKey(row) === key && (row.receipt !== 'rejected' || this.uncertain(row)));
    }
    private uncertain(row: HarnessControlRecord): boolean {return row.receipt === 'pending' || this.receiptDirty.has(row.requestId);}
    async start(request: HarnessInterruptRequest): Promise<void> {
        const target = {...request};
        const id = target.operationId ?? requestId();
        validateControls([{requestId: id, epoch: 'preparing', sessionId: target.sessionId, turnId: target.turnId, receipt: 'pending'}]);
        const previous = this.rows.find(row => row.requestId === id);
        if (!identity(id)) throw new FSError('EINVAL', 'Invalid control operation identity');
        if (previous) {
            if (targetKey(previous) !== targetKey(target)) throw new FSError('ECONFLICT', 'Control identity has a different target');
            return;
        }
        if (!this.canStart(target) || this.attempts.has(id)) throw new FSError('EBUSY', 'Control is already pending for this execution');
        const attempt = {target: targetKey(target), phase: 'prepare' as 'prepare' | 'sent'};
        this.attempts.set(id, attempt); this.ports.changed();
        try {
            const epoch = await this.ports.before(); this.assertOpen();
            this.prune();
            const row: HarnessControlRecord = {requestId: id, epoch, sessionId: target.sessionId, turnId: target.turnId, receipt: 'pending'};
            validateControls([row]);
            this.rows.push(row); this.mark(row, true); await this.persist(row); this.assertOpen();
            attempt.phase = 'sent';
            await this.dispatch(row);
        } finally {this.attempts.delete(id); this.ports.changed();}
    }
    private assertOpen(): void {if (this.ports.closed()) throw new FSError('EACCES', 'Control observation closed');}
    private prune(): void {
        if (this.rows.length < 64) return;
        this.rows = this.rows.filter(row => this.uncertain(row) || row.receipt === 'accepted' && !(row.terminal ?? this.ports.completion(row.turnId)));
        const retained = new Set(this.rows.map(row => row.requestId));
        for (const id of this.revisions.keys()) if (!retained.has(id)) {this.revisions.delete(id); this.lastQueries.delete(id);}
        if (this.rows.length >= 64) throw new FSError('EFBIG', 'Native control recovery is full');
    }
    private async dispatch(row: HarnessControlRecord): Promise<void> {
        const started = Date.now();
        try {
            await this.ports.call({...row}); await this.finish(row, 'accepted');
            this.log(row, 'dispatch', started);
        } catch (error) {
            if (row.receipt !== 'pending' && !this.receiptDirty.has(row.requestId)) return;
            if (row.receipt === 'pending' && (error as {outcome?: string})?.outcome === 'not-committed') await this.finish(row, 'rejected', codeOf(error));
            this.log(row, 'dispatch', started, error); throw error;
        }
    }
    private async finish(row: HarnessControlRecord, receipt: 'accepted' | 'rejected', code?: string): Promise<void> {
        if (row.receipt === 'pending') {row.receipt = receipt; row.code = code; this.mark(row, true);}
        await this.persist(row);
    }
    observeTerminal(turnId: string, terminal: NonNullable<HarnessControlRecord['terminal']>): void {
        for (const row of this.rows) {
            if (row.turnId === turnId && !row.terminal) {row.terminal = terminal; this.mark(row);}
        }
    }
    private mark(row: HarnessControlRecord, receipt = false): void {
        if (receipt) this.receiptDirty.add(row.requestId);
        this.revisions.set(row.requestId, (this.revisions.get(row.requestId) ?? 0) + 1);
        this.dirty.add(row.requestId); this.ports.changed();
    }
    private async persist(row: HarnessControlRecord): Promise<void> {
        while (this.dirty.has(row.requestId)) await this.write(row);
    }
    private write(row: HarnessControlRecord): Promise<void> {
        const existing = this.saves.get(row.requestId); if (existing) return existing;
        const version = this.revisions.get(row.requestId), receipt = row.receipt, started = Date.now();
        const work = this.ports.save().then(() => {
            if (this.revisions.get(row.requestId) === version) this.dirty.delete(row.requestId);
            if (row.receipt === receipt) this.receiptDirty.delete(row.requestId);
        }, error => {this.log(row, 'persist', started, error); throw error;})
            .finally(() => {this.saves.delete(row.requestId); this.ports.changed();});
        this.saves.set(row.requestId, work); return work;
    }
    async reconcile(id?: string, force = false): Promise<void> {
        for (const row of [...this.rows]) {
            if (this.dirty.has(row.requestId)) await this.persist(row);
            if (!this.shouldQuery(row, id, force)) continue;
            let work = this.queries.get(row.requestId);
            if (!work) {
                this.lastQueries.set(row.requestId, Date.now());
                work = this.query(row).finally(() => this.queries.delete(row.requestId));
                this.queries.set(row.requestId, work);
            }
            await work;
        }
    }
    private shouldQuery(row: HarnessControlRecord, id: string | undefined, force: boolean): boolean {
        if (id && id !== row.requestId || !this.uncertain(row)) return false;
        const attempt = this.attempts.get(row.requestId);
        if (attempt?.phase === 'prepare' || attempt && !force) return false;
        return force || Date.now() - (this.lastQueries.get(row.requestId) ?? 0) >= 1000;
    }
    private async query(row: HarnessControlRecord): Promise<void> {
        const started = Date.now();
        try {
            const receipt = await this.ports.query({...row});
            if (receipt.requestId !== row.requestId) throw new FSError('EIO', 'Mismatched control receipt');
            if (!['unknown', 'committed', 'not-committed'].includes(receipt.outcome)
                || receipt.code !== undefined && !/^[A-Z][A-Z0-9_]{0,79}$/.test(receipt.code)) throw new FSError('EIO', 'Invalid native control receipt');
            if (receipt.outcome !== 'unknown') {await this.finish(row, receipt.outcome === 'committed' ? 'accepted' : 'rejected', receipt.code); this.log(row, 'reconcile', started);}
        } catch (error) {this.log(row, 'reconcile', started, error); throw error;}
    }
    private log(row: HarnessControlRecord, stage: string, started: number, error?: unknown): void {
        const fields = {operation: 'harness.control.interrupt', operationId: row.requestId, stage,
            result: error ? 'unconfirmed' : row.receipt, durationMs: Date.now() - started, code: error ? codeOf(error) : row.code};
        if (error) console.warn('[Harness] Control receipt', fields); else console.info('[Harness] Control receipt', fields);
    }
}
