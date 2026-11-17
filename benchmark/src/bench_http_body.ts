/** Bound streamed HTTP bodies before JSON parsing, independently of service composition. */
export async function readBenchLimitedBody(stream: ReadableStream<Uint8Array> | null, limit: number): Promise<Uint8Array> {
    if (!stream) return new Uint8Array();
    const reader = stream.getReader(),
        chunks: Uint8Array[] = [];
    let length = 0;
    try {
        while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            length += value.length;
            if (length > limit) {
                await reader.cancel();
                throw new TypeError('request body exceeds size limit');
            }
            chunks.push(value);
        }
    } finally {
        reader.releaseLock();
    }
    const result = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
        result.set(chunk, offset);
        offset += chunk.length;
    }
    return result;
}
