import type {HarnessCommandRecord, HarnessCommandOutput, HarnessCommandResult} from './contracts';
import type {HarnessMessage} from './conversation-model';
import {FSError} from '@itookit/vfs-core';

export function commandResultIssue(records: readonly HarnessCommandRecord[]) {
    const row = records.find(row => row.resultError && row.operationId);
    return row ? {operationId: row.operationId!, code: row.resultError!.code} : undefined;
}

export function replaceCommandRecord(records: readonly HarnessCommandRecord[], next: HarnessCommandRecord): HarnessCommandRecord[] {
    const result = [...records.filter(row => !(next.operationId && row.operationId === next.operationId)
        && !(next.commandId && row.commandId === next.commandId)), next];
    while (result.length > 64) {
        const index = result.findIndex(row => row !== next && !row.resultError && row.status !== 'running');
        if (index < 0) throw new FSError('EFBIG', 'Too many unresolved committed command results');
        result.splice(index, 1);
    }
    return result;
}

export function bindCommandOutput(result: HarnessCommandResult, operationId: string | undefined, epoch: string | undefined): HarnessCommandResult {
    if (result.outputRef && (operationId && result.outputRef.requestId !== operationId || epoch && result.outputRef.epoch !== epoch)) {
        const {outputRef, ...rest} = result;
        return {...rest, outputError: {code: 'HARNESS_COMMAND_OUTPUT_REFERENCE_MISMATCH', bytes: outputRef.bytes}};
    }
    return result;
}

export function commandOutputView(record: HarnessCommandRecord): HarnessCommandOutput | undefined {
    if (!record.commandId || !record.outputRef && !record.outputError) return;
    return {commandId: record.commandId, ...(record.outputRef ? {ref: {...record.outputRef}} : {}),
        ...(record.outputError ? {unavailable: {...record.outputError}} : {}),
        truncated: !!record.outputError || (record.outputRef?.bytes ?? 0) > new TextEncoder().encode(record.output ?? '').length};
}

export function projectCommandMessage(message: HarnessMessage, records: readonly HarnessCommandRecord[]): HarnessMessage {
    const record = records.find(row => row.commandId && message.id === `command:${row.commandId}`);
    const commandOutput = record && commandOutputView(record);
    return commandOutput ? {...message, text: record!.output ?? '', contentParts: undefined, commandOutput} : {...message};
}

export function commandRecordMessage(row: HarnessCommandRecord): HarnessMessage | undefined {
    if (row.resultError && row.operationId) return {id: `command-operation:${row.operationId}`, role: 'system', status: 'result-invalid',
        text: 'Native operation committed; its result identity or completion could not be confirmed.'};
    if (!row.commandId) return;
    return {id: `command:${row.commandId}`, role: 'system', text: row.output ?? '',
        status: row.failed ? 'failed' : row.status === 'running' ? 'running' : 'completed', commandOutput: commandOutputView(row)};
}

export function commandOutputDiagnostic(operationId: string | undefined, stage: string, started: number, issue: {code?: unknown; bytes?: number}): void {
    const code = typeof issue.code === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(issue.code) ? issue.code : 'COMMAND_OUTPUT_FAILED';
    console.warn('[Harness] Native command result', {operation: 'harness.command.result', operationId, stage, outcome: 'failure',
        durationMs: Date.now() - started, code, ...(issue.bytes !== undefined ? {bytes: issue.bytes} : {})});
}
