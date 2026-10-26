import {expect, it, vi} from 'vitest';
import {createHash} from 'node:crypto';
import {HarnessConversation} from '../src/harness/conversation';
import type {HarnessClient, HarnessProfile} from '../src/harness/contracts';
import type {HarnessRecovery} from '../src/harness/conversation-journal';
const profile: HarnessProfile = {id: 'native', kind: 'native', projectRuntime: true, workspaces: [{id: 'p'}],
    capabilities: {history: true, create: true, resume: true, interrupt: true, interactions: true}};
const session = {id: 's', title: 'Test', cwd: '/p', status: 'idle', updatedAt: 1, resumable: true, owned: true};
const digest = (text: string) => createHash('sha256').update(text).digest('hex');
const evidence = {version: 1, requestId: 'original', promptSha256: digest('frozen input'), startSequence: 1, endSequence: 4};
function peer(): HarnessClient {
    return {profiles: vi.fn(async () => ({epoch: 'new', profiles: [profile]})), list: vi.fn(),
        read: vi.fn(async () => ({session, turns: []})), create: vi.fn(), resume: vi.fn(),
        turn: vi.fn(async () => ({turnId: 'original'})), interrupt: vi.fn(), respond: vi.fn(), operation: vi.fn(), close: vi.fn(),
        eventSnapshot: vi.fn(async () => ({epoch: 'events', cursor: 1, gap: false, events: [], requests: []}))};
}
async function fixture() {
    const client = peer(); let record: HarnessRecovery | undefined;
    const journal = {epoch: 'old', load: async () => record, save: async (value: HarnessRecovery) => {record = structuredClone(value);}};
    const first = new HarnessConversation(client, profile, 'p', 's', true, journal); await first.read();
    await first.enqueue('frozen input', [], undefined, 'original'); await first.refresh();
    await first.editInstructionQueue({action: 'pause', expectedRevision: first.snapshot().instructionQueue!.revision});
    expect(record?.instructionQueue?.items[0]?.receipt?.turnId).toBe('original'); await first.close();
    const open = () => new HarnessConversation(client, profile, 'p', 's', true, {...journal, epoch: 'new'});
    return {client, open, journal, saved: () => record};
}
it('settles an already admitted original operation from exact terminal history after a cold restart', async () => {
    const f = await fixture(); vi.mocked(f.client.read).mockResolvedValue({session,
        turns: [{id: 's-1', status: 'completed', submissionEvidence: evidence, items: []}]});
    const view = f.open();
    try {
        await view.read(); await view.reconcile('original');
        expect(view.snapshot().instructionQueue).toMatchObject({paused: true, items: [], acceptedIds: ['original']});
        expect(f.client.turn).toHaveBeenCalledTimes(1); expect(f.client.resume).not.toHaveBeenCalled();
        expect(f.saved()?.instructionQueue?.receipts[0].turnId).toBe('original');
    } finally {await view.close();}
});
it('does not treat a completed assistant item as a terminal turn fact', async () => {
    const f = await fixture(); vi.mocked(f.client.read).mockResolvedValue({session,
        turns: [{id: 'original', items: [{id: 'answer', type: 'agentMessage', text: 'done', status: 'completed'}]}]});
    const view = f.open();
    try {
        await view.read(); await view.refresh();
        expect(view.snapshot().instructionQueue?.items[0]).toMatchObject({id: 'original', state: 'dispatching'});
        expect(f.client.turn).toHaveBeenCalledTimes(1);
    } finally {await view.close();}
});


it.each([{requestId: 'another'}, {promptSha256: digest('changed input')}])('retains a claim when provenance does not match its frozen input: %j', async patch => {
    const f = await fixture(); vi.mocked(f.client.read).mockResolvedValue({session,
        turns: [{id: 's-1', status: 'completed', submissionEvidence: {...evidence, ...patch}, items: []}]});
    const view = f.open();
    try {await view.read(); await view.reconcile('original'); expect(view.snapshot().instructionQueue?.items).toHaveLength(1); expect(f.client.turn).toHaveBeenCalledTimes(1);}
    finally {await view.close();}
});
it('does not choose one of two historical turns claiming the same original request', async () => {
    const f = await fixture(); vi.mocked(f.client.read).mockResolvedValue({session,
        turns: ['s-1', 's-2'].map(id => ({id, status: 'completed', submissionEvidence: evidence, items: []}))});
    const view = f.open();
    try {await view.read(); await view.reconcile('original'); expect(view.snapshot().instructionQueue?.items).toHaveLength(1);}
    finally {await view.close();}
});
it.each([{version: 2}, {startSequence: -1}, {endSequence: 1}, {promptSha256: 'invalid'}])('rejects malformed declared provenance without settling a claim: %j', async patch => {
    const f = await fixture(); vi.mocked(f.client.read).mockResolvedValue({session,
        turns: [{id: 's-1', status: 'completed', submissionEvidence: {...evidence, ...patch}, items: []}]});
    const view = f.open();
    try {await expect(view.read()).rejects.toMatchObject({code: 'HARNESS_HISTORY_EVIDENCE_INVALID'}); expect(f.saved()?.instructionQueue?.items).toHaveLength(1);}
    finally {await view.close();}
});
it('rejects a history page from another Session before using its terminal fact', async () => {
    const f = await fixture(); vi.mocked(f.client.read).mockResolvedValue({session: {...session, id: 'other'},
        turns: [{id: 's-1', status: 'completed', submissionEvidence: evidence, items: []}]});
    const view = f.open();
    try {await expect(view.read()).rejects.toMatchObject({code: 'HARNESS_HISTORY_SCOPE_MISMATCH'}); expect(f.saved()?.instructionQueue?.items).toHaveLength(1);}
    finally {await view.close();}
});
it('uses explicitly loaded older history without scanning or adopting the native Session', async () => {
    const f = await fixture();
    vi.mocked(f.client.read).mockImplementation(async (_profile, _session, options) => options?.cursor
        ? {session, turns: [{id: 's-1', status: 'completed', submissionEvidence: evidence, items: []}], nextCursor: null}
        : {session, turns: [], nextCursor: 'older'});
    const view = f.open();
    try {
        await view.read(); await view.reconcile('original'); expect(view.snapshot().instructionQueue?.items).toHaveLength(1);
        expect(f.client.read).not.toHaveBeenCalledWith('native', 's', expect.objectContaining({cursor: 'older'}));
        await view.loadEarlier(); await view.reconcile('original');
        expect(view.snapshot().instructionQueue).toMatchObject({paused: true, items: []});
        expect(f.client.resume).not.toHaveBeenCalled(); expect(f.client.turn).toHaveBeenCalledTimes(1);
    } finally {await view.close();}
});


it('does not use prompt-only evidence to settle an instruction that included attachments', async () => {
    const f = await fixture(); f.saved()!.instructionQueue!.items[0].attachments = [{kind: 'text', name: 'private.txt', content: 'PRIVATE'}];
    vi.mocked(f.client.read).mockResolvedValue({session, turns: [{id: 's-1', status: 'completed', submissionEvidence: evidence, items: []}]});
    const view = f.open();
    try {await view.read(); await view.reconcile('original'); expect(view.snapshot().instructionQueue?.items).toHaveLength(1); expect(f.client.turn).toHaveBeenCalledTimes(1);}
    finally {await view.close();}
});
it('retains the original claim if persisting history-confirmed settlement fails, then recovers without replay', async () => {
    const f = await fixture(), save = f.journal.save; let fail = true;
    f.journal.save = async value => {if (fail && !value.instructionQueue?.items.length) throw new Error('Private storage failure'); await save(value);};
    vi.mocked(f.client.read).mockResolvedValue({session, turns: [{id: 's-1', status: 'completed', submissionEvidence: evidence, items: []}]});
    const first = f.open();
    try {await first.read(); await expect(first.reconcile('original')).rejects.toBeDefined(); expect(f.saved()?.instructionQueue?.items).toHaveLength(1);}
    finally {await first.close();}
    fail = false; const second = f.open();
    try {await second.read(); await second.reconcile('original'); expect(second.snapshot().instructionQueue?.items).toEqual([]); expect(f.client.turn).toHaveBeenCalledTimes(1);}
    finally {await second.close();}
});
