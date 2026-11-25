/**
 * JQL subset → parameterised SQL (JIRA_REQUIREMENTS §3.6).
 * Supports: = != ~ !~ > >= < <= IN, NOT IN, IS [NOT] EMPTY|NULL; AND / OR / NOT; parentheses;
 * ORDER BY f [ASC|DESC], ...; functions currentUser(), now(), startOfDay(), endOfDay(), startOfWeek(),
 * startOfMonth(); relative dates like "-7d", "2w"; membersOf() is not yet supported.
 */
import { bad } from './http.js';

type Tok =
  | { k: 'word'; v: string }
  | { k: 'str'; v: string }
  | { k: 'op'; v: string }
  | { k: 'lp' } | { k: 'rp' } | { k: 'comma' };

export function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) { i++; continue; }
    if (c === '(') { out.push({ k: 'lp' }); i++; continue; }
    if (c === ')') { out.push({ k: 'rp' }); i++; continue; }
    if (c === ',') { out.push({ k: 'comma' }); i++; continue; }
    if (c === '"' || c === "'") {
      let j = i + 1, v = '';
      while (j < src.length && src[j] !== c) {
        if (src[j] === '\\' && j + 1 < src.length) { v += src[j + 1]; j += 2; continue; }
        v += src[j++];
      }
      if (j >= src.length) throw bad(`JQL: unterminated string starting at ${i}`);
      out.push({ k: 'str', v });
      i = j + 1;
      continue;
    }
    const two = src.slice(i, i + 2);
    if (['!=', '!~', '>=', '<='].includes(two)) { out.push({ k: 'op', v: two }); i += 2; continue; }
    if ('=~<>'.includes(c)) { out.push({ k: 'op', v: c }); i++; continue; }
    const m = /^[A-Za-z0-9_.\-+\[\]@]+/.exec(src.slice(i));
    if (!m) throw bad(`JQL: unexpected character '${c}' at ${i}`);
    out.push({ k: 'word', v: m[0] });
    i += m[0].length;
  }
  return out;
}

export type Value = { kind: 'lit'; v: string } | { kind: 'fn'; name: string; args: string[] } | { kind: 'empty' };
export type Node =
  | { t: 'and' | 'or'; l: Node; r: Node }
  | { t: 'not'; e: Node }
  | { t: 'clause'; field: string; op: string; values: Value[] };
export interface Query { where: Node | null; orderBy: { field: string; dir: 'ASC' | 'DESC' }[] }

export function parse(src: string): Query {
  const toks = tokenize(src);
  let p = 0;
  const peek = () => toks[p];
  const isWord = (w: string) => peek()?.k === 'word' && (peek() as any).v.toUpperCase() === w;
  const eatWord = (w: string) => { if (!isWord(w)) throw bad(`JQL: expected ${w}`); p++; };

  const value = (): Value => {
    const t = toks[p++];
    if (!t) throw bad('JQL: expected a value');
    if (t.k === 'str') return { kind: 'lit', v: t.v };
    if (t.k !== 'word') throw bad('JQL: expected a value');
    const up = t.v.toUpperCase();
    if (up === 'EMPTY' || up === 'NULL') return { kind: 'empty' };
    if (peek()?.k === 'lp') {
      p++;
      const args: string[] = [];
      while (peek() && peek().k !== 'rp') {
        const a = toks[p++];
        if (a.k === 'str' || a.k === 'word') args.push(a.v);
        if (peek()?.k === 'comma') p++;
      }
      if (peek()?.k !== 'rp') throw bad('JQL: missing ) after function arguments');
      p++;
      return { kind: 'fn', name: t.v.toLowerCase(), args };
    }
    return { kind: 'lit', v: t.v };
  };

  const clause = (): Node => {
    const f = toks[p++];
    if (!f || (f.k !== 'word' && f.k !== 'str')) throw bad('JQL: expected a field name');
    const field = f.v.toLowerCase();
    let op: string;
    const t = peek();
    if (t?.k === 'op') { op = t.v; p++; }
    else if (isWord('IN')) { p++; op = 'in'; }
    else if (isWord('NOT')) { p++; eatWord('IN'); op = 'not in'; }
    else if (isWord('IS')) { p++; if (isWord('NOT')) { p++; op = 'is not'; } else op = 'is'; }
    else throw bad(`JQL: expected an operator after '${f.v}'`);
    let values: Value[];
    if ((op === 'in' || op === 'not in') && peek()?.k === 'word' && toks[p + 1]?.k === 'lp') {
      // list-valued function, e.g. "sprint in openSprints()"
      values = [value()];
    } else if (op === 'in' || op === 'not in') {
      if (peek()?.k !== 'lp') throw bad(`JQL: expected ( after ${op.toUpperCase()}`);
      p++;
      values = [];
      while (peek() && peek().k !== 'rp') {
        values.push(value());
        if (peek()?.k === 'comma') p++;
      }
      if (peek()?.k !== 'rp') throw bad('JQL: missing )');
      p++;
    } else values = [value()];
    if ((op === 'is' || op === 'is not') && values[0].kind !== 'empty') throw bad('JQL: IS must be followed by EMPTY');
    return { t: 'clause', field, op, values };
  };

  const primary = (): Node => {
    if (isWord('NOT')) { p++; return { t: 'not', e: primary() }; }
    if (peek()?.k === 'lp') {
      p++;
      const e = or();
      if (peek()?.k !== 'rp') throw bad('JQL: missing )');
      p++;
      return e;
    }
    return clause();
  };
  const and = (): Node => {
    let l = primary();
    while (isWord('AND')) { p++; l = { t: 'and', l, r: primary() }; }
    return l;
  };
  const or = (): Node => {
    let l = and();
    while (isWord('OR')) { p++; l = { t: 'or', l, r: and() }; }
    return l;
  };

  let where: Node | null = null;
  if (peek() && !isWord('ORDER')) where = or();
  const orderBy: Query['orderBy'] = [];
  if (isWord('ORDER')) {
    p++;
    eatWord('BY');
    do {
      if (peek()?.k === 'comma') p++;
      const f = toks[p++];
      if (!f || (f.k !== 'word' && f.k !== 'str')) throw bad('JQL: expected field after ORDER BY');
      let dir: 'ASC' | 'DESC' = 'ASC';
      if (isWord('ASC')) p++;
      else if (isWord('DESC')) { p++; dir = 'DESC'; }
      orderBy.push({ field: f.v.toLowerCase(), dir });
    } while (peek()?.k === 'comma');
  }
  if (p < toks.length) throw bad(`JQL: unexpected '${(toks[p] as any).v ?? toks[p].k}'`);
  return { where, orderBy };
}

// ---------------------------------------------------------------- compile

export interface Ctx { userId: number; tenantId: number; isSiteAdmin: boolean }

const ORDER_COLUMNS: Record<string, string> = {
  key: 'p.key, i.number', issuekey: 'p.key, i.number', created: 'i.created_at', updated: 'i.updated_at',
  // Jira: "ORDER BY priority DESC" puts Highest first; Highest has the smallest position
  duedate: 'i.due_date', summary: 'i.summary', priority: '(-pr.position)', status: 's.position',
  assignee: 'a.display_name', reporter: 'r.display_name', rank: 'i.rank', type: 't.name', issuetype: 't.name',
  resolution: 'i.resolution', project: 'p.key', sprint: 'sp.start_date', storypoints: 'i.story_points',
};

const CATEGORY: Record<string, string> = {
  'to do': 'todo', todo: 'todo', new: 'todo', 'in progress': 'in_progress', indeterminate: 'in_progress',
  done: 'done', complete: 'done',
};

export const FROM = `
  FROM issues i
  JOIN projects p ON p.id = i.project_id
  JOIN statuses s ON s.id = i.status_id
  JOIN issue_types t ON t.id = i.type_id
  LEFT JOIN priorities pr ON pr.id = i.priority_id
  LEFT JOIN users a ON a.id = i.assignee_id
  LEFT JOIN users r ON r.id = i.reporter_id
  LEFT JOIN sprints sp ON sp.id = i.sprint_id`;

export function compile(q: Query, ctx: Ctx, params: unknown[]): { where: string; order: string } {
  const P = (v: unknown) => { params.push(v); return `$${params.length}`; };

  const dateExpr = (v: Value): string => {
    if (v.kind === 'fn') {
      const map: Record<string, string> = {
        'now': 'now()', 'startofday': "date_trunc('day', now())", 'endofday': "date_trunc('day', now()) + interval '1 day' - interval '1 ms'",
        'startofweek': "date_trunc('week', now())", 'startofmonth': "date_trunc('month', now())",
        'endofweek': "date_trunc('week', now()) + interval '7 days' - interval '1 ms'",
        'endofmonth': "date_trunc('month', now()) + interval '1 month' - interval '1 ms'",
      };
      const sql = map[v.name];
      if (!sql) throw bad(`JQL: unsupported function ${v.name}() for dates`);
      return sql;
    }
    if (v.kind !== 'lit') throw bad('JQL: expected a date');
    const rel = /^([+-]?\d+)([mhdw])$/i.exec(v.v);
    if (rel) {
      const unit = { m: 'minutes', h: 'hours', d: 'days', w: 'weeks' }[rel[2].toLowerCase() as 'm'];
      return `(now() + ${P(`${rel[1]} ${unit}`)}::interval)`;
    }
    if (!/^\d{4}-\d{2}-\d{2}( \d{2}:\d{2})?$/.test(v.v)) throw bad(`JQL: invalid date '${v.v}'`);
    return `${P(v.v)}::timestamptz`;
  };

  const userExpr = (v: Value): string => {
    if (v.kind === 'fn') {
      if (v.name === 'currentuser') return P(ctx.userId);
      throw bad(`JQL: unsupported function ${v.name}() for users`);
    }
    if (v.kind !== 'lit') throw bad('JQL: expected a user');
    if (/^\d+$/.test(v.v)) return P(Number(v.v));
    return `(SELECT id FROM users WHERE tenant_id = ${P(ctx.tenantId)} AND (lower(email) = lower(${P(v.v)}) OR lower(display_name) = lower(${P(v.v)})) LIMIT 1)`;
  };

  const lit = (v: Value) => {
    if (v.kind !== 'lit') throw bad('JQL: expected a value');
    return v.v;
  };

  const clause = (c: Extract<Node, { t: 'clause' }>): string => {
    const { field, op, values } = c;
    const neg = op === '!=' || op === 'not in' || op === 'is not' || op === '!~';
    const isEmpty = op === 'is' || op === 'is not';
    const many = (col: string, fn: (v: Value) => string) => {
      if (isEmpty) return `${col} IS ${op === 'is not' ? 'NOT ' : ''}NULL`;
      if (op === '=' || op === '!=' || op === 'in' || op === 'not in') {
        const list = values.filter((v) => v.kind !== 'empty').map(fn);
        const hasEmpty = values.some((v) => v.kind === 'empty');
        const parts: string[] = [];
        if (list.length) parts.push(`${col} IN (${list.join(', ')})`);
        if (hasEmpty) parts.push(`${col} IS NULL`);
        const pos = parts.length ? `(${parts.join(' OR ')})` : 'FALSE';
        // Jira semantics: != / NOT IN exclude empty values unless EMPTY is listed
        return neg ? `(NOT ${pos} AND ${hasEmpty ? 'TRUE' : `${col} IS NOT NULL`})` : pos;
      }
      throw bad(`JQL: operator ${op} not supported for ${field}`);
    };
    const ci = (col: string) => many(`lower(${col})`, (v) => `lower(${P(lit(v))})`);

    switch (field) {
      case 'project':
        return many('p.key', (v) => {
          const s = lit(v);
          return `(SELECT key FROM projects WHERE tenant_id = ${P(ctx.tenantId)} AND (upper(key) = upper(${P(s)}) OR lower(name) = lower(${P(s)})) LIMIT 1)`;
        });
      case 'key': case 'issuekey': case 'id': case 'issue': {
        // issue in linkedIssues("KEY"[, "link phrase as seen from KEY"])
        if ((op === 'in' || op === 'not in') && values[0]?.kind === 'fn') {
          const fn = values[0];
          if (fn.name !== 'linkedissues' || !fn.args[0]) throw bad('JQL: use linkedIssues("KEY") or linkedIssues("KEY", "blocks")');
          const src = `(SELECT id FROM issues WHERE tenant_id = ${P(ctx.tenantId)} AND upper(key) = upper(${P(fn.args[0])}))`;
          const phrase = fn.args[1] ? P(fn.args[1].toLowerCase()) : null;
          const sub = `(SELECT l.inward_issue_id FROM issue_links l JOIN link_types lt ON lt.id = l.type_id
                          WHERE l.outward_issue_id = ${src}${phrase ? ` AND lower(lt.outward) = ${phrase}` : ''}
                        UNION SELECT l.outward_issue_id FROM issue_links l JOIN link_types lt ON lt.id = l.type_id
                          WHERE l.inward_issue_id = ${src}${phrase ? ` AND lower(lt.inward) = ${phrase}` : ''})`;
          return `i.id ${op === 'in' ? 'IN' : 'NOT IN'} ${sub}`;
        }
        if (['<', '<=', '>', '>='].includes(op)) {
          const k = lit(values[0]).toUpperCase().split('-');
          return `(p.key = ${P(k[0])} AND i.number ${op} ${P(Number(k[1]))})`;
        }
        return ci('i.key');
      }
      case 'status': return ci('s.name');
      case 'statuscategory':
        return many('s.category', (v) => {
          const s = lit(v).toLowerCase();
          if (!CATEGORY[s]) throw bad(`JQL: unknown status category '${lit(v)}'`);
          return P(CATEGORY[s]);
        });
      case 'type': case 'issuetype': return ci('t.name');
      case 'priority':
        if (['<', '<=', '>', '>='].includes(op)) {
          // Jira: "priority > Medium" means higher priority = smaller position
          const flip: Record<string, string> = { '>': '<', '>=': '<=', '<': '>', '<=': '>=' };
          return `pr.position ${flip[op]} (SELECT position FROM priorities WHERE lower(name) = lower(${P(lit(values[0]))}))`;
        }
        return ci('pr.name');
      case 'assignee': return many('i.assignee_id', userExpr);
      case 'reporter': return many('i.reporter_id', userExpr);
      case 'creator': return many('i.creator_id', userExpr);
      case 'resolution':
        if (values.some((v) => v.kind === 'lit' && v.v.toLowerCase() === 'unresolved')) {
          return neg ? 'i.resolution IS NOT NULL' : 'i.resolution IS NULL';
        }
        return ci('i.resolution');
      case 'sprint': {
        if (isEmpty) return `i.sprint_id IS ${op === 'is not' ? 'NOT ' : ''}NULL`;
        if (!['=', '!=', 'in', 'not in'].includes(op)) throw bad(`JQL: operator ${op} not supported for sprint`);
        const tenantSprints = `SELECT s2.id FROM sprints s2 JOIN projects p2 ON p2.id = s2.project_id WHERE p2.tenant_id = ${P(ctx.tenantId)}`;
        const conds = values.map((v) => {
          if (v.kind === 'empty') return 'i.sprint_id IS NULL';
          if (v.kind === 'fn') {
            const state = { opensprints: 'active', futuresprints: 'future', closedsprints: 'closed' }[v.name];
            if (!state) throw bad(`JQL: unsupported function ${v.name}() for sprint`);
            return `i.sprint_id IN (${tenantSprints} AND s2.state = '${state}')`;
          }
          return /^\d+$/.test(v.v)
            ? `i.sprint_id IN (${tenantSprints} AND s2.id = ${P(Number(v.v))})`
            : `i.sprint_id IN (${tenantSprints} AND lower(s2.name) = lower(${P(v.v)}))`;
        });
        const any = `(${conds.join(' OR ')})`;
        // like other fields, != / NOT IN exclude empty values unless EMPTY is listed
        const hasEmpty = values.some((v) => v.kind === 'empty');
        return neg ? `(NOT ${any} AND ${hasEmpty ? 'TRUE' : 'i.sprint_id IS NOT NULL'})` : any;
      }
      case 'parent':
        return many('i.parent_id', (v) => `(SELECT id FROM issues WHERE tenant_id = ${P(ctx.tenantId)} AND upper(key) = upper(${P(lit(v))}))`);
      case 'labels': case 'label': {
        if (isEmpty) return `cardinality(i.labels) ${op === 'is' ? '=' : '>'} 0`;
        const list = values.map(lit);
        const has = `i.labels && ${P(list)}::text[]`;
        if (op === '=' || op === 'in') return has;
        if (op === '!=' || op === 'not in') return `NOT (${has})`;
        throw bad(`JQL: operator ${op} not supported for labels`);
      }
      case 'summary': case 'description': case 'text': case 'comment': {
        if (isEmpty && field !== 'text') {
          const col = field === 'summary' ? 'i.summary' : 'i.description';
          return `${col} IS ${op === 'is not' ? 'NOT ' : ''}NULL`;
        }
        if (op !== '~' && op !== '!~') throw bad(`JQL: use ~ for text search on ${field}`);
        const term = P(`%${lit(values[0]).replace(/[%_\\]/g, (m) => '\\' + m)}%`);
        const cols =
          field === 'summary' ? ['i.summary']
          : field === 'description' ? ['i.description::text']
          : field === 'comment' ? [`(SELECT string_agg(body::text, ' ') FROM comments WHERE issue_id = i.id)`]
          : ['i.summary', 'i.description::text', `(SELECT string_agg(body::text, ' ') FROM comments WHERE issue_id = i.id)`];
        const any = cols.map((col) => `coalesce(${col}, '') ILIKE ${term}`).join(' OR ');
        return op === '~' ? `(${any})` : `NOT (${any})`;
      }
      case 'created': case 'createddate': case 'updated': case 'updateddate': case 'duedate': case 'due':
      case 'resolved': case 'resolutiondate': case 'startdate': {
        const col = {
          created: 'i.created_at', createddate: 'i.created_at', updated: 'i.updated_at', updateddate: 'i.updated_at',
          duedate: 'i.due_date', due: 'i.due_date', resolved: 'i.resolved_at', resolutiondate: 'i.resolved_at', startdate: 'i.start_date',
        }[field]!;
        if (isEmpty) return `${col} IS ${op === 'is not' ? 'NOT ' : ''}NULL`;
        if (!['=', '!=', '<', '<=', '>', '>='].includes(op)) throw bad(`JQL: operator ${op} not supported for dates`);
        return `${col} ${op === '!=' ? '<>' : op} ${dateExpr(values[0])}`;
      }
      default:
        throw bad(`JQL: unknown field '${field}'`, { field });
    }
  };

  const walk = (n: Node): string => {
    if (n.t === 'and') return `(${walk(n.l)} AND ${walk(n.r)})`;
    if (n.t === 'or') return `(${walk(n.l)} OR ${walk(n.r)})`;
    if (n.t === 'not') return `(NOT ${walk(n.e)})`;
    return clause(n as Extract<Node, { t: 'clause' }>);
  };

  const access = ctx.isSiteAdmin
    ? 'TRUE'
    : `EXISTS (SELECT 1 FROM project_members pm WHERE pm.project_id = i.project_id AND pm.user_id = ${P(ctx.userId)})`;
  const where = `i.tenant_id = ${P(ctx.tenantId)} AND ${access}${q.where ? ` AND ${walk(q.where)}` : ''}`;

  const order = q.orderBy.length
    ? q.orderBy
        .map((o) => {
          const col = ORDER_COLUMNS[o.field] ?? (o.field === 'cf[10019]' ? 'i.rank' : null);
          if (!col) throw bad(`JQL: cannot order by '${o.field}'`);
          return col.split(', ').map((c) => `${c} ${o.dir} NULLS LAST`).join(', ');
        })
        .join(', ') + ', i.id'
    : 'i.created_at DESC, i.id';
  return { where, order };
}
