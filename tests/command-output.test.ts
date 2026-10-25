import {expect, it, vi} from 'vitest';
import {sha256} from '@itookit/vfs-sync';
import {MCPHarnessClient} from '../src/harness/client';
import {HarnessConversation} from '../src/harness/conversation';
import {validateCommandResult} from '../src/harness/commands';
import {previewOutput, loadCommandOutput, validateCommandOutputPage} from '../src/harness/command-output';
import type {HarnessClient, HarnessCommandOutputRef, HarnessProfile} from '../src/harness/contracts';
import type {HarnessRecovery} from '../src/harness/conversation-journal';
import {HarnessInstructionRuntime} from '../src/harness/instruction-queue';
import {decodeCommittedResult} from '../src/harness/committed-result';

const profile: HarnessProfile = {id: 'native', kind: 'fixture', projectRuntime: true, workspaces: [{id: 'workspace'}],
    capabilities: {create: true, resume: true, history: true, interrupt: true, interactions: true, slashCommands: true, commandQueries: true, commandOutputs: true}};
const session = {id: 'session', title: 'Output', cwd: null, status: 'idle', updatedAt: 1, resumable: true, owned: true};
const commands = [{name: 'compact', description: 'Compact', kind: 'action' as const}];
async function output(text: string, requestId = 'operation') {
    const bytes = new TextEncoder().encode(text);
    const ref: HarnessCommandOutputRef = {version: 1, epoch: 'epoch', requestId, bytes: bytes.length, sha256: await sha256(bytes), mimeType: 'text/plain'};
    const page = (offset = 0, limit = 65536) => {const data = bytes.slice(offset, offset + limit), end = offset + data.length;
        return {ref, offset, data: Buffer.from(data).toString('base64'), nextOffset: end === bytes.length ? null : end};};
    return {bytes, ref, page, result: {commandId: 'command', status: 'completed' as const, output: previewOutput(text).text, outputRef: ref}};
}
function fixture(initial: unknown, saved?: HarnessRecovery) {
    let response = initial, receiptResult = initial, record = saved;
    const call = vi.fn(async (name: string, args: Record<string, unknown>) => name === 'harness_profiles' ? {epoch: 'epoch', profiles: [profile]}
        : name === 'harness_operation' ? {outcome: 'committed', requestId: args.requestId, result: receiptResult}
        : {outcome: 'committed', requestId: args.requestId, result: response});
    const native = new MCPHarnessClient({call, close: vi.fn()});
    const peer = {profiles: native.profiles.bind(native), command: native.command.bind(native), operation: native.operation.bind(native),
        queryCommand: vi.fn(async (_profile, _session, _name, _args, options) => ({commandId: options?.requestId ?? 'query', status: 'completed', output: 'State'})),
        commands: vi.fn(async () => commands), turn: vi.fn(async () => ({turnId: 'next-turn'})),
        read: vi.fn(async () => ({session, turns: []})), eventSnapshot: vi.fn(async () => ({epoch: 'events', cursor: 0, gap: false, events: [], requests: []})),
        subscribe: () => () => {}, close: vi.fn(async () => {}), readCommandOutput: vi.fn()} as unknown as HarnessClient;
    const journal = {epoch: 'epoch', load: async () => record, save: async (next: HarnessRecovery) => {record = structuredClone(next);}};
    const open = () => new HarnessConversation(peer, profile, 'workspace', 'session', true, journal);
    return {peer, native, call, open, record: () => record, reply: (value: unknown) => {response = receiptResult = value;}, receipt: (value: unknown) => {receiptResult = value;}};
}

it('keeps UTF-8 preview boundaries and marks old oversized bodies unavailable without losing native completion', () => {
    const text = 'a'.repeat(65535) + '😀'.repeat(40000), result = validateCommandResult({commandId: 'native', status: 'completed', output: text});
    expect(result).toMatchObject({commandId: 'native', status: 'completed', outputError: {code: 'HARNESS_COMMAND_OUTPUT_TOO_LARGE', bytes: new TextEncoder().encode(text).length}});
    expect(new TextEncoder().encode(result.output).length).toBe(65535); expect(result.output).not.toContain('\ufffd');
});

it('keeps completed legacy oversized output accepted across reopen and permits a later send without replay', async () => {
    const f = fixture({commandId: 'legacy', status: 'completed', output: '😀'.repeat(40000)}), view = f.open();
    await view.read(); await view.saveDraft('/compact');
    const result = await view.command('compact', '', undefined, '/compact', 'operation');
    expect(result).toMatchObject({pending: false, canSend: true, submission: {status: 'accepted'}});
    expect(result.messages[0].commandOutput).toMatchObject({commandId: 'legacy', truncated: true, unavailable: {code: 'HARNESS_COMMAND_OUTPUT_TOO_LARGE'}});
    vi.mocked(f.peer.eventSnapshot).mockResolvedValue({epoch: 'events', cursor: 1, gap: false, requests: [], events: [{seq: 1,
        message: {method: 'harness/command/updated', params: {threadId: 'session', commandId: 'legacy', status: 'completed'}}}]});
    expect((await view.refresh()).messages[0].commandOutput?.unavailable?.code).toBe('HARNESS_COMMAND_OUTPUT_TOO_LARGE');
    await view.close(); const reopened = f.open(); await reopened.read(); await reopened.send('Continue', [], undefined, 'next-input');
    expect(f.peer.turn).toHaveBeenCalledOnce(); expect(f.call.mock.calls.filter(([name]) => name === 'harness_command')).toHaveLength(1);
    expect(reopened.snapshot().messages.some(row => row.commandOutput?.unavailable)).toBe(true); await reopened.close();
});

it('persists committed invalid identity separately from unknown admission and repairs only the original operation', async () => {
    const f = fixture({commandId: '', status: 'completed', output: 'Do not replay'}), view = f.open(); await view.read();
    const result = await view.command('compact', '', undefined, '/compact', 'operation');
    expect(result).toMatchObject({pending: false, canSend: false, canQueryCommand: true, canQueue: true,
        submission: {id: 'operation', status: 'accepted', resultError: {code: 'HARNESS_COMMITTED_RESULT_INVALID'}}});
    expect(f.record()?.commandResults?.[0]).toMatchObject({operationId: 'operation', operationEpoch: 'epoch', resultError: {code: 'HARNESS_COMMITTED_RESULT_INVALID'}});
    await view.saveDraft('Newer draft'); await view.close(); const reopened = f.open();
    expect((await reopened.read()).resultError).toBeDefined();
    f.receipt({commandId: 'repaired-native', status: 'completed', output: 'Original result'});
    const repaired = await reopened.reconcile('operation');
    expect(repaired).toMatchObject({pending: false, canSend: true, draft: 'Newer draft', resultError: undefined});
    expect(f.call.mock.calls.filter(([name]) => name === 'harness_command')).toHaveLength(1);
    expect(f.call).toHaveBeenCalledWith('harness_operation', expect.objectContaining({requestId: 'operation', epoch: 'epoch'}), expect.anything());
    await reopened.close();
});

it('does not permit queue retry to re-execute a committed command with an invalid envelope', async () => {
    const f = fixture({commandId: '', status: 'completed'}), view = f.open(); await view.read();
    await view.enqueue('/compact', [], undefined, 'queued'); await view.refresh();
    await vi.waitFor(() => expect(view.snapshot().resultError).toBeDefined());
    await view.refresh(); const queue = view.snapshot().instructionQueue!;
    expect(queue).toMatchObject({paused: true, items: [{state: 'dispatching', receipt: {resultError: {code: 'HARNESS_COMMITTED_RESULT_INVALID'}}}]});
    await expect(view.editInstructionQueue({expectedRevision: queue.revision, action: 'retry', id: 'queued'})).rejects.toThrow();
    expect(f.call.mock.calls.filter(([name]) => name === 'harness_command')).toHaveLength(1); await view.close();
});

it('reads a frozen native output reference and validates every page and the complete SHA-256', async () => {
    const f = await output('a'.repeat(65535) + '😀'.repeat(20000));
    const read = vi.fn(async range => f.page(range.offset, range.limit));
    expect(new Uint8Array(await loadCommandOutput(f.ref, read))).toEqual(f.bytes);
    expect(read).toHaveBeenCalledTimes(Math.ceil(f.bytes.length / 65536));
    await expect(loadCommandOutput({...f.ref, sha256: '0'.repeat(64)}, async range => ({...f.page(range.offset, range.limit), ref: {...f.ref, sha256: '0'.repeat(64)}})))
        .rejects.toThrow('integrity mismatch');
});

it.each(['ref', 'offset', 'empty', 'next', 'base64'])('rejects malformed output pages (%s) without accepting progress', async kind => {
    const f = await output('abc'), page = f.page();
    const bad = kind === 'ref' ? {...page, ref: {...f.ref, requestId: 'foreign'}} : kind === 'offset' ? {...page, offset: 1}
        : kind === 'empty' ? {...page, data: ''} : kind === 'next' ? {...page, nextOffset: 0} : {...page, data: 'YWJj===='};
    expect(() => validateCommandOutputPage(bad, f.ref)).toThrow();
});

it('rejects excessive download budgets and cancellation before dispatching another output read', async () => {
    const f = await output('a'.repeat(70000)), read = vi.fn(async range => f.page(range.offset, range.limit));
    await expect(loadCommandOutput(f.ref, read, {maxBytes: 1})).rejects.toMatchObject({code: 'EFBIG'}); expect(read).not.toHaveBeenCalled();
    const controller = new AbortController(); controller.abort();
    await expect(loadCommandOutput(f.ref, read, {signal: controller.signal})).rejects.toThrow(); expect(read).not.toHaveBeenCalled();
    const next = new AbortController();
    await expect(loadCommandOutput(f.ref, async range => {next.abort(); return read(range);}, {signal: next.signal})).rejects.toThrow();
    expect(read).toHaveBeenCalledOnce();
});

it('requires positive output capability and sends exact frozen scope, epoch and byte identity', async () => {
    const f = await output('abc'), call = vi.fn(async (name: string) => name === 'harness_profiles' ? {epoch: 'current', profiles: [profile]} : f.page());
    const client = new MCPHarnessClient({call, close: vi.fn()}, {projectId: 'project', revision: 2});
    await client.readCommandOutput('native', f.ref, {offset: 0, limit: 3});
    expect(call).toHaveBeenCalledWith('harness_command_output', expect.objectContaining({projectId: 'project', revision: 2,
        epoch: 'epoch', requestId: 'operation', sha256: f.ref.sha256, bytes: 3, offset: 0, limit: 3}), expect.anything());
    const legacy = new MCPHarnessClient({call: vi.fn(async () => ({epoch: 'e', profiles: [{...profile, capabilities: {...profile.capabilities, commandOutputs: false}}]})), close: vi.fn()});
    await expect(legacy.readCommandOutput('native', f.ref)).rejects.toMatchObject({code: 'ECAPABILITY'});
});

it('keeps output read failures local and preserves references after native history and stream echoes', async () => {
    const out = await output('😀'.repeat(40000)), f = fixture(out.result), view = f.open();
    f.peer.readCommandOutput = vi.fn(async () => {throw new Error('Output storage unavailable');});
    await view.read(); await view.command('compact', '', undefined, '/compact', 'operation');
    vi.mocked(f.peer.read).mockResolvedValue({session, turns: [{items: [{id: 'command:command', type: 'systemMessage', text: 'HUGE'.repeat(100000), status: 'completed'}]}]});
    const state = await view.read(); expect(state.messages).toHaveLength(1);
    expect(state.messages[0]).toMatchObject({id: 'command:command', text: out.result.output, commandOutput: {ref: out.ref}});
    vi.mocked(f.peer.eventSnapshot).mockResolvedValue({epoch: 'events', cursor: 1, gap: false, requests: [], events: [{seq: 1,
        message: {method: 'harness/command/updated', params: {threadId: 'session', commandId: 'command', status: 'completed',
            outputRef: {...out.ref, requestId: 'foreign'}, output: 'new text'}}}]});
    expect((await view.refresh()).messages[0].commandOutput?.ref).toEqual(out.ref);
    await expect(view.loadCommandOutput('command')).rejects.toThrow('Output storage unavailable');
    expect(view.snapshot()).toMatchObject({pending: false, canSend: true, resultError: undefined});
    expect(view.snapshot().observation.refreshError).toBeUndefined();
    f.peer.readCommandOutput = vi.fn(async (_profile, _ref, range) => out.page(range?.offset, range?.limit));
    expect(new Uint8Array(await view.loadCommandOutput('command'))).toEqual(out.bytes); await view.close();
});

it.each([true, false])('negotiates reference projection only for capable nodes (commandOutputs=%s)', async capable => {
    const call = vi.fn(async (name: string, args: Record<string, unknown>) => name === 'harness_profiles'
        ? {epoch: 'epoch', profiles: [{...profile, capabilities: {...profile.capabilities, commandOutputs: capable}}]}
        : {requestId: args.requestId, outcome: 'committed', result: {commandId: 'native', output: 'Done', status: 'completed'}});
    const client = new MCPHarnessClient({call, close: vi.fn()});
    await client.command('native', 'session', 'compact', '', {requestId: 'once'}); await client.operation('native', 'once');
    for (const [name, args] of call.mock.calls.filter(([name]) => ['harness_command', 'harness_operation'].includes(name))) {
        expect(name).toBeDefined(); expect(args.outputMode).toBe(capable ? 'reference' : undefined);
    }
    await client.close();
});

it('keeps the full output identity frozen across reads and rejects SHA or body corruption locally', async () => {
    const out = await output('a'.repeat(70000)), f = fixture(out.result), view = f.open();
    const seen: HarnessCommandOutputRef[] = [];
    f.peer.readCommandOutput = vi.fn(async (_profile, ref, range) => {
        seen.push(structuredClone(ref));
        if (!range?.offset) (view as any).commandResults[0].outputRef = {...ref, requestId: 'later'};
        return out.page(range?.offset, range?.limit);
    });
    await view.read(); await view.command('compact', '', undefined, '/compact', 'operation');
    expect(new Uint8Array(await view.loadCommandOutput('command'))).toEqual(out.bytes);
    expect(seen).toEqual([out.ref, out.ref]);
    (view as any).commandResults[0].outputRef = out.ref;
    f.peer.readCommandOutput = vi.fn(async (_profile, _ref, range) => ({...out.page(range?.offset, range?.limit), data: Buffer.from('x'.repeat(range?.offset ? 4464 : 65536)).toString('base64')}));
    await expect(view.loadCommandOutput('command')).rejects.toThrow('integrity mismatch');
    expect(view.snapshot().canSend).toBe(true); await view.close();
});

it('retains a committed result barrier through 70 query reports and reopen, then reconciles the original without replay', async () => {
    const f = fixture({commandId: '', status: 'completed'}), view = f.open(); await view.read();
    await view.enqueue('/compact', [], undefined, 'blocked'); await view.refresh();
    await view.enqueue('Next input', [], undefined, 'next');
    for (let i = 0; i < 70; ++i) await view.queryCommand('session:status', '', `query-${i}`, {kind: 'action', execution: 'query'});
    expect(f.record()?.commandResults).toHaveLength(64);
    expect(f.record()?.commandResults?.some(row => row.resultError && row.operationId === 'blocked')).toBe(true);
    await view.close(); const reopened = f.open(); await reopened.read();
    expect(reopened.snapshot()).toMatchObject({pending: false, canSend: false, resultError: {operationId: 'blocked'}});
    const queue = reopened.snapshot().instructionQueue!;
    expect(queue.items.find(row => row.id === 'next')?.state).toBe('pending');
    await expect(reopened.editInstructionQueue({expectedRevision: queue.revision, action: 'retry', id: 'blocked'})).rejects.toThrow();
    f.receipt({commandId: 'repaired', output: 'Done', status: 'completed'}); await reopened.reconcile('blocked');
    expect(reopened.snapshot().resultError).toBeUndefined();
    await reopened.editInstructionQueue({expectedRevision: reopened.snapshot().instructionQueue!.revision, action: 'resume'});
    await vi.waitFor(() => expect(f.peer.turn).toHaveBeenCalledOnce());
    expect(f.call.mock.calls.filter(([name]) => name === 'harness_command')).toHaveLength(1); await reopened.close();
});

it('uses one native identity bound in both command decoding and persisted queue receipts', async () => {
    const id = 'n'.repeat(1024), receipt = validateCommandResult({commandId: id, status: 'completed', output: 'Done'});
    const runtime = new HarnessInstructionRuntime({save: vi.fn(), load: vi.fn(), snapshot: vi.fn(), send: vi.fn(), reconcile: vi.fn(), command: vi.fn(), completion: vi.fn()});
    const item = {id: 'operation', text: '/compact', attachments: [], createdAt: 1, state: 'dispatching' as const,
        receipt: {commandId: receipt.commandId, commandStatus: 'completed' as const}};
    expect(() => runtime.restore({revision: 1, paused: true, items: [item], receipts: []})).not.toThrow();
    expect(() => validateCommandResult({commandId: id + 'x'})).toThrow();
    expect(() => runtime.restore({revision: 1, paused: true, items: [{...item, receipt: {commandId: id + 'x'}}], receipts: []})).toThrow();
});

it('retains active command ownership through query-window pressure and settles from its exact native history echo', async () => {
    const f = fixture({commandId: 'active-native', status: 'running', output: 'Started'}), view = f.open(); await view.read();
    await view.command('compact', '', undefined, '/compact', 'operation');
    for (let i = 0; i < 70; ++i) await view.queryCommand('session:status', '', `query-${i}`, {kind: 'action', execution: 'query'});
    expect(view.snapshot()).toMatchObject({active: true, canSend: false});
    expect(f.record()?.commandResults?.find(row => row.commandId === 'active-native')?.status).toBe('running');
    vi.mocked(f.peer.read).mockResolvedValue({session, turns: [{items: [{id: 'command:other', type: 'systemMessage', text: 'Unrelated', status: 'completed'}]}]});
    expect((await view.read()).active).toBe(true);
    vi.mocked(f.peer.read).mockResolvedValue({session, turns: [{items: [{id: 'command:active-native', type: 'systemMessage', text: 'Native completion', status: 'completed'}]}]});
    expect(await view.read()).toMatchObject({active: false, canSend: true}); await view.close();
});

it('never consumes the local draft or confirms its pending request from another committed operation', async () => {
    const f = fixture({commandId: 'unused'}), view = f.open(); await view.read(); await view.saveDraft('/compact');
    f.peer.command = vi.fn(async () => decodeCommittedResult({requestId: 'foreign', outcome: 'committed', result: {private: 'PRIVATE_BODY'}}, () => {throw new Error('Bad envelope');}));
    await expect(view.command('compact', '', undefined, '/compact', 'local')).rejects.toMatchObject({outcome: 'committed', requestId: 'foreign'});
    expect(view.snapshot()).toMatchObject({draft: '/compact', pending: true, submission: {id: 'local', status: 'pending'}});
    expect(view.snapshot().resultError).toBeUndefined(); await view.close();
});

it('keeps private committed receipts and original storage exceptions outside result diagnostics', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {}), f = fixture({commandId: '', output: 'PRIVATE_RESULT_BODY'}), view = f.open();
    try {
        await view.read(); await view.command('compact', '', undefined, '/compact', 'operation');
        const diagnostics = JSON.stringify(warn.mock.calls);
        expect(diagnostics).toContain('HARNESS_COMMITTED_RESULT_INVALID'); expect(diagnostics).not.toContain('PRIVATE_RESULT_BODY');
        const error = await f.native.command('native', 'session', 'compact', '', {requestId: 'other'}).catch(error => error);
        expect(JSON.stringify(error)).not.toContain('PRIVATE_RESULT_BODY'); expect(Object.getOwnPropertyNames(error)).not.toContain('committedReceipt');
    } finally {warn.mockRestore(); await view.close();}
});
