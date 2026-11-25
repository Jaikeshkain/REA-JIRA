/**
 * Atlassian Document Format helpers. Descriptions and comments are stored as ADF JSON
 * (observed: doc → paragraph/bulletList/listItem/text + marks, JIRA_REQUIREMENTS §2.2, §8.1).
 */
export type AdfNode = { type: string; text?: string; content?: AdfNode[]; attrs?: Record<string, unknown>; marks?: { type: string }[] };

const ALLOWED = new Set([
  'doc', 'paragraph', 'text', 'heading', 'bulletList', 'orderedList', 'listItem', 'codeBlock', 'blockquote',
  'hardBreak', 'rule', 'mention',
]);
const MARKS = new Set(['strong', 'em', 'code', 'strike', 'underline', 'link']);

/** Drop unknown node/mark types and cap size so stored documents stay renderable and safe. */
export function sanitizeAdf(input: unknown): AdfNode | null {
  if (input == null) return null;
  if (typeof input === 'string') return textToAdf(input);
  const walk = (n: any, depth: number): AdfNode | null => {
    if (!n || typeof n !== 'object' || depth > 20 || !ALLOWED.has(n.type)) return null;
    const out: AdfNode = { type: n.type };
    if (n.type === 'text') {
      out.text = String(n.text ?? '').slice(0, 20000);
      const marks = Array.isArray(n.marks) ? n.marks.filter((m: any) => MARKS.has(m?.type)) : [];
      if (marks.length) {
        out.marks = marks.map((m: any) =>
          m.type === 'link' && /^https?:\/\//.test(m.attrs?.href ?? '') ? { type: 'link', attrs: { href: m.attrs.href } } : { type: m.type },
        );
      }
    }
    if (n.type === 'heading') out.attrs = { level: Math.min(6, Math.max(1, Number(n.attrs?.level) || 1)) };
    if (n.type === 'mention') out.attrs = { id: String(n.attrs?.id ?? ''), text: String(n.attrs?.text ?? '') };
    if (Array.isArray(n.content)) out.content = n.content.map((c: any) => walk(c, depth + 1)).filter(Boolean) as AdfNode[];
    return out;
  };
  const doc = walk(input, 0);
  if (!doc || doc.type !== 'doc') return null;
  return { ...doc, attrs: undefined, ...{ version: 1 } } as AdfNode;
}

/** Plain text → ADF: blank-line separated paragraphs, lines starting "- " become bullet lists. */
export function textToAdf(text: string): AdfNode {
  const blocks = text.replace(/\r\n/g, '\n').split(/\n{2,}/).filter((b) => b.trim());
  const content: AdfNode[] = blocks.map((block) => {
    const lines = block.split('\n');
    if (lines.every((l) => /^\s*[-*] /.test(l))) {
      return {
        type: 'bulletList',
        content: lines.map((l) => ({
          type: 'listItem',
          content: [{ type: 'paragraph', content: [{ type: 'text', text: l.replace(/^\s*[-*] /, '') }] }],
        })),
      };
    }
    return { type: 'paragraph', content: [{ type: 'text', text: lines.join('\n') }] };
  });
  return { type: 'doc', content, ...{ version: 1 } } as AdfNode;
}

export function adfToText(doc: AdfNode | null | undefined): string {
  if (!doc) return '';
  const parts: string[] = [];
  const walk = (n: AdfNode) => {
    if (n.type === 'text') parts.push(n.text ?? '');
    n.content?.forEach(walk);
    if (['paragraph', 'heading', 'listItem', 'codeBlock'].includes(n.type)) parts.push('\n');
  };
  walk(doc);
  return parts.join('').trim();
}
