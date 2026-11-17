import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { analysisPopoverPlacement } from '../web/analysis-popover.js';

function popoverFixture(native = false, options = {}) {
    const documentHandlers = new Map(),
        windowHandlers = new Map();
    let focused = null,
        dismissals = 0;
    class Node {
        constructor(height = 400) {
            this.height = height;
            this.hidden = true;
            this.attributes = {};
            this.dataset = {};
            this.events = new Map();
            this.style = {
                setProperty(name, value) {
                    this[name] = value;
                }
            };
        }
        setAttribute(name, value) {
            this.attributes[name] = value;
        }
        addEventListener(name, handler) {
            this.events.set(name, handler);
        }
        getBoundingClientRect() {
            const left = this.left ?? 250;
            const width = Number.parseFloat(this.style.width) || 100;
            return {
                left,
                right: left + width,
                top: 100,
                bottom: 130,
                width,
                height: Math.min(this.height, Number.parseFloat(this.style.maxHeight) || this.height)
            };
        }
        contains(node) {
            return node === this;
        }
        querySelector() {
            return {
                focus: () => {
                    focused = 'content';
                }
            };
        }
        focus() {
            focused = 'trigger';
        }
        matches() {
            return this.nativeOpen;
        }
        showPopover() {
            this.nativeOpen = true;
        }
        hidePopover() {
            this.nativeOpen = false;
            this.events.get('toggle')?.({ newState: 'closed' });
        }
    }
    class Element {}
    if (native) Object.defineProperty(Element.prototype, 'popover', { value: '' });
    const viewport = { innerWidth: 390, innerHeight: 380, addEventListener: (name, handler) => windowHandlers.set(name, handler) };
    const context = vm.createContext({
        HTMLElement: Element,
        CSS: { supports: () => native },
        document: { addEventListener: (name, handler) => documentHandlers.set(name, handler) },
        window: viewport
    });
    const source = readFileSync(new URL('../web/analysis-popover.js', import.meta.url), 'utf8').replace(/^export /gm, '');
    vm.runInContext(source + '\nthis.createPopover = createAnalysisPopover;', context);
    const trigger = new Node(30),
        panel = new Node();
    const popup = context.createPopover(trigger, panel, {
        width: 760,
        ...options,
        onDismiss: () => {
            dismissals++;
        }
    });
    return {
        trigger,
        panel,
        popup,
        viewport,
        documentHandlers,
        windowHandlers,
        get focused() {
            return focused;
        },
        get dismissals() {
            return dismissals;
        }
    };
}

test('analysis popover placement flips at edges and clamps short viewports without page scrolling', () => {
    expect(analysisPopoverPlacement({ left: 10, top: 20, bottom: 50 }, 300, 200, 390, 740)).toEqual({ left: 16, top: 56 });
    expect(analysisPopoverPlacement({ left: 300, top: 600, bottom: 630 }, 300, 200, 390, 740)).toEqual({ left: 74, top: 394 });
    expect(analysisPopoverPlacement({ left: 100, top: 160, bottom: 190 }, 358, 348, 390, 380)).toEqual({ left: 16, top: 16 });
});

test('native anchors yield to the manual viewport inset on narrow gutters and oversized inline spans', () => {
    const fixture = popoverFixture(true),
        { popup, panel, trigger, viewport } = fixture;
    viewport.innerWidth = 1200;
    viewport.innerHeight = 1000;
    popup.setOpen(true);
    expect(panel.dataset.anchorLayout).toBe('true');
    viewport.innerWidth = 390;
    viewport.innerHeight = 740;
    trigger.left = 14;
    popup.position();
    expect(panel.dataset.anchorLayout).toBe('false');
    expect(panel.style.left).toBe('16px');
    trigger.left = 180;
    popup.position();
    expect(panel.dataset.anchorLayout).toBe('false');
    expect(panel.style.left).toBe('16px');
});

test('record popovers stay compact in tall windows and shrink to shorter viewport bounds', () => {
    const { popup, panel, viewport } = popoverFixture(true, { width: 440, maxHeight: 360 });
    viewport.innerWidth = 1440;
    viewport.innerHeight = 1000;
    popup.setOpen(true);
    expect([panel.style.width, panel.style.maxHeight]).toEqual(['440px', '360px']);
    viewport.innerWidth = 320;
    viewport.innerHeight = 300;
    popup.position();
    expect([panel.style.width, panel.style.maxHeight]).toEqual(['288px', '268px']);
});

for (const native of [false, true])
    test(`analysis popover ${native ? 'native' : 'fallback'} keeps bounds, dismisses and restores keyboard focus`, () => {
        const fixture = popoverFixture(native),
            { trigger, panel, popup, documentHandlers } = fixture;
        popup.setOpen(true, { focus: true });
        expect(panel.hidden).toBe(false);
        expect(trigger.attributes['aria-expanded']).toBe('true');
        expect([panel.style.width, panel.style.maxHeight, panel.style.left, panel.style.top]).toEqual(['358px', '348px', '16px', '16px']);
        expect(fixture.focused).toBe('content');
        expect(panel.dataset.anchorLayout).toBe('false');
        documentHandlers.get('pointerdown')({ target: panel });
        expect(popup.isOpen).toBe(true);
        let prevented = false;
        documentHandlers.get('keydown')({
            key: 'Escape',
            preventDefault() {
                prevented = true;
            },
            stopPropagation() {}
        });
        expect(prevented).toBe(true);
        expect(panel.hidden).toBe(true);
        expect(trigger.attributes['aria-expanded']).toBe('false');
        expect(fixture.focused).toBe('trigger');
        expect(fixture.dismissals).toBe(1);
        popup.setOpen(true);
        documentHandlers.get('pointerdown')({ target: {} });
        expect(popup.isOpen).toBe(false);
        expect(fixture.dismissals).toBe(2);
        if (native) {
            popup.setOpen(true);
            panel.nativeOpen = false;
            panel.events.get('toggle')({ newState: 'closed' });
            expect(panel.hidden).toBe(true);
            expect(popup.isOpen).toBe(false);
        }
    });
