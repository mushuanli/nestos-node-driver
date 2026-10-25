import {FSError} from '@itookit/vfs-core';
import type {HarnessSlashCommand, HarnessCommandResult, HarnessCommandCatalog, HarnessCommandRecord} from './contracts';
import {COMMAND_ID_LIMIT, previewOutput, validateCommandOutputRef} from './command-output';

export function validateCommandCatalog(value: unknown): HarnessCommandCatalog {
    const commands = validateCommands(value), observation = (value as HarnessCommandCatalog).observation;
    if (observation === undefined) return {commands};
    if (!observation || typeof observation.complete !== 'boolean'
        || observation.code !== undefined && (typeof observation.code !== 'string' || !/^[A-Z][A-Z0-9_]{0,79}$/.test(observation.code))
        || !observation.complete && !observation.code) throw new FSError('EIO', 'Invalid command catalog observation');
    return {commands, observation: {complete: observation.complete, ...(observation.code ? {code: observation.code} : {})}};
}

export function validateCommandResult(value: unknown): HarnessCommandResult {
    const result = commandEnvelope(value), raw = value as HarnessCommandResult;
    try {return {...result, ...commandOutput(raw)};}
    catch {return {...result, output: '', outputError: {code: 'HARNESS_COMMAND_OUTPUT_INVALID'}};}
}

function commandOutput(raw: HarnessCommandResult): Pick<HarnessCommandResult, 'output' | 'outputRef' | 'outputError'> {
    if (raw.output !== undefined && typeof raw.output !== 'string') throw invalidResult();
    const preview = raw.output === undefined ? undefined : previewOutput(raw.output);
    const result: Pick<HarnessCommandResult, 'output' | 'outputRef' | 'outputError'> = {output: preview?.text};
    if (raw.outputRef !== undefined) result.outputRef = validateCommandOutputRef(raw.outputRef);
    result.outputError = validateOutputIssue(raw.outputError);
    assertOutputReference(result, preview?.bytes ?? 0);
    if (!result.outputRef && !result.outputError && preview?.truncated)
        result.outputError = {code: 'HARNESS_COMMAND_OUTPUT_TOO_LARGE', bytes: preview.bytes};
    return result;
}
function assertOutputReference(result: HarnessCommandResult, previewBytes: number): void {
    if (result.outputRef && (result.outputError || previewBytes > result.outputRef.bytes)) throw invalidResult();
}

function invalidResult(): FSError {return new FSError('EIO', 'Invalid native command result');}
function commandEnvelope(value: unknown): HarnessCommandResult {
    const result = value as HarnessCommandResult;
    if (!result || typeof result !== 'object' || Array.isArray(result) || !validResultIds(result) || !validResultState(result)) throw invalidResult();
    const {turnId, commandId, failed, status} = result;
    return {turnId, commandId, failed, status};
}
function validResultIds(result: HarnessCommandResult): boolean {
    return !!(result.turnId || result.commandId) && [result.turnId, result.commandId].every(id => id === undefined || validNativeId(id));
}
function validNativeId(id: unknown): boolean {
    return typeof id === 'string' && !!id.trim() && !id.includes('\0') && id.length <= COMMAND_ID_LIMIT;
}
function validResultState(result: HarnessCommandResult): boolean {
    return (result.status === undefined || ['running', 'completed'].includes(result.status)) && (result.failed === undefined || typeof result.failed === 'boolean');
}

function validateOutputIssue(value: unknown): import('./contracts').HarnessCommandOutputIssue | undefined {
    if (value === undefined) return;
    const issue = value as import('./contracts').HarnessCommandOutputIssue;
    if (!issue || typeof issue !== 'object' || typeof issue.code !== 'string' || !/^[A-Z][A-Z0-9_]{0,79}$/.test(issue.code)
        || issue.bytes !== undefined && (!Number.isSafeInteger(issue.bytes) || issue.bytes < 0)) throw invalidResult();
    return {code: issue.code, ...(issue.bytes !== undefined ? {bytes: issue.bytes} : {})};
}

export function validateCommandReceipts(value: unknown): HarnessCommandRecord[] {
    if (value === undefined) return [];
    if (!Array.isArray(value) || value.length > 64) throw new FSError('EIO', 'Invalid native command receipts');
    return value.map(readCommandRecord);
}
function readCommandRecord(row: HarnessCommandRecord): HarnessCommandRecord {
    if (row?.resultError) return validateResultFailure(row);
    const result = validateCommandResult(row), operationId = validateOperationId(row?.operationId), operationEpoch = validateOperationEpoch(row?.operationEpoch);
    if ((!result.commandId && !result.turnId) || result.output === undefined) throw new FSError('EIO', 'Invalid native command receipt');
    const record = {...result, ...(operationId ? {operationId} : {}), ...(operationEpoch ? {operationEpoch} : {})};
    return row.query === undefined ? record : {...record, query: validateQuery(row.query, result)};
}
function validateQuery(query: import('./contracts').HarnessCommandQuery, result: HarnessCommandResult): import('./contracts').HarnessCommandQuery {
    if (!query || !validQueryIdentity(query) || !validQueryDefinition(query) || result.commandId !== query.id || result.turnId || result.status !== 'completed')
        throw new FSError('EIO', 'Invalid read-only command receipt');
    return {id: query.id, name: query.name, sessionId: query.sessionId, ...(query.definitionId ? {definitionId: query.definitionId} : {}), ...(query.revision ? {revision: query.revision} : {})};
}
function validQueryIdentity(query: import('./contracts').HarnessCommandQuery): boolean {
    return typeof query.id === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(query.id)
        && typeof query.name === 'string' && /^[\p{L}\p{N}_:.-]{1,128}$/u.test(query.name)
        && validNativeId(query.sessionId);
}
function validQueryDefinition(query: import('./contracts').HarnessCommandQuery): boolean {
    return [query.definitionId, query.revision].every(value => value === undefined || typeof value === 'string' && !!value && value.length <= 256);
}

function validateOperationId(value: unknown): string | undefined {
    if (value === undefined) return;
    if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(value)) throw invalidResult();
    return value;
}

function validateResultFailure(row: HarnessCommandRecord): HarnessCommandRecord {
    const operationId = validateOperationId(row.operationId), issue = validateOutputIssue(row.resultError), operationEpoch = validateOperationEpoch(row.operationEpoch);
    if (!operationId || !operationEpoch || !issue || row.query || row.commandId || row.turnId || row.status || row.failed !== undefined || row.outputRef)
        throw invalidResult();
    return {operationId, operationEpoch, output: '', resultError: {code: issue.code}};
}

function validateOperationEpoch(value: unknown): string | undefined {
    if (value === undefined) return;
    if (typeof value !== 'string' || !value || value.length > 256) throw invalidResult();
    return value;
}

export function validateCommands(value: unknown): HarnessSlashCommand[] {
    const rows = (value as {commands?: unknown})?.commands;
    if (!Array.isArray(rows) || rows.length > 256) throw new FSError('EIO', 'Invalid native command catalog');
    const names = new Set<string>();
    return rows.map(row => {
        if (!row || typeof row.name !== 'string' || !/^[\p{L}\p{N}_:.-]{1,128}$/u.test(row.name)
            || names.has(row.name) || typeof row.description !== 'string' || row.description.length > 4096
            || row.argumentHint !== undefined && (typeof row.argumentHint !== 'string' || row.argumentHint.length > 512)
            || row.execution !== undefined && !['query', 'serial'].includes(row.execution)
            || row.execution === 'query' && row.kind !== 'action'
            || ['id','revision'].some(key => row[key] !== undefined && (typeof row[key] !== 'string' || !row[key] || row[key].length > 256))
            || !['prompt', 'action'].includes(row.kind) || row.disabled !== undefined && typeof row.disabled !== 'boolean') throw new FSError('EIO', 'Invalid native command');
        names.add(row.name);
        return {...(row.id ? {id: row.id} : {}), ...(row.revision ? {revision: row.revision} : {}), ...(row.execution ? {execution: row.execution} : {}), name: row.name, description: row.description, argumentHint: row.argumentHint, kind: row.kind, ...(row.disabled !== undefined ? {disabled: row.disabled} : {})};
    });
}
