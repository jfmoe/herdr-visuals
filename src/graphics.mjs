import { PassThrough } from 'node:stream';

// Each viewer owns one image ID in its terminal. Uppercase I also frees pixels.
export const IMAGE_ID = 1;
export const clearGraphics = () => `\x1b_Ga=d,d=I,i=${IMAGE_ID},q=2\x1b\\`;

export function imageGraphics(png, { cols, rows }) {
  const data = png.toString('base64');
  const chunks = [];
  for (let offset = 0; offset < data.length; offset += 4096) {
    const more = offset + 4096 < data.length ? 1 : 0;
    const control = offset === 0
      ? `a=T,f=100,t=d,i=${IMAGE_ID},c=${cols},r=${rows},C=1,q=2,`
      : 'q=2,';
    chunks.push(`\x1b_G${control}m=${more};${data.slice(offset, offset + 4096)}\x1b\\`);
  }
  // Cursor coordinates are one-based; keep the four header rows and left margin.
  return `\x1b7\x1b[5;2H${clearGraphics()}${chunks.join('')}\x1b8`;
}

// Strip standard cell-size replies before readline sees them as user keys.
// Replies and key sequences can arrive split across arbitrary PTY reads.
export function terminalInput(input, onCellSize) {
  const keys = new PassThrough();
  let pending = '', timer, reportUntil = 0, reports = 0;
  keys.expectCellSize = () => {
    if (Date.now() > reportUntil) reports = 0;
    reports++; reportUntil = Date.now() + 1000;
  };
  function flush() {
    clearTimeout(timer);
    while (pending) {
      const match = pending.match(/^\x1b\[6;(\d{1,4});(\d{1,4})t/);
      if (match) {
        reports = Math.max(0, reports - 1);
        if (!reports) reportUntil = 0;
        const height = Number(match[1]), width = Number(match[2]);
        if (width > 0 && height > 0 && width <= 1000 && height <= 1000) onCellSize({ width, height });
        pending = pending.slice(match[0].length);
      } else if (/^(?:\x1b\[|\x1b\[6|\x1b\[6;\d{0,4}(?:;\d{0,4})?)$/.test(pending)) {
        // A recognized report is bounded to 14 characters. Keep it through
        // delayed PTY reads; its digits must never become search/zoom keys.
        return;
      } else if (pending === '\x1b') {
        // While a query is outstanding, an Escape may begin its reply.
        // Unsupported terminals still release a user's standalone Escape.
        const wait = Math.max(50, reportUntil - Date.now());
        timer = setTimeout(() => {
          pending = '';
          // Dispatch the resolved Escape without readline's second timeout.
          keys.emit('keypress', '\x1b', { name: 'escape', sequence: '\x1b', ctrl: false, meta: false, shift: false });
        }, wait);
        return;
      } else {
        const char = String.fromCodePoint(pending.codePointAt(0));
        keys.write(char); pending = pending.slice(char.length);
      }
    }
  }
  input.setEncoding('utf8');
  const receive = text => { pending += text; flush(); };
  input.on('data', receive);
  input.once('end', () => {
    clearTimeout(timer);
    keys.end(pending.startsWith('\x1b[6;') ? '' : pending); pending = '';
  });
  return keys;
}
