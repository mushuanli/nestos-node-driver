import {expect, it, vi} from 'vitest';
import {HarnessControlLedger, validateControls, type HarnessControlRecord} from '../src/harness/control-ledger';

function deferred() {let resolve!: () => void; const promise = new Promise<void>(done => {resolve = done;}); return {promise, resolve};}
it('keeps acknowledgement durable while persisting a later terminal observation', async () => {
    const second = deferred(), third = deferred();
    const saved: HarnessControlRecord[][] = [];
    const call = vi.fn(async () => {});
    const ledger = new HarnessControlLedger({before: async () => 'epoch', call, query: vi.fn(),
        completion: () => undefined, changed: () => {}, closed: () => false,
        save: async () => {saved.push(ledger.records()); if (saved.length === 2) await second.promise; if (saved.length === 3) await third.promise;}});
    const starting = ledger.start({sessionId: 's', turnId: 't', operationId: 'stop'});
    await vi.waitFor(() => expect(saved).toHaveLength(2));
    ledger.observeTerminal('t', 'completed');
    second.resolve();
    await vi.waitFor(() => expect(saved).toHaveLength(3));
    expect(ledger.projection()[0]).toMatchObject({receipt: 'accepted', effect: 'completed'});
    expect(ledger.pending).toBe(false); expect(ledger.blocksDispatch).toBe(true);
    third.resolve(); await starting;
    expect(saved[2][0]).toMatchObject({receipt: 'accepted', terminal: 'completed'});
    expect(ledger.blocksDispatch).toBe(false); expect(call).toHaveBeenCalledOnce();
});
it('rejects malformed recovery and reused identities with different targets', async () => {
    expect(() => validateControls([{requestId: 'stop', epoch: 'e', sessionId: 's', turnId: 't', receipt: 'accepted', terminal: 'idle'}])).toThrow();
    const ledger = new HarnessControlLedger({before: async () => 'e', call: vi.fn(), query: vi.fn(), save: async () => {}, completion: () => undefined, changed: () => {}, closed: () => false});
    ledger.restore([{requestId: 'stop', epoch: 'e', sessionId: 's', turnId: 't', receipt: 'accepted'}]);
    await expect(ledger.start({operationId: 'stop', sessionId: 's', turnId: 'other'})).rejects.toMatchObject({code: 'ECONFLICT'});
});
