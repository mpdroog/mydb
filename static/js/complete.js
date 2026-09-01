// complete.js - table and column completion for the SQL console.
//
// Ctrl/Cmd+Space opens it; typing a dot after a table or an alias opens it
// on that table's columns. What it offers comes from the schema cache, so
// it never blocks on the network and never suggests something that is not
// in the database you are pointed at.
//
// The popup follows the caret. Working out where the caret is inside a
// textarea means measuring a mirror of it — the browser will not say —
// which is what caretBox does.

import { h, clear } from './dom.js';
import * as schema from './schema.js';

// KEYWORDS is a small, deliberately boring list: the words you type at the
// start of a clause, where a completion saves the most.
const KEYWORDS = [
  'SELECT', 'FROM', 'WHERE', 'GROUP BY', 'ORDER BY', 'HAVING', 'LIMIT',
  'INSERT INTO', 'UPDATE', 'DELETE FROM', 'SET', 'VALUES', 'JOIN',
  'LEFT JOIN', 'INNER JOIN', 'ON', 'AS', 'AND', 'OR', 'NOT', 'NULL',
  'IS NULL', 'IS NOT NULL', 'IN', 'LIKE', 'BETWEEN', 'DISTINCT', 'COUNT(*)',
  'EXPLAIN', 'SHOW CREATE TABLE', 'DESCRIBE', 'ASC', 'DESC',
];

// MAX is how many suggestions are shown at once.
const MAX = 12;

// MINAUTO is how many characters of a word are typed before the list opens
// on its own.
//
// It opens by itself because Ctrl+Space is not reliably deliverable: on
// Linux the input-method switcher takes it before the browser sees it, and
// a completion you have to know a shortcut for is one most people never
// find. The shortcut still works where the desktop leaves it alone.
const MINAUTO = 2;

// attach wires completion onto a textarea. getContext returns the server
// and database the console is currently pointed at.
// mount is where the popup lives. It defaults to the editor's own parent,
// which is right for a plain textarea; the statement band scrolls its box,
// and an absolutely-positioned popup inside a scrolling box is clipped by
// it, so that caller hands in the wrapper instead.
export function attach(editor, getContext, mount) {
  const pop = h('div', { class: 'complete', hidden: true });
  (mount || editor.parentNode).append(pop);

  let items = [];
  let cursor = 0;
  let replacing = null; // [start, end] of the word being completed
  // Set when Escape closed the list, so the next keystroke does not put it
  // straight back. Cleared as soon as the word being typed is left behind.
  let dismissed = false;

  function close() {
    pop.hidden = true;
    items = [];
    replacing = null;
  }

  function draw() {
    clear(pop);
    items.slice(0, MAX).forEach((it, i) => {
      pop.append(h('div', {
        class: 'citem' + (i === cursor ? ' on' : ''),
        onmousedown: (ev) => { ev.preventDefault(); accept(it); },
      },
        h('span', { class: 'cname', text: it.text }),
        h('span', { class: 'ckind', text: it.hint || it.kind }),
      ));
    });
    pop.hidden = items.length === 0;
  }

  function accept(it) {
    if (!replacing) return;
    const [a, b] = replacing;
    const before = editor.value.slice(0, a);
    const after = editor.value.slice(b);
    editor.value = before + it.text + after;
    const at = a + it.text.length;
    editor.setSelectionRange(at, at);
    close();
    editor.focus();
  }

  // open works out what is being typed and what could follow it.
  function open() {
    const { server, db } = getContext();
    const pos = editor.selectionStart;
    const text = editor.value;

    // The word under the caret, dots included so "orders.cli" is one unit.
    const m = /[\w$`.]*$/.exec(text.slice(0, pos));
    const word = m ? m[0] : '';
    const start = pos - word.length;

    const dot = word.lastIndexOf('.');
    const qualifier = dot >= 0 ? unquote(word.slice(0, dot)) : '';
    const prefix = word.slice(dot + 1).toLowerCase();

    const known = aliases(text, db);
    schema.warm(server, db, [...new Set(known.values())]);

    let cand = [];
    if (qualifier) {
      // After a dot the answer is that one table's columns, whether the
      // qualifier was the table's name or an alias for it.
      const table = known.get(qualifier.toLowerCase()) || qualifier;
      cand = schema.columns(server, db, table)
        .map((c) => ({ text: c.name, kind: 'column', hint: c.type + (c.pk ? ' · pk' : '') }));
      if (!cand.length) {
        // The qualifier may be a schema rather than a table.
        cand = schema.tables(server, qualifier)
          .map((t) => ({ text: t.name, kind: 'table', hint: t.type === 'VIEW' ? 'view' : 'table' }));
      }
    } else {
      // What the clause you are in is asking for. After FROM or JOIN it is
      // a table; after SELECT, WHERE, SET, ON or ORDER BY it is a column.
      // Getting this the wrong way round is what makes a completion list
      // feel like it is guessing.
      const wantsTable = tablePosition(text.slice(0, start));

      for (const [alias, table] of known) {
        for (const c of schema.columns(server, db, table)) {
          cand.push({
            text: c.name,
            kind: 'column',
            hint: table + '.' + c.name + ' · ' + c.type,
            rank: wantsTable ? 2 : 0,
            alias,
          });
        }
      }
      for (const t of schema.tables(server, db)) {
        cand.push({
          text: t.name,
          kind: 'table',
          hint: t.type === 'VIEW' ? 'view' : 'table',
          rank: wantsTable ? 0 : 1,
        });
      }
      for (const k of KEYWORDS) {
        cand.push({ text: k, kind: 'keyword', rank: wantsTable ? 3 : 2 });
      }
    }

    items = rank(cand, prefix);
    cursor = 0;
    replacing = [dot >= 0 ? start + dot + 1 : start, pos];
    draw();
    if (!pop.hidden) place();
  }

  // place puts the popup under the caret rather than under the box, which
  // matters once the editor is a few lines tall.
  function place() {
    const box = caretBox(editor);
    pop.style.left = Math.round(box.left) + 'px';
    pop.style.top = Math.round(box.top + box.height) + 'px';
  }

  editor.addEventListener('keydown', (ev) => {
    // ev.code as well as ev.key: with some layouts and input methods a
    // modified space arrives as an unidentified key with only the code set.
    if ((ev.ctrlKey || ev.metaKey) && (ev.key === ' ' || ev.code === 'Space')) {
      ev.preventDefault();
      ev.stopImmediatePropagation();
      dismissed = false;
      open();
      return;
    }
    if (pop.hidden) return;

    switch (ev.key) {
      case 'ArrowDown':
        cursor = Math.min(cursor + 1, Math.min(items.length, MAX) - 1); draw(); break;
      case 'ArrowUp':
        cursor = Math.max(cursor - 1, 0); draw(); break;
      case 'Enter':
      case 'Tab':
        if (items[cursor]) accept(items[cursor]);
        break;
      case 'Escape':
        dismissed = true;
        close();
        break;
      default:
        return;
    }
    ev.preventDefault();
    // Immediate: the console registers its own keydown on this same
    // element, and stopPropagation does not stop a sibling listener. Without
    // this, arrowing through the list would also walk the query history.
    ev.stopImmediatePropagation();
  });

  editor.addEventListener('input', (ev) => {
    // A dot after an identifier is the surest one: you have already said
    // which table, so the list is short and certainly right.
    if (ev.data === '.') { dismissed = false; open(); return; }

    // An open list re-filters on every keystroke.
    if (!pop.hidden) { open(); return; }

    // Typing anything that is not part of a word ends the word Escape was
    // dismissing, so the list is allowed back.
    if (!ev.data || !/[\w$]/.test(ev.data)) { dismissed = false; return; }
    if (dismissed) return;

    // Otherwise open once the word is long enough to be worth completing,
    // and never inside a string literal, where a column name is not what
    // is being typed.
    const before = editor.value.slice(0, editor.selectionStart);
    const word = /[\w$]*$/.exec(before)[0];
    if (word.length >= MINAUTO && !inString(before)) open();
  });

  editor.addEventListener('blur', () => setTimeout(close, 120));
  editor.addEventListener('scroll', () => { if (!pop.hidden) place(); });

  return { open, close };
}

// rank filters and orders the candidates for what has been typed.
function rank(cand, prefix) {
  const seen = new Set();
  const out = [];
  for (const c of cand) {
    const low = c.text.toLowerCase();
    if (prefix && !low.includes(prefix)) continue;
    const key = c.kind + ':' + low;
    if (seen.has(key)) continue;
    seen.add(key);
    // A prefix match beats a match in the middle; within that, keep the
    // order the sources were added in.
    c.score = (prefix && low.startsWith(prefix) ? 0 : 10) + (c.rank || 0);
    out.push(c);
  }
  out.sort((a, b) => a.score - b.score || a.text.length - b.text.length);
  return out.slice(0, MAX);
}

// tableWords are the keywords a table name follows.
const tableWords = /^(from|join|into|update|table|describe|desc|analyze|optimize|truncate)$/;

// tablePosition reports whether the word being typed is where a table name
// goes rather than a column name.
//
// It looks back for the last clause keyword. The parenthesis check is for
// `INSERT INTO t (col…`: the clause is still INTO, but once a bracket has
// been opened it is column names being listed.
function tablePosition(before) {
  const words = before.match(/[\w$]+|\(|\)/g);
  if (!words) return false;

  for (let i = words.length - 1; i >= 0; i--) {
    const w = words[i].toLowerCase();
    if (w === '(') return false;
    if (w === ')') continue;
    if (tableWords.test(w)) return true;
    // Any other clause keyword means we are past the table list.
    if (/^(select|where|set|on|using|group|order|having|limit|values|and|or|by)$/.test(w)) {
      return false;
    }
  }
  return false;
}

// aliases maps every name a statement can refer to a table by — the table
// itself and any alias — onto the table's real name.
function aliases(sql, db) {
  const out = new Map();
  const re = /\b(?:from|join|update|into)\s+([`\w.]+)(?:\s+(?:as\s+)?(?!where|on|set|using|left|right|inner|outer|join|group|order|limit|values|select)([a-z_]\w*))?/gi;
  for (const m of sql.matchAll(re)) {
    let name = unquote(m[1]);
    // A qualified name is only ours when it names the current database.
    const dot = name.lastIndexOf('.');
    if (dot >= 0) {
      if (db && name.slice(0, dot).toLowerCase() !== db.toLowerCase()) continue;
      name = name.slice(dot + 1);
    }
    out.set(name.toLowerCase(), name);
    if (m[2]) out.set(m[2].toLowerCase(), name);
  }
  return out;
}

function unquote(s) {
  return s.replace(/`/g, '');
}

// inString reports whether the caret sits inside a string literal, so that
// typing a value does not raise a list of column names over it. Counting
// unescaped quotes is enough for the question being asked.
function inString(before) {
  let quote = null;
  for (let i = 0; i < before.length; i++) {
    const c = before[i];
    if (quote) {
      if (c === '\\') i++;
      else if (c === quote) quote = null;
    } else if (c === "'" || c === '"') {
      quote = c;
    }
  }
  return quote !== null;
}

// caretBox measures where the caret sits inside a textarea.
//
// There is no API for this, so the textarea is mirrored into a div with the
// same metrics, the text up to the caret is put in it, and a marker span is
// measured. The mirror is built and thrown away per call: it is one layout
// on a keystroke that already opened a popup.
function caretBox(el) {
  const style = getComputedStyle(el);
  const mirror = h('div', { class: 'caret-mirror' });
  for (const p of [
    'fontFamily', 'fontSize', 'fontWeight', 'lineHeight', 'letterSpacing',
    'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
    'borderTopWidth', 'borderLeftWidth', 'textIndent', 'whiteSpace', 'wordWrap',
  ]) {
    mirror.style[p] = style[p];
  }
  mirror.style.width = el.clientWidth + 'px';

  const marker = h('span', { text: '​' });
  mirror.append(document.createTextNode(el.value.slice(0, el.selectionStart)), marker);
  el.parentNode.append(mirror);

  const box = {
    left: marker.offsetLeft - el.scrollLeft,
    top: marker.offsetTop - el.scrollTop + el.offsetTop,
    height: parseFloat(style.lineHeight) || 16,
  };
  mirror.remove();
  return box;
}
