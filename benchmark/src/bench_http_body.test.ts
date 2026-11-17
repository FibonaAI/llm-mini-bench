import { expect, test } from 'bun:test';
import { readBenchLimitedBody } from './bench_http_body.ts';

test('bounded HTTP body preserves chunk bytes at the exact limit and releases the reader', async () => {
    const chunks = [new Uint8Array([0xe4, 0xbd]), new Uint8Array([0xa0, 0x21])];
    const stream = new ReadableStream<Uint8Array>({ start(controller) { chunks.forEach(chunk => controller.enqueue(chunk)); controller.close(); } });
    expect(await readBenchLimitedBody(stream, 4)).toEqual(new Uint8Array([0xe4, 0xbd, 0xa0, 0x21]));
    expect(stream.locked).toBe(false);
    expect(await readBenchLimitedBody(null, 4)).toEqual(new Uint8Array());
});

test('bounded HTTP body cancels overflow before parsing and releases the reader', async () => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
        start(controller) { controller.enqueue(new Uint8Array(3)); controller.enqueue(new Uint8Array(3)); },
        cancel() { cancelled = true; }
    });
    await expect(readBenchLimitedBody(stream, 4)).rejects.toThrow('request body exceeds size limit');
    expect(cancelled).toBe(true);
    expect(stream.locked).toBe(false);
});

test('bounded HTTP body releases its reader when the source fails', async () => {
    const stream = new ReadableStream<Uint8Array>({ pull() { throw new Error('stream fixture failed'); } });
    await expect(readBenchLimitedBody(stream, 4)).rejects.toThrow('stream fixture failed');
    expect(stream.locked).toBe(false);
});
