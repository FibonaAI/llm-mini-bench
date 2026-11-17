function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
/** Extract visible Responses message text only, never hidden reasoning. */
export function calibration_visible_text(payload: unknown): string {
    if (!record(payload)) return '';
    if (typeof payload.output_text === 'string') return payload.output_text;
    if (!Array.isArray(payload.output)) return '';
    let text = '';
    for (const item of payload.output) {
        if (!record(item) || item.type !== 'message' || !Array.isArray(item.content)) continue;
        for (const part of item.content) if (record(part) && part.type === 'output_text' && typeof part.text === 'string') text += part.text;
    }
    return text;
}
/** Parse explicit finite nonnegative per-token prices; missing is not free. */
export function calibration_price(value: unknown): number {
    if ((typeof value !== 'number' && typeof value !== 'string') || (typeof value === 'string' && !value.trim())) throw new TypeError('Calibration requires explicit per-token catalog pricing');
    const text = typeof value === 'string' ? value.trim() : null;
    if (text !== null && !/^[+-]?(?:\d(?:_?\d)*(?:\.(?:\d(?:_?\d)*)?)?|\.\d(?:_?\d)*)(?:[eE][+-]?\d(?:_?\d)*)?$/.test(text)) throw new TypeError('Calibration requires explicit per-token catalog pricing');
    const price = text === null ? value as number : Number(text.replaceAll('_', ''));
    if (!Number.isFinite(price) || price < 0) throw new TypeError('Calibration requires finite nonnegative catalog pricing');
    return price;
}
