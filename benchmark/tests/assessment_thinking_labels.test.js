import { expect, test } from 'bun:test';
import { placeThinkingLabels } from '../web/chart-layout.js';

test('all Thinking labels in a dense top-score cluster have distinct anchored placements', () => {
    const levels = ['default', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
    const candidates = levels.map((level, i) => ({ id: level, x: 160 + i * 2, y: 40, width: level.length * 7 }));
    const layout = placeThinkingLabels(candidates, { left: 40, right: 330, top: 38, bottom: 340 });
    expect(layout).toHaveLength(levels.length);
    expect(new Set(layout.map(label => label.id)).size).toBe(levels.length);
    for (const label of layout) {
        expect(label.distance).toBeLessThanOrEqual(110);
        expect(label.endX).toBeGreaterThanOrEqual(label.box.x);
        expect(label.endX).toBeLessThanOrEqual(label.box.x + label.box.w);
        expect(label.box.y).toBeGreaterThanOrEqual(38);
    }
    for (let i = 0; i < layout.length; i++)
        for (let j = i + 1; j < layout.length; j++) {
            const a = layout[i].box,
                b = layout[j].box;
            expect(a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y).toBe(false);
        }
});
