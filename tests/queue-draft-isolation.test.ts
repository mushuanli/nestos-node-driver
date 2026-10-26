import {expect, it, vi} from 'vitest';
import {HarnessConversation} from '../src/harness/conversation';
import type {HarnessClient, HarnessProfile} from '../src/harness/contracts';
import type {HarnessRecovery} from '../src/harness/conversation-journal';
const session = {id: 's', title: 'Test', cwd: '/p', status: 'idle', updatedAt: 1, resumable: true, owned: true};
type Kind = 'message' | 'prompt' | 'action';
async function fixture(kind: Kind, unknown = false) {
    const profile: HarnessProfile = {id: 'native', kind: 'native', projectRuntime: true, workspaces: [{id: 'p'}],
        capabilities: {history: true, create: true, resume: true, interrupt: true, interactions: true, slashCommands: true, attachments: ['text']}};
    const command = {name: 'native', kind: kind === 'message' ? 'prompt' as const : kind, description: 'Native', execution: 'serial' as const};
    const turn = async () => {if (unknown) throw Object.assign(new Error('Lost reply'), {outcome: 'unknown'}); return {turnId: 'turn'};};
    const execute = async () => {if (unknown) throw Object.assign(new Error('Lost reply'), {outcome: 'unknown'}); return {commandId: 'command', status: 'completed' as const};};
    const client: HarnessClient = {profiles: vi.fn(async () => ({epoch: 'e', profiles: [profile]})), list: vi.fn(),
        read: vi.fn(async () => ({session, turns: []})), create: vi.fn(), resume: vi.fn(), turn: vi.fn(turn), command: vi.fn(execute),
        commands: vi.fn(async () => [command]), interrupt: vi.fn(), respond: vi.fn(), operation: vi.fn(), close: vi.fn(),
        eventSnapshot: vi.fn(async () => ({epoch: 'events', cursor: 1, gap: false, events: [], requests: []}))};
    let record: HarnessRecovery | undefined;
    const journal = {epoch: 'e', load: async () => record, save: async (value: HarnessRecovery) => {record = structuredClone(value);}};
    const open = () => new HarnessConversation(client, profile, 'p', 's', true, journal), view = open(); await view.read();
    const text = kind === 'message' ? 'Frozen queue input' : '/native';
    return {view, open, client, text, saved: () => record};
}
const cases = (['message', 'prompt', 'action'] as const).flatMap(kind => ['empty', 'different', 'identical'].map(draft => ({kind, draft})));
it.each(cases)('preserves an existing $draft composer draft when a queued $kind is dispatched', async ({kind, draft}) => {
    const f = await fixture(kind), text = draft === 'empty' ? '' : draft === 'identical' ? f.text : 'Next input';
    const files = draft === 'different' ? [{kind: 'text' as const, name: 'next.txt', content: 'Next attachment'}] : [];
    try {
        await f.view.saveDraft(text, files); await f.view.enqueue(f.text, [], undefined, 'original'); await f.view.refresh();
        expect(f.view.snapshot().draft).toBe(text); expect(f.view.snapshot().draftAttachments).toEqual(files);
        expect(f.saved()?.draft).toBe(text);
        expect(kind === 'message' ? f.client.turn : f.client.command).toHaveBeenCalledTimes(1);
    } finally {await f.view.close();}
});
it.each(['message', 'prompt', 'action'] as const)('keeps an identical next draft through unknown queued %s admission and reopening', async kind => {
    const f = await fixture(kind, true); await f.view.saveDraft(f.text);
    await f.view.enqueue(f.text, [], undefined, 'original'); await f.view.refresh();
    expect(f.view.snapshot().pending).toBe(true); await f.view.close();
    vi.mocked(f.client.operation).mockResolvedValue({requestId: 'original', outcome: 'committed', result: kind === 'message' ? {turnId: 'turn'} : {commandId: 'command', status: 'completed'}});
    const reopened = f.open();
    try {
        await reopened.read(); await reopened.reconcile();
        expect(reopened.snapshot().draft).toBe(f.text); expect(f.saved()?.draft).toBe(f.text);
        expect(kind === 'message' ? f.client.turn : f.client.command).toHaveBeenCalledTimes(1);
    } finally {await reopened.close();}
});

it.each([true, 'false', null, 0])('rejects a malformed draft consumption marker before using recovery: %j', async value => {
    const f = await fixture('message', true);
    await f.view.enqueue(f.text, [], undefined, 'original'); await f.view.refresh(); await f.view.close();
    Object.assign(f.saved()!.pending!, {consumeDraft: value});
    const reopened = f.open();
    try {await expect(reopened.read()).rejects.toMatchObject({code: 'EINVAL'}); expect(f.client.operation).not.toHaveBeenCalled();}
    finally {await reopened.close();}
});
