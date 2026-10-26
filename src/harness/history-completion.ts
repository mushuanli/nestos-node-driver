import {sha256} from '@itookit/vfs-sync';
import type {HarnessHistory, HarnessTurnSubmissionEvidence} from './contracts';
import type {HarnessInstruction} from './instruction-queue';
interface TerminalTurn {id: string; status: 'completed' | 'failed' | 'interrupted' | 'cancelled'; submissionEvidence: HarnessTurnSubmissionEvidence}
const row = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const integer = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
async function promptDigest(text: string): Promise<string | undefined> {
    const bytes = new TextEncoder().encode(text);
    return bytes.length <= 128 * 1024 && new TextDecoder('utf-8', {ignoreBOM: true}).decode(bytes) === text ? sha256(bytes) : undefined;
}
function invalid(code = 'HARNESS_HISTORY_EVIDENCE_INVALID'): Error {return Object.assign(new Error(code), {code});}

/** Evidence is optional; malformed declared evidence cannot be downgraded to ordinary history. */
export function terminalTurn(value: unknown): TerminalTurn | undefined {
    if (!row(value) || value.submissionEvidence === undefined) return;
    const evidence = value.submissionEvidence;
    const fields: Record<keyof HarnessTurnSubmissionEvidence, (value: unknown) => boolean> = {
        version: value => value === 1,
        requestId: value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(value),
        promptSha256: value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value),
        startSequence: integer, endSequence: integer,
    };
    if (typeof value.id !== 'string' || !value.id || value.id.length > 1024
        || !['completed', 'failed', 'interrupted', 'cancelled'].includes(String(value.status)) || !row(evidence)) throw invalid();
    for (const [name, valid] of Object.entries(fields)) if (!valid(evidence[name])) throw invalid();
    if (Number(evidence.endSequence) <= Number(evidence.startSequence)) throw invalid();
    return value as unknown as TerminalTurn;
}

function admittedPrompt(item: HarnessInstruction): boolean {
    return ['dispatching', 'uncertain'].includes(item.state) && item.receipt?.turnId === (item.attemptId ?? item.id)
        && !item.attachments.length && item.commandKind === undefined;
}

/** Match an already admitted, attachment-free prompt. Never recover from matching reply text. */
export async function recoverHistoryCompletions(history: HarnessHistory, sessionId: string, items: readonly HarnessInstruction[]) {
    if (history.session.id !== sessionId) throw invalid('HARNESS_HISTORY_SCOPE_MISMATCH');
    const turns = (history.turns ?? []).flatMap(value => {const turn = terminalTurn(value); return turn ? [turn] : [];});
    const result: Array<{turnId: string; nativeTurnId: string; status: TerminalTurn['status']}> = [];
    for (const item of items) {
        const requestId = item.attemptId ?? item.id;
        if (!admittedPrompt(item)) continue;
        const matching = turns.filter(turn => turn.submissionEvidence.requestId === requestId);
        if (matching.length !== 1 || matching[0].submissionEvidence.promptSha256 !== await promptDigest(item.text)) continue;
        result.push({turnId: requestId, nativeTurnId: matching[0].id, status: matching[0].status});
    }
    return result;
}
