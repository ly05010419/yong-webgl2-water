// Two helpers the demo builds its whole DOM out of. Deliberately tiny: the
// point is that `panel.ts` reads as a description of the panel rather than as
// three hundred lines of `document.createElement` plus `appendChild`.

/** Attributes `element()` understands beyond `class` and `text`. */
export interface ElementOptions {
  readonly className?: string;
  readonly text?: string;
  readonly attributes?: Readonly<Record<string, string>>;
  readonly children?: readonly Node[];
}

/**
 * One element, with its class, text, attributes and children applied in that
 * order. `text` is written through `textContent`, never `innerHTML`, so no
 * caller can smuggle markup in through a label or a metric value.
 */
export function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  options: ElementOptions = {},
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (options.className !== undefined) node.className = options.className;
  if (options.text !== undefined) node.textContent = options.text;
  for (const [name, value] of Object.entries(options.attributes ?? {})) node.setAttribute(name, value);
  for (const child of options.children ?? []) node.append(child);
  return node;
}

/** A `<section>` with the panel's uppercase label above its body. */
export function labelledSection(label: string, ...body: readonly Node[]): HTMLElement {
  return element("section", {
    children: [element("span", { className: "label", text: label }), ...body],
  });
}
