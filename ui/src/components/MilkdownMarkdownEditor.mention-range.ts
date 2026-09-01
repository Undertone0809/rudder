type MentionRangeTarget = {
  trigger: "@" | "$";
  query: string;
  textNode: Text;
  atPos: number;
  endPos: number;
};

type MentionRangeView = {
  state: { selection: { from: number; to: number } };
  posAtDOM?: (node: Node, offset: number) => number;
};

export function resolveMentionReplacementRange(
  view: MentionRangeView,
  target: MentionRangeTarget,
  readText: (from: number, to: number) => string,
) {
  const search = `${target.trigger}${target.query}`;
  const replacementRange = (from: number, to: number) => ({
    from,
    to: /^\s$/u.test(readText(to, to + 1)) ? to + 1 : to,
  });
  if (view.posAtDOM) {
    try {
      const from = view.posAtDOM(target.textNode, target.atPos);
      const to = view.posAtDOM(target.textNode, target.endPos);
      if (from <= to && readText(from, to) === search) return replacementRange(from, to);
    } catch {
      // ProseMirror may redraw and detach the saved DOM node before selection.
    }
  }

  const { from, to } = view.state.selection;
  const start = Math.max(0, from - search.length);
  return readText(start, to) === search ? replacementRange(start, to) : null;
}
