import {expect, it} from 'vitest';
import {validateHarnessAttachments, validateHarnessTurnInput} from '../src/harness';
import {readStoredAttachments} from '../src/harness/attachments';

const png = 'data:image/png;base64,iVBORw0KGgo=';
it('validates the public inline contract including Unicode, BOM and image file signatures', () => {
    const files = [{kind: 'text', name: '文件.txt', content: '\ufeff正文\n'}, {kind: 'image', name: 'image.png', content: png, mimeType: 'image/png'}];
    expect(validateHarnessTurnInput('Review', files)).toEqual(files);
    expect(validateHarnessAttachments(undefined)).toEqual([]);
});
it.each([
    [[{kind: 'image', name: 'a.png', content: 'data:image/png;base64,AQID', mimeType: 'image/png'}], 'HARNESS_ATTACHMENT_MIME_MISMATCH'],
    [[{kind: 'image', name: 'a.gif', content: 'data:image/gif;base64,AQID', mimeType: 'image/gif'}], 'HARNESS_ATTACHMENT_FORMAT_UNSUPPORTED'],
    [[{kind: 'text', name: '../a.txt', content: 'text'}], 'HARNESS_ATTACHMENT_NAME_INVALID'],
    [[{kind: 'text', name: 'a.txt', content: '\u009f'}], 'HARNESS_ATTACHMENT_TEXT_ENCODING'],
    [[{kind: 'text', name: 'a.txt', content: '\ud800'}], 'HARNESS_ATTACHMENT_TEXT_ENCODING'],
    [[{kind: 'text', name: 'a.txt', content: '中'.repeat(25000)}], 'HARNESS_ATTACHMENT_TEXT_LIMIT'],
    [[{kind: 'text', name: '中'.repeat(86), content: 'text'}], 'HARNESS_ATTACHMENT_NAME_INVALID'],
    [Array.from({length: 6}, (_, i) => ({kind: 'text', name: `${i}.txt`, content: 'text'})), 'HARNESS_ATTACHMENT_COUNT_LIMIT'],
])('rejects invalid native data with a precise safe classification (%s)', (files, code) => {
    expect(() => validateHarnessAttachments(files)).toThrow(expect.objectContaining({attachmentCode: code, remoteCode: code, code: 'EINVAL', outcome: 'not-committed'}));
});
it('checks image byte and total encoded budgets before any native operation', () => {
    const image = (size: number) => {const bytes = new Uint8Array(size); bytes.set([137, 80, 78, 71, 13, 10, 26, 10]);
        return {kind: 'image', name: 'a.png', mimeType: 'image/png', content: 'data:image/png;base64,' + Buffer.from(bytes).toString('base64')};};
    expect(() => validateHarnessAttachments([image(256 * 1024 + 1)])).toThrow(expect.objectContaining({attachmentCode: 'HARNESS_ATTACHMENT_IMAGE_LIMIT'}));
    expect(() => validateHarnessAttachments([image(250000), {...image(250000), name: 'b.png'}])).toThrow(expect.objectContaining({attachmentCode: 'HARNESS_ATTACHMENT_TOTAL_LIMIT'}));
});
it('validates actual UTF-8 prompt bytes and rejects malformed Unicode', () => {
    for (const text of ['', '  ']) expect(() => validateHarnessTurnInput(text, [])).toThrow(expect.objectContaining({attachmentCode: 'HARNESS_PROMPT_INVALID'}));
    expect(() => validateHarnessTurnInput('中'.repeat(50000), [])).toThrow(expect.objectContaining({attachmentCode: 'HARNESS_PROMPT_LIMIT'}));
    expect(() => validateHarnessTurnInput('\ud800', [])).toThrow(expect.objectContaining({attachmentCode: 'HARNESS_PROMPT_ENCODING'}));
});

it.each([
    {kind: 'image', name: 'a.png', content: 'data:image/png;base64,AQID', mimeType: 'image/png'},
    {kind: 'image', name: 'a.png', content: 'data:image/png;base64,iVBORw0KGgo=,legacy', mimeType: 'image/png'},
    {kind: 'image', name: 'a.png', content: 'data:image/png;base64,iVBORw0KGgp=', mimeType: 'image/png'},
    {kind: 'text', name: 'a.txt', content: '\ud800'},
    {kind: 'text', name: 'a\u009f.txt', content: '\u009f'},
])('preserves legacy stored bytes without allowing them into new native calls (%s)', file => {
    const stored = [file];
    expect(readStoredAttachments(stored)).toEqual(stored);
    expect(readStoredAttachments(stored)).not.toBe(stored);
    expect(() => validateHarnessAttachments(stored)).toThrow();
});

it('keeps existing storage shape and capacity constraints during recovery', () => {
    for (const files of [[{kind: 'text', name: '../a.txt', content: 'text'}], [{kind: 'text', name: 'a.txt', content: 'x'.repeat(65537)}], {}])
        expect(() => readStoredAttachments(files)).toThrow();
});
